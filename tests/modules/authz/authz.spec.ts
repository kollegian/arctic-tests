import { coins } from '@cosmjs/stargate';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { Querier } from '@sei-js/cosmos/rest';
import { Encoder } from '@sei-js/cosmos/encoding';
import { SeiUser, UserFactory } from '../../../shared/User';
import testConfig from '../../../config/testConfig.json';
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import ExpectStatic = Chai.ExpectStatic;
import fs from 'node:fs';

let expect: ExpectStatic;
const restEndpoint = testConfig.restEndpoint;
const fee = { amount: coins(24000, 'usei'), gas: '500000' };
const CLI_FEE = '24200usei';
const AUTHZ_SEND_AMOUNT = '100000';
const SMALL_AUTHZ_SEND_AMOUNT = '1000';
const LIFECYCLE_SEND_AMOUNT = '50000';
const AUTHZ_MSG_TYPE = '/cosmos.bank.v1beta1.MsgSend';

describe('Authz Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let granter: SeiUser;
  let grantee: SeiUser;

  before(async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    granter = await UserFactory.createSeiUser(admin, 'authzGranter');
    grantee = await UserFactory.createSeiUser(admin, 'authzGrantee');
  });

  describe('seid CLI Tests', function () {
    it('Grant generic authorization via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx authz grant ${grantee.seiAddress} generic --msg-type ${AUTHZ_MSG_TYPE} --from authzGranter --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query grants via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q authz grants ${granter.seiAddress} ${grantee.seiAddress}`
      );
      expect(result.grants).to.be.an('array');
      expect(result.grants).to.have.length.gte(1);
    });

    it('Execute grant via seid CLI', async () => {
      const innerTx = await execCommandAndReturnJson(
        `seid tx bank send ${granter.seiAddress} ${grantee.seiAddress} ${AUTHZ_SEND_AMOUNT}usei --from authzGranter --generate-only`
      );
      const tmpFile = '/tmp/authz_inner_tx.json';
      fs.writeFileSync(tmpFile, JSON.stringify(innerTx));
      const result = await execCommandAndReturnJson(
        `seid tx authz exec ${tmpFile} --from authzGrantee --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Revoke grant via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx authz revoke ${grantee.seiAddress} ${AUTHZ_MSG_TYPE} --from authzGranter --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query grants after revoke via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q authz grants ${granter.seiAddress} ${grantee.seiAddress}`
      );
      expect(result.grants).to.have.length(0);
    });
  });

  describe('CosmJS Tests', function () {
    it('Grant with cosmjs', async () => {
      const grantMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
        value: {
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          grant: {
            authorization: {
              typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
              value: GenericAuthorization.encode(
                GenericAuthorization.fromPartial({
                  msg: AUTHZ_MSG_TYPE,
                }),
              ).finish(),
            },
          },
        },
      };
      const grantResult = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [grantMsg], fee, 'Test grant'
      );
      expect(grantResult.code).to.be.eq(0);
    });

    it('Execute grant', async () => {
      const sendMsg = Encoder.cosmos.bank.v1beta1.MsgSend.fromPartial({
        from_address: granter.seiAddress,
        to_address: grantee.seiAddress,
        amount: [{ denom: 'usei', amount: AUTHZ_SEND_AMOUNT }],
      });

      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: Encoder.cosmos.bank.v1beta1.MsgSend.encode(sendMsg).finish(),
      });

      const execMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: {
          grantee: grantee.seiAddress,
          msgs: [anyMsgSend],
        },
      };
      const result = await grantee.seiWallet.signingClient.signAndBroadcast(
        grantee.seiAddress, [execMsg], fee, 'exec example'
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query grantee grants via Querier', async () => {
      const grantResponse = await Querier.cosmos.authz.v1beta1.GranteeGrants({
        grantee: grantee.seiAddress,
      }, { pathPrefix: restEndpoint });
      expect(grantResponse.grants[0].granter).to.be.eq(granter.seiAddress);
      expect(grantResponse.grants[0].grantee).to.be.eq(grantee.seiAddress);
      expect(grantResponse.grants[0].authorization!.msg).to.be.eq(AUTHZ_MSG_TYPE);
    });

    it('Query granter grants via Querier', async () => {
      const grantResponse = await Querier.cosmos.authz.v1beta1.GranterGrants({
        granter: granter.seiAddress,
      }, { pathPrefix: restEndpoint });
      expect(grantResponse.grants[0].granter).to.be.eq(granter.seiAddress);
      expect(grantResponse.grants[0].grantee).to.be.eq(grantee.seiAddress);
      expect(grantResponse.grants[0].authorization!.msg).to.be.eq(AUTHZ_MSG_TYPE);
    });

    it('Revoke grant', async () => {
      const revokeMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
        value: MsgRevoke.fromPartial({
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          msgTypeUrl: "/cosmos.bank.v1beta1.MsgSend",
        }),
      };
      const result = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [revokeMsg], fee, 'Revoke grant'
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query after revoke', async () => {
      const granteeResponse = await Querier.cosmos.authz.v1beta1.GranteeGrants({
        grantee: grantee.seiAddress,
      }, { pathPrefix: restEndpoint });
      expect(granteeResponse.grants).to.have.length(0);

      const granterResponse = await Querier.cosmos.authz.v1beta1.GranterGrants({
        granter: granter.seiAddress,
      }, { pathPrefix: restEndpoint });
      expect(granterResponse.grants).to.have.length(0);
    });

    it('Cannot execute revoked grant', async () => {
      const sendMsg = Encoder.cosmos.bank.v1beta1.MsgSend.fromPartial({
        from_address: granter.seiAddress,
        to_address: grantee.seiAddress,
        amount: [{ denom: 'usei', amount: '100' }],
      });

      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: Encoder.cosmos.bank.v1beta1.MsgSend.encode(sendMsg).finish(),
      });

      const execMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: {
          grantee: grantee.seiAddress,
          msgs: [anyMsgSend],
        },
      };
      const result = await grantee.seiWallet.signingClient.signAndBroadcast(
        grantee.seiAddress, [execMsg], fee, 'exec after revoke'
      );
      expect(result.code).to.not.be.eq(0);
    });

    it('Cannot revoke non-existent grant', async () => {
      const revokeMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
        value: MsgRevoke.fromPartial({
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          msgTypeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
        }),
      };
      const result = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [revokeMsg], fee, 'Revoke nonexistent'
      );
      expect(result.code).to.not.be.eq(0);
    });
  });

  describe('Error Cases', function () {
    it('Cannot grant to self (CosmJS)', async () => {
      const grantMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
        value: {
          granter: granter.seiAddress,
          grantee: granter.seiAddress,
          grant: {
            authorization: {
              typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
              value: GenericAuthorization.encode(
                GenericAuthorization.fromPartial({
                  msg: AUTHZ_MSG_TYPE,
                }),
              ).finish(),
            },
          },
        },
      };
      const result = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [grantMsg], fee, 'self grant'
      );
      expect(result.code).to.not.be.eq(0);
    });

    it('Cannot execute grant for unauthorized message type', async () => {
      const grantMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
        value: {
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          grant: {
            authorization: {
              typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
              value: GenericAuthorization.encode(
                GenericAuthorization.fromPartial({
                  msg: AUTHZ_MSG_TYPE,
                }),
              ).finish(),
            },
          },
        },
      };
      const grantResult = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [grantMsg], fee, 'grant for send only'
      );
      expect(grantResult.code).to.be.eq(0);

      const delegateMsg = Encoder.cosmos.staking.v1beta1.MsgDelegate.fromPartial({
        delegator_address: granter.seiAddress,
        validator_address: 'seivaloper1example',
        amount: { denom: "usei", amount: "1000" },
      });
      const anyDelegateMsg = Any.fromPartial({
        typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
        value: Encoder.cosmos.staking.v1beta1.MsgDelegate.encode(delegateMsg).finish(),
      });
      const execMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: {
          grantee: grantee.seiAddress,
          msgs: [anyDelegateMsg],
        },
      };
      const result = await grantee.seiWallet.signingClient.signAndBroadcast(
        grantee.seiAddress, [execMsg], fee, 'exec unauthorized type'
      );
      expect(result.code).to.not.be.eq(0);

      const revokeMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
        value: MsgRevoke.fromPartial({
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          msgTypeUrl: '/cosmos.bank.v1beta1.MsgSend',
        }),
      };
      await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [revokeMsg], fee, 'cleanup revoke'
      );
    });

    it('Cannot execute with wrong grantee', async () => {
      const wrongUser = await UserFactory.createSeiUser(admin, 'authzWrong');

      const grantMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
        value: {
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          grant: {
            authorization: {
              typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
              value: GenericAuthorization.encode(
                GenericAuthorization.fromPartial({
                  msg: AUTHZ_MSG_TYPE,
                }),
              ).finish(),
            },
          },
        },
      };
      const grantResult = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [grantMsg], fee, 'grant for grantee'
      );
      expect(grantResult.code).to.be.eq(0);

      const sendMsg = Encoder.cosmos.bank.v1beta1.MsgSend.fromPartial({
        from_address: granter.seiAddress,
        to_address: wrongUser.seiAddress,
        amount: [{ denom: 'usei', amount: SMALL_AUTHZ_SEND_AMOUNT }],
      });
      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: Encoder.cosmos.bank.v1beta1.MsgSend.encode(sendMsg).finish(),
      });
      const execMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: {
          grantee: wrongUser.seiAddress,
          msgs: [anyMsgSend],
        },
      };
      const result = await wrongUser.seiWallet.signingClient.signAndBroadcast(
        wrongUser.seiAddress, [execMsg], fee, 'wrong grantee exec'
      );
      expect(result.code).to.not.be.eq(0);

      const revokeMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
        value: MsgRevoke.fromPartial({
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          msgTypeUrl: '/cosmos.bank.v1beta1.MsgSend',
        }),
      };
      await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [revokeMsg], fee, 'cleanup revoke'
      );
    });
  });

  describe('Cross-Runtime Consistency', function () {
    before(async () => {
      const grantResult = await execCommandAndReturnJson(
        `seid tx authz grant ${grantee.seiAddress} generic --msg-type ${AUTHZ_MSG_TYPE} --from authzGranter --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(grantResult.code).to.be.eq(0);
    });

    after(async () => {
      await execCommandAndReturnJson(
        `seid tx authz revoke ${grantee.seiAddress} ${AUTHZ_MSG_TYPE} --from authzGranter --fees ${CLI_FEE} -y --broadcast-mode block`
      );
    });

    it('CLI grants query matches Querier query', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q authz grants ${granter.seiAddress} ${grantee.seiAddress}`
      );
      const restResponse = await Querier.cosmos.authz.v1beta1.GranteeGrants({
        grantee: grantee.seiAddress,
      }, { pathPrefix: restEndpoint });

      expect(cliResult.grants).to.be.an('array');
      expect(cliResult.grants).to.have.length.gte(1);

      const restGrant = restResponse.grants.find(
        (g: any) => g.granter === granter.seiAddress && g.grantee === grantee.seiAddress
      );
      expect(restGrant).to.not.be.undefined;
      expect(restGrant!.authorization!.msg).to.be.eq(AUTHZ_MSG_TYPE);

      const cliGrant = cliResult.grants.find(
        (g: any) => g.authorization?.msg === AUTHZ_MSG_TYPE
      );
      expect(cliGrant).to.not.be.undefined;
      expect(cliGrant!.grantee).to.be.eq(grantee.seiAddress);
    });
  });

  describe('Full Lifecycle', function () {
    let lcGranter: SeiUser;
    let lcGrantee: SeiUser;

    before(async () => {
      lcGranter = await UserFactory.createSeiUser(admin, 'authzLcGranter');
      lcGrantee = await UserFactory.createSeiUser(admin, 'authzLcGrantee');
    });

    it('Grant -> Execute -> Verify state change -> Revoke -> Verify cannot execute', async () => {
      const grantMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
        value: {
          granter: lcGranter.seiAddress,
          grantee: lcGrantee.seiAddress,
          grant: {
            authorization: {
              typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
              value: GenericAuthorization.encode(
                GenericAuthorization.fromPartial({
                  msg: AUTHZ_MSG_TYPE,
                }),
              ).finish(),
            },
          },
        },
      };
      const grantResult = await lcGranter.seiWallet.signingClient.signAndBroadcast(
        lcGranter.seiAddress, [grantMsg], fee, 'lifecycle grant'
      );
      expect(grantResult.code).to.be.eq(0);

      const grantsResponse = await Querier.cosmos.authz.v1beta1.GranteeGrants({
        grantee: lcGrantee.seiAddress,
      }, { pathPrefix: restEndpoint });
      const activeGrant = grantsResponse.grants.find(
        (g: any) => g.granter === lcGranter.seiAddress
      );
      expect(activeGrant).to.not.be.undefined;
      expect(activeGrant!.authorization!.msg).to.be.eq(AUTHZ_MSG_TYPE);

      const granterPreBalance = await Querier.cosmos.bank.v1beta1.Balance({
        address: lcGranter.seiAddress,
        denom: 'usei'
      }, { pathPrefix: restEndpoint });

      const sendMsg = Encoder.cosmos.bank.v1beta1.MsgSend.fromPartial({
        from_address: lcGranter.seiAddress,
        to_address: lcGrantee.seiAddress,
        amount: [{ denom: 'usei', amount: LIFECYCLE_SEND_AMOUNT }],
      });
      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: Encoder.cosmos.bank.v1beta1.MsgSend.encode(sendMsg).finish(),
      });
      const execMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: {
          grantee: lcGrantee.seiAddress,
          msgs: [anyMsgSend],
        },
      };
      const execResult = await lcGrantee.seiWallet.signingClient.signAndBroadcast(
        lcGrantee.seiAddress, [execMsg], fee, 'lifecycle exec'
      );
      expect(execResult.code).to.be.eq(0);

      const granterPostBalance = await Querier.cosmos.bank.v1beta1.Balance({
        address: lcGranter.seiAddress,
        denom: 'usei'
      }, { pathPrefix: restEndpoint });
      expect(
        Number(granterPreBalance.balance!.amount) - Number(granterPostBalance.balance!.amount)
      ).to.be.eq(Number(LIFECYCLE_SEND_AMOUNT));

      const revokeMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
        value: MsgRevoke.fromPartial({
          granter: lcGranter.seiAddress,
          grantee: lcGrantee.seiAddress,
          msgTypeUrl: '/cosmos.bank.v1beta1.MsgSend',
        }),
      };
      const revokeResult = await lcGranter.seiWallet.signingClient.signAndBroadcast(
        lcGranter.seiAddress, [revokeMsg], fee, 'lifecycle revoke'
      );
      expect(revokeResult.code).to.be.eq(0);

      const postRevokeGrants = await Querier.cosmos.authz.v1beta1.GranteeGrants({
        grantee: lcGrantee.seiAddress,
      }, { pathPrefix: restEndpoint });
      const revokedGrant = postRevokeGrants.grants.find(
        (g: any) => g.granter === lcGranter.seiAddress
      );
      expect(revokedGrant).to.not.exist;

      const execAfterRevoke = await lcGrantee.seiWallet.signingClient.signAndBroadcast(
        lcGrantee.seiAddress, [execMsg], fee, 'exec after revoke'
      );
      expect(execAfterRevoke.code).to.not.be.eq(0);
    });
  });
});
