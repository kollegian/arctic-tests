import { Contract, ethers } from "ethers";
import { expect } from "chai";
import { QueryClient, StakingExtension, setupStakingExtension } from "@cosmjs/stargate";
import {SeiUser, UserFactory} from "../../shared/User";
import distrAbi from "./abis/distr_abi.json";
import stakingAbi from "./abis/staking_abi.json";
import {returnQueryClient} from "./utils";

const STAKING_ADDRESS = "0x0000000000000000000000000000000000001005";
const DISTR_ADDRESS = "0x0000000000000000000000000000000000001007";

describe('Distribution Precompile Tests', function () {
    this.timeout(3 * 60 * 1000);
    let admin: SeiUser;
    let alice: SeiUser;
    let distrContract: Contract;
    let stakingQueryClient: QueryClient & StakingExtension;
    let validatorAddress1: string;
    let validatorAddress2: string;
    let stakingContract: Contract;
    before('Initialize clients, users and staking query client', async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        ([alice] = await UserFactory.createSeiUsers(admin, 1));

        distrContract = new Contract(DISTR_ADDRESS, distrAbi, admin.evmWallet.wallet);
        stakingContract = new Contract(STAKING_ADDRESS, stakingAbi, admin.evmWallet.wallet);

        stakingQueryClient = await returnQueryClient(setupStakingExtension) as QueryClient & StakingExtension;

        const validatorsResponse = await stakingQueryClient.staking.validators("BOND_STATUS_BONDED");
        if (validatorsResponse.validators.length < 2) {
            throw new Error("At least two validators are required for these tests");
        }
        validatorAddress1 = validatorsResponse.validators[0].operatorAddress;
        validatorAddress2 = validatorsResponse.validators[1].operatorAddress;
        const stakeAmount = ethers.parseEther("0.01");

        const delegateTx = await stakingContract.connect(alice.evmWallet.wallet)
            .delegate(validatorAddress1, { value: stakeAmount });
        const delegateReceipt = await delegateTx.wait();
        expect(delegateReceipt.status).to.equal(1);

        const delegateTx2 = await stakingContract.connect(alice.evmWallet.wallet)
            .delegate(validatorAddress2, { value: stakeAmount });
        const delegateReceipt2 = await delegateTx2.wait();
        expect(delegateReceipt2.status).to.equal(1);
        await waitFor(5);
    });

    it('should set the withdraw address', async () => {
        const adminPreBalance = await admin.evmWallet.queryBalance();
        const tx = await distrContract.connect(alice.evmWallet.wallet)
            .setWithdrawAddress(admin.evmAddress);
        const receipt = await tx.wait();
        expect(receipt.status).to.equal(1);
        const adminAfterBalance = await admin.evmWallet.queryBalance();
    });

    it('should withdraw delegation rewards for a single validator', async () => {
        const tx = await distrContract.connect(alice.evmWallet.wallet)
            .withdrawDelegationRewards(validatorAddress1);
        const receipt = await tx.wait();
        expect(receipt.status).to.equal(1);
    });

    it('should withdraw delegation rewards for multiple validators', async () => {
        const validators = [validatorAddress1, validatorAddress2];
        const tx = await distrContract.connect(alice.evmWallet.wallet)
            .withdrawMultipleDelegationRewards(validators);
        const receipt = await tx.wait();
        expect(receipt.status).to.equal(1);
    });

    it('should query rewards for a delegator', async () => {
        const rewards = await distrContract.rewards(alice.evmAddress);
        expect(rewards.length).to.be.eq(2);
    });
});
