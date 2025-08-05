import {Contract, ethers} from "ethers";
import {expect} from "chai";
import {SeiUser, UserFactory} from "../../shared/User";
import stakingAbi from "./abis/staking_abi.json";
import {findValidator, returnQueryClient} from "./utils";
import {QueryClient, setupStakingExtension, StakingExtension} from "@cosmjs/stargate";
import crypto from "crypto";
import {waitFor} from "../../shared/utils/helpers";

const STAKING_ADDRESS = "0x0000000000000000000000000000000000001005";

describe('Staking Precompile Tests', function () {
    this.timeout(3 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let stakingContract: Contract;
    let invalidValidator: string = "invalid_validator_address";
    let stakingQueryClient: QueryClient & StakingExtension;
    let validatorAddress1: string;
    let validatorAddress2: string;
    let operatorPubkey: string;

    before('Initialize users and contract', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 2);

        stakingContract = new Contract(STAKING_ADDRESS, stakingAbi, admin.evmWallet.wallet);
        stakingQueryClient = await returnQueryClient(setupStakingExtension) as QueryClient & StakingExtension;

        const validatorsResponse = await stakingQueryClient.staking.validators("BOND_STATUS_BONDED");
        if (validatorsResponse.validators.length < 2) {
            throw new Error("At least two validators are required for these tests");
        }
        validatorAddress1 = validatorsResponse.validators[0].operatorAddress;
        validatorAddress2 = validatorsResponse.validators[1].operatorAddress;
    });

    describe('delegate()', function () {
        it.only('Given that users have sufficient funds, users can delegate successfully to a valid validator', async () => {
            const amount = ethers.parseEther("0.02");
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress1, {value: amount});
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            // Validate delegation on-chain
            const delegation = await stakingQueryClient.staking.delegation(
                alice.seiAddress, validatorAddress1
            );
            expect(delegation.delegationResponse?.delegation.validatorAddress).to.eq(validatorAddress1);
            expect(Number(delegation.delegationResponse?.balance.amount)).to.be.gt(0);
        });

        it.only('Given that users have sufficient funds, they cant delegate to an invalid validator', async () => {
            const amount = ethers.parseEther("0.01");
            let error = null;
            try {
                await stakingContract.connect(alice.evmWallet.wallet)
                    .delegate(invalidValidator, {value: amount});
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it.only('Given that users have insufficient funds, the delegation to a validator fails', async () => {
            const hugeAmount = ethers.parseEther("1000000");
            let error = null;
            try {
                await stakingContract.connect(bob.evmWallet.wallet)
                    .delegate(validatorAddress1, {value: hugeAmount});
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it.only('Given that users have sufficient funds, users can stake into multiple validators', async () => {
            const amount = ethers.parseEther("0.02");
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress2, {value: amount});
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            // Validate delegation on-chain
            const delegation = await stakingQueryClient.staking.delegation(
                alice.seiAddress, validatorAddress2
            );
            expect(delegation.delegationResponse?.delegation.validatorAddress).to.eq(validatorAddress2);
            expect(delegation.delegationResponse?.delegation.delegatorAddress).to.eq(alice.seiAddress);
            expect(delegation.delegationResponse?.delegation.shares).to.eq((BigInt(amount) * BigInt(10 **6)).toString());
            expect(Number(delegation.delegationResponse?.balance.amount)).to.be.eq(20000);
        });

        it.only('Given that users have sufficient funds, users can stake into the same validator in multiple txs', async () =>{
            const amount = ethers.parseEther("0.02");
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress1, {value: amount});
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            // Validate delegation on-chain
            const delegation = await stakingQueryClient.staking.delegation(
                alice.seiAddress, validatorAddress1
            );
            expect(delegation.delegationResponse?.delegation.validatorAddress).to.eq(validatorAddress1);
            expect(delegation.delegationResponse?.delegation.delegatorAddress).to.eq(alice.seiAddress);

            //At this point Alice will have this as stake amount
            expect(delegation.delegationResponse?.delegation.shares).to.eq((BigInt(ethers.parseEther('0.04')) * BigInt(10 **6)).toString());
            expect(Number(delegation.delegationResponse?.balance.amount)).to.be.eq(40000);
        });

        it.skip('Given that users have sufficient funds, users cant delegate amounts over max voting power', async () => {
            const pool = await stakingQueryClient.staking.pool();
            const maxVotingPower = 0.2;
            const maxAvailableForStake = (Number(pool.pool.bondedTokens) / (1-maxVotingPower)) - Number(pool.pool.bondedTokens);
            const overCap = Number((maxAvailableForStake / 10 **6) + 10);
            await UserFactory.fundAddressOnSei(alice.seiAddress, 'usei', '10000000000');
            await waitFor(1);
            const userPreBalance = await alice.evmWallet.queryBalance();
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress1, {value: ethers.parseEther('300'), gasLimit: 1000000});
            const receipt = await tx.wait();
            console.log(validatorAddress2);
            const userPostBalance = await alice.evmWallet.queryBalance();
            console.log(ethers.formatEther(userPreBalance - userPostBalance));
            expect(Number(ethers.formatEther(userPreBalance - userPostBalance))).to.be.gt(100);
            const poolAfter = await stakingQueryClient.staking.pool();
            console.log(poolAfter);

            const delegation = await stakingQueryClient.staking.delegation(
                alice.seiAddress, validatorAddress1
            );
            expect(delegation.delegationResponse?.delegation.validatorAddress).to.eq(validatorAddress1);
            expect(delegation.delegationResponse?.delegation.delegatorAddress).to.eq(alice.seiAddress);

            //At this point Alice will have this as stake amount
            expect(delegation.delegationResponse?.delegation.shares).to.eq((BigInt(ethers.parseEther('1000000.04')) * BigInt(10 **6)).toString());
            expect(Number(delegation.delegationResponse?.balance.amount)).to.be.eq('1000000040000');
        })
    });

    describe('redelegate()', function () {
        it.only('Given that users have delegations to validator1, they can redelegate validator2', async () => {
            const amount = '5000';
            const delegatedAmount = await stakingQueryClient.staking.delegation(alice.seiAddress, validatorAddress1);
            const delegation2 = await stakingContract.delegation(alice.evmAddress, validatorAddress1);
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .redelegate(validatorAddress1, validatorAddress2, amount);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            // Query redelegation (check new shares)
            const delegation = await stakingQueryClient.staking.delegation(
                alice.seiAddress, validatorAddress2
            );
            expect(Number(delegation.delegationResponse?.balance.amount)).to.be.gte(Number(amount));
        });

        it('Given that users have delegations, redelegations from invalid source validator fails', async () => {
            const amount = ethers.parseEther("0.001");
            let error = null;
            try {
                await stakingContract.connect(alice.evmWallet.wallet)
                    .redelegate(invalidValidator, validatorAddress2, amount);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it('Given that user has delegations, redelegations to invalid validators fails', async () => {
            const amount = ethers.parseEther("0.001");
            let error = null;
            try {
                await stakingContract.connect(alice.evmWallet.wallet)
                    .redelegate(validatorAddress1, invalidValidator, amount);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it.only('Given that user has delegations, redelegations more than user staked amount fails', async () =>{
            const amount = ethers.parseEther("100");
            let error = null;
            try {
                await stakingContract.connect(alice.evmWallet.wallet)
                    .redelegate(validatorAddress1, invalidValidator, amount);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });

    describe('undelegate()', function () {
        it.only('User can undelegate successfully from validator2', async () => {
            const amount = '1000';
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .undelegate(validatorAddress2, amount);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            // Query undelegation, amount should be lower
            const delegation = await stakingQueryClient.staking.unbondingDelegation(
                alice.seiAddress, validatorAddress2
            );
            // Can be zero or lower, depending on chain state and unbonding period
            expect(Number(delegation.unbond.entries[0].balance)).to.be.eq(Number(amount));
        });

        it.only('Given that users have undelegations, they cant undelegate from invalid validators', async () => {
            const amount = ethers.parseEther("0.001");
            let error = null;
            try {
                await stakingContract.connect(alice.evmWallet.wallet)
                    .undelegate(invalidValidator, amount);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it('Given that users have undelegations, they cant have undelegations more than ', async () => {
            const hugeAmount = ethers.parseEther("1000000");
            let error = null;
            try {
                await stakingContract.connect(alice.evmWallet.wallet)
                    .undelegate(validatorAddress2, hugeAmount);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });

    describe('createValidator()', function () {

        let operatorAddress: string;

        it('Bonded users can create a validator (positive flow)', async () => {
            const ed = require('ed25519-supercop');
            const minSelfDelegation = "100000";
            const seed = Buffer.alloc(32);
            crypto.randomFillSync(seed);
            const kp = ed.createKeyPair(seed)
            operatorPubkey = kp.publicKey.toString('hex');
            const tx = await stakingContract.connect(bob.evmWallet.wallet)
                .createValidator(
                    operatorPubkey,
                    "MyMoniker",
                    "0.10",
                    "0.20",
                    "0.05",
                    minSelfDelegation,
                    {value: ethers.parseEther('1'), gasLimit: 1000000},
                );
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
            const newValidator = findValidator(validators, operatorPubkey);
            operatorAddress = newValidator?.operatorAddress as string;
            expect(newValidator?.jailed).to.be.false;
            expect(newValidator?.status).to.be.eq(3);
            expect(newValidator?.tokens).to.be.eq('1000000');
            expect(newValidator?.description?.moniker).to.be.eq("MyMoniker");
            expect(newValidator?.commission.commissionRates.rate).to.be.eq((0.1 * 10 ** 18).toString());
            expect(newValidator?.commission.commissionRates.maxRate).to.be.eq((0.2 * 10 ** 18).toString());
            expect(newValidator?.commission.commissionRates.maxChangeRate).to.be.eq((0.05 * 10 ** 18).toString());
        });

        it('should fail with insufficient self delegation', async () => {
            const minSelfDelegation = ethers.parseEther("10");
            let error = null;
            try {
                await stakingContract.connect(bob.evmWallet.wallet)
                    .createValidator(
                        operatorPubkey,
                        "BadMoniker",
                        "0.1",
                        "0.2",
                        "0.05",
                        minSelfDelegation,
                        {value: ethers.parseEther("2")}
                    );
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });

    describe('editValidator()', function () {

        it('Cant change commission rate in 24h', async () => {
            const minSelfDelegation = '200000';
            let error = null;
            try {
                const tx = await stakingContract.connect(bob.evmWallet.wallet)
                    .editValidator(
                        "MyMoniker2",
                        "0.15",
                        minSelfDelegation,
                        {gasLimit: 1000000}
                    );
                const receipt = await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it('Can update moniker name', async () => {
            const tx = await stakingContract.connect(bob.evmWallet.wallet)
                .editValidator(
                    "MyMoniker2",
                    "",
                    0,
                    {gasLimit: 1000000}
                );
            const receipt = await tx.wait();
            const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
            const newValidator = findValidator(validators, operatorPubkey);
            console.log(newValidator);
            expect(newValidator?.description?.moniker).to.be.eq("MyMoniker2");
            expect(newValidator?.commission.commissionRates.rate).to.be.eq((0.1 * 10 ** 18).toString());
        });

        it('Can increase min self delegation', async () => {
            const minSelfDelegation = '200000';
            const tx = await stakingContract.connect(bob.evmWallet.wallet)
                .editValidator(
                    "MyMoniker2",
                    "",
                    minSelfDelegation,
                    {gasLimit: 1000000}
                );
            const receipt = await tx.wait();
            const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
            const newValidator = findValidator(validators, operatorPubkey);
            console.log(newValidator);
            expect(newValidator?.minSelfDelegation).to.be.eq(minSelfDelegation);
        });

        it('Cant decrease min self delegation', async () => {
            const minSelfDelegation = '1000';
            let error = null;
            try {
                const tx = await stakingContract.connect(bob.evmWallet.wallet)
                    .editValidator(
                        "MyMoniker2",
                        "",
                        minSelfDelegation,
                        {gasLimit: 1000000}
                    );
                const receipt = await tx.wait();
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it('should fail to edit with invalid commission rate', async () => {
            let error = null;
            try {
                await stakingContract.connect(bob.evmWallet.wallet)
                    .editValidator("MyMoniker3", "-0.01", ethers.parseEther("1"));
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });

    describe('delegation()', function () {

        it('should query delegation info (positive)', async () => {
            const result = await stakingContract.delegation(alice.evmAddress, validatorAddress1);
            expect(result.delegation.validator_address).to.eq(validatorAddress1);
            expect(result.delegation.delegator_address).to.eq(alice.seiAddress);
            expect(Number(result.balance.amount)).to.be.eq(15000);
            expect(Number(result.delegation.shares).toString()).to.be.eq((15000 * (10 **12)).toString());
        });

        it('should return zero for non-delegated pair', async () => {
            try{
                const result = await stakingContract.delegation(bob.evmAddress, validatorAddress1);
                throw new Error('Should fail');
            } catch(e: any){
                expect(e.message).not.to.be.eq('Should fail');
            }
        });

        it('should fail for invalid validator', async () => {
            let error = null;
            try {
                await stakingContract.delegation(alice.evmAddress, invalidValidator);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });
});
