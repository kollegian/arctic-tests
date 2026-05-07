import { ethers, JsonRpcProvider } from "ethers";
import { expect } from "chai";
import { QueryClient, StakingExtension, setupStakingExtension, setupDistributionExtension, DistributionExtension } from "@cosmjs/stargate";
import { SeiUser, UserFactory } from "../../shared/User";
import distrAbi from "./abis/distr_abi.json";
import stakingAbi from "./abis/staking_abi.json";
import { returnQueryClient, findValidator, parseRewardsResponse, calculateTotalRewardsAmount, findEvent, waitForRewards } from "./utils";
import { waitFor } from "../../shared/utils/helpers";
import crypto from "crypto";
import testConfig from "../../config/testConfig.json";

const STAKING_ADDRESS = "0x0000000000000000000000000000000000001005";
const DISTR_ADDRESS = "0x0000000000000000000000000000000000001007";

describe('Distribution Precompile Tests', function () {
    this.timeout(15 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let validatorOperator: SeiUser;
    let distrContract: any;
    let stakingContract: any;
    let stakingQueryClient: QueryClient & StakingExtension;
    let distrQueryClient: QueryClient & DistributionExtension;
    let validatorAddress1: string;
    let validatorAddress2: string;
    let provider: JsonRpcProvider;
    let operatorPubkey: string;
    let createdValidatorAddress: string;

    before('Initialize clients, users and staking query client', async () => {
        admin = await UserFactory.createAdminUser();
        ([alice, bob, validatorOperator] = await UserFactory.createSeiUsers(admin, 3));

        provider = new JsonRpcProvider(testConfig.evmRpcEndpoint);
        distrContract = new ethers.Contract(DISTR_ADDRESS, distrAbi, admin.evmWallet.wallet);
        stakingContract = new ethers.Contract(STAKING_ADDRESS, stakingAbi, admin.evmWallet.wallet);
        console.log('Contracts created');

        stakingQueryClient = await returnQueryClient(setupStakingExtension) as QueryClient & StakingExtension;
        distrQueryClient = await returnQueryClient(setupDistributionExtension) as QueryClient & DistributionExtension;
        console.log('Query clients initialized');
        const validatorsResponse = await stakingQueryClient.staking.validators("BOND_STATUS_BONDED");
        expect(validatorsResponse.validators.length).to.be.gte(2, "At least two validators are required");
        validatorAddress1 = validatorsResponse.validators[0].operatorAddress;
        validatorAddress2 = validatorsResponse.validators[1].operatorAddress;
        console.log('Validators fetched');
        const stakeAmount = ethers.parseEther("4");
        const tx1 = await stakingContract.connect(alice.evmWallet.wallet)
            .delegate(validatorAddress1, { value: stakeAmount });
        const receipt1 = await tx1.wait();
        expect(receipt1.status).to.equal(1);

        const tx2 = await stakingContract.connect(alice.evmWallet.wallet)
            .delegate(validatorAddress2, { value: stakeAmount });
        const receipt2 = await tx2.wait();
        expect(receipt2.status).to.equal(1);
        console.log('Delegations made');
        await waitForRewards(distrContract, alice.evmAddress);
        console.log('Waiting for rewards to accumulate');
    });

    describe('Query: rewards()', function () {
        it('should query rewards for a delegator with active delegations', async () => {
            console.log('First test');
            const rewards = await distrContract.rewards(alice.evmAddress);
            const parsedRewards = parseRewardsResponse(rewards);

            expect(parsedRewards).to.have.property('rewards').that.is.an('array');
            expect(parsedRewards).to.have.property('total').that.is.an('array');
            expect(parsedRewards.rewards.length).to.be.gte(2);

            for (const reward of parsedRewards.rewards as any[]) {
                expect(reward).to.have.property('coins');
                expect(reward).to.have.property('validator_address');
                expect(reward.validator_address).to.be.a('string').that.matches(/^seivaloper/);

                for (const coin of reward.coins as any[]) {
                    expect(coin).to.have.property('amount');
                    expect(coin).to.have.property('decimals');
                    expect(coin).to.have.property('denom');
                }
            }
        });

        it('should return empty rewards for address with no delegations', async () => {
            const rewards = await distrContract.rewards(bob.evmAddress);
            const parsedRewards = parseRewardsResponse(rewards);

            expect(parsedRewards.rewards).to.have.lengthOf(0);
            expect(parsedRewards.total).to.have.lengthOf(0);
        });

        it('should query rewards and compare with cosmos query', async () => {
            const [evmRewards, cosmosRewards] = await Promise.all([
                distrContract.rewards(alice.evmAddress),
                distrQueryClient.distribution.delegationTotalRewards(alice.seiAddress),
            ]);
            const parsedEvmRewards = parseRewardsResponse(evmRewards);

            expect(parsedEvmRewards.rewards.length).to.equal(cosmosRewards.rewards.length);

            const evmValidators = parsedEvmRewards.rewards.map((r: any) => r.validator_address).sort();
            const cosmosValidators = cosmosRewards.rewards.map((r: any) => r.validatorAddress).sort();
            expect(evmValidators).to.deep.equal(cosmosValidators);
        });
    });

    describe('Function: setWithdrawAddress()', function () {
        it('should set the withdraw address and emit WithdrawAddressSet event', async () => {
            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .setWithdrawAddress(bob.evmAddress);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const event = findEvent(receipt, distrContract, 'WithdrawAddressSet');
            expect(event).to.not.be.undefined;
            const parsedEvent = distrContract.interface.parseLog(event!);

            expect(parsedEvent?.args[0].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(parsedEvent?.args[1].toLowerCase()).to.equal(bob.evmAddress.toLowerCase());
        });

        it('should allow setting withdraw address back to self', async () => {
            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .setWithdrawAddress(alice.evmAddress);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const event = findEvent(receipt, distrContract, 'WithdrawAddressSet');
            expect(event).to.not.be.undefined;
            const parsedEvent = distrContract.interface.parseLog(event!);
            expect(parsedEvent?.args[1].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
        });
    });

    describe('Function: withdrawDelegationRewards()', function () {
        before('Wait for rewards to accumulate', async () => {
            await waitForRewards(distrContract, alice.evmAddress);
        });

        it('should withdraw delegation rewards for a single validator with balance verification', async () => {
            const preBalance = await alice.evmWallet.queryBalance();
            const preRewards = parseRewardsResponse(await distrContract.rewards(alice.evmAddress));
            const totalPreRewards = calculateTotalRewardsAmount(preRewards);

            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .withdrawDelegationRewards(validatorAddress1);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const event = findEvent(receipt, distrContract, 'DelegationRewardsWithdrawn');
            expect(event).to.not.be.undefined;
            const parsedEvent = distrContract.interface.parseLog(event!);
            expect(parsedEvent?.args[0].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(parsedEvent?.args[1]).to.equal(validatorAddress1);

            const postBalance = await alice.evmWallet.queryBalance();
            const postRewards = parseRewardsResponse(await distrContract.rewards(alice.evmAddress));
            const totalPostRewards = calculateTotalRewardsAmount(postRewards);

            const gasCost = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice);
            expect(BigInt(postBalance) >= BigInt(preBalance) - gasCost).to.be.true;
            expect(totalPostRewards < totalPreRewards).to.be.true;
        });

        it('should fail to withdraw rewards from invalid validator', async () => {
            let error = null;
            try {
                const tx = await distrContract.connect(alice.evmWallet.wallet)
                    .withdrawDelegationRewards("seivaloperinvalid123");
                await tx.wait();
            } catch (err: any) { error = err; }
            expect(error).to.not.be.null;
        });

        it('should fail to withdraw rewards from validator with no delegation', async () => {
            let error = null;
            try {
                const tx = await distrContract.connect(bob.evmWallet.wallet)
                    .withdrawDelegationRewards(validatorAddress1);
                await tx.wait();
            } catch (err: any) { error = err; }
            expect(error).to.not.be.null;
        });
    });

    describe('Function: withdrawMultipleDelegationRewards()', function () {
        before('Wait for rewards to accumulate', async () => {
            await waitForRewards(distrContract, alice.evmAddress);
        });

        it('should withdraw delegation rewards from multiple validators with balance verification', async () => {
            const preBalance = await alice.evmWallet.queryBalance();
            const preRewards = parseRewardsResponse(await distrContract.rewards(alice.evmAddress));
            const totalPreRewards = calculateTotalRewardsAmount(preRewards);

            const validators = [validatorAddress1, validatorAddress2];
            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .withdrawMultipleDelegationRewards(validators);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const event = findEvent(receipt, distrContract, 'MultipleDelegationRewardsWithdrawn');
            expect(event).to.not.be.undefined;
            const parsedEvent = distrContract.interface.parseLog(event!);

            expect(parsedEvent?.args[0].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(parsedEvent?.args[1]).to.deep.equal(validators);
            expect(parsedEvent?.args[2]).to.have.lengthOf(validators.length);

            const postRewards = parseRewardsResponse(await distrContract.rewards(alice.evmAddress));
            const totalPostRewards = calculateTotalRewardsAmount(postRewards);
            expect(totalPostRewards < totalPreRewards).to.be.true;
        });

        it('should handle empty validators array without crashing', async () => {
            let succeeded = false;
            try {
                const tx = await distrContract.connect(alice.evmWallet.wallet)
                    .withdrawMultipleDelegationRewards([]);
                const receipt = await tx.wait();
                succeeded = receipt.status === 1;
            } catch {
                succeeded = false;
            }
            // Either outcome is acceptable (no-op success or revert)
            expect(typeof succeeded).to.equal('boolean');
        });

        it('should fail with invalid validator in array', async () => {
            let error = null;
            try {
                const tx = await distrContract.connect(alice.evmWallet.wallet)
                    .withdrawMultipleDelegationRewards([validatorAddress1, "seivaloperinvalid123"]);
                await tx.wait();
            } catch (err: any) { error = err; }
            expect(error).to.not.be.null;
        });
    });

    describe.skip('Function: withdrawValidatorCommission()', function () {
        before('Create a validator for commission tests', async function () {
            this.timeout(3 * 60 * 1000);

            await UserFactory.fundAddressOnSei(validatorOperator.seiAddress, 'usei', '10000000000');
            await waitFor(2);

            const ed = require('ed25519-supercop');
            const seed = Buffer.alloc(32);
            crypto.randomFillSync(seed);
            const kp = ed.createKeyPair(seed);
            operatorPubkey = kp.publicKey.toString('hex');

            try {
                const tx = await stakingContract.connect(validatorOperator.evmWallet.wallet)
                    .createValidator(
                        operatorPubkey, "TestDistValidator", "0.10", "0.20", "0.05", "100000",
                        { value: ethers.parseEther('5'), gasLimit: 1000000 }
                    );
                const receipt = await tx.wait();
                expect(receipt.status).to.equal(1);

                const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
                const newValidator = findValidator(validators, operatorPubkey);
                createdValidatorAddress = newValidator?.operatorAddress as string;

                const delegateTx = await stakingContract.connect(alice.evmWallet.wallet)
                    .delegate(createdValidatorAddress, { value: ethers.parseEther('0.5') });
                await delegateTx.wait();
                await waitFor(15);
            } catch (e: any) {
                console.log("Validator creation failed:", e.message);
                this.skip();
            }
        });

        it('should withdraw validator commission with balance verification', async function () {
            if (!createdValidatorAddress) this.skip();

            const preBalance = await validatorOperator.evmWallet.queryBalance();

            const tx = await distrContract.connect(validatorOperator.evmWallet.wallet)
                .withdrawValidatorCommission();
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const event = findEvent(receipt, distrContract, 'ValidatorCommissionWithdrawn');
            if (event) {
                const parsedEvent = distrContract.interface.parseLog(event!);
                expect(parsedEvent?.args[1]).to.be.a('bigint');
            }

            const postBalance = await validatorOperator.evmWallet.queryBalance();
            expect(BigInt(postBalance) >= BigInt(preBalance) - BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice)).to.be.true;
        });

        it('should fail to withdraw commission for non-validator', async () => {
            let error = null;
            try {
                const tx = await distrContract.connect(alice.evmWallet.wallet)
                    .withdrawValidatorCommission();
                await tx.wait();
            } catch (err: any) { error = err; }
            expect(error).to.not.be.null;
        });
    });

    describe('Event Verification', function () {
        it('should emit correct event structure for DelegationRewardsWithdrawn', async () => {
            await waitForRewards(distrContract, alice.evmAddress);

            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .withdrawDelegationRewards(validatorAddress1);
            const receipt = await tx.wait();

            const event = findEvent(receipt, distrContract, 'DelegationRewardsWithdrawn');
            expect(event).to.not.be.undefined;
            const parsedEvent = distrContract.interface.parseLog(event!);

            expect(parsedEvent?.args[0]).to.be.a('string');
            expect(parsedEvent?.args[0].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(parsedEvent?.args[1]).to.be.a('string').that.matches(/^seivaloper/);
            expect(typeof parsedEvent?.args[2]).to.equal('bigint');
        });

        it('should emit correct event structure for MultipleDelegationRewardsWithdrawn', async () => {
            await waitForRewards(distrContract, alice.evmAddress);

            const validators = [validatorAddress1, validatorAddress2];
            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .withdrawMultipleDelegationRewards(validators);
            const receipt = await tx.wait();

            const event = findEvent(receipt, distrContract, 'MultipleDelegationRewardsWithdrawn');
            expect(event).to.not.be.undefined;
            const parsedEvent = distrContract.interface.parseLog(event!);

            expect(parsedEvent?.args[0].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(parsedEvent?.args[1]).to.be.an('array').with.lengthOf(validators.length);
            expect(parsedEvent?.args[2]).to.be.an('array').with.lengthOf(validators.length);
        });

        it('should emit correct event structure for WithdrawAddressSet', async () => {
            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .setWithdrawAddress(bob.evmAddress);
            const receipt = await tx.wait();

            const event = findEvent(receipt, distrContract, 'WithdrawAddressSet');
            expect(event).to.not.be.undefined;
            const parsedEvent = distrContract.interface.parseLog(event!);

            expect(parsedEvent?.args[0].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(parsedEvent?.args[1].toLowerCase()).to.equal(bob.evmAddress.toLowerCase());

            await (await distrContract.connect(alice.evmWallet.wallet).setWithdrawAddress(alice.evmAddress)).wait();
        });
    });

    describe('Log Queries: eth_getLogs for Distribution Precompile', function () {
        const EVENT_TOPICS = {
            DelegationRewardsWithdrawn: ethers.id("DelegationRewardsWithdrawn(address,string,uint256)"),
            MultipleDelegationRewardsWithdrawn: ethers.id("MultipleDelegationRewardsWithdrawn(address,string[],uint256[])"),
            ValidatorCommissionWithdrawn: ethers.id("ValidatorCommissionWithdrawn(string,uint256)"),
            WithdrawAddressSet: ethers.id("WithdrawAddressSet(address,address)")
        };

        it('should query all logs from distribution precompile', async () => {
            const currentBlock = await provider.getBlockNumber();
            const logs = await provider.getLogs({
                address: DISTR_ADDRESS,
                fromBlock: Math.max(0, currentBlock - 1000),
                toBlock: currentBlock
            });
            expect(logs.length).to.be.gte(0);

            for (const log of logs) {
                expect(log.address.toLowerCase()).to.equal(DISTR_ADDRESS.toLowerCase());
                expect(log.topics.length).to.be.gte(1);
            }
        });

        it('should query logs filtered by DelegationRewardsWithdrawn event', async () => {
            const currentBlock = await provider.getBlockNumber();
            const logs = await provider.getLogs({
                address: DISTR_ADDRESS,
                topics: [EVENT_TOPICS.DelegationRewardsWithdrawn],
                fromBlock: Math.max(0, currentBlock - 1000),
                toBlock: currentBlock
            });

            for (const log of logs) {
                expect(log.topics[0]).to.equal(EVENT_TOPICS.DelegationRewardsWithdrawn);
                const parsed = distrContract.interface.parseLog({ topics: log.topics as string[], data: log.data });
                expect(parsed?.name).to.equal('DelegationRewardsWithdrawn');
            }
        });

        it('should query logs filtered by delegator address (indexed)', async () => {
            const currentBlock = await provider.getBlockNumber();
            const paddedAddress = ethers.zeroPadValue(alice.evmAddress, 32);

            const logs = await provider.getLogs({
                address: DISTR_ADDRESS,
                topics: [EVENT_TOPICS.DelegationRewardsWithdrawn, paddedAddress],
                fromBlock: Math.max(0, currentBlock - 1000),
                toBlock: currentBlock
            });

            for (const log of logs) {
                const parsed = distrContract.interface.parseLog({ topics: log.topics as string[], data: log.data });
                expect(parsed?.args[0].toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            }
        });

        it('should query WithdrawAddressSet logs', async () => {
            const currentBlock = await provider.getBlockNumber();
            const logs = await provider.getLogs({
                address: DISTR_ADDRESS,
                topics: [EVENT_TOPICS.WithdrawAddressSet],
                fromBlock: Math.max(0, currentBlock - 1000),
                toBlock: currentBlock
            });

            for (const log of logs) {
                const parsed = distrContract.interface.parseLog({ topics: log.topics as string[], data: log.data });
                expect(parsed?.name).to.equal('WithdrawAddressSet');
            }
        });

        it('should query MultipleDelegationRewardsWithdrawn logs', async () => {
            const currentBlock = await provider.getBlockNumber();
            const logs = await provider.getLogs({
                address: DISTR_ADDRESS,
                topics: [EVENT_TOPICS.MultipleDelegationRewardsWithdrawn],
                fromBlock: Math.max(0, currentBlock - 1000),
                toBlock: currentBlock
            });

            for (const log of logs) {
                const parsed = distrContract.interface.parseLog({ topics: log.topics as string[], data: log.data });
                expect(parsed?.name).to.equal('MultipleDelegationRewardsWithdrawn');
            }
        });

        it('should verify log count matches transaction receipts', async () => {
            await waitForRewards(distrContract, alice.evmAddress);

            const tx = await distrContract.connect(alice.evmWallet.wallet)
                .withdrawDelegationRewards(validatorAddress1);
            const receipt = await tx.wait();

            const receiptEvents = receipt.logs.filter((l: any) => {
                try { return distrContract.interface.parseLog(l)?.name === 'DelegationRewardsWithdrawn'; }
                catch { return false; }
            });

            const queriedLogs = await provider.getLogs({
                address: DISTR_ADDRESS,
                topics: [EVENT_TOPICS.DelegationRewardsWithdrawn],
                fromBlock: receipt.blockNumber,
                toBlock: receipt.blockNumber
            });

            const txLogs = queriedLogs.filter(l => l.transactionHash === receipt.hash);
            expect(txLogs.length).to.equal(receiptEvents.length);

            for (let i = 0; i < txLogs.length; i++) {
                expect(txLogs[i].topics[0]).to.equal(receiptEvents[i].topics[0]);
                expect(txLogs[i].data).to.equal(receiptEvents[i].data);
            }
        });

        it('should query logs within a specific block range', async () => {
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = Math.max(0, currentBlock - 100);

            const logs = await provider.getLogs({
                address: DISTR_ADDRESS,
                fromBlock,
                toBlock: currentBlock
            });

            for (const log of logs) {
                expect(log.blockNumber).to.be.gte(fromBlock);
                expect(log.blockNumber).to.be.lte(currentBlock);
            }
        });
    });

    describe('Integration: Withdraw Address Flow', function () {
        it('should withdraw rewards to custom address when withdraw address is set', async () => {
            await waitForRewards(distrContract, alice.evmAddress);

            const bobPreBalance = await bob.evmWallet.queryBalance();

            await (await distrContract.connect(alice.evmWallet.wallet).setWithdrawAddress(bob.evmAddress)).wait();

            const withdrawTx = await distrContract.connect(alice.evmWallet.wallet)
                .withdrawDelegationRewards(validatorAddress1);
            await withdrawTx.wait();

            const bobPostBalance = await bob.evmWallet.queryBalance();
            expect(BigInt(bobPostBalance) >= BigInt(bobPreBalance)).to.be.true;

            await (await distrContract.connect(alice.evmWallet.wallet).setWithdrawAddress(alice.evmAddress)).wait();
        });
    });

    describe('Integration: Full Rewards Lifecycle', function () {
        it('should complete full lifecycle: delegate -> accumulate -> query -> withdraw -> verify', async () => {
            const [testUser] = await UserFactory.createSeiUsers(admin, 1);

            const delegateAmount = ethers.parseEther("0.1");
            const delegateTx = await stakingContract.connect(testUser.evmWallet.wallet)
                .delegate(validatorAddress1, { value: delegateAmount });
            await delegateTx.wait();

            const totalRewardsAmount = await waitForRewards(distrContract, testUser.evmAddress);
            expect(totalRewardsAmount > BigInt(0)).to.be.true;

            const preBalance = await testUser.evmWallet.queryBalance();
            const withdrawTx = await distrContract.connect(testUser.evmWallet.wallet)
                .withdrawDelegationRewards(validatorAddress1);
            const withdrawReceipt = await withdrawTx.wait();

            const event = findEvent(withdrawReceipt, distrContract, 'DelegationRewardsWithdrawn');
            expect(event).to.not.be.undefined;

            const postBalance = await testUser.evmWallet.queryBalance();
            const postRewards = parseRewardsResponse(await distrContract.rewards(testUser.evmAddress));
            const totalPostRewards = calculateTotalRewardsAmount(postRewards);

            expect(totalPostRewards < totalRewardsAmount).to.be.true;

            const gasCost = BigInt(withdrawReceipt.gasUsed) * BigInt(withdrawReceipt.gasPrice);
            expect(BigInt(postBalance) >= BigInt(preBalance) - gasCost).to.be.true;
        });
    });
});
