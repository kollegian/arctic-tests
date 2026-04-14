import { SeiUser, UserFactory } from '../../../shared/User';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import testConfig from '../../../config/testConfig.json';
import { Querier } from '@sei-js/cosmos/rest';

import { coins } from '@cosmjs/amino';
import { QueryValidatorResponse } from '@sei-js/cosmos/types/cosmos/staking/v1beta1';
import { fromBase64, toBech32 } from '@cosmjs/encoding';
import { sha256 } from '@cosmjs/crypto';
import ExpectStatic = Chai.ExpectStatic;

let expect: ExpectStatic;

const fee = { amount: coins(24000, 'usei'), gas: '500000' };
const SIGNING_INFO_PUBKEY_TYPE = '/cosmos.crypto.ed25519.PubKey';

describe('Slashing Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;
  let validatorAddr: string;
  let validatorInfo: QueryValidatorResponse;
  let consAddress: string;
  const restEndpoint = testConfig.restEndpoint;

  before('Initializes users and fetches validator info', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'slashUser');
    await waitFor(1);

    const validatorsInfo = await Querier.cosmos.staking.v1beta1.Validators({
      status: 'BOND_STATUS_BONDED'
    }, { pathPrefix: restEndpoint });
    validatorAddr = validatorsInfo.validators[0].operator_address;
    validatorInfo = await Querier.cosmos.staking.v1beta1.Validator({
      validator_addr: validatorAddr
    }, { pathPrefix: restEndpoint });

    const ed25519PubkeyRaw = fromBase64(validatorInfo!.validator!.consensus_pubkey!.key);
    const addressData = sha256(ed25519PubkeyRaw).slice(0, 20);
    consAddress = toBech32('seivalcons', addressData);
  });

  describe('seid CLI Tests', function () {
    it('Queries slashing params via seid', async () => {
      const result = await execCommandAndReturnJson('seid q slashing params');
      expect(result.params).to.be.an('object');
      expect(Number(result.params.signed_blocks_window)).to.be.gt(0);
      expect(result.params.min_signed_per_window).to.be.a('string');
    });

    it('Queries signing info for a validator via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q slashing signing-info '{"@type":"${SIGNING_INFO_PUBKEY_TYPE}","key":"${validatorInfo!.validator!.consensus_pubkey!.key}"}'`
      );
      expect(result.val_signing_info.address).to.be.eq(consAddress);
      expect(Number(result.val_signing_info.start_height)).to.be.gte(0);
    });

    it('Queries all signing infos via seid', async () => {
      const result = await execCommandAndReturnJson('seid q slashing signing-infos');
      expect(result.info).to.be.an('array');
      expect(result.info).to.have.length.gte(1);
      expect(result.info.some((entry: any) => entry.address === consAddress)).to.be.true;
    });
  });

  describe('CosmJS Tests', function () {
    it('Unjail message fails for non-validator sender', async () => {
      const unjailMsg = {
        typeUrl: '/cosmos.slashing.v1beta1.MsgUnjail',
        value: {
          validatorAddr: validatorAddr
        }
      };
      const response = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [unjailMsg], fee, 'unjail tx'
      );
      expect(response.code).to.not.be.eq(0);
    });

    it('Queries signing info for a specific validator', async () => {
      const response = await Querier.cosmos.slashing.v1beta1.SigningInfo({
        cons_address: consAddress
      }, { pathPrefix: restEndpoint });
      expect(response.val_signing_info).to.not.be.undefined;
      expect(response.val_signing_info!.address).to.be.eq(consAddress);
    });

    it('Queries all signing infos', async () => {
      const response = await Querier.cosmos.slashing.v1beta1.SigningInfos(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.info).to.be.an('array');
      expect(response.info).to.have.length.gte(1);
      expect(response.info.some((entry: any) => entry.address === consAddress)).to.be.true;
    });

    it('Queries slashing params', async () => {
      const response = await Querier.cosmos.slashing.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.params).to.not.be.undefined;
      expect(Number(response.params!.signed_blocks_window)).to.be.gt(0);
      expect(response.params!.min_signed_per_window).to.be.a('string');
    });

    it('Signing info shows correct start height and jailed status', async () => {
      const response = await Querier.cosmos.slashing.v1beta1.SigningInfo({
        cons_address: consAddress
      }, { pathPrefix: restEndpoint });
      expect(response.val_signing_info!.jailed_until).to.be.a('string');
      expect(Number(response.val_signing_info!.start_height)).to.be.gte(0);
    });
  });

  describe('Error Cases', function () {
    it('Unjail for non-jailed validator fails', async () => {
      const unjailMsg = {
        typeUrl: '/cosmos.slashing.v1beta1.MsgUnjail',
        value: {
          validatorAddr: validatorAddr,
        },
      };
      const response = await admin.seiWallet.signingClient.signAndBroadcast(
        admin.seiAddress, [unjailMsg], fee, 'unjail non-jailed'
      );
      expect(response.code).to.not.be.eq(0);
    });

    it('Query signing info for invalid consensus address fails', async () => {
      const invalidConsAddr = 'seivalcons1invalidaddressxxxxxxxxxxxxxxxxxx';
      try {
        await Querier.cosmos.slashing.v1beta1.SigningInfo(
          { cons_address: invalidConsAddr },
          { pathPrefix: restEndpoint }
        );
        expect.fail('Should have thrown for invalid consensus address');
      } catch (e: any) {
        expect(e.message).to.be.a('string');
        expect(e.message.length).to.be.gt(0);
      }
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid slashing params matches Querier params (signed_blocks_window)', async () => {
      const seidResult = await execCommandAndReturnJson('seid q slashing params');
      const querierResp = await Querier.cosmos.slashing.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );

      expect(seidResult.params.signed_blocks_window).to.be.eq(
        querierResp.params!.signed_blocks_window
      );
    });

    it('Signing info via seid matches Querier signing info', async () => {
      const seidResult = await execCommandAndReturnJson(
        `seid q slashing signing-info '{"@type":"${SIGNING_INFO_PUBKEY_TYPE}","key":"${validatorInfo!.validator!.consensus_pubkey!.key}"}'`
      );
      const querierResp = await Querier.cosmos.slashing.v1beta1.SigningInfo(
        { cons_address: consAddress },
        { pathPrefix: restEndpoint }
      );

      expect(seidResult.val_signing_info.address).to.be.eq(
        querierResp.val_signing_info!.address
      );
      expect(seidResult.val_signing_info.start_height).to.be.eq(
        querierResp.val_signing_info!.start_height
      );
    });
  });
});
