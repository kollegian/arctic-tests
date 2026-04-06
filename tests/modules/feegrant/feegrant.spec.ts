import { coins } from '@cosmjs/stargate';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { Querier } from '@sei-js/cosmos/rest';

import { SeiUser, UserFactory } from '../../../shared/User';
import testConfig from '../../../config/testConfig.json';
import { BasicAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/feegrant';
import { MsgGrantAllowance } from 'cosmjs-types/cosmos/feegrant/v1beta1/tx';
import ExpectStatic = Chai.ExpectStatic;

let expect: ExpectStatic;
const restEndpoint = testConfig.restEndpoint;
const fee = { amount: coins(24000, 'usei'), gas: '500000' };

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
        `seid tx feegrant grant fgPayer ${payee.seiAddress} --spend-limit 300000usei --from fgPayer --fees 24200usei -y --broadcast-mode block`
      );
      expect(result.code).to.be.eq(0);
    });

    it('Query allowance via seid CLI', async () => {
      const result = await execCommandAndReturnJson(
        `seid q feegrant grant ${payer.seiAddress} ${payee.seiAddress}`
      );
      expect(result.allowance).to.exist;
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
        `seid tx feegrant revoke fgPayer ${payee.seiAddress} --from fgPayer --fees 24200usei -y --broadcast-mode block`
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
            spendLimit: [{ denom: "usei", amount: "300000" }],
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
      expect(result.code).to.be.eq(0);
    });

    it('Granter pays for grantee fee', async () => {
      const payeePreBalance = await Querier.cosmos.bank.v1beta1.Balance({
        address: payee.seiAddress,
        denom: 'usei'
      }, { pathPrefix: restEndpoint });
      const payerPreBalance = await Querier.cosmos.bank.v1beta1.Balance({
        address: payer.seiAddress,
        denom: 'usei'
      }, { pathPrefix: restEndpoint });

      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: payee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: "usei", amount: "1000" }]
        }
      };
      const grantedFee = {
        amount: coins(24000, 'usei'),
        gas: "500000",
        granter: payer.seiAddress,
      };
      const result = await payee.seiWallet.signingClient.signAndBroadcast(
        payee.seiAddress, [msgSend], grantedFee, 'feegrant tx'
      );
      expect(result.code).to.be.eq(0);

      const payeeAfterBalance = await Querier.cosmos.bank.v1beta1.Balance({
        address: payee.seiAddress,
        denom: 'usei'
      }, { pathPrefix: restEndpoint });
      const payerAfterBalance = await Querier.cosmos.bank.v1beta1.Balance({
        address: payer.seiAddress,
        denom: 'usei'
      }, { pathPrefix: restEndpoint });

      expect(Number(payeePreBalance.balance!.amount) - Number(payeeAfterBalance.balance!.amount)).to.be.eq(1000);
      expect(Number(payerPreBalance.balance!.amount) - Number(payerAfterBalance.balance!.amount)).to.be.eq(24000);
    });

    it('Query allowance via Querier', async () => {
      const response = await Querier.cosmos.feegrant.v1beta1.Allowance({
        granter: payer.seiAddress,
        grantee: payee.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.allowance!.granter).to.be.eq(payer.seiAddress);
      expect(response.allowance!.grantee).to.be.eq(payee.seiAddress);
      expect(response.allowance!.allowance!.spend_limit).to.have.length(1);
      expect(response.allowance!.allowance!.spend_limit[0].denom).to.be.eq('usei');
      expect(Number(response.allowance!.allowance!.spend_limit[0].amount)).to.be.gt(0);
      expect(Number(response.allowance!.allowance!.spend_limit[0].amount)).to.be.lt(300000);
    });

    it('Query allowances via Querier', async () => {
      const response = await Querier.cosmos.feegrant.v1beta1.Allowances({
        grantee: payee.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.allowances[0].granter).to.be.eq(payer.seiAddress);
      expect(response.allowances[0].grantee).to.be.eq(payee.seiAddress);
      expect(response.allowances[0].allowance!.spend_limit).to.have.length(1);
      expect(response.allowances[0].allowance!.spend_limit[0].denom).to.be.eq('usei');
      expect(Number(response.allowances[0].allowance!.spend_limit[0].amount)).to.be.gt(0);
    });

    it('Query by granter via Querier', async () => {
      const response = await Querier.cosmos.feegrant.v1beta1.AllowancesByGranter({
        granter: payer.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.allowances[0].granter).to.be.eq(payer.seiAddress);
      expect(response.allowances[0].grantee).to.be.eq(payee.seiAddress);
      expect(response.allowances[0].allowance!.spend_limit).to.have.length(1);
      expect(response.allowances[0].allowance!.spend_limit[0].denom).to.be.eq('usei');
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
      const response = await Querier.cosmos.feegrant.v1beta1.Allowances({
        grantee: payee.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.allowances).to.have.length(0);
    });

    it('Query by granter after revoke', async () => {
      const response = await Querier.cosmos.feegrant.v1beta1.AllowancesByGranter({
        granter: payer.seiAddress
      }, { pathPrefix: restEndpoint });
      expect(response.allowances).to.have.length(0);
    });

    it('Grantee cannot use revoked allowance for fee', async () => {
      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: payee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: "usei", amount: "100" }]
        }
      };
      const grantedFee = {
        amount: coins(24000, 'usei'),
        gas: "500000",
        granter: payer.seiAddress,
      };
      try {
        await payee.seiWallet.signingClient.signAndBroadcast(
          payee.seiAddress, [msgSend], grantedFee, 'revoked feegrant tx'
        );
        expect.fail('Should have failed with revoked grant');
      } catch (e: any) {
        expect(e.message).to.contain('not found');
      }
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
              spendLimit: [{ denom: "usei", amount: "300000" }],
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
      const result = await payer.seiWallet.signingClient.signAndBroadcast(
        payer.seiAddress, [grantMsg], fee, 'self grant'
      );
      expect(result.code).to.not.be.eq(0);
    });

    it('Cannot grant with zero spend limit (CosmJS)', async () => {
      const zeroAllowance = {
        typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
        value: Uint8Array.from(
          BasicAllowance.encode(
            BasicAllowance.fromPartial({
              spendLimit: [{ denom: "usei", amount: "0" }],
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
      try {
        const result = await payer.seiWallet.signingClient.signAndBroadcast(
          payer.seiAddress, [grantMsg], fee, 'zero spend grant'
        );
        expect(result.code).to.not.be.eq(0);
      } catch (e: any) {
        expect(e.message).to.exist;
      }
    });

    it('Grantee cannot exceed spend limit', async () => {
      const smallAllowance = {
        typeUrl: "/cosmos.feegrant.v1beta1.BasicAllowance",
        value: Uint8Array.from(
          BasicAllowance.encode(
            BasicAllowance.fromPartial({
              spendLimit: [{ denom: "usei", amount: "1000" }],
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
          amount: [{ denom: "usei", amount: "100" }]
        }
      };
      const grantedFee = {
        amount: coins(24000, 'usei'),
        gas: "500000",
        granter: payer.seiAddress,
      };
      try {
        await payee.seiWallet.signingClient.signAndBroadcast(
          payee.seiAddress, [msgSend], grantedFee, 'exceed limit'
        );
        expect.fail('Should have failed exceeding spend limit');
      } catch (e: any) {
        expect(e.message).to.exist;
      }

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
          amount: [{ denom: "usei", amount: "100" }]
        }
      };
      const grantedFee = {
        amount: coins(24000, 'usei'),
        gas: "500000",
        granter: unrelatedUser.seiAddress,
      };
      try {
        await payee.seiWallet.signingClient.signAndBroadcast(
          payee.seiAddress, [msgSend], grantedFee, 'unrelated granter'
        );
        expect.fail('Should have failed with unrelated granter');
      } catch (e: any) {
        expect(e.message).to.contain('not found');
      }
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
              spendLimit: [{ denom: "usei", amount: "300000" }],
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
          amount: [{ denom: "usei", amount: "100" }]
        }
      };
      const grantedFee = {
        amount: coins(24000, 'usei'),
        gas: "500000",
        granter: bvPayer.seiAddress,
      };
      const sendResult = await bvPayee.seiWallet.signingClient.signAndBroadcast(
        bvPayee.seiAddress, [msgSend], grantedFee, 'bv use grant'
      );
      expect(sendResult.code).to.be.eq(0);

      const response = await Querier.cosmos.feegrant.v1beta1.Allowance({
        granter: bvPayer.seiAddress,
        grantee: bvPayee.seiAddress
      }, { pathPrefix: restEndpoint });
      const remaining = Number(response.allowance!.allowance!.spend_limit[0].amount);
      expect(remaining).to.be.eq(276000);
    });

    it('Multiple fee uses deplete allowance', async () => {
      const response1 = await Querier.cosmos.feegrant.v1beta1.Allowance({
        granter: bvPayer.seiAddress,
        grantee: bvPayee.seiAddress
      }, { pathPrefix: restEndpoint });
      const remainingBefore = Number(response1.allowance!.allowance!.spend_limit[0].amount);

      const msgSend = {
        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
        value: {
          fromAddress: bvPayee.seiAddress,
          toAddress: admin.seiAddress,
          amount: [{ denom: "usei", amount: "100" }]
        }
      };
      const grantedFee = {
        amount: coins(24000, 'usei'),
        gas: "500000",
        granter: bvPayer.seiAddress,
      };

      const result1 = await bvPayee.seiWallet.signingClient.signAndBroadcast(
        bvPayee.seiAddress, [msgSend], grantedFee, 'deplete 1'
      );
      expect(result1.code).to.be.eq(0);

      const response2 = await Querier.cosmos.feegrant.v1beta1.Allowance({
        granter: bvPayer.seiAddress,
        grantee: bvPayee.seiAddress
      }, { pathPrefix: restEndpoint });
      const remainingAfterFirst = Number(response2.allowance!.allowance!.spend_limit[0].amount);
      expect(remainingAfterFirst).to.be.eq(remainingBefore - 24000);

      const result2 = await bvPayee.seiWallet.signingClient.signAndBroadcast(
        bvPayee.seiAddress, [msgSend], grantedFee, 'deplete 2'
      );
      expect(result2.code).to.be.eq(0);

      const response3 = await Querier.cosmos.feegrant.v1beta1.Allowance({
        granter: bvPayer.seiAddress,
        grantee: bvPayee.seiAddress
      }, { pathPrefix: restEndpoint });
      const remainingAfterSecond = Number(response3.allowance!.allowance!.spend_limit[0].amount);
      expect(remainingAfterSecond).to.be.eq(remainingAfterFirst - 24000);
    });
  });

  describe('Cross-Runtime Consistency', function () {
    let xrPayer: SeiUser;
    let xrPayee: SeiUser;

    before(async () => {
      xrPayer = await UserFactory.createSeiUser(admin, 'fgXrPayer');
      xrPayee = await UserFactory.createSeiUser(admin, 'fgXrPayee');
      const grantResult = await execCommandAndReturnJson(
        `seid tx feegrant grant fgXrPayer ${xrPayee.seiAddress} --spend-limit 500000usei --from fgXrPayer --fees 24200usei -y --broadcast-mode block`
      );
      expect(grantResult.code).to.be.eq(0);
    });

    it('CLI grant query matches Querier allowance query', async () => {
      const cliResult = await execCommandAndReturnJson(
        `seid q feegrant grant ${xrPayer.seiAddress} ${xrPayee.seiAddress}`
      );
      const restResponse = await Querier.cosmos.feegrant.v1beta1.Allowance({
        granter: xrPayer.seiAddress,
        grantee: xrPayee.seiAddress
      }, { pathPrefix: restEndpoint });

      expect(restResponse.allowance!.granter).to.be.eq(xrPayer.seiAddress);
      expect(restResponse.allowance!.grantee).to.be.eq(xrPayee.seiAddress);

      const cliAllowance = cliResult.allowance;
      expect(cliAllowance).to.exist;

      const restSpendLimit = restResponse.allowance!.allowance!.spend_limit;
      expect(restSpendLimit).to.be.an('array');
      expect(restSpendLimit[0].denom).to.be.eq('usei');
      expect(Number(restSpendLimit[0].amount)).to.be.eq(500000);
    });
  });
});
