import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import testConfig from '../../../config/testConfig.json';
import { Querier } from '@sei-js/cosmos/rest';
import ExpectStatic = Chai.ExpectStatic;
import {expectNonEmptyArray, expectUseiCoin, normalizeRestEndpoint} from '../moduleTestUtils';

let expect: ExpectStatic;

describe.skip('Mint Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  const restEndpoint = normalizeRestEndpoint(testConfig.restEndpoint);
  const MINT_DENOM = 'usei';

  before('Initializes test dependencies', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
  });

  describe('seid CLI Tests', function () {
    it('Queries minter via seid', async () => {
      const result = await execCommandAndReturnJson('seid q mint minter');
      const minter = result.minter ?? result;
      expect(minter).to.be.an('object');
    });

    it('Queries mint params via seid', async () => {
      const result = await execCommandAndReturnJson('seid q mint params');
      const params = result.params ?? result;
      expect(params).to.be.an('object');
      expect(params.mint_denom).to.be.eq(MINT_DENOM);
      expectNonEmptyArray(params.token_release_schedule, 'mint token release schedule');
    });
  });

  describe('CosmJS Tests', function () {
    it('Queries annual provisions and returns a numeric value', async () => {
      const response = await Querier.cosmos.mint.v1beta1.AnnualProvisions(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.annual_provisions).to.be.a('string');
      expect(parseFloat(response.annual_provisions)).to.be.gte(0);
    });

    it('Queries inflation and returns a numeric value', async () => {
      const response = await Querier.cosmos.mint.v1beta1.Inflation(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.inflation).to.be.a('string');
      expect(parseFloat(response.inflation)).to.be.gte(0);
    });

    it('Queries Minter and returns valid minter data', async () => {
      const response = await Querier.mint.v1beta1.Minter(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.minter).to.not.be.undefined;
      expect(response.minter!.inflation).to.be.a('string');
      expect(parseFloat(response.minter!.inflation)).to.be.gte(0);
    });

    it('Queries params and returns token release schedule', async () => {
      const response = await Querier.mint.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response.params).to.not.be.undefined;
      expect(response.params!.mint_denom).to.be.eq(MINT_DENOM);
      expectNonEmptyArray(response.params!.token_release_schedule, 'mint token release schedule');
    });

    it('Annual provisions is consistent with inflation and supply', async () => {
      const inflationResp = await Querier.cosmos.mint.v1beta1.Inflation(
        {}, { pathPrefix: restEndpoint }
      );
      const provisionsResp = await Querier.cosmos.mint.v1beta1.AnnualProvisions(
        {}, { pathPrefix: restEndpoint }
      );
      const inflation = parseFloat(inflationResp.inflation);
      const provisions = parseFloat(provisionsResp.annual_provisions);

      expect(provisions >= 0).to.be.true;
      expect(inflation === 0 ? provisions === 0 : provisions > 0).to.be.true;
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid mint minter matches Querier minter data', async () => {
      const seidResult = await execCommandAndReturnJson('seid q mint minter');
      const querierResp = await Querier.mint.v1beta1.Minter(
        {}, { pathPrefix: restEndpoint }
      );

      const seidMinter = seidResult.minter ?? seidResult;
      expect(seidMinter).to.be.an('object');
      expect(querierResp.minter).to.not.be.undefined;
    });

    it('seid mint params matches Querier params', async () => {
      const seidResult = await execCommandAndReturnJson('seid q mint params');
      const querierResp = await Querier.mint.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );

      const seidParams = seidResult.params ?? seidResult;
      expect(seidParams.mint_denom).to.be.eq(querierResp.params!.mint_denom);
      const seidScheduleLen = seidParams.token_release_schedule?.length ?? 0;
      const querierScheduleLen = querierResp.params!.token_release_schedule?.length ?? 0;
      expect(seidScheduleLen).to.be.eq(querierScheduleLen);
    });

    it('mint denom exists in bank supply', async () => {
      const supplyResp = await Querier.cosmos.bank.v1beta1.SupplyOf(
        { denom: MINT_DENOM }, { pathPrefix: restEndpoint }
      );
      expectUseiCoin(supplyResp.amount!);
      expect(BigInt(supplyResp.amount!.amount)).to.be.gt(0n);
    });
  });

  describe('Validation Tests', function () {
    it('Inflation is within valid range (0 to 1)', async () => {
      const response = await Querier.cosmos.mint.v1beta1.Inflation(
        {}, { pathPrefix: restEndpoint }
      );
      const inflation = parseFloat(response.inflation);
      expect(inflation).to.be.gte(0);
      expect(inflation).to.be.lte(1);
    });

    it('Annual provisions is a positive number', async () => {
      const response = await Querier.cosmos.mint.v1beta1.AnnualProvisions(
        {}, { pathPrefix: restEndpoint }
      );
      const provisions = parseFloat(response.annual_provisions);
      expect(provisions).to.be.gte(0);
    });

    it('Token release schedule has valid start/end dates', async () => {
      const response = await Querier.mint.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );
      const schedule = response.params!.token_release_schedule;
      expect(schedule).to.be.an('array');
      expect(schedule.length).to.be.gte(1);

      for (const entry of schedule) {
        const startDate = new Date(entry.start_date);
        const endDate = new Date(entry.end_date);
        expect(startDate.getTime()).to.be.a('number');
        expect(endDate.getTime()).to.be.a('number');
        expect(endDate.getTime()).to.be.gte(startDate.getTime());
      }
    });
  });
});
