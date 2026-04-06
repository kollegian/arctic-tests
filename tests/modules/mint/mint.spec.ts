import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import testConfig from '../../../config/testConfig.json';
import { Querier } from '@sei-js/cosmos/rest';
import ExpectStatic = Chai.ExpectStatic;

let expect: ExpectStatic;

describe('Mint Module Tests', function () {
  this.timeout(4 * 60 * 1000);
  const restEndpoint = testConfig.restEndpoint;

  before('Initializes test dependencies', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
  });

  describe('seid CLI Tests', function () {
    it('Queries inflation via seid', async () => {
      const result = await execCommandAndReturnJson('seid q mint inflation');
      expect(result).to.exist;
      expect(result.inflation).to.be.a('string');
      expect(parseFloat(result.inflation)).to.be.gte(0);
    });

    it('Queries annual provisions via seid', async () => {
      const result = await execCommandAndReturnJson('seid q mint annual-provisions');
      expect(result).to.exist;
      expect(result.annual_provisions).to.be.a('string');
      expect(parseFloat(result.annual_provisions)).to.be.gte(0);
    });

    it('Queries mint params via seid', async () => {
      const result = await execCommandAndReturnJson('seid q mint params');
      expect(result).to.exist;
      expect(result.params).to.exist;
    });
  });

  describe('CosmJS Tests', function () {
    it('Queries annual provisions and returns a numeric value', async () => {
      const response = await Querier.cosmos.mint.v1beta1.AnnualProvisions(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response).to.exist;
      expect(response.annual_provisions).to.be.a('string');
      expect(parseFloat(response.annual_provisions)).to.be.gte(0);
    });

    it('Queries inflation and returns a numeric value', async () => {
      const response = await Querier.cosmos.mint.v1beta1.Inflation(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response).to.exist;
      expect(response.inflation).to.be.a('string');
      expect(parseFloat(response.inflation)).to.be.gte(0);
    });

    it('Queries Minter and returns valid minter data', async () => {
      const response = await Querier.mint.v1beta1.Minter(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response).to.exist;
      expect(response.minter).to.exist;
    });

    it('Queries params and returns token release schedule', async () => {
      const response = await Querier.mint.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );
      expect(response).to.exist;
      expect(response.params).to.exist;
      expect(response.params!.token_release_schedule).to.be.an('array');
      expect(response.params!.token_release_schedule).to.have.length.gte(1);
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

      if (inflation > 0) {
        expect(provisions).to.be.gt(0);
      }
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('seid mint inflation matches Querier inflation value', async () => {
      const seidResult = await execCommandAndReturnJson('seid q mint inflation');
      const querierResp = await Querier.cosmos.mint.v1beta1.Inflation(
        {}, { pathPrefix: restEndpoint }
      );

      const seidInflation = parseFloat(seidResult.inflation);
      const querierInflation = parseFloat(querierResp.inflation);
      expect(Math.abs(seidInflation - querierInflation)).to.be.lt(0.0001);
    });

    it('seid mint params matches Querier params', async () => {
      const seidResult = await execCommandAndReturnJson('seid q mint params');
      const querierResp = await Querier.mint.v1beta1.Params(
        {}, { pathPrefix: restEndpoint }
      );

      expect(seidResult.params.mint_denom).to.be.eq(querierResp.params!.mint_denom);
      const seidScheduleLen = seidResult.params.token_release_schedule?.length ?? 0;
      const querierScheduleLen = querierResp.params!.token_release_schedule?.length ?? 0;
      expect(seidScheduleLen).to.be.eq(querierScheduleLen);
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
