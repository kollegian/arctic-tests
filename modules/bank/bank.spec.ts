import { Querier } from "@sei-js/cosmos/rest";
import {DirectSecp256k1HdWallet} from '@cosmjs/proto-signing';
import {SigningStargateClient} from '@cosmjs/stargate';
import { Encoder } from "@sei-js/cosmos/encoding";
import {createSeiProvider} from '../utils/utils';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {restEndpoint, rpcEndpoint} from '../constants';
import {fee} from '../tokenfactory/types';

describe('Bank Queries', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let seiAddress: string;
  let baseTestDenom= 'usei';
  let tokenFactoryDenom = 'test';
  let fullTokenDenom: string;

  before('', async () =>{
    seiWallet = await generateValidAddress();
    await waitFor(1);
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingClient = await createSeiProvider(rpcEndpoint, seiWallet);
    const msgCreateDenom = Encoder.tokenfactory.MsgCreateDenom.fromPartial({
      sender: seiAddress,
      subdenom: tokenFactoryDenom,
    });
    fullTokenDenom = `factory/${seiAddress}/${tokenFactoryDenom}`;
    const msgSend = {typeUrl:  `/${Encoder.tokenfactory.MsgCreateDenom.$type}`, value: msgCreateDenom};
    await signingClient.signAndBroadcast(seiAddress, [msgSend], fee);
    await waitFor(1);
    const mintAmount = {
      denom: fullTokenDenom,
      amount: '100000',
    };
    const msgMint = Encoder.tokenfactory.MsgMint.fromPartial({
      sender: seiAddress,
      amount: mintAmount,
    });
    const msg = {
      typeUrl: `/${Encoder.tokenfactory.MsgMint.$type}`,
      value: msgMint,
    };
    await signingClient.signAndBroadcast(seiAddress, [msg], fee);

  });

  it('Tests balance query', async () =>{
    const response = await Querier.cosmos.bank.v1beta1.Balance({
      address: seiAddress,
      denom: fullTokenDenom
    }, {
      pathPrefix: restEndpoint
    });
    console.log(response);
  })

  it('Tests denom metadata', async () =>{
    const response = await Querier.cosmos.bank.v1beta1.DenomMetadata({
      denom: 'usei'
    }, {
      pathPrefix: restEndpoint
    })
    console.log(response);
  });

  it.skip('Tests supply of', async () =>{
    const response = await Querier.cosmos.bank.v1beta1.SupplyOf({
      denom: fullTokenDenom
    }, {
      pathPrefix: restEndpoint
    })
    console.log(response);
  });

  it('Tests total supply', async () =>{
    const response = await Querier.cosmos.bank.v1beta1.TotalSupply({}, {
      pathPrefix: restEndpoint
    });
    console.log(response);
  });

  it('Tests all balances', async () =>{
    const response = await Querier.cosmos.bank.v1beta1.AllBalances({
      address: seiAddress
    }, {
      pathPrefix: restEndpoint
    })
    console.log(response);
  });

  it('Tests spendable balances', async () =>{
    // first stake
    const response = await Querier.cosmos.bank.v1beta1.SpendableBalances({
      address: seiAddress
    }, {
      pathPrefix: restEndpoint
    });
  });

  it('Tests all denoms metadata', async () =>{
    const response = await Querier.cosmos.bank.v1beta1.DenomsMetadata({}, {
      pathPrefix: restEndpoint
    });
    console.log(response);
  });

})