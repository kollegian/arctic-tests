import {DirectSecp256k1HdWallet, Registry} from '@cosmjs/proto-signing';
import {coin, coins, SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {createSeiProvider} from '../utils/utils';
import {restEndpoint, rpcEndpoint} from '../constants';
import ExpectStatic = Chai.ExpectStatic;
import { Encoder } from '@sei-js/cosmos/encoding';
import { seiProtoRegistry } from '@sei-js/cosmos/encoding/stargate';
import {fee} from '../tokenfactory/types';
import {BasicAllowance} from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import {MsgGrantAllowance} from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import {Any} from 'cosmjs-types/google/protobuf/any';
import { Querier } from '@sei-js/cosmos/rest';
let expect: ExpectStatic;

describe('Feegrant Tests', function () {
  this.timeout(4 * 60 * 1000);
  let payerWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let payerAddress: string;
  let validatorAddress: string;
  let sClient: SigningStargateClient;
  let payedWallet: DirectSecp256k1HdWallet;
  let payedAddress: string;
  let allowance: any;
  let allowanceSeiJs: any;
  before('initializes client', async () => {
    allowanceSeiJs = {
      typeUrl: `/${Encoder.cosmos.feegrant.v1beta1.BasicAllowance.$type}}`,
      value: Uint8Array.from(
        Encoder.cosmos.feegrant.v1beta1.BasicAllowance.encode(
          Encoder.cosmos.feegrant.v1beta1.BasicAllowance.fromPartial({
            spend_limit: [
              {
                denom: "usei",
                amount: "30000",
              },
            ],
          }),
        ).finish(),
      ),
    };
    allowance = {
      typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
      value: Uint8Array.from(
        BasicAllowance.encode(
          BasicAllowance.fromPartial({
            spendLimit: [
              {
                denom: "usei",
                amount: "300000",
              },
            ],
          }),
        ).finish(),
      ),
    };
    const chai = await import('chai');
    ({expect} = chai);
    payerWallet = await generateValidAddress();
    await waitFor(2);
    payedWallet = await generateValidAddress();
    await waitFor(2);
    payerAddress = (await payerWallet.getAccounts())[0].address;
    const registry = new Registry(seiProtoRegistry);
    signingClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, payerWallet, {registry});
    sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, payerWallet);
    payedWallet = await generateValidAddress();
    payedAddress = (await payedWallet.getAccounts())[0].address
    await waitFor(1);
  });

  it.skip('Can grant fee with sei-js', async () =>{
    const grantMsg = {
      typeUrl: `/${Encoder.cosmos.feegrant.v1beta1.MsgGrantAllowance.$type}`,
      value: Encoder.cosmos.feegrant.v1beta1.MsgGrantAllowance.fromPartial({
        granter: payerAddress,
        grantee: payedAddress,
        allowance: allowanceSeiJs,
      }),
    };
    const result = await signingClient.signAndBroadcast(payerAddress, [grantMsg], fee, 'fee grant');
    console.log(result.code);
  });

  it('Can grant fee pay with cosmjs', async () =>{
    const grantMsg = {
      typeUrl: `/cosmos.feegrant.v1beta1.MsgGrantAllowance`,
      value: MsgGrantAllowance.fromPartial({
        granter: payerAddress,
        grantee: payedAddress,
        allowance: allowance,
      }),
    };
    const result = await sClient.signAndBroadcast(payerAddress, [grantMsg], fee, 'fee grant');
    expect(result.code).to.be.eq(0);
  });

  it('Granter pays for the fee', async () =>{
    const receiverAddress = 'sei1dky090wkylxzaeczqs90fnh8m02gnu0rdypgd7'
    const payedPreBalance = await Querier.cosmos.bank.v1beta1.Balance({
      address: payedAddress,
      denom: 'usei'
    }, {pathPrefix: restEndpoint});
    const payerPreBalance = await Querier.cosmos.bank.v1beta1.Balance({
      address: payerAddress,
      denom: 'usei'
    }, {pathPrefix: restEndpoint});

    const msgSend = {
      typeUrl: `/${Encoder.cosmos.bank.v1beta1.MsgSend.$type}`,
      value: Encoder.cosmos.bank.v1beta1.MsgSend.fromPartial({
        from_address: payedAddress,
        to_address: receiverAddress,
        amount: [{ denom: "usei", amount: "1000" }]
      })
    }
    const fee = {
      amount: coins(24000, 'usei'),
      gas: "500000",
      granter: payerAddress,
    };
    const registry = new Registry(seiProtoRegistry);
    const signingClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, payedWallet, {registry});
    const result = await signingClient.signAndBroadcast(payedAddress, [msgSend], fee, 'feegrant tx' );
    expect(result.code).to.be.eq(0);

    const payedAfterBalance = await Querier.cosmos.bank.v1beta1.Balance({
      address: payedAddress,
      denom: 'usei'
    }, {pathPrefix: restEndpoint});
    const payerAfterBalance = await Querier.cosmos.bank.v1beta1.Balance({
      address: payerAddress,
      denom: 'usei'
    }, {pathPrefix: restEndpoint});


    expect(Number(payedPreBalance.balance!.amount) - Number(payedAfterBalance.balance!.amount)).to.be.eq(1000);
    expect(Number(payerPreBalance.balance!.amount) - Number(payerAfterBalance.balance!.amount)).to.be.eq(24000);
  });

  it('Can query allowance', async () =>{
    const response = await Querier.cosmos.feegrant.v1beta1.Allowance({
      granter: payerAddress,
      grantee: payedAddress
    }, {pathPrefix: restEndpoint});
    expect(response.allowance!.granter).to.be.eq(payerAddress);
    expect(response.allowance!.grantee).to.be.eq(payedAddress);
    expect(response.allowance!.allowance!.spend_limit).to.be.deep.eq([{ denom: 'usei', amount: '276000'}])
  });

  it('Can query allowances', async () =>{
    const response = await Querier.cosmos.feegrant.v1beta1.Allowances({
      grantee: payedAddress
    }, {pathPrefix: restEndpoint});
    expect(response.allowances[0].granter).to.be.eq(payerAddress);
    expect(response.allowances[0].grantee).to.be.eq(payedAddress);
    expect(response.allowances[0].allowance!.spend_limit).to.be.deep.eq([{ denom: 'usei', amount: '276000'}])
  });

  it('Can query allowance by grantee', async () =>{
    const response = await Querier.cosmos.feegrant.v1beta1.AllowancesByGranter({
      granter: payerAddress
    }, {pathPrefix: restEndpoint});
    expect(response.allowances[0].granter).to.be.eq(payerAddress);
    expect(response.allowances[0].grantee).to.be.eq(payedAddress);
    expect(response.allowances[0].allowance!.spend_limit).to.be.deep.eq([{ denom: 'usei', amount: '276000'}])
  });

  it('Can revoke allowance with sei js', async () =>{
    const revokeMsg = {
      typeUrl: `/${Encoder.cosmos.feegrant.v1beta1.MsgRevokeAllowance.$type}`,
      value: Encoder.cosmos.feegrant.v1beta1.MsgRevokeAllowance.fromPartial({
        granter: payerAddress,
        grantee: payedAddress,
      }),
    };
    const result = await signingClient.signAndBroadcast(payerAddress, [revokeMsg], fee, 'fee revoke');
    expect(result.code).to.be.eq(0);
  });

  it.skip('Can query allowance', async () =>{
    const response = await Querier.cosmos.feegrant.v1beta1.Allowance({
      granter: payerAddress,
      grantee: payedAddress
    }, {pathPrefix: restEndpoint});
  });

  it('Can query allowances', async () =>{
    const response = await Querier.cosmos.feegrant.v1beta1.Allowances({
      grantee: payedAddress
    }, {pathPrefix: restEndpoint});
    expect(response.allowances).to.have.length(0);
  });

  it('Can query allowance by grantee', async () =>{
    const response = await Querier.cosmos.feegrant.v1beta1.AllowancesByGranter({
      granter: payerAddress
    }, {pathPrefix: restEndpoint});
    expect(response.allowances).to.have.length(0);
  });
});