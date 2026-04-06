import { SeiUser, UserFactory } from '../../../shared/User';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import { deployWasmContract, instantiateCode, registerName } from '../utils/utils';
import testConfig from '../../../config/testConfig.json';
import ExpectStatic = Chai.ExpectStatic;

let expect: ExpectStatic;

describe('Wasm Module Tests', function () {
  this.timeout(5 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;
  let codeId: number;
  let contractAddress: string;
  const name = 'firstName';

  before('Initializes users and deploys contract', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'wasmUser');
    await waitFor(1);

    codeId = await deployWasmContract(user.seiWallet.cosmWasmSigningClient, user.seiAddress);
    contractAddress = await instantiateCode(user.seiWallet.cosmWasmSigningClient, user.seiAddress, codeId);
    await registerName(user.seiWallet.cosmWasmSigningClient, user.seiAddress, name, contractAddress);
  });

  describe('seid CLI Tests', function () {
    it('Queries all codes via seid', async () => {
      const result = await execCommandAndReturnJson('seid q wasm list-code');
      expect(result).to.exist;
      expect(result.code_infos).to.be.an('array');
      expect(result.code_infos.length).to.be.gte(1);
    });

    it('Queries code info by ID via seid', async () => {
      const result = await execCommandAndReturnJson(`seid q wasm code-info ${codeId}`);
      expect(result).to.exist;
      expect(result.code_id).to.be.eq(String(codeId));
      expect(result.creator).to.be.eq(user.seiAddress);
    });

    it('Queries contract info via seid', async () => {
      const result = await execCommandAndReturnJson(`seid q wasm contract ${contractAddress}`);
      expect(result).to.exist;
      expect(result.address).to.be.eq(contractAddress);
      expect(result.contract_info).to.exist;
      expect(result.contract_info.label).to.be.eq('Our Name Service');
    });

    it('Queries contract state via smart query in seid', async () => {
      const query = JSON.stringify({ resolve_record: { name } });
      const result = await execCommandAndReturnJson(
        `seid q wasm contract-state smart ${contractAddress} '${query}'`
      );
      expect(result).to.exist;
      expect(result.data).to.exist;
      expect(result.data.address).to.be.eq(user.seiAddress);
    });

    it('Stores code via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid tx wasm store ./artifacts/cw_nameservice.wasm --from ${user.seiAddress} --fees 25000000usei --gas 25000000 --broadcast-mode block -y`
      );
      expect(result).to.exist;
      expect(result.code).to.be.eq(0);
    });

    it('Instantiates contract via seid', async () => {
      const cliCodeId = codeId;
      const initMsg = JSON.stringify({
        purchase_price: { amount: '100', denom: 'usei' },
        transfer_price: { amount: '999', denom: 'usei' },
      });
      const result = await execCommandAndReturnJson(
        `seid tx wasm instantiate ${cliCodeId} '${initMsg}' --label "CLI Name Service" --admin ${user.seiAddress} --from ${user.seiAddress} --fees 24200usei --gas 500000 --broadcast-mode block -y`
      );
      expect(result).to.exist;
      expect(result.code).to.be.eq(0);
    });
  });

  describe('CosmJS Tests', function () {
    describe('Code Queries', function () {
      it('Can query all uploaded codes', async () => {
        const allCode = await user.seiWallet.cosmWasmSigningClient.getCodes();
        expect(allCode).to.be.an('array');
        expect(allCode).to.have.length.gte(1);
        const uploaded = allCode.find((c: any) => c.id === codeId);
        expect(uploaded).to.exist;
      });

      it('Can query specific code by ID', async () => {
        const specificCode = await user.seiWallet.cosmWasmSigningClient.getCodeDetails(codeId);
        expect(specificCode).to.exist;
        expect(specificCode.id).to.be.eq(codeId);
        expect(specificCode.creator).to.be.eq(user.seiAddress);
        expect(specificCode.data).to.exist;
      });

      it('Can query contracts by code ID', async () => {
        const contractsByCodeId = await user.seiWallet.cosmWasmSigningClient.getContracts(codeId);
        expect(contractsByCodeId).to.be.an('array');
        expect(contractsByCodeId).to.have.length.gte(1);
        expect(contractsByCodeId).to.contain(contractAddress);
      });
    });

    describe('Contract Queries', function () {
      it('Can query contract info by address', async () => {
        const contractInfo = await user.seiWallet.cosmWasmSigningClient.getContract(contractAddress);
        expect(contractInfo).to.exist;
        expect(contractInfo.address).to.be.eq(contractAddress);
        expect(contractInfo.codeId).to.be.eq(codeId);
        expect(contractInfo.creator).to.be.eq(user.seiAddress);
        expect(contractInfo.label).to.be.eq('Our Name Service');
      });

      it('Can query smart contract state', async () => {
        const queryDataRaw = {
          resolve_record: { name }
        };
        const smartQuery = await user.seiWallet.cosmWasmSigningClient.queryContractSmart(contractAddress, queryDataRaw);
        expect(smartQuery).to.exist;
        expect(smartQuery.address).to.be.eq(user.seiAddress);
      });

      it('Can query contract code history', async () => {
        const contractHistory = await user.seiWallet.cosmWasmSigningClient.getContractCodeHistory(contractAddress);
        expect(contractHistory).to.be.an('array');
        expect(contractHistory).to.have.length.gte(1);
        expect(contractHistory[0].codeId).to.be.eq(codeId);
      });

      it('Smart query with unknown name returns error', async () => {
        const queryDataRaw = {
          resolve_record: { name: 'nonexistentname' }
        };
        try {
          await user.seiWallet.cosmWasmSigningClient.queryContractSmart(contractAddress, queryDataRaw);
          expect.fail('Should have thrown for unknown name');
        } catch (e: any) {
          expect(e.message).to.exist;
        }
      });
    });

    describe('Contract Execution', function () {
      it('Can register another name on the contract', async () => {
        const newName = 'secondName';
        await registerName(user.seiWallet.cosmWasmSigningClient, user.seiAddress, newName, contractAddress);

        const queryResult = await user.seiWallet.cosmWasmSigningClient.queryContractSmart(contractAddress, {
          resolve_record: { name: newName }
        });
        expect(queryResult.address).to.be.eq(user.seiAddress);
      });

      it('Can transfer name ownership', async () => {
        const recipient = await UserFactory.createSeiUser(admin, 'wasmRecipient');
        const transferName = 'thirdName';
        await registerName(user.seiWallet.cosmWasmSigningClient, user.seiAddress, transferName, contractAddress);

        const transferMsg = {
          transfer: { name: transferName, to: recipient.seiAddress }
        };
        await user.seiWallet.cosmWasmSigningClient.execute(
          user.seiAddress,
          contractAddress,
          transferMsg,
          user.seiWallet.fee
        );

        const queryResult = await user.seiWallet.cosmWasmSigningClient.queryContractSmart(contractAddress, {
          resolve_record: { name: transferName }
        });
        expect(queryResult.address).to.be.eq(recipient.seiAddress);
      });
    });
  });

  describe('Error Cases', function () {
    it('Cannot instantiate with invalid code ID', async () => {
      const invalidCodeId = 999999;
      const instantiateMsg = {
        purchase_price: { amount: '100', denom: 'usei' },
        transfer_price: { amount: '999', denom: 'usei' },
      };
      try {
        await user.seiWallet.cosmWasmSigningClient.instantiate(
          user.seiAddress, invalidCodeId, instantiateMsg, 'Bad Code ID', user.seiWallet.fee
        );
        expect.fail('Should have thrown for invalid code ID');
      } catch (e: any) {
        expect(e.message).to.exist;
      }
    });

    it('Cannot execute on non-existent contract address', async () => {
      const fakeContract = 'sei1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0yqtl5';
      try {
        await user.seiWallet.cosmWasmSigningClient.execute(
          user.seiAddress,
          fakeContract,
          { register: { name: 'test' } },
          user.seiWallet.fee,
          '',
          [{ denom: 'usei', amount: '110' }]
        );
        expect.fail('Should have thrown for non-existent contract');
      } catch (e: any) {
        expect(e.message).to.exist;
      }
    });

    it('Cannot query non-existent contract', async () => {
      const fakeContract = 'sei1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq0yqtl5';
      try {
        await user.seiWallet.cosmWasmSigningClient.getContract(fakeContract);
        expect.fail('Should have thrown for non-existent contract');
      } catch (e: any) {
        expect(e.message).to.exist;
      }
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('Code list via seid matches CosmJS getCodes() count', async () => {
      const seidResult = await execCommandAndReturnJson('seid q wasm list-code');
      const cosmjsCodes = await user.seiWallet.cosmWasmSigningClient.getCodes();

      expect(seidResult.code_infos.length).to.be.eq(cosmjsCodes.length);
    });

    it('Contract info via seid matches CosmJS getContract()', async () => {
      const seidResult = await execCommandAndReturnJson(
        `seid q wasm contract ${contractAddress}`
      );
      const cosmjsInfo = await user.seiWallet.cosmWasmSigningClient.getContract(contractAddress);

      expect(seidResult.address).to.be.eq(cosmjsInfo.address);
      expect(seidResult.contract_info.label).to.be.eq(cosmjsInfo.label);
      expect(seidResult.contract_info.creator).to.be.eq(cosmjsInfo.creator);
      expect(Number(seidResult.contract_info.code_id)).to.be.eq(cosmjsInfo.codeId);
    });
  });
});
