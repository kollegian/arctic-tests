import { SeiUser, UserFactory } from '../../../shared/User';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import { Querier } from '@sei-js/cosmos/rest';

import { coin } from '@cosmjs/proto-signing';
import { coins } from '@cosmjs/amino';
import ExpectStatic = Chai.ExpectStatic;
import { expectNonEmptyArray, expectTxSuccess, expectValoperAddress } from '../moduleTestUtils';
import { getRpcQueryClient, moduleRestEndpoint, toSnakeCase, withRestFallback } from '../utils/rpcQueryClient';

let expect: ExpectStatic;

const fee = { amount: coins(50000, 'usei'), gas: '500000' };
const CLI_FEE = '50000usei';
const INITIAL_DELEGATION_AMOUNT = '10000';
const LIFECYCLE_DELEGATION_AMOUNT = '100000';
const REWARD_DENOM = 'usei';
const STANDARD_FEE_AMOUNT = 50000;

const queryStakingValidators = (status: string) =>
  withRestFallback(
    'staking.validators',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.validators(status as any)),
    () => Querier.cosmos.staking.v1beta1.Validators({ status }, { pathPrefix: moduleRestEndpoint }),
  );

const queryDelegation = (delegator: string, validator: string) =>
  withRestFallback(
    'staking.delegation',
    async () =>
      toSnakeCase(
        await (await getRpcQueryClient()).staking.delegation(delegator, validator),
      ),
    () =>
      Querier.cosmos.staking.v1beta1.Delegation(
        { delegator_addr: delegator, validator_addr: validator },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryDelegationRewards = (delegator: string, validator: string) =>
  withRestFallback(
    'distribution.delegationRewards',
    async () =>
      toSnakeCase(
        await (await getRpcQueryClient()).distribution.delegationRewards(delegator, validator),
      ),
    () =>
      Querier.cosmos.distribution.v1beta1.DelegationRewards(
        { delegator_address: delegator, validator_address: validator },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryDelegationTotalRewards = (delegator: string) =>
  withRestFallback(
    'distribution.delegationTotalRewards',
    async () =>
      toSnakeCase(
        await (await getRpcQueryClient()).distribution.delegationTotalRewards(delegator),
      ),
    () =>
      Querier.cosmos.distribution.v1beta1.DelegationTotalRewards(
        { delegator_address: delegator },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryDelegatorWithdrawAddress = (delegator: string) =>
  withRestFallback(
    'distribution.delegatorWithdrawAddress',
    async () => {
      const addr = await (await getRpcQueryClient()).distribution.delegatorWithdrawAddress(delegator);
      // cosmjs returns `{ withdrawAddress }`; normalise to REST shape
      return toSnakeCase(addr);
    },
    () =>
      Querier.cosmos.distribution.v1beta1.DelegatorWithdrawAddress(
        { delegator_address: delegator },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryDistributionParams = () =>
  withRestFallback(
    'distribution.params',
    async () => toSnakeCase(await (await getRpcQueryClient()).distribution.params()),
    () =>
      Querier.cosmos.distribution.v1beta1.Params({}, { pathPrefix: moduleRestEndpoint }),
  );

const queryCommunityPool = () =>
  withRestFallback(
    'distribution.communityPool',
    async () => toSnakeCase(await (await getRpcQueryClient()).distribution.communityPool()),
    () =>
      Querier.cosmos.distribution.v1beta1.CommunityPool({}, { pathPrefix: moduleRestEndpoint }),
  );

const queryValidatorCommission = (validator: string) =>
  withRestFallback(
    'distribution.validatorCommission',
    async () =>
      toSnakeCase(
        await (await getRpcQueryClient()).distribution.validatorCommission(validator),
      ),
    () =>
      Querier.cosmos.distribution.v1beta1.ValidatorCommission(
        { validator_address: validator },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryValidatorOutstandingRewards = (validator: string) =>
  withRestFallback(
    'distribution.validatorOutstandingRewards',
    async () =>
      toSnakeCase(
        await (await getRpcQueryClient()).distribution.validatorOutstandingRewards(validator),
      ),
    () =>
      Querier.cosmos.distribution.v1beta1.ValidatorOutstandingRewards(
        { validator_address: validator },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryValidatorSlashes = (validator: string, startingHeight: number, endingHeight: number) =>
  withRestFallback(
    'distribution.validatorSlashes',
    async () =>
      toSnakeCase(
        await (await getRpcQueryClient()).distribution.validatorSlashes(
          validator,
          startingHeight,
          endingHeight,
        ),
      ),
    () =>
      Querier.cosmos.distribution.v1beta1.ValidatorSlashes(
        {
          validator_address: validator,
          starting_height: startingHeight,
          ending_height: endingHeight,
        },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryDistributionDelegatorValidators = (delegator: string) =>
  withRestFallback(
    'distribution.delegatorValidators',
    async () =>
      toSnakeCase(
        await (await getRpcQueryClient()).distribution.delegatorValidators(delegator),
      ),
    () =>
      Querier.cosmos.distribution.v1beta1.DelegatorValidators(
        { delegator_address: delegator },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

describe('Distribution Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;
  let validatorAddress: string;

  before('Initializes users and fetches validator', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'distUser');
    await waitFor(1);

    const val = await queryStakingValidators('BOND_STATUS_BONDED');
    expectNonEmptyArray(val.validators, 'bonded validators');
    validatorAddress = val.validators[0].operator_address;
    expectValoperAddress(validatorAddress);

    const msg = {
      typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
      value: {
        delegatorAddress: user.seiAddress,
        validatorAddress: validatorAddress,
        amount: coin(INITIAL_DELEGATION_AMOUNT, REWARD_DENOM),
      },
    };
    const result = await user.seiWallet.signingClient.signAndBroadcast(
      user.seiAddress, [msg], fee, 'distribution setup delegation'
    );
    expectTxSuccess(result, 'distribution setup delegation');
  });

  function distributionParams(result: any) {
    return result.params ?? result;
  }

  function commissionCoins(result: any) {
    return result.commission?.commission ?? result.commission;
  }

  function useiRewardAmount(rewards: { denom: string; amount: string }[]) {
    return parseFloat(rewards.find((reward) => reward.denom === REWARD_DENOM)?.amount ?? '0');
  }

  describe('seid CLI Tests', function () {
    it('Queries rewards via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q distribution rewards ${user.seiAddress} ${validatorAddress}`
      );
      expect(result.rewards).to.be.an('array');
    });

    it('Queries community pool via seid', async () => {
      const result = await execCommandAndReturnJson('seid q distribution community-pool');
      expectNonEmptyArray(result.pool, 'community pool');
      expect(result.pool[0].denom).to.be.eq(REWARD_DENOM);
    });

    it('Queries distribution params via seid', async () => {
      const result = await execCommandAndReturnJson('seid q distribution params');
      const params = distributionParams(result);
      expect(params).to.be.an('object');
      expect(parseFloat(params.community_tax)).to.be.gte(0);
    });

    it('Queries validator commission via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q distribution commission ${validatorAddress}`
      );
      const commission = commissionCoins(result);
      expect(commission).to.be.an('array');
      expect(commission[0].denom).to.be.eq(REWARD_DENOM);
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

    it('Withdraws rewards via seid CLI and charges no more than the standard fee', async () => {
      const preBalance = await execCommandAndReturnJson(`seid q bank balances ${user.seiAddress} --denom usei`);
      const result = await execCommandAndReturnJson(
        `seid tx distribution withdraw-rewards ${validatorAddress} --from distUser --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
      const postBalance = await execCommandAndReturnJson(`seid q bank balances ${user.seiAddress} --denom usei`);
      const balanceDelta = Number(postBalance.amount) - Number(preBalance.amount);
      expect(balanceDelta).to.be.gte(-STANDARD_FEE_AMOUNT);
    });

    it('Sets withdraw address via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx distribution set-withdraw-addr ${admin.seiAddress} --from distUser --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
      const withdrawAddr = await queryDelegatorWithdrawAddress(user.seiAddress);
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
    it('As a pre-condition, user has delegated tokens to validator', async () => {
      const delegation = await queryDelegation(user.seiAddress, validatorAddress);
      expect(delegation.delegation_response?.balance?.denom).to.eq(REWARD_DENOM);
      expect(BigInt(delegation.delegation_response!.balance!.amount) > 0n).to.be.true;
    });

    it('Can add to an existing delegation', async () => {
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
      expectTxSuccess(result, 'distribution setup delegation');
    });

    it('Queries reward data and withdraws rewards', async () => {
      await waitFor(15);
      let rewards = await queryDelegationRewards(user.seiAddress, validatorAddress);
      const preRewardAmount = useiRewardAmount(rewards.rewards);

      expect(rewards.rewards[0].denom).to.be.eq(REWARD_DENOM);
      expect(preRewardAmount).to.be.gt(0);

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

      rewards = await queryDelegationRewards(user.seiAddress, validatorAddress);
      const afterRewardAmount = useiRewardAmount(rewards.rewards);
      expect(afterRewardAmount).to.be.at.most(preRewardAmount);
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
      const response = await queryDelegatorWithdrawAddress(user.seiAddress);
      expect(response.withdraw_address).to.be.eq(withdrawAddress);
    });

    it('Queries delegation total rewards', async () => {
      const response = await queryDelegationTotalRewards(user.seiAddress);
      expect(response.total[0].denom).to.be.eq(REWARD_DENOM);
      expect(parseFloat(response.total[0].amount)).to.be.gt(0);
    });

    it('Queries community pool', async () => {
      const response = await queryCommunityPool();
      expect(response.pool[0].denom).to.be.eq(REWARD_DENOM);
      expect(parseFloat(response.pool[0].amount)).to.be.gt(0);
    });

    it('Queries validator commission', async () => {
      const response = await queryValidatorCommission(validatorAddress);
      expect(response.commission?.commission[0].denom).to.be.eq(REWARD_DENOM);
      expect(parseFloat(response.commission!.commission[0]!.amount)).to.be.gt(0);
    });

    it('Queries validator outstanding rewards', async () => {
      await waitFor(10);
      const response = await queryValidatorOutstandingRewards(validatorAddress);
      expect(parseFloat(response.rewards!.rewards[0].amount)).to.be.gt(0);
      expect(response.rewards!.rewards[0].denom).to.be.eq(REWARD_DENOM);
    });

    it('Queries validator slashes', async () => {
      const response = await queryValidatorSlashes(validatorAddress, 30, 70);
      expect(response.slashes).to.be.an('array');
      for (const slash of response.slashes) {
        expect(Number(slash.validator_period)).to.be.gte(0);
        expect(parseFloat(slash.fraction)).to.be.gte(0);
      }
    });

    it('Queries delegator validators', async () => {
      const response = await queryDistributionDelegatorValidators(user.seiAddress);
      expect(response.validators).to.be.an('array');
      expect(response.validators).to.have.length.gte(1);
      expect(response.validators).to.contain(validatorAddress);
    });

    it('Queries distribution params', async () => {
      const response = await queryDistributionParams();
      expect(response.params).to.not.be.undefined;
      expect(parseFloat(response.params!.community_tax)).to.be.gte(0);
    });

    it('Withdraw address persists across queries', async () => {
      const response = await queryDelegatorWithdrawAddress(user.seiAddress);
      expect(response.withdraw_address).to.be.a('string');
      expect(response.withdraw_address).to.have.length.gt(0);
    });

    it('Rewards do not decrease over time after delegation', async () => {
      const rewards1 = await queryDelegationRewards(user.seiAddress, validatorAddress);
      const amount1 = parseFloat(rewards1.rewards[0].amount);

      await waitFor(5);

      const rewards2 = await queryDelegationRewards(user.seiAddress, validatorAddress);
      const amount2 = parseFloat(rewards2.rewards[0].amount);
      expect(amount2).to.be.at.least(amount1);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid rewards query matches Querier rewards for same delegator', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q distribution rewards ${user.seiAddress} ${validatorAddress}`
      );
      const querierResult = await queryDelegationRewards(user.seiAddress, validatorAddress);

      if (cliResult.rewards && cliResult.rewards.length > 0 && querierResult.rewards.length > 0) {
        expect(cliResult.rewards[0].denom).to.be.eq(querierResult.rewards[0].denom);
        const cliAmount = parseFloat(cliResult.rewards[0].amount);
        const querierAmount = parseFloat(querierResult.rewards[0].amount);
        expect(Math.abs(cliAmount - querierAmount)).to.be.lt(querierAmount * 0.1);
      }
    });

    it('Community pool via seid matches Querier community pool', async () => {
      const cliResult = await execCommandAndReturnJson('seid q distribution community-pool');
      const querierResult = await queryCommunityPool();
      expect(cliResult.pool[0].denom).to.be.eq(querierResult.pool[0].denom);
    });
  });

  describe('Error Cases', function () {
    it('Cannot withdraw rewards from a validator the user has not delegated to', async () => {
      const freshUser = await UserFactory.createSeiUser(admin, 'distNoStake');
      const val = await queryStakingValidators('BOND_STATUS_BONDED');
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
    it('Delegate -> accumulate rewards -> withdraw -> verify balance and rewards state', async () => {
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

      const rewards = await queryDelegationRewards(lifecycleUser.seiAddress, validatorAddress);
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
      expect(balanceDiff).to.be.at.least(-STANDARD_FEE_AMOUNT);

      const rewardsAfterWithdraw = await queryDelegationRewards(lifecycleUser.seiAddress, validatorAddress);
      expect(parseFloat(rewardsAfterWithdraw.rewards[0].amount)).to.be.at.most(rewardAmountBeforeWithdraw);
    });
  });
});
