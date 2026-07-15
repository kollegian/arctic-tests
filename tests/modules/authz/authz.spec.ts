import { coins } from '@cosmjs/stargate';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { Querier } from '@sei-js/cosmos/rest';
import { Encoder } from '@sei-js/cosmos/encoding';
import { SeiUser, UserFactory } from '../../../shared/User';
import { GenericAuthorization } from 'cosmjs-types/cosmos/authz/v1beta1/authz';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { MsgGrant, MsgRevoke } from 'cosmjs-types/cosmos/authz/v1beta1/tx';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import ExpectStatic = Chai.ExpectStatic;
import fs from 'node:fs';
import { getRpcQueryClient, moduleRestEndpoint, withRestFallback } from '../utils/rpcQueryClient';
import { expectFailure } from '../moduleTestUtils';

let expect: ExpectStatic;
const fee = { amount: coins(50000, 'usei'), gas: '500000' };
const CLI_FEE = '50000usei';
const AUTHZ_SEND_AMOUNT = '100000';
const SMALL_AUTHZ_SEND_AMOUNT = '1000';
const LIFECYCLE_SEND_AMOUNT = '50000';
const AUTHZ_MSG_TYPE = '/cosmos.bank.v1beta1.MsgSend';
const AUTHZ_EXPIRATION = '2030-01-01T00:00:00Z';
const AUTHZ_EXPIRATION_TIMESTAMP = {
  seconds: BigInt(Math.floor(new Date(AUTHZ_EXPIRATION).getTime() / 1000)),
  nanos: 0,
};
const AUTHZ_EXPIRATION_UNIX = AUTHZ_EXPIRATION_TIMESTAMP.seconds.toString();

