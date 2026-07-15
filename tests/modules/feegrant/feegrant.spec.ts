import { coins, createProtobufRpcClient } from '@cosmjs/stargate';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { Querier } from '@sei-js/cosmos/rest';

import { SeiUser, UserFactory } from '../../../shared/User';
import { waitFor } from '../../../shared/utils/helpers';
import { BasicAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import { MsgGrantAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import { QueryClientImpl as FeegrantQueryClientImpl } from 'cosmjs-types/cosmos/feegrant/v1beta1/query';
import ExpectStatic = Chai.ExpectStatic;
import { expectFailure, expectTxSuccess, expectUseiCoin } from '../moduleTestUtils';
import { getRpcQueryClient, moduleRestEndpoint, toSnakeCase, withRestFallback } from '../utils/rpcQueryClient';

let expect: ExpectStatic;
const fee = { amount: coins(50000, 'usei'), gas: '500000' };
const CLI_FEE = '24200usei';
const FEE_GRANT_GAS = '500000';
const FEE_GRANT_FEE_AMOUNT = 50000;
const BASIC_SPEND_LIMIT = '300000';
const CROSS_RUNTIME_SPEND_LIMIT = '500000';
const SMALL_SPEND_LIMIT = '1000';
const SEND_AMOUNT = '1000';
const MICRO_SEND_AMOUNT = '100';
const USEI_DENOM = 'usei';

function feegrantGrant(result: any) {
  return result.allowance?.granter ? result.allowance : result;
}

function basicAllowance(grant: any) {
  return grant.allowance?.spend_limit ? grant.allowance : grant.allowance?.allowance;
}

// cosmjs returns the inner `allowance` field as a raw protobuf `Any`
// (`{ typeUrl, value: Uint8Array }`); REST decodes it into a JSON object with
// `spend_limit`, `expiration`, etc. This decodes the Any into the REST-shaped
// BasicAllowance so downstream assertions work for both code paths.
function decodeGrantAllowance(grant: any): any {
  if (!grant || !grant.allowance) return grant;
  const inner = grant.allowance;
  if (inner.value instanceof Uint8Array) {
    grant.allowance = toSnakeCase(BasicAllowance.decode(inner.value));
  }
  return grant;
}

const queryAllowance = (granter: string, grantee: string) =>
  withRestFallback(
    'feegrant.allowance',
    async () => {
      // cosmjs's feegrant.allowance already returns the full RPC response
      // ({ allowance: Grant | undefined }), not the unwrapped Grant — so we
      // only need to decode the inner Any and snake-case the keys.
      const resp = await (await getRpcQueryClient()).feegrant.allowance(granter, grantee);
      if (resp?.allowance) decodeGrantAllowance(resp.allowance);
      return toSnakeCase(resp);
    },
    () =>
      Querier.cosmos.feegrant.v1beta1.Allowance(
        { granter, grantee },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryAllowances = (grantee: string) =>
  withRestFallback(
    'feegrant.allowances',
    async () => {
      const resp = await (await getRpcQueryClient()).feegrant.allowances(grantee);
      const allowances = (resp.allowances ?? []).map((g: any) => decodeGrantAllowance(g));
      return toSnakeCase({ allowances, pagination: resp.pagination });
    },
    () =>
      Querier.cosmos.feegrant.v1beta1.Allowances(
        { grantee },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryAllowancesByGranter = (granter: string) =>
  withRestFallback(
    'feegrant.allowancesByGranter',
    async () => {
      // cosmjs's setupFeegrantExtension does not expose AllowancesByGranter, so
      // fall back to the raw protobuf RPC client built on top of our base
      // QueryClient. Same Tendermint connection — no extra REST hop.
      const client = await getRpcQueryClient();
      const rpc = createProtobufRpcClient(client);
      const queryService = new FeegrantQueryClientImpl(rpc);
      const resp = await queryService.AllowancesByGranter({ granter });
      const allowances = (resp.allowances ?? []).map((g: any) => decodeGrantAllowance(g));
      return toSnakeCase({ allowances, pagination: resp.pagination });
    },
    () =>
      Querier.cosmos.feegrant.v1beta1.AllowancesByGranter(
        { granter },
        { pathPrefix: moduleRestEndpoint },
      ),
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

describe('Feegrant Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let payer: SeiUser;
  let payee: SeiUser;

  before(async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    payer = await UserFactory.createSeiUser(admin, 'fgPayer');
    payee = await UserFactory.createSeiUser(admin, 'fgPayee');
  });

  describe('seid CLI Tests', function () {
    it('Grant basic allowance via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx feegrant grant fgPayer ${payee.seiAddress} --spend-limit ${BASIC_SPEND_LIMIT}${USEI_DENOM} --from fgPayer --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query allowance via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q feegrant grant ${payer.seiAddress} ${payee.seiAddress}`
      );
      const grant = feegrantGrant(result);
      const allowance = basicAllowance(grant);
      expect(grant.granter).to.be.eq(payer.seiAddress);
      expect(grant.grantee).to.be.eq(payee.seiAddress);
      expect(allowance.spend_limit[0].denom).to.be.eq(USEI_DENOM);
      expect(allowance.spend_limit[0].amount).to.be.eq(BASIC_SPEND_LIMIT);
    });

    it('Query grants-by-grantee via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q feegrant grants-by-grantee ${payee.seiAddress}`
      );
      expect(result.allowances).to.be.an('array');
      expect(result.allowances).to.have.length.gte(1);
    });

    it('Query grants-by-granter via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q feegrant grants-by-granter ${payer.seiAddress}`
      );
      expect(result.allowances).to.be.an('array');
      expect(result.allowances).to.have.length.gte(1);
    });

    it('Revoke allowance via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx feegrant revoke fgPayer ${payee.seiAddress} --from fgPayer --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query after revoke via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q feegrant grants-by-grantee ${payee.seiAddress}`
      );
      expect(result.allowances).to.have.length(0);
    });
  });

  describe('CosmJS Tests', function () {
    const allowance = {
      typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
      value: Uint8Array.from(
        BasicAllowance.encode(
          BasicAllowance.fromPartial({
            spendLimit: [{ denom: USEI_DENOM, amount: BASIC_SPEND_LIMIT }],
          }),
        ).finish(),
      ),
    };

    it('Grant fee allowance', async () => {
      const grantMsg = {
        typeUrl: `/cosmos.feegrant.v1beta1.MsgGrantAllowance`,
        value: MsgGrantAllowance.fromPartial({
          granter: payer.seiAddress,
          grantee: payee.seiAddress,
          allowance: allowance,
        }),
      };
      const result = await payer.seiWallet.signingClient.signAndBroadcast(
        payer.seiAddress, [grantMsg], fee, 'fee grant'
      );
      expectTxSuccess(result, 'fee grant');
    });

    it('Granter pays for grantee fee', async () => {
      const payeePreBalance = await queryBalance(payee.seiAddress, 'usei');
      const payerPreBalance = await queryBalance(payer.seiAddress, 'usei');

      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: payee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: USEI_DENOM, amount: SEND_AMOUNT }]
        }
      };
      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: payer.seiAddress,
      };
      const result = await payee.seiWallet.signingClient.signAndBroadcast(
        payee.seiAddress, [msgSend], grantedFee, 'feegrant tx'
      );
      expectTxSuccess(result, 'fee-granted send');

      const payeeAfterBalance = await queryBalance(payee.seiAddress, 'usei');
      const payerAfterBalance = await queryBalance(payer.seiAddress, 'usei');

      expect(Number(payeePreBalance.amount) - Number(payeeAfterBalance.amount)).to.be.eq(Number(SEND_AMOUNT));
      expect(Number(payerPreBalance.amount) - Number(payerAfterBalance.amount)).to.be.eq(FEE_GRANT_FEE_AMOUNT);
      expectUseiCoin(payeeAfterBalance);
      expectUseiCoin(payerAfterBalance);
    });

    it('Query allowance via Querier', async () => {
      const response = await queryAllowance(payer.seiAddress, payee.seiAddress);
      expect(response.allowance!.granter).to.be.eq(payer.seiAddress);
      expect(response.allowance!.grantee).to.be.eq(payee.seiAddress);
      expect(response.allowance!.allowance!.spend_limit).to.have.length(1);
      expect(response.allowance!.allowance!.spend_limit[0].denom).to.be.eq(USEI_DENOM);
      expect(Number(response.allowance!.allowance!.spend_limit[0].amount)).to.be.gt(0);
      expect(Number(response.allowance!.allowance!.spend_limit[0].amount)).to.be.lt(Number(BASIC_SPEND_LIMIT));
    });

    it('Query allowances via Querier', async () => {
      const response = await queryAllowances(payee.seiAddress);
      expect(response.allowances[0].granter).to.be.eq(payer.seiAddress);
      expect(response.allowances[0].grantee).to.be.eq(payee.seiAddress);
      expect(response.allowances[0].allowance!.spend_limit).to.have.length(1);
      expect(response.allowances[0].allowance!.spend_limit[0].denom).to.be.eq(USEI_DENOM);
      expect(Number(response.allowances[0].allowance!.spend_limit[0].amount)).to.be.gt(0);
    });

    it('Query by granter via Querier', async () => {
      const response = await queryAllowancesByGranter(payer.seiAddress);
      expect(response.allowances[0].granter).to.be.eq(payer.seiAddress);
      expect(response.allowances[0].grantee).to.be.eq(payee.seiAddress);
      expect(response.allowances[0].allowance!.spend_limit).to.have.length(1);
      expect(response.allowances[0].allowance!.spend_limit[0].denom).to.be.eq(USEI_DENOM);
    });

    it('Revoke allowance', async () => {
      const revokeMsg = {
        typeUrl: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
        value: {
          granter: payer.seiAddress,
          grantee: payee.seiAddress,
        },
      };
      const result = await payer.seiWallet.signingClient.signAndBroadcast(
        payer.seiAddress, [revokeMsg], fee, 'fee revoke'
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query allowances after revoke', async () => {
      const response = await queryAllowances(payee.seiAddress);
      expect(response.allowances).to.have.length(0);
    });

    it('Query by granter after revoke', async () => {
      const response = await queryAllowancesByGranter(payer.seiAddress);
      expect(response.allowances).to.have.length(0);
    });

    it('Grantee cannot use revoked allowance for fee', async () => {
      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: payee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: USEI_DENOM, amount: MICRO_SEND_AMOUNT }]
        }
      };
      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: payer.seiAddress,
      };
      await expectFailure(
        payee.seiWallet.signingClient.signAndBroadcast(
          payee.seiAddress, [msgSend], grantedFee, 'revoked feegrant tx'
        ),
        'not found',
        'send using revoked feegrant'
      );
    });

    it('Cannot revoke non-existent allowance', async () => {
      const revokeMsg = {
        typeUrl: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
        value: {
          granter: payer.seiAddress,
          grantee: payee.seiAddress,
        },
      };
      const result = await payer.seiWallet.signingClient.signAndBroadcast(
        payer.seiAddress, [revokeMsg], fee, 'revoke nonexistent'
      );
      expect(result.code).to.not.be.eq(0);
    });
  });

  describe('Error Cases', function () {
    it('Cannot grant allowance to self (CosmJS)', async () => {
      const selfAllowance = {
        typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
        value: Uint8Array.from(
          BasicAllowance.encode(
            BasicAllowance.fromPartial({
              spendLimit: [{ denom: USEI_DENOM, amount: BASIC_SPEND_LIMIT }],
            }),
          ).finish(),
        ),
      };
      const grantMsg = {
        typeUrl: `/cosmos.feegrant.v1beta1.MsgGrantAllowance`,
        value: MsgGrantAllowance.fromPartial({
          granter: payer.seiAddress,
          grantee: payer.seiAddress,
          allowance: selfAllowance,
        }),
      };
      await expectFailure(
        payer.seiWallet.signingClient.signAndBroadcast(
          payer.seiAddress, [grantMsg], fee, 'self grant'
        ),
        'cannot self-grant fee authorization',
        'self feegrant'
      );
    });

    it('Cannot grant with zero spend limit (CosmJS)', async () => {
      const zeroAllowance = {
        typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
        value: Uint8Array.from(
          BasicAllowance.encode(
            BasicAllowance.fromPartial({
              spendLimit: [{ denom: USEI_DENOM, amount: "0" }],
            }),
          ).finish(),
        ),
      };
      const grantMsg = {
        typeUrl: `/cosmos.feegrant.v1beta1.MsgGrantAllowance`,
        value: MsgGrantAllowance.fromPartial({
          granter: payer.seiAddress,
          grantee: payee.seiAddress,
          allowance: zeroAllowance,
        }),
      };
      await expectFailure(
        payer.seiWallet.signingClient.signAndBroadcast(
          payer.seiAddress, [grantMsg], fee, 'zero spend grant'
        ),
        undefined,
        'feegrant with zero spend limit'
      );
    });

    it('Grantee cannot exceed spend limit', async () => {
      const smallAllowance = {
        typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
        value: Uint8Array.from(
          BasicAllowance.encode(
            BasicAllowance.fromPartial({
              spendLimit: [{ denom: USEI_DENOM, amount: SMALL_SPEND_LIMIT }],
            }),
          ).finish(),
        ),
      };
      const grantMsg = {
        typeUrl: `/cosmos.feegrant.v1beta1.MsgGrantAllowance`,
        value: MsgGrantAllowance.fromPartial({
          granter: payer.seiAddress,
          grantee: payee.seiAddress,
          allowance: smallAllowance,
        }),
      };
      const grantResult = await payer.seiWallet.signingClient.signAndBroadcast(
        payer.seiAddress, [grantMsg], fee, 'small grant'
      );
      expect(grantResult.code).to.be.eq(0);

      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: payee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: USEI_DENOM, amount: MICRO_SEND_AMOUNT }]
        }
      };
      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: payer.seiAddress,
      };
      await expectFailure(
        payee.seiWallet.signingClient.signAndBroadcast(
          payee.seiAddress, [msgSend], grantedFee, 'exceed limit'
        ),
        undefined,
        'fee exceeding feegrant spend limit'
      );

      const revokeMsg = {
        typeUrl: '/cosmos.feegrant.v1beta1.MsgRevokeAllowance',
        value: {
          granter: payer.seiAddress,
          grantee: payee.seiAddress,
        },
      };
      await payer.seiWallet.signingClient.signAndBroadcast(
        payer.seiAddress, [revokeMsg], fee, 'cleanup revoke'
      );
    });

    it('Cannot use feegrant from unrelated granter', async () => {
      const unrelatedUser = await UserFactory.createSeiUser(admin, 'fgUnrelated');

      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: payee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: USEI_DENOM, amount: MICRO_SEND_AMOUNT }]
        }
      };
      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: unrelatedUser.seiAddress,
      };
      await expectFailure(
        payee.seiWallet.signingClient.signAndBroadcast(
          payee.seiAddress, [msgSend], grantedFee, 'unrelated granter'
        ),
        'not found',
        'fee via unrelated granter'
      );
    });
  });

  describe('Edge Cases', function () {
    function basicAllowanceAny(spendLimit: string, expiration?: { seconds: bigint; nanos: number }) {
      return {
        typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
        value: Uint8Array.from(
          BasicAllowance.encode(
            BasicAllowance.fromPartial({
              spendLimit: [{ denom: USEI_DENOM, amount: spendLimit }],
              ...(expiration ? { expiration } : {}),
            }),
          ).finish(),
        ),
      };
    }

    function grantMsgFor(granter: SeiUser, grantee: SeiUser, allowanceAny: any) {
      return {
        typeUrl: `/cosmos.feegrant.v1beta1.MsgGrantAllowance`,
        value: MsgGrantAllowance.fromPartial({
          granter: granter.seiAddress,
          grantee: grantee.seiAddress,
          allowance: allowanceAny,
        }),
      };
    }

    function grantedSendMsg(grantee: SeiUser, toAddress: string) {
      return {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: grantee.seiAddress,
          toAddress,
          amount: [{ denom: USEI_DENOM, amount: MICRO_SEND_AMOUNT }]
        }
      };
    }

    it('An exactly depleted allowance is pruned and cannot be reused', async () => {
      const edPayer = await UserFactory.createSeiUser(admin, 'fgEdPayer');
      const edPayee = await UserFactory.createSeiUser(admin, 'fgEdPayee');

      // Spend limit equals exactly one fee, so a single use empties it.
      const grantResult = await edPayer.seiWallet.signingClient.signAndBroadcast(
        edPayer.seiAddress,
        [grantMsgFor(edPayer, edPayee, basicAllowanceAny(String(FEE_GRANT_FEE_AMOUNT)))],
        fee, 'exact-fee grant'
      );
      expect(grantResult.code).to.be.eq(0);

      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: edPayer.seiAddress,
      };
      const useResult = await edPayee.seiWallet.signingClient.signAndBroadcast(
        edPayee.seiAddress, [grantedSendMsg(edPayee, admin.seiAddress)], grantedFee, 'deplete exactly'
      );
      expect(useResult.code).to.be.eq(0);

      // Fully spent basic allowances are removed from state.
      const allowances = await queryAllowances(edPayee.seiAddress);
      expect(allowances.allowances).to.have.length(0);

      await expectFailure(
        edPayee.seiWallet.signingClient.signAndBroadcast(
          edPayee.seiAddress, [grantedSendMsg(edPayee, admin.seiAddress)], grantedFee, 'reuse depleted'
        ),
        'not found',
        'fee via depleted allowance'
      );
    });

    it('An expired allowance cannot be used for fees', async () => {
      const expPayer = await UserFactory.createSeiUser(admin, 'fgExpPayer');
      const expPayee = await UserFactory.createSeiUser(admin, 'fgExpPayee');

      const shortExpiration = {
        seconds: BigInt(Math.floor(Date.now() / 1000) + 5),
        nanos: 0,
      };
      const grantResult = await expPayer.seiWallet.signingClient.signAndBroadcast(
        expPayer.seiAddress,
        [grantMsgFor(expPayer, expPayee, basicAllowanceAny(BASIC_SPEND_LIMIT, shortExpiration))],
        fee, 'short-lived grant'
      );
      expect(grantResult.code).to.be.eq(0);

      await waitFor(10);

      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: expPayer.seiAddress,
      };
      await expectFailure(
        expPayee.seiWallet.signingClient.signAndBroadcast(
          expPayee.seiAddress, [grantedSendMsg(expPayee, admin.seiAddress)], grantedFee, 'use expired grant'
        ),
        'expired',
        'fee via expired allowance'
      );
    });
  });

  describe('Balance Verification', function () {
    let bvPayer: SeiUser;
    let bvPayee: SeiUser;

    before(async () => {
      bvPayer = await UserFactory.createSeiUser(admin, 'fgBvPayer');
      bvPayee = await UserFactory.createSeiUser(admin, 'fgBvPayee');
    });

    it('Grant + use + query remaining allowance', async () => {
      const grantAllowance = {
        typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
        value: Uint8Array.from(
          BasicAllowance.encode(
            BasicAllowance.fromPartial({
              spendLimit: [{ denom: USEI_DENOM, amount: BASIC_SPEND_LIMIT }],
            }),
          ).finish(),
        ),
      };
      const grantMsg = {
        typeUrl: `/cosmos.feegrant.v1beta1.MsgGrantAllowance`,
        value: MsgGrantAllowance.fromPartial({
          granter: bvPayer.seiAddress,
          grantee: bvPayee.seiAddress,
          allowance: grantAllowance,
        }),
      };
      const grantResult = await bvPayer.seiWallet.signingClient.signAndBroadcast(
        bvPayer.seiAddress, [grantMsg], fee, 'bv grant'
      );
      expect(grantResult.code).to.be.eq(0);

      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: bvPayee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: USEI_DENOM, amount: MICRO_SEND_AMOUNT }]
        }
      };
      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: bvPayer.seiAddress,
      };
      const sendResult = await bvPayee.seiWallet.signingClient.signAndBroadcast(
        bvPayee.seiAddress, [msgSend], grantedFee, 'bv use grant'
      );
      expect(sendResult.code).to.be.eq(0);

      const response = await queryAllowance(bvPayer.seiAddress, bvPayee.seiAddress);
      const remaining = Number(response.allowance!.allowance!.spend_limit[0].amount);
      expect(remaining).to.be.eq(Number(BASIC_SPEND_LIMIT) - FEE_GRANT_FEE_AMOUNT);
    });

    it('Multiple fee uses deplete allowance', async () => {
      const response1 = await queryAllowance(bvPayer.seiAddress, bvPayee.seiAddress);
      const remainingBefore = Number(response1.allowance!.allowance!.spend_limit[0].amount);

      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: bvPayee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: USEI_DENOM, amount: MICRO_SEND_AMOUNT }]
        }
      };
      const grantedFee = {
        amount: coins(FEE_GRANT_FEE_AMOUNT, USEI_DENOM),
        gas: FEE_GRANT_GAS,
        granter: bvPayer.seiAddress,
      };

      const result1 = await bvPayee.seiWallet.signingClient.signAndBroadcast(
        bvPayee.seiAddress, [msgSend], grantedFee, 'deplete 1'
      );
      expect(result1.code).to.be.eq(0);

      const response2 = await queryAllowance(bvPayer.seiAddress, bvPayee.seiAddress);
      const remainingAfterFirst = Number(response2.allowance!.allowance!.spend_limit[0].amount);
      expect(remainingAfterFirst).to.be.eq(remainingBefore - FEE_GRANT_FEE_AMOUNT);

      const result2 = await bvPayee.seiWallet.signingClient.signAndBroadcast(
        bvPayee.seiAddress, [msgSend], grantedFee, 'deplete 2'
      );
      expect(result2.code).to.be.eq(0);

      const response3 = await queryAllowance(bvPayer.seiAddress, bvPayee.seiAddress);
      const remainingAfterSecond = Number(response3.allowance!.allowance!.spend_limit[0].amount);
      expect(remainingAfterSecond).to.be.eq(remainingAfterFirst - FEE_GRANT_FEE_AMOUNT);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    let xrPayer: SeiUser;
    let xrPayee: SeiUser;

    before(async () => {
      xrPayer = await UserFactory.createSeiUser(admin, 'fgXrPayer');
      xrPayee = await UserFactory.createSeiUser(admin, 'fgXrPayee');
      const grantResult = await execCommandAndReturnJson(
        `seid tx feegrant grant fgXrPayer ${xrPayee.seiAddress} --spend-limit ${CROSS_RUNTIME_SPEND_LIMIT}${USEI_DENOM} --from fgXrPayer --fees ${CLI_FEE} -y --broadcast-mode block`
      );
      expect(grantResult.code).to.be.eq(0);
    });

    it('CLI grant query matches Querier allowance query', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q feegrant grant ${xrPayer.seiAddress} ${xrPayee.seiAddress}`
      );
      const restResponse = await queryAllowance(xrPayer.seiAddress, xrPayee.seiAddress);

      expect(restResponse.allowance!.granter).to.be.eq(xrPayer.seiAddress);
      expect(restResponse.allowance!.grantee).to.be.eq(xrPayee.seiAddress);

      const cliAllowance = feegrantGrant(cliResult);
      const cliSpendLimit = basicAllowance(cliAllowance).spend_limit;
      expect(cliAllowance.granter).to.be.eq(xrPayer.seiAddress);
      expect(cliAllowance.grantee).to.be.eq(xrPayee.seiAddress);
      expect(cliSpendLimit[0].denom).to.be.eq(USEI_DENOM);
      expect(cliSpendLimit[0].amount).to.be.eq(CROSS_RUNTIME_SPEND_LIMIT);

      const restSpendLimit = restResponse.allowance!.allowance!.spend_limit;
      expect(restSpendLimit).to.be.an('array');
      expect(restSpendLimit[0].denom).to.be.eq(USEI_DENOM);
      expect(Number(restSpendLimit[0].amount)).to.be.eq(Number(CROSS_RUNTIME_SPEND_LIMIT));
    });
  });
});
