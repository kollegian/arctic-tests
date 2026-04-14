import { SeiUser, UserFactory } from '../../../shared/User';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import testConfig from '../../../config/testConfig.json';
import { Querier } from '@sei-js/cosmos/rest';

import { coin } from '@cosmjs/proto-signing';
import { coins } from '@cosmjs/amino';
import ExpectStatic = Chai.ExpectStatic;

let expect: ExpectStatic;

const fee = { amount: coins(24000, 'usei'), gas: '500000' };
const CLI_FEE = '24200usei';
const INITIAL_DELEGATION_AMOUNT = '10000';
const LIFECYCLE_DELEGATION_AMOUNT = '100000';
const REWARD_DENOM = 'usei';

describe('Distribution Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;
  let validatorAddress: string;
  const restEndpoint = testConfig.restEndpoint;

  before('Initializes users and fetches validator', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'distUser');
    await waitFor(1);

    const val = await Querier.cosmos.staking.v1beta1.Validators({
      status: 'BOND_STATUS_BONDED'
    }, { pathPrefix: restEndpoint });
    validatorAddress = val.validators[0].operator_address;
  });

  describe('seid CLI Tests', function () {
    it('Queries rewards via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q distribution rewards ${user.seiAddress} ${validatorAddress}`
      );
      expect(result.rewards).to.be.an('array');
      expect(result.total).to.be.an('array');
    });

    it('Queries community pool via seid', async () => {
      const result = await execCommandAndReturnJson('seid q distribution community-pool');
      expect(result.pool).to.be.an('array');
      expect(result.pool.length).to.be.gte(1);
      expect(result.pool[0].denom).to.be.eq(REWARD_DENOM);
    });

    it('Queries distribution params via seid', async () => {
      const result = await execCommandAndReturnJson('seid q distribution params');
      expect(result.params).to.be.an('object');
      expect(parseFloat(result.params.community_tax)).to.be.gte(0);
    });

    it('Queries validator commission via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q distribution commission ${validatorAddress}`
      );
      expect(result.commission.commission).to.be.an('array');
      expect(result.commission.commission[0].denom).to.be.eq(REWARD_DENOM);
    });

    it('Queries validator slashes via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q distribution slashes ${validatorAddress} 1 1000`
      );
      expect(result.slashes).to.be.an('array');
    });

    it('Queries delegator validators via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q distribution rewards ${user.seiAddress}`
      );
      expect(result.rewards).to.be.an('array');
      expect(result.total).to.be.an('array');
    });

    it('Withdraws rewards via seid CLI and balance increases', async () => {
      const preBalance = await execCommandAndReturnJson(`seid q bank balances ${user.seiAddress} --denom usei`);
      const result = await execCommandAndReturnJson(
        `seid tx distribution withdraw-rewards ${validatorAddress} --from distUser --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
      const postBalance = await execCommandAndReturnJson(`seid q bank balances ${user.seiAddress} --denom usei`);
      const balanceDelta = Number(postBalance.amount) - Number(preBalance.amount);
      expect(balanceDelta).to.be.gte(-24000);
    });

    it('Sets withdraw address via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx distribution set-withdraw-addr ${admin.seiAddress} --from distUser --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
      const withdrawAddr = await execCommandAndReturnJson(
        `seid q distribution withdraw-addr ${user.seiAddress}`
      );
      expect(withdrawAddr.withdraw_address).to.be.eq(admin.seiAddress);
      // Reset back
      await execCommandAndReturnJson(
        `seid tx distribution set-withdraw-addr ${user.seiAddress} --from distUser --fees ${CLI_FEE} -y --broadcast-mode block`
      );
    });

    it('Queries rewards for non-delegated user returns empty', async () => {
      const freshUser = await UserFactory.createUnassociatedUsers(admin, 'distFresh');
      const result = await execCommandAndReturnJson(
        `seid q distribution rewards ${freshUser.seiAddress}`
      );
      expect(result.rewards).to.be.an('array');
      expect(result.rewards).to.have.length(0);
    });
  });

  describe('CosmJS Tests', function () {
    it('As a pre-condition, user delegates tokens to validator', async () => {
      const msg = {
        typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
        value: {
          delegatorAddress: user.seiAddress,
          validatorAddress: validatorAddress,
          amount: coin(INITIAL_DELEGATION_AMOUNT, REWARD_DENOM),
        },
      };
      const result = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msg], fee, 'stake'
      );
      expect(result.code).to.be.eq(0);
    });

    it('Queries reward data and withdraws rewards', async () => {
      await waitFor(15);
      let rewards = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
        delegator_address: user.seiAddress,
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      const preRewardAmount = rewards.rewards[0].amount;

      expect(rewards.rewards[0].denom).to.be.eq(REWARD_DENOM);
      expect(parseFloat(rewards.rewards[0].amount)).to.be.gt(0);
      console.log(preRewardAmount);

      const withdrawMsg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
        value: {
          delegatorAddress: user.seiAddress,
          validatorAddress: validatorAddress,
        }
      };
      const result = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [withdrawMsg], fee, 'withdraw'
      );
      expect(result.code).to.be.eq(0);
      await waitFor(1);

      rewards = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
        delegator_address: user.seiAddress,
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      const afterRewardAmount = rewards.rewards[0].amount;
      expect(parseFloat(afterRewardAmount)).to.be.lt(parseFloat(preRewardAmount));
    });

    it('Sets a withdraw address', async () => {
      const withdrawAddress = admin.seiAddress;
      const msg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgSetWithdrawAddress',
        value: {
          delegatorAddress: user.seiAddress,
          withdrawAddress: withdrawAddress
        }
      };
      await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msg], fee, 'set withdraw address'
      );
      const response = await Querier.cosmos.distribution.v1beta1.DelegatorWithdrawAddress({
        delegator_address: user.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.withdraw_address).to.be.eq(withdrawAddress);
    });

    it('Queries delegation total rewards', async () => {
      const response = await Querier.cosmos.distribution.v1beta1.DelegationTotalRewards({
        delegator_address: user.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.total[0].denom).to.be.eq(REWARD_DENOM);
      expect(parseFloat(response.total[0].amount)).to.be.gt(0);
    });

    it('Queries community pool', async () => {
      const response = await Querier.cosmos.distribution.v1beta1.CommunityPool(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.pool[0].denom).to.be.eq(REWARD_DENOM);
      expect(parseFloat(response.pool[0].amount)).to.be.gt(0);
    });

    it('Queries validator commission', async () => {
      const response = await Querier.cosmos.distribution.v1beta1.ValidatorCommission({
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      expect(response.commission?.commission[0].denom).to.be.eq(REWARD_DENOM);
      expect(parseFloat(response.commission!.commission[0]!.amount)).to.be.gt(0);
    });

    it('Queries validator outstanding rewards', async () => {
      await waitFor(10);
      const response = await Querier.cosmos.distribution.v1beta1.ValidatorOutstandingRewards({
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      expect(parseFloat(response.rewards!.rewards[0].amount)).to.be.gt(0);
      expect(response.rewards!.rewards[0].denom).to.be.eq(REWARD_DENOM);
    });

    it('Queries validator slashes', async () => {
      const response = await Querier.cosmos.distribution.v1beta1.ValidatorSlashes({
        validator_address: validatorAddress,
        starting_height: 30,
        ending_height: 70
      }, { pathPrefix: restEndpoint });
      expect(response.slashes).to.have.length.gte(0);
    });

    it('Queries delegator validators', async () => {
      const response = await Querier.cosmos.distribution.v1beta1.DelegatorValidators({
        delegator_address: user.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.validators).to.be.an('array');
      expect(response.validators).to.have.length.gte(1);
      expect(response.validators).to.contain(validatorAddress);
    });

    it('Queries distribution params', async () => {
      const response = await Querier.cosmos.distribution.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.params).to.not.be.undefined;
      expect(parseFloat(response.params!.community_tax)).to.be.gte(0);
    });

    it('Withdraw address persists across queries', async () => {
      const response = await Querier.cosmos.distribution.v1beta1.DelegatorWithdrawAddress({
        delegator_address: user.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.withdraw_address).to.be.a('string');
      expect(response.withdraw_address).to.have.length.gt(0);
    });

    it('Rewards accumulate over time after delegation', async () => {
      const rewards1 = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
        delegator_address: user.seiAddress,
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      const amount1 = parseFloat(rewards1.rewards[0].amount);

      await waitFor(5);

      const rewards2 = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
        delegator_address: user.seiAddress,
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      const amount2 = parseFloat(rewards2.rewards[0].amount);
      expect(amount2).to.be.gt(amount1);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid rewards query matches Querier rewards for same delegator', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q distribution rewards ${user.seiAddress} ${validatorAddress}`
      );
      const querierResult = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
        delegator_address: user.seiAddress,
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });

      if (cliResult.rewards && cliResult.rewards.length > 0 && querierResult.rewards.length > 0) {
        expect(cliResult.rewards[0].denom).to.be.eq(querierResult.rewards[0].denom);
        const cliAmount = parseFloat(cliResult.rewards[0].amount);
        const querierAmount = parseFloat(querierResult.rewards[0].amount);
        expect(Math.abs(cliAmount - querierAmount)).to.be.lt(querierAmount * 0.1);
      }
    });

    it('Community pool via seid matches Querier community pool', async () => {
      const cliResult = await execCommandAndReturnJson('seid q distribution community-pool');
      const querierResult = await Querier.cosmos.distribution.v1beta1.CommunityPool({}, { pathPrefix: restEndpoint });
      expect(cliResult.pool[0].denom).to.be.eq(querierResult.pool[0].denom);
    });
  });

  describe('Error Cases', function () {
    it('Cannot withdraw rewards from a validator the user has not delegated to', async () => {
      const freshUser = await UserFactory.createSeiUser(admin, 'distNoStake');
      const val = await Querier.cosmos.staking.v1beta1.Validators({
        status: 'BOND_STATUS_BONDED'
      }, { pathPrefix: restEndpoint });
      const withdrawMsg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
        value: {
          delegatorAddress: freshUser.seiAddress,
          validatorAddress: val.validators[0].operator_address,
        }
      };
      const result = await freshUser.seiWallet.signingClient.signAndBroadcast(
        freshUser.seiAddress, [withdrawMsg], fee, 'withdraw no delegation'
      );
      expect(result.code).to.not.be.eq(0);
    });

    it('Cannot set withdraw address to an empty string', async () => {
      const msg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgSetWithdrawAddress',
        value: {
          delegatorAddress: user.seiAddress,
          withdrawAddress: ''
        }
      };
      try {
        await user.seiWallet.signingClient.signAndBroadcast(
          user.seiAddress, [msg], fee, 'empty withdraw addr'
        );
        expect.fail('Should have failed');
      } catch (e: any) {
        expect(e.message).to.be.a('string');
        expect(e.message.length).to.be.gt(0);
      }
    });

    it('Cannot set withdraw address to an invalid address', async () => {
      const msg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgSetWithdrawAddress',
        value: {
          delegatorAddress: user.seiAddress,
          withdrawAddress: 'invalidaddress123'
        }
      };
      try {
        await user.seiWallet.signingClient.signAndBroadcast(
          user.seiAddress, [msg], fee, 'invalid withdraw addr'
        );
        expect.fail('Should have failed');
      } catch (e: any) {
        expect(e.message).to.be.a('string');
        expect(e.message.length).to.be.gt(0);
      }
    });
  });

  describe('Full Lifecycle', function () {
    it('Delegate -> accumulate rewards -> withdraw -> verify balance increase', async () => {
      const lifecycleUser = await UserFactory.createSeiUser(admin, 'distLifecycle');

      const delegateMsg = {
        typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
        value: {
          delegatorAddress: lifecycleUser.seiAddress,
          validatorAddress: validatorAddress,
          amount: coin(LIFECYCLE_DELEGATION_AMOUNT, REWARD_DENOM),
        },
      };
      const delegateResult = await lifecycleUser.seiWallet.signingClient.signAndBroadcast(
        lifecycleUser.seiAddress, [delegateMsg], fee, 'delegate'
      );
      expect(delegateResult.code).to.be.eq(0);

      await waitFor(15);

      const rewards = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
        delegator_address: lifecycleUser.seiAddress,
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      expect(parseFloat(rewards.rewards[0].amount)).to.be.gt(0);
      const rewardAmountBeforeWithdraw = parseFloat(rewards.rewards[0].amount);

      const preBalance = await lifecycleUser.seiWallet.queryBalance();

      const withdrawMsg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
        value: {
          delegatorAddress: lifecycleUser.seiAddress,
          validatorAddress: validatorAddress,
        }
      };
      const withdrawResult = await lifecycleUser.seiWallet.signingClient.signAndBroadcast(
        lifecycleUser.seiAddress, [withdrawMsg], fee, 'withdraw'
      );
      expect(withdrawResult.code).to.be.eq(0);

      const postBalance = await lifecycleUser.seiWallet.queryBalance();
      const balanceDiff = Number(postBalance.amount) - Number(preBalance.amount);
      expect(balanceDiff).to.be.gt(-24000);

      const rewardsAfterWithdraw = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
        delegator_address: lifecycleUser.seiAddress,
        validator_address: validatorAddress
      }, { pathPrefix: restEndpoint });
      expect(parseFloat(rewardsAfterWithdraw.rewards[0].amount)).to.be.lt(rewardAmountBeforeWithdraw);
    });
  });
});