// `Querier` (REST) returns each grant's `authorization` already decoded into
// JSON, so `authorization.msg` is populated directly. The Tendermint RPC path
// returns it as a raw protobuf `Any` ({ typeUrl, value: Uint8Array }). This
// helper normalises both shapes so call sites stay identical regardless of
// which path produced the response.
function authzMsg(grant: any): string | undefined {
  const auth = grant?.authorization;
  if (!auth) return undefined;
  if (typeof auth.msg === 'string') return auth.msg;
  if (auth.value instanceof Uint8Array) {
    try {
      return GenericAuthorization.decode(auth.value).msg;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// `Querier` and cosmjs both return GrantAuthorization/Any types but bundle them
// from different proto packages, so we widen to `any` to avoid the structural
// mismatch noise — the runtime shape is the same in either case.
const queryGranteeGrants = (grantee: string): Promise<any> =>
  withRestFallback<any>(
    'authz.granteeGrants',
    async () => (await getRpcQueryClient()).authz.granteeGrants(grantee),
    () => Querier.cosmos.authz.v1beta1.GranteeGrants({ grantee }, { pathPrefix: moduleRestEndpoint }) as any,
  );

const queryGranterGrants = (granter: string): Promise<any> =>
  withRestFallback<any>(
    'authz.granterGrants',
    async () => (await getRpcQueryClient()).authz.granterGrants(granter),
    () => Querier.cosmos.authz.v1beta1.GranterGrants({ granter }, { pathPrefix: moduleRestEndpoint }) as any,
  );

async function queryBalance(address: string, denom: string): Promise<{ denom: string; amount: string }> {
  return withRestFallback(
    'bank.balance',
    async () => {
      const coin = await (await getRpcQueryClient()).bank.balance(address, denom);
      return { denom: coin?.denom ?? denom, amount: coin?.amount ?? '0' };
    },
    async () => {
      const resp = await Querier.cosmos.bank.v1beta1.Balance(
        { address, denom },
        { pathPrefix: moduleRestEndpoint },
      );
      return { denom: resp.balance?.denom ?? denom, amount: resp.balance?.amount ?? '0' };
    },
  );
}

function genericGrantMsg(
  granter: string,
  grantee: string,
  msgType = AUTHZ_MSG_TYPE,
  expiration: { seconds: bigint; nanos: number } = AUTHZ_EXPIRATION_TIMESTAMP
) {
  return {
    typeUrl: "/cosmos.authz.v1beta1.MsgGrant",
    value: MsgGrant.fromPartial({
      granter,
      grantee,
      grant: {
        authorization: {
          typeUrl: "/cosmos.authz.v1beta1.GenericAuthorization",
          value: GenericAuthorization.encode(
            GenericAuthorization.fromPartial({
              msg: msgType,
            }),
          ).finish(),
        },
        expiration,
      },
    }),
  };
}

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
        `seid tx authz grant ${grantee.seiAddress} generic --msg-type ${AUTHZ_MSG_TYPE} --expiration ${AUTHZ_EXPIRATION_UNIX} --from authzGranter --fees ${CLI_FEE} -y --broadcast-mode block`
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
      const grantMsg = genericGrantMsg(granter.seiAddress, grantee.seiAddress);
      const grantResult = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [grantMsg], fee, 'Test grant'
      );
      expect(grantResult.code).to.be.eq(0);
    });

    it('Execute grant', async () => {
      const sendMsg = MsgSend.fromPartial({
        fromAddress: granter.seiAddress,
        toAddress: grantee.seiAddress,
        amount: [{ denom: 'usei', amount: AUTHZ_SEND_AMOUNT }],
      });

      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: MsgSend.encode(sendMsg).finish(),
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
      expect(result.code, result.rawLog).to.be.eq(0);
    });

    it('Query grantee grants via Querier', async () => {
      const grantResponse = await queryGranteeGrants(grantee.seiAddress);
      expect(grantResponse.grants[0].granter).to.be.eq(granter.seiAddress);
      expect(grantResponse.grants[0].grantee).to.be.eq(grantee.seiAddress);
      expect(authzMsg(grantResponse.grants[0])).to.be.eq(AUTHZ_MSG_TYPE);
    });

    it('Query granter grants via Querier', async () => {
      const grantResponse = await queryGranterGrants(granter.seiAddress);
      expect(grantResponse.grants[0].granter).to.be.eq(granter.seiAddress);
      expect(grantResponse.grants[0].grantee).to.be.eq(grantee.seiAddress);
      expect(authzMsg(grantResponse.grants[0])).to.be.eq(AUTHZ_MSG_TYPE);
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
      const granteeResponse = await queryGranteeGrants(grantee.seiAddress);
      expect(granteeResponse.grants).to.have.length(0);

      const granterResponse = await queryGranterGrants(granter.seiAddress);
      expect(granterResponse.grants).to.have.length(0);
    });

    it('Cannot execute revoked grant', async () => {
      const sendMsg = MsgSend.fromPartial({
        fromAddress: granter.seiAddress,
        toAddress: grantee.seiAddress,
        amount: [{ denom: 'usei', amount: '100' }],
      });

      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: MsgSend.encode(sendMsg).finish(),
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
      const grantMsg = genericGrantMsg(granter.seiAddress, granter.seiAddress);
      await expectFailure(
        granter.seiWallet.signingClient.signAndBroadcast(
          granter.seiAddress, [grantMsg], fee, 'self grant'
        ),
        'granter and grantee cannot be same',
        'authz self-grant'
      );
    });

    it('Cannot execute grant for unauthorized message type', async () => {
      const grantMsg = genericGrantMsg(granter.seiAddress, grantee.seiAddress);
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

      const grantMsg = genericGrantMsg(granter.seiAddress, grantee.seiAddress);
      const grantResult = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [grantMsg], fee, 'grant for grantee'
      );
      expect(grantResult.code).to.be.eq(0);

      const sendMsg = MsgSend.fromPartial({
        fromAddress: granter.seiAddress,
        toAddress: wrongUser.seiAddress,
        amount: [{ denom: 'usei', amount: SMALL_AUTHZ_SEND_AMOUNT }],
      });
      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: MsgSend.encode(sendMsg).finish(),
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

  describe('Edge Cases', function () {
    it('Exec with an empty message list is rejected', async () => {
      const execMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: {
          grantee: grantee.seiAddress,
          msgs: [],
        },
      };
      await expectFailure(
        grantee.seiWallet.signingClient.signAndBroadcast(
          grantee.seiAddress, [execMsg], fee, 'empty exec'
        ),
        'empty',
        'authz exec with no messages'
      );
    });

    it('A grant with a past expiration is accepted but can never be executed', async () => {
      // sei-cosmos (SDK 0.45) does not validate expiration at grant time, so
      // the grant tx itself lands. The edge case that matters: the already
      // expired authorization must not authorize anything.
      const pastExpiration = {
        seconds: BigInt(Math.floor(Date.now() / 1000) - 3600),
        nanos: 0,
      };
      const grantMsg = genericGrantMsg(
        granter.seiAddress, grantee.seiAddress, AUTHZ_MSG_TYPE, pastExpiration
      );
      const grantResult = await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [grantMsg], fee, 'past expiration grant'
      );
      expect(grantResult.code).to.be.eq(0);

      const sendMsg = MsgSend.fromPartial({
        fromAddress: granter.seiAddress,
        toAddress: grantee.seiAddress,
        amount: [{ denom: 'usei', amount: SMALL_AUTHZ_SEND_AMOUNT }],
      });
      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: MsgSend.encode(sendMsg).finish(),
      });
      const execMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgExec",
        value: {
          grantee: grantee.seiAddress,
          msgs: [anyMsgSend],
        },
      };
      const execResult = await grantee.seiWallet.signingClient.signAndBroadcast(
        grantee.seiAddress, [execMsg], fee, 'exec expired grant'
      );
      expect(execResult.code, 'exec under expired grant must fail').to.not.be.eq(0);

      // Best-effort cleanup: the stale grant may already have been pruned.
      const revokeMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
        value: MsgRevoke.fromPartial({
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          msgTypeUrl: AUTHZ_MSG_TYPE,
        }),
      };
      await granter.seiWallet.signingClient.signAndBroadcast(
        granter.seiAddress, [revokeMsg], fee, 'cleanup stale grant'
      ).catch(() => undefined);
    });

    it('Re-granting the same message type overwrites instead of duplicating', async () => {
      const regrantGranter = await UserFactory.createSeiUser(admin, 'authzRegrantGranter');
      const regrantGrantee = await UserFactory.createSeiUser(admin, 'authzRegrantGrantee');

      const firstGrant = await regrantGranter.seiWallet.signingClient.signAndBroadcast(
        regrantGranter.seiAddress,
        [genericGrantMsg(regrantGranter.seiAddress, regrantGrantee.seiAddress)],
        fee, 'regrant 1'
      );
      expect(firstGrant.code).to.be.eq(0);

      const laterExpiration = {
        seconds: AUTHZ_EXPIRATION_TIMESTAMP.seconds + BigInt(365 * 24 * 3600),
        nanos: 0,
      };
      const secondGrant = await regrantGranter.seiWallet.signingClient.signAndBroadcast(
        regrantGranter.seiAddress,
        [genericGrantMsg(regrantGranter.seiAddress, regrantGrantee.seiAddress, AUTHZ_MSG_TYPE, laterExpiration)],
        fee, 'regrant 2'
      );
      expect(secondGrant.code).to.be.eq(0);

      const grants = await queryGranteeGrants(regrantGrantee.seiAddress);
      const matching = grants.grants.filter(
        (g: any) => g.granter === regrantGranter.seiAddress && authzMsg(g) === AUTHZ_MSG_TYPE
      );
      expect(matching).to.have.length(1);

      const revokeMsg = {
        typeUrl: "/cosmos.authz.v1beta1.MsgRevoke",
        value: MsgRevoke.fromPartial({
          granter: regrantGranter.seiAddress,
          grantee: regrantGrantee.seiAddress,
          msgTypeUrl: AUTHZ_MSG_TYPE,
        }),
      };
      await regrantGranter.seiWallet.signingClient.signAndBroadcast(
        regrantGranter.seiAddress, [revokeMsg], fee, 'regrant cleanup'
      );
    });
  });

  describe('Cross-Runtime Consistency', function () {
    before(async () => {
      const grantResult = await execCommandAndReturnJson(
        `seid tx authz grant ${grantee.seiAddress} generic --msg-type ${AUTHZ_MSG_TYPE} --expiration ${AUTHZ_EXPIRATION_UNIX} --from authzGranter --fees ${CLI_FEE} -y --broadcast-mode block`
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
      const queryResponse = await queryGranteeGrants(grantee.seiAddress);

      expect(cliResult.grants).to.be.an('array');
      expect(cliResult.grants).to.have.length.gte(1);

      const queryGrant = queryResponse.grants.find(
        (g: any) => g.granter === granter.seiAddress && g.grantee === grantee.seiAddress
      );
      expect(queryGrant).to.not.be.undefined;
      expect(authzMsg(queryGrant)).to.be.eq(AUTHZ_MSG_TYPE);

      const cliGrant = cliResult.grants.find(
        (g: any) => authzMsg(g) === AUTHZ_MSG_TYPE
      );
      expect(cliGrant).to.not.be.undefined;
      expect(queryGrant!.granter).to.be.eq(granter.seiAddress);
      expect(queryGrant!.grantee).to.be.eq(grantee.seiAddress);
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
      const grantMsg = genericGrantMsg(lcGranter.seiAddress, lcGrantee.seiAddress);
      const grantResult = await lcGranter.seiWallet.signingClient.signAndBroadcast(
        lcGranter.seiAddress, [grantMsg], fee, 'lifecycle grant'
      );
      expect(grantResult.code).to.be.eq(0);

      const grantsResponse = await queryGranteeGrants(lcGrantee.seiAddress);
      const activeGrant = grantsResponse.grants.find(
        (g: any) => g.granter === lcGranter.seiAddress
      );
      expect(activeGrant).to.not.be.undefined;
      expect(authzMsg(activeGrant)).to.be.eq(AUTHZ_MSG_TYPE);

      const granterPreBalance = await queryBalance(lcGranter.seiAddress, 'usei');

      const sendMsg = MsgSend.fromPartial({
        fromAddress: lcGranter.seiAddress,
        toAddress: lcGrantee.seiAddress,
        amount: [{ denom: 'usei', amount: LIFECYCLE_SEND_AMOUNT }],
      });
      const anyMsgSend = Any.fromPartial({
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: MsgSend.encode(sendMsg).finish(),
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
      expect(execResult.code, execResult.rawLog).to.be.eq(0);

      const granterPostBalance = await queryBalance(lcGranter.seiAddress, 'usei');
      expect(
        Number(granterPreBalance.amount) - Number(granterPostBalance.amount)
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

      const postRevokeGrants = await queryGranteeGrants(lcGrantee.seiAddress);
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
