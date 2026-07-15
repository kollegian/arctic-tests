import { SeiUser, UserFactory } from '../../../shared/User';
import { Cw20Token } from '../../../shared/Token';
import { existingWasmAddresses } from '../../../shared/utils/testFlags';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import ExpectStatic = Chai.ExpectStatic;
import { expectFailure, expectSeiAddress } from '../moduleTestUtils';

let expect: ExpectStatic;
const INVALID_CONTRACT_ADDRESS = 'sei1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0yqtl5';
const MINT_AMOUNT = '1000';
const TRANSFER_AMOUNT = '250';

// Storing/instantiating wasm code is disabled on arctic-1, so this suite runs
// exclusively against the pre-deployed CW20 from knownContractAddresses.json
// (overridable via testConfig.existingWasm). No store/instantiate tests here.
describe('Wasm Module Tests (existing contracts)', function () {
  this.timeout(5 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;
  let cw20Address: string;
  let cw20: Cw20Token;
  let codeId: number;
  let adminIsMinter = false;

  before('Resolves the existing CW20 contract', async function () {
    const chai = await import('chai');
    ({ expect } = chai);

    const existing = existingWasmAddresses();
    if (!existing.cw20Address) {
      this.skip();
      return;
    }
    cw20Address = existing.cw20Address;

    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'wasmUser');
    await waitFor(1);

    cw20 = new Cw20Token(admin, cw20Address);
    const contractInfo = await admin.seiWallet.cosmWasmSigningClient.getContract(cw20Address);
    codeId = contractInfo.codeId;

    const minterResp = await admin.seiWallet.cosmWasmSigningClient.queryContractSmart(
      cw20Address, { minter: {} }
    );
    adminIsMinter = minterResp?.minter === admin.seiAddress;
  });

  describe('seid CLI Tests', function () {
    it('Queries code info for the existing code ID via seid', async () => {
      const result = await execCommandAndReturnJson(`seid q wasm code-info ${codeId}`);
      expect(result.code_id).to.be.eq(String(codeId));
      expectSeiAddress(result.creator, 'code creator');
    });

    it('Queries contract info via seid', async () => {
      const result = await execCommandAndReturnJson(`seid q wasm contract ${cw20Address}`);
      expect(result.address).to.be.eq(cw20Address);
      expect(result.contract_info).to.not.be.undefined;
      expect(Number(result.contract_info.code_id)).to.be.eq(codeId);
      expect(result.contract_info.label).to.be.a('string');
    });

    it('Queries contracts by code ID via seid and finds the CW20', async () => {
      const result = await execCommandAndReturnJson(
        `seid q wasm list-contract-by-code ${codeId} --limit 1000`
      );
      expect(result.contracts).to.be.an('array');
      expect(result.contracts).to.contain(cw20Address);
    });

    it('Queries CW20 token_info via smart query in seid', async () => {
      const query = JSON.stringify({ token_info: {} });
      const result = await execCommandAndReturnJson(
        `seid q wasm contract-state smart ${cw20Address} '${query}'`
      );
      expect(result.data.name).to.be.a('string');
      expect(result.data.symbol).to.be.a('string');
      expect(result.data.decimals).to.be.a('number');
      expect(result.data.total_supply).to.match(/^[0-9]+$/);
    });
  });

  describe('CosmJS Tests', function () {
    describe('Code Queries', function () {
      it('Can query the existing code by ID', async () => {
        const specificCode = await user.seiWallet.cosmWasmSigningClient.getCodeDetails(codeId);
        expect(specificCode.id).to.be.eq(codeId);
        expectSeiAddress(specificCode.creator, 'code creator');
        expect(specificCode.data).to.not.be.undefined;
        expect(specificCode.data.length).to.be.gt(0);
      });

      it('Can query contracts by code ID', async () => {
        const contractsByCodeId = await user.seiWallet.cosmWasmSigningClient.getContracts(codeId);
        expect(contractsByCodeId).to.be.an('array');
        expect(contractsByCodeId).to.have.length.gte(1);
        expect(contractsByCodeId).to.contain(cw20Address);
      });
    });

    describe('Contract Queries', function () {
      it('Can query contract info by address', async () => {
        const contractInfo = await user.seiWallet.cosmWasmSigningClient.getContract(cw20Address);
        expect(contractInfo.address).to.be.eq(cw20Address);
        expect(contractInfo.codeId).to.be.eq(codeId);
        expectSeiAddress(contractInfo.creator, 'contract creator');
      });

      it('Can query CW20 token info via smart query', async () => {
        const tokenInfo = await cw20.tokenInfo();
        expect(tokenInfo.name).to.be.a('string');
        expect(tokenInfo.symbol).to.be.a('string');
        expect(BigInt(tokenInfo.total_supply) >= 0n).to.be.true;
      });

      it('Can query contract code history', async () => {
        const contractHistory = await user.seiWallet.cosmWasmSigningClient.getContractCodeHistory(cw20Address);
        expect(contractHistory).to.be.an('array');
        expect(contractHistory).to.have.length.gte(1);
        expect(contractHistory.some((entry: any) => entry.codeId === codeId)).to.be.true;
      });

      it('Balance query for a fresh address returns zero', async () => {
        const freshUser = await UserFactory.createUnassociatedUsers(admin, 'wasmFresh');
        const balance = await cw20.balanceOf(freshUser.seiAddress);
        expect(balance).to.be.eq('0');
      });
    });

    describe('Contract Execution', function () {
      it('Admin can mint CW20 tokens to a user', async function () {
        if (!adminIsMinter) {
          this.skip();
          return;
        }
        const preBalance = BigInt(await cw20.balanceOf(user.seiAddress));
        await cw20.mint(user.seiAddress, MINT_AMOUNT);
        const postBalance = BigInt(await cw20.balanceOf(user.seiAddress));
        expect(postBalance - preBalance).to.be.eq(BigInt(MINT_AMOUNT));
      });

      it('User can transfer CW20 tokens back to admin', async function () {
        if (!adminIsMinter) {
          this.skip();
          return;
        }
        const userPre = BigInt(await cw20.balanceOf(user.seiAddress));
        const adminPre = BigInt(await cw20.balanceOf(admin.seiAddress));
        expect(userPre >= BigInt(TRANSFER_AMOUNT)).to.be.true;

        await cw20.transferFromSender(user, admin.seiAddress, TRANSFER_AMOUNT);

        const userPost = BigInt(await cw20.balanceOf(user.seiAddress));
        const adminPost = BigInt(await cw20.balanceOf(admin.seiAddress));
        expect(userPre - userPost).to.be.eq(BigInt(TRANSFER_AMOUNT));
        expect(adminPost - adminPre).to.be.eq(BigInt(TRANSFER_AMOUNT));
      });

      it('Cannot transfer more CW20 than the sender holds', async () => {
        const balance = BigInt(await cw20.balanceOf(user.seiAddress));
        const overBalance = (balance + 1000000n).toString();
        await expectFailure(
          cw20.transferFromSender(user, admin.seiAddress, overBalance),
          undefined,
          'CW20 transfer above balance'
        );
      });
    });
  });

  describe('Error Cases', function () {
    it('Cannot execute on non-existent contract address', async () => {
      await expectFailure(
        user.seiWallet.cosmWasmSigningClient.execute(
          user.seiAddress,
          INVALID_CONTRACT_ADDRESS,
          { transfer: { recipient: admin.seiAddress, amount: '1' } },
          user.seiWallet.fee
        ),
        undefined,
        'execute on non-existent contract'
      );
    });

    it('Cannot query non-existent contract', async () => {
      await expectFailure(
        user.seiWallet.cosmWasmSigningClient.getContract(INVALID_CONTRACT_ADDRESS),
        undefined,
        'query non-existent contract'
      );
    });

    it('Smart query with unknown message variant returns error', async () => {
      await expectFailure(
        user.seiWallet.cosmWasmSigningClient.queryContractSmart(cw20Address, {
          definitely_not_a_query: {}
        }),
        undefined,
        'smart query with unknown variant'
      );
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('Contract info via seid matches CosmJS getContract()', async () => {
      const seidResult = await execCommandAndReturnJson(
        `seid q wasm contract ${cw20Address}`
      );
      const cosmjsInfo = await user.seiWallet.cosmWasmSigningClient.getContract(cw20Address);

      expect(seidResult.address).to.be.eq(cosmjsInfo.address);
      expect(seidResult.contract_info.label).to.be.eq(cosmjsInfo.label);
      expect(seidResult.contract_info.creator).to.be.eq(cosmjsInfo.creator);
      expect(Number(seidResult.contract_info.code_id)).to.be.eq(cosmjsInfo.codeId);
    });

    it('token_info via seid smart query matches CosmJS smart query', async () => {
      const query = JSON.stringify({ token_info: {} });
      const seidResult = await execCommandAndReturnJson(
        `seid q wasm contract-state smart ${cw20Address} '${query}'`
      );
      const cosmjsInfo = await cw20.tokenInfo();

      expect(seidResult.data.name).to.be.eq(cosmjsInfo.name);
      expect(seidResult.data.symbol).to.be.eq(cosmjsInfo.symbol);
      expect(seidResult.data.decimals).to.be.eq(cosmjsInfo.decimals);
    });
  });
});
