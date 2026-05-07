import {Contract, ethers} from "ethers";
import {expect} from "chai";
import {SeiUser, UserFactory} from "../../shared/User";
import stakingAbi from "./abis/staking_abi.json";
import {
    findValidator,
    returnQueryClient,
    parseParams,
    parsePool,
    parseUnbondingDelegation,
    parseValidator,
    parseRedelegation
} from "./utils";
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
        it('Given that users have sufficient funds, users can delegate successfully to a valid validator', async () => {
            const amount = ethers.parseEther("0.02");
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress1, {value: amount});
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'Delegate';
                } catch (e) { return false; }
            });
            expect(log).to.not.be.undefined;
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(alice.evmAddress);
            expect(parsedLog?.args[1]).to.eq(validatorAddress1);
            expect(parsedLog?.args[2]).to.eq(amount);

            const delegation = await stakingQueryClient.staking.delegation(
                alice.seiAddress, validatorAddress1
            );
            expect(delegation.delegationResponse?.delegation.validatorAddress).to.eq(validatorAddress1);
            expect(Number(delegation.delegationResponse?.balance.amount)).to.be.gt(0);
        });

        it('Given that users have sufficient funds, they cant delegate to an invalid validator', async () => {
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

        it('Given that users have insufficient funds, the delegation to a validator fails', async () => {
            const hugeAmount = ethers.parseEther("1000000000");
            let error = null;
            try {
                await stakingContract.connect(bob.evmWallet.wallet)
                    .delegate(validatorAddress1, {value: hugeAmount});
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });

        it('Given that users have sufficient funds, users can stake into multiple validators', async () => {
            const amount = ethers.parseEther("0.02");
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress2, {value: amount});
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'Delegate';
                } catch (e) { return false; }
            });
            expect(log).to.not.be.undefined;
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(alice.evmAddress);
            expect(parsedLog?.args[1]).to.eq(validatorAddress2);
            expect(parsedLog?.args[2]).to.eq(amount);

            const delegation = await stakingQueryClient.staking.delegation(
                alice.seiAddress, validatorAddress2
            );
            expect(delegation.delegationResponse?.delegation.validatorAddress).to.eq(validatorAddress2);
            expect(delegation.delegationResponse?.delegation.delegatorAddress).to.eq(alice.seiAddress);
            expect(delegation.delegationResponse?.delegation.shares).to.eq((BigInt(amount) * BigInt(10 **6)).toString());
            expect(Number(delegation.delegationResponse?.balance.amount)).to.be.eq(20000);
        });

        it('Given that users have sufficient funds, users can stake into the same validator in multiple txs', async () =>{
            const amount = ethers.parseEther("0.02");
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .delegate(validatorAddress1, {value: amount});
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);
            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'Delegate';
                } catch (e) { return false; }
            });
            expect(log).to.not.be.undefined;
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(alice.evmAddress);
            expect(parsedLog?.args[1]).to.eq(validatorAddress1);
            expect(parsedLog?.args[2]).to.eq(amount);
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
        it('Given that users have delegations to validator1, they can redelegate validator2', async () => {
            const amount = '5000';
            const delegatedAmount = await stakingQueryClient.staking.delegation(alice.seiAddress, validatorAddress1);
            const delegation2 = await stakingContract.delegation(alice.evmAddress, validatorAddress1);
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .redelegate(validatorAddress1, validatorAddress2, amount);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'Redelegate';
                } catch (e) { return false; }
            });
            expect(log).to.not.be.undefined;
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(alice.evmAddress);
            expect(parsedLog?.args[1]).to.eq(validatorAddress1);
            expect(parsedLog?.args[2]).to.eq(validatorAddress2);
            expect(parsedLog?.args[3].toString()).to.eq(amount);

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

        it('Given that user has delegations, redelegations more than user staked amount fails', async () =>{
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
        it('User can undelegate successfully from validator2', async () => {
            const amount = '1000';
            const tx = await stakingContract.connect(alice.evmWallet.wallet)
                .undelegate(validatorAddress2, amount);
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'Undelegate';
                } catch (e) { return false; }
            });
            expect(log).to.not.be.undefined;
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(alice.evmAddress);
            expect(parsedLog?.args[1]).to.eq(validatorAddress2);
            expect(parsedLog?.args[2].toString()).to.eq(amount);

            const delegation = await stakingQueryClient.staking.unbondingDelegation(
                alice.seiAddress, validatorAddress2
            );
            expect(Number(delegation.unbond.entries[0].balance)).to.be.eq(Number(amount));
        });

        it('Given that users have undelegations, they cant undelegate from invalid validators', async () => {
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
                    "TestMoniker",
                    "0.10",
                    "0.20",
                    "0.05",
                    minSelfDelegation,
                    {value: ethers.parseEther('1'), gasLimit: 1000000},
                );
            const receipt = await tx.wait();
            expect(receipt.status).to.equal(1);

            // Verify ValidatorCreated event
            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'ValidatorCreated';
                } catch (e) { return false; }
            });
            const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
            const newValidator = findValidator(validators, operatorPubkey);
            operatorAddress = newValidator?.operatorAddress as string;
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(bob.evmAddress);
            expect(parsedLog?.args[1]).to.eq(operatorAddress);
            expect(parsedLog?.args[2]).to.eq("TestMoniker");


            expect(newValidator?.jailed).to.be.false;
            expect(newValidator?.status).to.be.eq(3);
            expect(newValidator?.tokens).to.be.eq('1000000');
            expect(newValidator?.description?.moniker).to.be.eq("TestMoniker");
            expect(newValidator?.commission.commissionRates.rate).to.be.eq((0.1 * 10 ** 18).toString());
            expect(newValidator?.commission.commissionRates.maxRate).to.be.eq((0.2 * 10 ** 18).toString());
            expect(newValidator?.commission.commissionRates.maxChangeRate).to.be.eq((0.05 * 10 ** 18).toString());
        });

        it('should fail with insufficient self delegation', async () => {
            const minSelfDelegation = ethers.parseEther("10");
            const seed = Buffer.alloc(32);
            const ed = require('ed25519-supercop');
            crypto.randomFillSync(seed);
            const kp = ed.createKeyPair(seed)
            const operatorPubkey = kp.publicKey.toString('hex');
            let error = null;
            try {
                const tx = await stakingContract.connect(bob.evmWallet.wallet)
                    .createValidator(
                        operatorPubkey,
                        "BadMoniker",
                        "0.1",
                        "0.2",
                        "0.05",
                        minSelfDelegation,
                        {value: ethers.parseEther("2"), gasLimit: 6000000}
                    );
                const receipt = await tx.wait();
                const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
                const newValidator = findValidator(validators, operatorPubkey);
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
                        {gasLimit: 6000000}
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
                    {gasLimit: 6000000}
                );
            const receipt = await tx.wait();

            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'ValidatorEdited';
                } catch (e) { return false; }
            });
            const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
            const newValidator = findValidator(validators, operatorPubkey);
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(bob.evmAddress);
            expect(parsedLog?.args[1]).to.eq(newValidator?.operatorAddress);
            expect(parsedLog?.args[2]).to.eq("MyMoniker2");


            expect(newValidator?.description?.moniker).to.be.eq("MyMoniker2");
            expect(newValidator?.commission.commissionRates.rate).to.be.eq((0.1 * 10 ** 18).toString());
            expect(newValidator?.jailed).to.be.false;
            expect(newValidator?.status).to.be.eq(3);
        });
        let operatorAddress: string;
        it('Can increase min self delegation', async () => {
            const minSelfDelegation = '200000';
            const tx = await stakingContract.connect(bob.evmWallet.wallet)
                .editValidator(
                    "MyMoniker2",
                    "",
                    minSelfDelegation,
                    {gasLimit: 6000000}
                );
            const receipt = await tx.wait();

            // Verify ValidatorEdited event
            const log = receipt.logs.find((l: any) => {
                try {
                    return stakingContract.interface.parseLog(l)?.name === 'ValidatorEdited';
                } catch (e) { return false; }
            });
            expect(log).to.not.be.undefined;
            const parsedLog = stakingContract.interface.parseLog(log!);
            expect(parsedLog?.args[0]).to.eq(bob.evmAddress);
            expect(parsedLog?.args[2]).to.eq("MyMoniker2");

            const validators = await stakingQueryClient.staking.validators('BOND_STATUS_BONDED');
            const newValidator = findValidator(validators, operatorPubkey);
            operatorAddress = newValidator?.operatorAddress as string;
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
                        {gasLimit: 6000000}
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
                const tx = await stakingContract.connect(bob.evmWallet.wallet)
                    .editValidator("MyMoniker3", "-0.01", ethers.parseEther("1"), {gasLimit: 6000000});
                const receipt = await tx.wait();
                console.log(receipt);
                const validator = await stakingContract.validator(operatorAddress);
                console.log(validator);
            } catch (err: any) {
                error = err;
            }
            expect(error).to.not.be.null;
        });
    });

    describe('delegation()', function () {
        it('should query delegation info (positive)', async () => {
            const result = await stakingContract.delegation(alice.evmAddress, validatorAddress1);
            const balance = result[0];
            const delegation = result[1];
            expect(delegation.validator_address).to.eq(validatorAddress1);
            expect(delegation.delegator_address).to.eq(alice.seiAddress);
            expect(Number(balance.amount)).to.be.eq(35000);
            expect(balance.denom).to.eq('usei');
            expect(delegation.shares.toString()).to.be.eq((BigInt(35000) * BigInt(10 ** 18)).toString());
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

    describe('View Functions', function () {
        it('validators() should return list of validators and match cosmos query', async () => {
            const status = "BOND_STATUS_BONDED";
            const evmResult = await stakingContract.validators(status, "0x");
            const cosmosResult = await stakingQueryClient.staking.validators(status);
            const validators = evmResult[0];

            expect(validators.length).to.be.gt(0);
            expect(validators.length).to.eq(cosmosResult.validators.length);

            for (const evmValRaw of validators) {
                const evmVal = parseValidator(evmValRaw);
                const cosmosVal = cosmosResult.validators.find((v: any) => v.operatorAddress === evmVal.operatorAddress);
                expect(cosmosVal).to.not.be.undefined;

                expect(evmVal.operatorAddress).to.eq(cosmosVal.operatorAddress);

                expect(evmVal.jailed).to.eq(cosmosVal.jailed);
                expect(Number(evmVal.status)).to.eq(cosmosVal.status);

                expect(evmVal.delegatorShares.toString().replace('.', '')).to.eq(cosmosVal.delegatorShares.toString().replace('.', ''));

                const descriptionStr = evmVal.description;
                const description: any = {};
                if (descriptionStr) {
                    descriptionStr.split('\n').forEach((line: string) => {
                        const [key, value] = line.split(': ');
                        if (key && value !== undefined) {
                            description[key.trim()] = value.replace(/"/g, '').trim();
                        }
                    });
                }
                expect(description.moniker).to.eq(cosmosVal.description?.moniker);
                expect(evmVal.minSelfDelegation).to.eq(cosmosVal.minSelfDelegation);
            }
        });

        it('validator() should return validator info', async () => {
            console.log(validatorAddress1);
            const result = await stakingContract.validator(validatorAddress1);
            // result is [validator] tuple
            console.log(result);
            const validatorInfo = parseValidator(result);
            expect(validatorInfo.operatorAddress).to.eq(validatorAddress1);

            const cosmosResponse = await stakingQueryClient.staking.validator(validatorAddress1);
            const cosmosVal = cosmosResponse.validator;

            expect(validatorInfo.operatorAddress).to.eq(cosmosVal?.operatorAddress);
        });

        it('delegatorDelegations() should return delegations', async () => {
            const result = await stakingContract.delegatorDelegations(alice.evmAddress, "0x");
            // result is [delegations, nextKey]
            const delegations = result[0];

            expect(delegations.length).to.be.gte(2);

            // Verify specific delegations
            // Delegation structure: [Balance, DelegationDetails]
            // Balance: [amount, denom]
            // DelegationDetails: [delegator, shares, decimals, validator]

            const del1 = delegations.find((d: any) => d[1][3] === validatorAddress1);
            expect(del1).to.not.be.undefined;
            expect(Number(del1[0][0])).to.eq(35000); // 40000 - 5000 redelegated
            expect(del1[0][1]).to.eq('usei');

            const del2 = delegations.find((d: any) => d[1][3] === validatorAddress2);
            expect(del2).to.not.be.undefined;
            // 20000 (initial) + 5000 (redelegated) - 1000 (undelegated) = 24000
            expect(Number(del2[0][0])).to.eq(24000);
        });

        it('delegatorValidators() should return validators for delegator', async () => {
            const result = await stakingContract.delegatorValidators(alice.evmAddress, "0x");
            const validators = result[0];

            expect(validators.length).to.be.gte(2);
            const valAddrs = validators.map((v: any) => v[0]); // operatorAddress at index 0
            expect(valAddrs).to.include(validatorAddress1);
            expect(valAddrs).to.include(validatorAddress2);
        });

        it('delegatorUnbondingDelegations() should return unbonding delegations', async () => {
            const result = await stakingContract.delegatorUnbondingDelegations(alice.evmAddress, "0x");
            const unbondingDelegationsRaw = result[0];

            if (unbondingDelegationsRaw.length > 0) {
                // Accessing the first unbonding delegation
                const unbond = parseUnbondingDelegation(unbondingDelegationsRaw[0]);

                // Verify delegator address
                expect(unbond.delegatorAddress).to.eq(alice.seiAddress);

                // Verify validator address matches one of our known validators
                expect([validatorAddress1, validatorAddress2]).to.include(unbond.validatorAddress);

                // Access entries
                expect(unbond.entries.length).to.be.gte(1);

                // Access first entry details
                const entry = unbond.entries[0];
                expect(Number(entry.balance)).to.be.eq(1000); // Exact match
            }
        });

        it('params() should return staking params', async () => {
            const result = await stakingContract.params();
            const params = parseParams(result);
            expect(params.bondDenom).to.eq('usei');
        });

        it('pool() should return staking pool info', async () => {
            const result = await stakingContract.pool();
            const pool = parsePool(result);
            expect(Number(pool.bondedTokens)).to.be.gt(0);
        });

        it('redelegations() should return redelegations', async () => {
            const result = await stakingContract.redelegations(alice.seiAddress, validatorAddress1, validatorAddress2, "0x");
            const redelegationsRaw = result[0];
            expect(redelegationsRaw.length).to.be.gte(1);

            const redelegation = parseRedelegation(redelegationsRaw[0]);
            expect(redelegation.delegatorAddress).to.eq(alice.seiAddress);
            expect(redelegation.validatorSrcAddress).to.eq(validatorAddress1);
            expect(redelegation.validatorDstAddress).to.eq(validatorAddress2);

            expect(redelegation.entries.length).to.be.gte(1);
            // Verify entry details for the 5000 redelegation
            const entry = redelegation.entries[0];
            // initialBalance should be 5000
            console.log(entry);
            expect(Number(entry.initialBalance)).to.eq(5000);
            expect(entry.sharesDst).to.eq((BigInt(5000)).toString());
            expect(Number(entry.creationHeight)).to.be.gt(0);
            expect(Number(entry.completionTime)).to.be.gt(0);
        });

        it('unbondingDelegation() should return specific unbonding delegation', async () => {
            const result = await stakingContract.unbondingDelegation(alice.evmAddress, validatorAddress2);
            console.log(result);
            const unbondingDelegation = parseUnbondingDelegation(result);
            if (unbondingDelegation && unbondingDelegation.entries) {
                expect(unbondingDelegation.entries.length).to.be.gte(1);
                const entry = unbondingDelegation.entries[0];
                expect(Number(entry.balance)).to.be.eq(1000);
                expect(Number(entry.initialBalance)).to.be.gte(Number(entry.balance));
                expect(Number(entry.creationHeight)).to.be.gt(0);
                expect(Number(entry.completionTime)).to.be.gt(0);
            }
        });

         it('validatorDelegations() should return delegations to a validator', async () => {
            const result = await stakingContract.validatorDelegations(validatorAddress1, "0x");
            const delegations = result[0];

            expect(delegations.length).to.be.gte(1);

            // Find Alice's delegation
            // Delegation structure: [Balance, DelegationDetails]
            // DelegationDetails: [delegator, shares, decimals, validator]
            const aliceDelegation = delegations.find((d: any) => d[1][0] === alice.seiAddress);
            console.log(aliceDelegation);
            expect(aliceDelegation).to.not.be.undefined;

            // Should be 35000
            expect(Number(aliceDelegation[0][0])).to.eq(35000);
        });

         it('validatorUnbondingDelegations() should return unbonding delegations from a validator', async () => {
            const result = await stakingContract.validatorUnbondingDelegations(validatorAddress2, "0x");
            const unbondingDelegationsRaw = result[0];

            expect(unbondingDelegationsRaw.length).to.be.gte(1);

            // Find Alice's unbonding
            // UnbondingDelegation: [delegator, validator, entries]
            const aliceUnbond = unbondingDelegationsRaw.find((u: any) => u[0] === alice.seiAddress);
            expect(aliceUnbond).to.not.be.undefined;

            const unbond = parseUnbondingDelegation(aliceUnbond);
            expect(unbond.validatorAddress).to.eq(validatorAddress2);
            expect(unbond.entries.length).to.be.gte(1);
            expect(Number(unbond.entries[0].balance)).to.eq(1000);
        });
    });
});
