import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import { SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {createSeiProvider} from '../utils/utils';
import {restEndpoint, rpcEndpoint} from '../constants';
import {fee} from '../tokenfactory/types';
import { Querier } from '@sei-js/cosmos/rest';
import { Encoder } from '@sei-js/cosmos/encoding';
import { coin } from '@cosmjs/proto-signing';
import ExpectStatic = Chai.ExpectStatic;
import {after} from 'mocha';
let expect: ExpectStatic;

describe('Distribution Tests', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let seiAddress: string;
  let validatorAddress: string;
  let sClient: SigningStargateClient;

  before('', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    seiWallet = await generateValidAddress();
    await waitFor(1);
    console.log(seiWallet.mnemonic);
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingClient = await createSeiProvider(rpcEndpoint, seiWallet);
    sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet);
    const val = await Querier.cosmos.staking.v1beta1.Validators({
      status: 'BOND_STATUS_BONDED'
    }, {
      pathPrefix: restEndpoint
    })
    validatorAddress = val.validators[0].operator_address;
  })

  it('As a pre condition user delegates tokens to validator', async () => {
    const msg = {
      typeUrl: `/${Encoder.cosmos.staking.v1beta1.MsgDelegate.$type}`,
      value: Encoder.cosmos.staking.v1beta1.MsgDelegate.fromPartial({
        delegator_address: seiAddress,
        validator_address: validatorAddress,
        amount: coin('10000', 'usei'),
      }),
    }
    const result = await signingClient.signAndBroadcast(seiAddress, [msg], fee, "stake");
    console.log(result.rawLog);
  });

  it('Queries reward data', async () =>{
    await waitFor(120);
    let rewards = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
      delegator_address: seiAddress,
      validator_address: validatorAddress
    }, {pathPrefix: restEndpoint});
    const preRewardAmount = rewards.rewards[0].amount;

    expect(rewards.rewards[0].denom).to.be.eq('usei');
    expect(parseFloat(rewards.rewards[0].amount)).to.be.gt(0);
    console.log(preRewardAmount);

    const sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet);
    const msgg = {
      typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
      value: {
        delegatorAddress: seiAddress,
        validatorAddress: validatorAddress,
      }
    }
    const result = await sClient.signAndBroadcast(seiAddress, [msgg], fee, 'withdraw');
    expect(result.code).to.be.eq(0);
    await waitFor(1);
    // const result = await signingClient.signAndBroadcast(seiAddress, [msg], fee, "withdraw");
    rewards = await Querier.cosmos.distribution.v1beta1.DelegationRewards({
      delegator_address: seiAddress,
      validator_address: validatorAddress
    }, {pathPrefix: restEndpoint});
    const afterRewardAmount = rewards.rewards[0].amount;
    expect(parseFloat(afterRewardAmount)).to.be.lt(parseFloat(preRewardAmount));
  });

  it('sets a withdraw address', async () =>{
    const withAddress = 'sei19907knyd83jregfjh0v2knwfls22k2mamhxdnn';
    const msg = {
      typeUrl: `/cosmos.distribution.v1beta1.MsgSetWithdrawAddress`,
      value: {
        delegatorAddress: seiAddress,
        withdrawAddress: withAddress
      }
    }
    await sClient.signAndBroadcast(seiAddress, [msg], fee, "stake");
    const response = await Querier.cosmos.distribution.v1beta1.DelegatorWithdrawAddress({
      delegator_address: seiAddress
    }, {pathPrefix: restEndpoint})
    expect(response.withdraw_address).to.be.eq(withAddress)
  });

  it('Queries delegation total rewards', async () =>{
    const response = await Querier.cosmos.distribution.v1beta1.DelegationTotalRewards({
      delegator_address: seiAddress
    }, {pathPrefix: restEndpoint});
    expect(response.total[0].denom).to.be.eq('usei');
    expect(parseFloat(response.total[0].amount)).to.be.gt(0);
  });

  it('Queries community pool', async () =>{
    const response = await Querier.cosmos.distribution.v1beta1.CommunityPool({}, {pathPrefix: restEndpoint});
    expect(response.pool[0].denom).to.be.eq('usei');
    expect(parseFloat(response.pool[0].amount)).to.be.gt(0);
  });
  

  it('Queries validator commission', async () =>{
    const response = await Querier.cosmos.distribution.v1beta1.ValidatorCommission({
      validator_address: validatorAddress
    }, {pathPrefix: restEndpoint});
    expect(response.commission?.commission[0].denom).to.be.eq('usei');
    expect(parseFloat(response.commission!.commission[0]!.amount)).to.be.gt(0);
  });

  it('Queries validator rewards', async () =>{
    await waitFor(100);
    const response = await Querier.cosmos.distribution.v1beta1.ValidatorOutstandingRewards({
      validator_address: validatorAddress
    }, {pathPrefix: restEndpoint});
    expect(parseFloat(response.rewards!.rewards[0].amount)).to.be.gt(0);
    expect(parseFloat(response.rewards!.rewards[0].denom)).to.be.eq('usei');
  });

  it('Queries validator slashes', async () =>{
    const response = await Querier.cosmos.distribution.v1beta1.ValidatorSlashes({
      validator_address: validatorAddress,
      starting_height: 30,
      ending_height: 70
    }, {pathPrefix: restEndpoint});
    expect(response.slashes).to.have.length.gte(0);
  });

  it('Queries delegator validators', async () =>{
    const response = await Querier.cosmos.distribution.v1beta1.DelegatorValidators({
      delegator_address: seiAddress
    }, {pathPrefix: restEndpoint});
    expect(response.validators[0]).to.be.eq(validatorAddress);
  });
});