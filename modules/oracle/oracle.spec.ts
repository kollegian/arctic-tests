import {DirectSecp256k1HdWallet, Registry} from '@cosmjs/proto-signing';
import {SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {createSeiProvider} from '../utils/utils';
import {restEndpoint, rpcEndpoint} from '../constants';
import { Querier } from '@sei-js/cosmos/rest';
import { Encoder } from '@sei-js/cosmos/encoding';
import ExpectStatic = Chai.ExpectStatic;
import {fee} from '../tokenfactory/types';
import { seiProtoRegistry } from '@sei-js/cosmos/encoding/stargate';
import {addNewFeeder, aggregateVote} from '../utils/oldUtils';

describe('Oracle Queries', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let seiAddress: string;
  let validatorAddress: string;
  let expect: ExpectStatic;

  before('Initializes clients', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    seiWallet = await generateValidAddress();
    await waitFor(1);
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingClient = await createSeiProvider(rpcEndpoint, seiWallet);

    const val = await Querier.cosmos.staking.v1beta1.Validators({
      status: 'BOND_STATUS_BONDED'
    }, {
      pathPrefix: restEndpoint
    })
    validatorAddress = val.validators[0].operator_address;
  })

  it.skip('Can delegate feed', async () =>{
    const msgDelegateFeedConsent = Encoder.oracle.MsgDelegateFeedConsent.fromPartial({
      operator: validatorAddress,
      delegate: seiAddress,
    });

    const msgSend = {
      typeUrl: `/${Encoder.oracle.MsgDelegateFeedConsent.$type}`,
      value: msgDelegateFeedConsent,
    };

    const result = await signingClient.signAndBroadcast(seiAddress, [msgSend], fee);
    expect(result.code).to.equal(0);
    await waitFor(1);
  });

  it.skip('Can call aggregate vote', async () =>{
    const registry = new Registry(seiProtoRegistry);
    signingClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet, {registry});
    const exchangeRates = '100.5usei,0.25uatom';
    const msgAggregateExchangeRateVote = Encoder.oracle.MsgAggregateExchangeRateVote.fromPartial({
      exchange_rates: exchangeRates,
      feeder: seiAddress,
      validator: validatorAddress,
    });

    const msg = {
      typeUrl: `/${Encoder.oracle.MsgAggregateExchangeRateVote.$type}`,
      value: msgAggregateExchangeRateVote,
    };

    const result = await signingClient.signAndBroadcast(seiAddress, [msg], fee);
    expect(result.code).to.equal(0);
  });

  it('Can add new feeder', async () =>{
    await addNewFeeder(seiAddress);
    await waitFor(1);
  });

  it('Can aggregate vote', async () =>{
    await aggregateVote(seiAddress, validatorAddress, seiWallet);
  });

  it('Query actives', async () =>{
    const response = await Querier.oracle.Actives({}, {
      pathPrefix: restEndpoint
    });
    expect(response.actives).to.have.length(2);
    expect(response.actives).contain('uatom');
    expect(response.actives).to.contain('usei');
  })

  it('Query exchange rate', async () =>{
    const response = await Querier.oracle.ExchangeRate({
      denom: 'usei'
    }, {
      pathPrefix: restEndpoint
    });
    expect(Number(response.oracle_exchange_rate!.exchange_rate)).to.be.gte(0);
  })

  it('Query exchange rates', async () =>{
    const response = await Querier.oracle.ExchangeRates({}, {pathPrefix: restEndpoint});
    expect(response.denom_oracle_exchange_rate_pairs).to.have.length(2);
    expect(Number(response.denom_oracle_exchange_rate_pairs[0].oracle_exchange_rate!.exchange_rate)).to.be.gte(0)
  })

  it('Query feeder delegation', async () =>{
    const response = await Querier.oracle.FeederDelegation({
      validator_addr: validatorAddress
    }, {
      pathPrefix: restEndpoint
    })
    expect(response.feeder_addr).to.be.eq(seiAddress);
  })

  it('Query price snapshot history', async () =>{
    const response = await Querier.oracle.PriceSnapshotHistory({}, {pathPrefix: restEndpoint});
    expect(response.price_snapshots).to.have.length.gte(1);
  })

  it('Query slash window', async () =>{
    const response = await Querier.oracle.SlashWindow({}, {pathPrefix: restEndpoint});
    expect(Number(response.window_progress)).to.be.gt(1);
  })

  it('Query twaps', async () =>{
    const response = await Querier.oracle.Twaps({
      lookback_seconds: 200
    }, {
      pathPrefix: restEndpoint
    })
    expect(response.oracle_twaps).to.have.length(2);
    expect(response.oracle_twaps[0]).to.haveOwnProperty('denom');
    expect(response.oracle_twaps[0]).to.haveOwnProperty('twap');
    expect(response.oracle_twaps[0]).to.haveOwnProperty('lookback_seconds');
    expect(response.oracle_twaps[0].lookback_seconds).to.be.eq('200');
  });

  it('Query vote penalty counter', async () =>{
    const response = await Querier.oracle.VotePenaltyCounter({
      validator_addr: validatorAddress
    }, {
      pathPrefix: restEndpoint
    });
    expect(response.vote_penalty_counter).to.haveOwnProperty('miss_count');
    expect(response.vote_penalty_counter).to.haveOwnProperty('abstain_count');
    expect(Number(response.vote_penalty_counter!.success_count)).to.be.eq(1);
    expect(Number(response.vote_penalty_counter!.abstain_count)).to.be.gt(1);
  });

  it('Query vote targets', async () =>{
    const response = await Querier.oracle.VoteTargets({}, {pathPrefix: restEndpoint});
    expect(response.vote_targets).to.contain('usei');
    expect(response.vote_targets).to.contain('uatom');
  });
});