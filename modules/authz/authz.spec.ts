import {DirectSecp256k1HdWallet, Registry} from '@cosmjs/proto-signing';
import {SigningStargateClient} from '@cosmjs/stargate';
import {generateValidAddress, waitFor} from '../tokenfactory/helpers';
import {createSeiProvider} from '../utils/utils';
import {restEndpoint, rpcEndpoint} from '../constants';
import ExpectStatic = Chai.ExpectStatic;
import { Encoder } from '@sei-js/cosmos/encoding';
import {fee} from '../tokenfactory/types';
import {GenericAuthorization} from 'cosmjs-types/cosmos/authz/v1beta1/authz';
import {Any} from 'cosmjs-types/google/protobuf/any';
import { seiProtoRegistry } from '@sei-js/cosmos/encoding/stargate';
import { Querier } from '@sei-js/cosmos/rest';
import {MsgRevoke} from 'cosmjs-types/cosmos/authz/v1beta1/tx';
let expect: ExpectStatic;


describe('Authz Tests', function () {
  this.timeout(4 * 60 * 1000);
  let seiWallet: DirectSecp256k1HdWallet;
  let signingClient: SigningStargateClient;
  let seiAddress: string;
  let validatorAddress: string;
  let sClient: SigningStargateClient;
  let grantee: DirectSecp256k1HdWallet;
  let granteeAddress: string;

  before('', async () => {
    const chai = await import('chai');
    ({expect} = chai);
    seiWallet = await generateValidAddress();
    await waitFor(1);
    console.log(seiWallet.mnemonic);
    seiAddress = (await seiWallet.getAccounts())[0].address;
    signingClient = await createSeiProvider(rpcEndpoint, seiWallet);
    sClient = await SigningStargateClient.connectWithSigner(rpcEndpoint, seiWallet);
    grantee = await generateValidAddress();
    granteeAddress = (await grantee.getAccounts())[0].address
    await waitFor(1);
  });

  it('Can grant to another account', async () =>{

    const grantMsgSeiJs = {
      typeUrl: `/${Encoder.cosmos.authz.v1beta1.MsgGrant.$type}`,
      value: {
        granter: seiAddress,
        grantee: (await grantee.getAccounts())[0].address,
        grant: {
          authorization: {
            typeUrl: `/${Encoder.cosmos.authz.v1beta1.GenericAuthorization.$type}`,
            value: Encoder.cosmos.authz.v1beta1.GenericAuthorization.encode(
              Encoder.cosmos.authz.v1beta1.GenericAuthorization.fromPartial({
                msg: `/${Encoder.cosmos.bank.v1beta1.MsgSend.$type}`,
              }),
            ).finish(),
          },
        },
      },
    };

    const grantMsg = {
      typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
      value: {
        granter: seiAddress,
        grantee: (await grantee.getAccounts())[0].address,
        grant: {
          authorization: {
            typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
            value: GenericAuthorization.encode(
              GenericAuthorization.fromPartial({
                msg: `/${Encoder.cosmos.bank.v1beta1.MsgSend.$type}`,
              }),
            ).finish(),
          },
        },
      },
    };
    const grantResult = await sClient.signAndBroadcast(
      seiAddress,
      [grantMsg],
      fee,
      "Test grant for sei-js",
    );
    console.log(grantResult.rawLog);
  });

  it('Can execute grant', async () =>{
    const sendMsg = Encoder.cosmos.bank.v1beta1.MsgSend.fromPartial({
      from_address: seiAddress,
      to_address: (await grantee.getAccounts())[0].address,
      amount: [
        {
          denom: "usei",
          amount: "100000",
        },
      ],
    });

    const anyMsgSend = Any.fromPartial({
      typeUrl: `/${Encoder.cosmos.bank.v1beta1.MsgSend.$type}`,
      value: Encoder.cosmos.bank.v1beta1.MsgSend.encode(sendMsg).finish(),
    });

    const execMsg = {
      typeUrl: "/cosmos.authz.v1beta1.MsgExec",
      value: {
        grantee: (await grantee.getAccounts())[0].address,
        msgs: [anyMsgSend],      // The messages to execute
      },
    };
    const registry = new Registry(seiProtoRegistry)
    const signingCl = await SigningStargateClient.connectWithSigner(rpcEndpoint, grantee, {registry})
    const result = await signingCl.signAndBroadcast(
      (await grantee.getAccounts())[0].address,
      [execMsg],
      fee,
      'exec example'
    );
    console.log(result.rawLog);
  });

  it.skip('Queries grants', async () =>{
    const grantResponse = await Querier.cosmos.authz.v1beta1.Grants({
      granter: seiAddress,
      grantee: granteeAddress,
      msg_type_url: `/${Encoder.cosmos.authz.v1beta1.GenericAuthorization.$type}`
    }, {pathPrefix: restEndpoint});
    // console.log(grantResponse.grants);
  });

  it('Queries grantee grants', async () =>{
    const grantResponse = await Querier.cosmos.authz.v1beta1.GranteeGrants({
      grantee: granteeAddress,
    }, {pathPrefix: restEndpoint});
    expect(grantResponse.grants[0].granter).to.be.eq(seiAddress);
    expect(grantResponse.grants[0].grantee).to.be.eq(granteeAddress);
    expect(grantResponse.grants[0].authorization!.msg).to.be.eq('/cosmos.bank.v1beta1.MsgSend');

  });

  it('Queries granter grants', async () =>{
    const grantResponse = await Querier.cosmos.authz.v1beta1.GranterGrants({
      granter: seiAddress,
    }, {pathPrefix: restEndpoint});
    expect(grantResponse.grants[0].granter).to.be.eq(seiAddress);
    expect(grantResponse.grants[0].grantee).to.be.eq(granteeAddress);
    expect(grantResponse.grants[0].authorization!.msg).to.be.eq('/cosmos.bank.v1beta1.MsgSend');
  });

  it('Can revoke grant', async () =>{
    const revokeMsg = {
      typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
      value: MsgRevoke.fromPartial({
        granter: seiAddress,
        grantee: granteeAddress,
        msgTypeUrl: "/cosmos.bank.v1beta1.MsgSend",
      }),
    };

    const result = await sClient.signAndBroadcast(
      seiAddress,
      [revokeMsg],
      fee,
      'Revoke grant'
    );
    expect(result.code).to.be.eq(0);
  });

  it('Queries grantee grants', async () =>{
    const grantResponse = await Querier.cosmos.authz.v1beta1.GranteeGrants({
      grantee: granteeAddress,
    }, {pathPrefix: restEndpoint});
    expect(grantResponse.grants).to.have.length(0);
  });

  it('Queries granter grants', async () =>{
    const grantResponse = await Querier.cosmos.authz.v1beta1.GranterGrants({
      granter: seiAddress,
    }, {pathPrefix: restEndpoint});
    expect(grantResponse.grants).to.have.length(0);
  });
});