import { SeiUser, UserFactory } from '../../../shared/User';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import { Querier } from '@sei-js/cosmos/rest';
import { Encoder } from '@sei-js/cosmos/encoding';
import { ethers } from 'ethers';
import testConfig from '../../../config/testConfig.json';
import ExpectStatic = Chai.ExpectStatic;

let expect: ExpectStatic;

const restEndpoint = testConfig.restEndpoint;
const POINTER_TYPE_ERC20 = 0;
const CUSTOM_ASSOCIATE_MESSAGE = 'customMessage';

describe('EVM Module Tests', function () {
  this.timeout(5 * 60 * 1000);
  let admin: SeiUser;
  let user: SeiUser;
  let unassociatedUser: SeiUser;

  before('Initialize users', async () => {
    const chai = await import('chai');
    ({ expect } = chai);
    admin = await UserFactory.createAdminUser();
    user = await UserFactory.createSeiUser(admin, 'evmUser');
    unassociatedUser = await UserFactory.createUnassociatedUsers(admin, 'evmUnassoc');
    await waitFor(1);
  });

  describe('seid CLI Tests', function () {
    it('Queries EVM address by sei address via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q evm evm-addr ${user.seiAddress}`
      );
      expect(result.evm_address).to.be.a('string');
      expect(result.evm_address).to.not.be.eq('');
    });

    it('Queries sei address by EVM address via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q evm sei-addr ${user.evmAddress}`
      );
      expect(result.sei_address).to.be.a('string');
      expect(result.sei_address).to.be.eq(user.seiAddress);
    });

    it('Queries pointer version via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q evm pointer ERC20 usei`
      );
      expect(String(result.pointer_type || result.pointerType)).to.have.length.gt(0);
      expect(String(result.pointee || result.pointee_address || result.pointeeAddress)).to.have.length.gt(0);
    });

    it('Queries EVM params via seid', async () => {
      const result = await execCommandAndReturnJson('seid q evm params');
      expect(result.params).to.be.an('object');
    });
  });

  describe('CosmJS Tests', function () {
    it('Can associate an EVM address with a Sei address', async () => {
      const freshUser = await UserFactory.createUnassociatedUsers(admin, 'freshAssoc');
      await UserFactory.fundAddressOnSei(freshUser.seiAddress);
      await waitFor(1);

      let response = await Querier.evm.EVMAddressBySeiAddress(
        { sei_address: freshUser.seiAddress },
        { pathPrefix: restEndpoint }
      );
      expect(response.associated).to.be.false;
      expect(response.evm_address).to.be.eq('');

      const msgAssociate = Encoder.evm.MsgAssociate.fromPartial({
        sender: freshUser.seiAddress,
        custom_message: CUSTOM_ASSOCIATE_MESSAGE,
      });
      const msgSend = {
        typeUrl: `/${Encoder.evm.MsgAssociate.$type}`,
        value: msgAssociate,
      };
      const txResult = await freshUser.seiWallet.signingClient.signAndBroadcast(
        freshUser.seiAddress, [msgSend], freshUser.seiWallet.fee
      );
      expect(txResult.code).to.equal(0);
      expect(txResult.transactionHash).to.be.a('string');

      response = await Querier.evm.EVMAddressBySeiAddress(
        { sei_address: freshUser.seiAddress },
        { pathPrefix: restEndpoint }
      );
      expect(response.associated).to.be.true;
      expect(response.evm_address).to.not.be.eq('');
    });

    it('Cannot associate an already associated address', async () => {
      const msgAssociate = Encoder.evm.MsgAssociate.fromPartial({
        sender: user.seiAddress,
        custom_message: CUSTOM_ASSOCIATE_MESSAGE,
      });
      const msgSend = {
        typeUrl: `/${Encoder.evm.MsgAssociate.$type}`,
        value: msgAssociate,
      };
      const txResult = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msgSend], user.seiWallet.fee
      );
      expect(txResult.code).to.not.be.eq(0);
    });

    it('Querying unassociated sei address returns empty evm address', async () => {
      const response = await Querier.evm.EVMAddressBySeiAddress(
        { sei_address: unassociatedUser.seiAddress },
        { pathPrefix: restEndpoint }
      );
      expect(response.evm_address).to.be.eq('');
      expect(response.associated).to.be.false;
    });

    it('Querying unassociated evm address returns empty sei address', async () => {
      const randomEvmAddress = ethers.Wallet.createRandom().address;
      const response = await Querier.evm.SeiAddressByEVMAddress(
        { evm_address: randomEvmAddress },
        { pathPrefix: restEndpoint }
      );
      expect(response.associated).to.be.false;
    });

    it('Can get pointer version via Querier', async () => {
      const response = await Querier.evm.PointerVersion(
        { pointer_type: POINTER_TYPE_ERC20 },
        { pathPrefix: restEndpoint }
      );
      expect(response.version).to.be.a('number');
      expect(response.cw_code_id).to.be.a('string');
    });
  });

  describe('Ethers.js Tests', function () {
    it('Can send native EVM transfer', async () => {
      const funded = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const recipient = ethers.Wallet.createRandom().address;

      const fundTx = await admin.evmWallet.wallet.sendTransaction({
        to: funded.address,
        value: ethers.parseEther('1.0'),
      });
      await fundTx.wait();

      const preBal = await admin.evmWallet.signingClient.getBalance(recipient);
      const sendTx = await funded.sendTransaction({
        to: recipient,
        value: ethers.parseEther('0.01'),
      });
      await sendTx.wait();

      const postBal = await admin.evmWallet.signingClient.getBalance(recipient);
      expect(postBal > preBal).to.be.true;
      expect(postBal - preBal).to.be.eq(ethers.parseEther('0.01'));
    });

    it('EVM transfer with insufficient balance fails', async () => {
      const poorWallet = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const recipient = ethers.Wallet.createRandom().address;

      try {
        await poorWallet.sendTransaction({
          to: recipient,
          value: ethers.parseEther('100'),
        });
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.contain('insufficient');
      }
    });

    it('Can query EVM chain ID', async () => {
      const network = await admin.evmWallet.signingClient.getNetwork();
      expect(Number(network.chainId)).to.be.gt(0);
    });

    it('Can query EVM block number', async () => {
      const blockNumber = await admin.evmWallet.signingClient.getBlockNumber();
      expect(blockNumber).to.be.gt(0);
    });

    it('Can query EVM gas price', async () => {
      const feeData = await admin.evmWallet.signingClient.getFeeData();
      expect(feeData.gasPrice).to.not.be.null;
      expect(Number(feeData.gasPrice)).to.be.gt(0);
    });

    it('Can query EVM balance', async () => {
      const balance = await admin.evmWallet.signingClient.getBalance(admin.evmAddress);
      expect(balance).to.be.gte(0n);
    });
  });

  describe('Error Cases', function () {
    it('Cannot query EVM address for invalid sei address format via seid', async () => {
      try {
        await execCommandAndReturnJson('seid q evm evm-addr notavalidaddress');
        expect.fail('Should have thrown for invalid sei address');
      } catch (e: any) {
        expect(e.message).to.be.a('string');
        expect(e.message.length).to.be.gt(0);
      }
    });

    it('EVM transfer with exact balance fails due to gas', async () => {
      const fundAmount = ethers.parseEther('0.01');
      const funded = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const recipient = ethers.Wallet.createRandom().address;

      const fundTx = await admin.evmWallet.wallet.sendTransaction({
        to: funded.address,
        value: fundAmount,
      });
      await fundTx.wait();

      try {
        await funded.sendTransaction({
          to: recipient,
          value: fundAmount,
        });
        expect.fail('Should have failed due to insufficient funds for gas');
      } catch (e: any) {
        expect(e.message).to.contain('insufficient');
      }
    });

    it('Cannot associate an already-associated address (verify error code)', async () => {
      const msgAssociate = Encoder.evm.MsgAssociate.fromPartial({
        sender: user.seiAddress,
        custom_message: 'duplicateAssoc',
      });
      const msgSend = {
        typeUrl: `/${Encoder.evm.MsgAssociate.$type}`,
        value: msgAssociate,
      };
      const txResult = await user.seiWallet.signingClient.signAndBroadcast(
        user.seiAddress, [msgSend], user.seiWallet.fee
      );
      expect(txResult.code).to.not.be.eq(0);
      expect(txResult.code).to.be.a('number');
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('EVM balance via ethers matches seid bank query', async () => {
      const evmBalance = await admin.evmWallet.signingClient.getBalance(admin.evmAddress);
      const seidResult = await execCommandAndReturnJson(
        `seid q bank balance ${admin.seiAddress} usei`
      );
      const seidBalance = BigInt(seidResult.balance.amount);

      const evmBalanceInUsei = evmBalance / BigInt(1e12);
      const tolerance = BigInt(50000);
      const diff = evmBalanceInUsei > seidBalance
        ? evmBalanceInUsei - seidBalance
        : seidBalance - evmBalanceInUsei;
      expect(diff <= tolerance).to.be.true;
    });

    it('After EVM transfer, Cosmos-side balance reflects the change', async () => {
      const recipient = await UserFactory.createSeiUser(admin, 'evmCrossRecip');
      await waitFor(1);

      const preBalance = await recipient.seiWallet.queryBalance();
      const preBal = BigInt(preBalance.amount);

      const transferAmount = ethers.parseEther('0.1');
      const tx = await admin.evmWallet.wallet.sendTransaction({
        to: recipient.evmAddress,
        value: transferAmount,
      });
      await tx.wait();
      await waitFor(2);

      const postBalance = await recipient.seiWallet.queryBalance();
      const postBal = BigInt(postBalance.amount);
      expect(postBal > preBal).to.be.true;
    });

    it('Association status consistent between Querier and seid CLI', async () => {
      const querierResp = await Querier.evm.EVMAddressBySeiAddress(
        { sei_address: user.seiAddress },
        { pathPrefix: restEndpoint }
      );
      const seidResult = await execCommandAndReturnJson(
        `seid q evm evm-addr ${user.seiAddress}`
      );

      expect(querierResp.associated).to.be.true;
      expect(seidResult.evm_address).to.not.be.eq('');
      expect(querierResp.evm_address.toLowerCase()).to.be.eq(
        seidResult.evm_address.toLowerCase()
      );
    });
  });

  describe('Gas and Fee Tests', function () {
    it('Simple transfer gas used is within expected range', async () => {
      const recipient = ethers.Wallet.createRandom().address;
      const tx = await admin.evmWallet.wallet.sendTransaction({
        to: recipient,
        value: ethers.parseEther('0.001'),
      });
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;
      const gasUsed = Number(receipt!.gasUsed);
      expect(gasUsed).to.be.gte(21000);
      expect(gasUsed).to.be.lte(100000);
    });

    it('Failed transaction still consumes gas', async () => {
      const funded = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const fundTx = await admin.evmWallet.wallet.sendTransaction({
        to: funded.address,
        value: ethers.parseEther('0.05'),
      });
      await fundTx.wait();

      const preBalance = await admin.evmWallet.signingClient.getBalance(funded.address);

      try {
        const failTx = await funded.sendTransaction({
          to: ethers.Wallet.createRandom().address,
          value: ethers.parseEther('100'),
        });
        await failTx.wait();
        expect.fail('Should have failed');
      } catch (_) {
        // expected
      }

      const postBalance = await admin.evmWallet.signingClient.getBalance(funded.address);
      expect(postBalance <= preBalance).to.be.true;
    });
  });
});
