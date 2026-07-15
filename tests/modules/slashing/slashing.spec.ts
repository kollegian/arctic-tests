import { SeiUser, UserFactory } from '../../../shared/User';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import { Querier } from '@sei-js/cosmos/rest';

import { coins } from '@cosmjs/amino';
import { QueryValidatorResponse } from '@sei-js/cosmos/types/cosmos/staking/v1beta1';
import { fromBase64, toBase64, toBech32 } from '@cosmjs/encoding';
import { sha256 } from '@cosmjs/crypto';
import { PubKey as Ed25519PubKey } from 'cosmjs-types/cosmos/crypto/ed25519/keys';
import ExpectStatic = Chai.ExpectStatic;
import { expectFailure, expectNonEmptyArray, expectValoperAddress } from '../moduleTestUtils';
import { getRpcQueryClient, moduleRestEndpoint, toSnakeCase, withRestFallback } from '../utils/rpcQueryClient';

let expect: ExpectStatic;

const fee = { amount: coins(50000, 'usei'), gas: '500000' };
const SIGNING_INFO_PUBKEY_TYPE = '/cosmos.crypto.ed25519.PubKey';

/**
 * Returns the raw 32-byte ed25519 public key bytes from a validator's
 * `consensus_pubkey` field, regardless of which transport returned it:
 *   - REST returns the JSON shape `{ '@type', key: '<base64 of raw bytes>' }`
 *   - RPC returns a protobuf `Any` `{ type_url, value: Uint8Array }` where
 *     `value` is the encoded `cosmos.crypto.ed25519.PubKey` message wrapping
 *     the raw bytes (so we have to decode it).
 */
function rawEd25519Pubkey(consensusPubkey: any): Uint8Array {
  if (consensusPubkey?.value instanceof Uint8Array) {
    return Ed25519PubKey.decode(consensusPubkey.value).key;
  }
  if (typeof consensusPubkey?.key === 'string') {
    return fromBase64(consensusPubkey.key);
  }
  throw new Error(`Unsupported consensus_pubkey shape: ${JSON.stringify(consensusPubkey)}`);
}

const queryStakingValidators = (status: string) =>
  withRestFallback(
    'staking.validators',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.validators(status as any)),
    () =>
      Querier.cosmos.staking.v1beta1.Validators(
        { status },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const queryStakingValidator = (valAddr: string) =>
  withRestFallback(
    'staking.validator',
    async () => toSnakeCase(await (await getRpcQueryClient()).staking.validator(valAddr)),
    () =>
      Querier.cosmos.staking.v1beta1.Validator(
        { validator_addr: valAddr },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const querySigningInfo = (consAddr: string) =>
  withRestFallback(
    'slashing.signingInfo',
    async () => toSnakeCase(await (await getRpcQueryClient()).slashing.signingInfo(consAddr)),
    () =>
      Querier.cosmos.slashing.v1beta1.SigningInfo(
        { cons_address: consAddr },
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const querySigningInfos = () =>
  withRestFallback(
    'slashing.signingInfos',
    async () => toSnakeCase(await (await getRpcQueryClient()).slashing.signingInfos()),
    () =>
      Querier.cosmos.slashing.v1beta1.SigningInfos(
        {},
        { pathPrefix: moduleRestEndpoint },
      ),
  );

const querySlashingParams = () =>
  withRestFallback(
    'slashing.params',
    async () => toSnakeCase(await (await getRpcQueryClient()).slashing.params()),
    () =>
      Querier.cosmos.slashing.v1beta1.Params(
        {},
        { pathPrefix: moduleRestEndpoint },
      ),
  );

describe('Slashing Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;
  let validatorAddr: string;
  let validatorInfo: QueryValidatorResponse;
  let consAddress: string;
  let consensusPubkeyBase64: string;

  before('Initializes users and fetches validator info', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'slashUser');
    await waitFor(1);

    const validatorsInfo = await queryStakingValidators('BOND_STATUS_BONDED');
    expectNonEmptyArray(validatorsInfo.validators, 'bonded validators');
    validatorAddr = validatorsInfo.validators[0].operator_address;
    expectValoperAddress(validatorAddr);
    validatorInfo = await queryStakingValidator(validatorAddr);

    const consensusPubkey = validatorInfo!.validator!.consensus_pubkey as any;
    const ed25519PubkeyRaw = rawEd25519Pubkey(consensusPubkey);
    consensusPubkeyBase64 = toBase64(ed25519PubkeyRaw);
    const addressData = sha256(ed25519PubkeyRaw).slice(0, 20);
    consAddress = toBech32('seivalcons', addressData);
  });

  function slashingParams(result: any) {
    return result.params ?? result;
  }

  function signingInfo(result: any) {
    return result.val_signing_info ?? result;
  }

  describe('seid CLI Tests', function () {
    it('Queries slashing params via seid', async () => {
      const result = await execCommandAndReturnJson('seid q slashing params');
      const params = slashingParams(result);
      expect(params).to.be.an('object');
      expect(Number(params.signed_blocks_window)).to.be.gt(0);
      expect(params.min_signed_per_window).to.be.a('string');
    });

    it('Queries signing info for a validator via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q slashing signing-info '{"@type":"${SIGNING_INFO_PUBKEY_TYPE}","key":"${consensusPubkeyBase64}"}'`
      );
      const info = signingInfo(result);
      expect(info.address).to.be.eq(consAddress);
      expect(Number(info.start_height)).to.be.gte(0);
    });

    it('Queries all signing infos via seid', async () => {
      const result = await execCommandAndReturnJson('seid q slashing signing-infos');
      expectNonEmptyArray(result.info, 'signing infos');
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
      await expectFailure(
        user.seiWallet.signingClient.signAndBroadcast(
          user.seiAddress, [unjailMsg], fee, 'unjail tx'
        ),
        undefined,
        'unjail from non-validator sender'
      );
    });

    it('Queries signing info for a specific validator', async () => {
      const response = await querySigningInfo(consAddress);
      expect(response.val_signing_info).to.not.be.undefined;
      expect(response.val_signing_info!.address).to.be.eq(consAddress);
    });

    it('Queries all signing infos', async () => {
      const response = await querySigningInfos();
      expectNonEmptyArray(response.info, 'signing infos');
      expect(response.info.some((entry: any) => entry.address === consAddress)).to.be.true;
    });

    it('Queries slashing params', async () => {
      const response = await querySlashingParams();
      expect(response.params).to.not.be.undefined;
      expect(Number(response.params!.signed_blocks_window)).to.be.gt(0);
      expect(response.params!.min_signed_per_window).to.be.a('string');
    });

    it('Signing info shows correct start height and jailed status', async () => {
      const response = await querySigningInfo(consAddress);
      expect(response.val_signing_info!.jailed_until).to.be.a('string');
      expect(Number(response.val_signing_info!.start_height)).to.be.gte(0);
    });

    it('Slashing params are within sane on-chain bounds', async () => {
      const response = await querySlashingParams();
      const params = response.params!;

      expect(Number(params.signed_blocks_window)).to.be.gt(0);

      const minSignedPerWindow = parseFloat(params.min_signed_per_window);
      expect(minSignedPerWindow).to.be.gte(0);
      expect(minSignedPerWindow).to.be.lte(1);

      const doubleSignFraction = parseFloat(params.slash_fraction_double_sign);
      expect(doubleSignFraction).to.be.gte(0);
      expect(doubleSignFraction).to.be.lte(1);

      const downtimeFraction = parseFloat(params.slash_fraction_downtime);
      expect(downtimeFraction).to.be.gte(0);
      expect(downtimeFraction).to.be.lte(1);

      // Double-sign slashing should never be softer than downtime slashing.
      expect(doubleSignFraction).to.be.gte(downtimeFraction);
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
      await expectFailure(
        admin.seiWallet.signingClient.signAndBroadcast(
          admin.seiAddress, [unjailMsg], fee, 'unjail non-jailed'
        ),
        undefined,
        'unjail non-jailed validator'
      );
    });

    it('Query signing info for invalid consensus address fails', async () => {
      const invalidConsAddr = 'seivalcons1invalidaddressxxxxxxxxxxxxxxxxxx';
      await expectFailure(
        querySigningInfo(invalidConsAddr),
        undefined,
        'signing info query for invalid consensus address'
      );
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid slashing params matches Querier params (signed_blocks_window)', async () => {
      const seidResult = await execCommandAndReturnJson('seid q slashing params');
      const querierResp = await querySlashingParams();

      const seidParams = slashingParams(seidResult);
      expect(seidParams.signed_blocks_window).to.be.eq(
        querierResp.params!.signed_blocks_window,
      );
    });

    it('Signing info via seid matches Querier signing info', async () => {
      const seidResult = await execCommandAndReturnJson(
        `seid q slashing signing-info '{"@type":"${SIGNING_INFO_PUBKEY_TYPE}","key":"${consensusPubkeyBase64}"}'`
      );
      const querierResp = await querySigningInfo(consAddress);

      const seidInfo = signingInfo(seidResult);
      expect(seidInfo.address).to.be.eq(querierResp.val_signing_info!.address);
      expect(seidInfo.start_height).to.be.eq(
        querierResp.val_signing_info!.start_height,
      );
    });
  });
});
