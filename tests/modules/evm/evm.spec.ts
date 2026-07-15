import { SeiUser, UserFactory } from '../../../shared/User';
import { execCommandAndReturnJson } from '../../../shared/utils/cliUtils';
import { waitFor } from '../../../shared/utils/helpers';
import { Querier } from '@sei-js/cosmos/rest';
import { Encoder } from '@sei-js/cosmos/encoding';
import { ethers } from 'ethers';
import ExpectStatic = Chai.ExpectStatic;
import { expectFailure, expectSeiAddress, expectTxSuccess } from '../moduleTestUtils';
import { getRpcQueryClient, moduleRestEndpoint, withRestFallback } from '../utils/rpcQueryClient';

let expect: ExpectStatic;

const restEndpoint = moduleRestEndpoint;
const POINTER_TYPE_ERC20 = 0;
const CUSTOM_ASSOCIATE_MESSAGE = 'customMessage';
const EVM_FUND_AMOUNT = ethers.parseEther('0.005');
const EVM_TRANSFER_AMOUNT = ethers.parseEther('0.001');

// Sei's evm gRPC service exposes seiAddressByEVMAddress / eVMAddressBySeiAddress
// via @sei-js/proto. We normalise both the cosmjs-types camelCase response
// (e.g. `evmAddress`, `seiAddress`) and the REST snake_case response into a
// unified shape so call sites can read `evm_address`, `sei_address`,
// `associated` regardless of the active path.
type AddressLookupResp = { evm_address: string; sei_address: string; associated: boolean };

const queryEvmAddressBySeiAddress = (seiAddress: string): Promise<AddressLookupResp> =>
  withRestFallback(
    'evm.eVMAddressBySeiAddress',
    async () => {
      const resp = await (await getRpcQueryClient()).evm.eVMAddressBySeiAddress({ seiAddress });
      return { evm_address: resp.evmAddress ?? '', sei_address: seiAddress, associated: resp.associated };
    },
    async () => {
      const resp = await Querier.evm.EVMAddressBySeiAddress(
        { sei_address: seiAddress },
        { pathPrefix: restEndpoint },
      );
      return { evm_address: resp.evm_address ?? '', sei_address: seiAddress, associated: !!resp.associated };
    },
  );

const querySeiAddressByEvmAddress = (evmAddress: string): Promise<AddressLookupResp> =>
  withRestFallback(
    'evm.seiAddressByEVMAddress',
    async () => {
      const resp = await (await getRpcQueryClient()).evm.seiAddressByEVMAddress({ evmAddress });
      return { evm_address: evmAddress, sei_address: resp.seiAddress ?? '', associated: resp.associated };
    },
    async () => {
      const resp = await Querier.evm.SeiAddressByEVMAddress(
        { evm_address: evmAddress },
        { pathPrefix: restEndpoint },
      );
      return { evm_address: evmAddress, sei_address: resp.sei_address ?? '', associated: !!resp.associated };
    },
  );

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
      expectSeiAddress(result.sei_address);
      expect(result.sei_address).to.be.eq(user.seiAddress);
    });

    it('Queries pointer version via seid', async () => {
      const result = await execCommandAndReturnJson(
        `seid q evm pointer ERC20 usei`
      );
      expect(String(result.pointer_type || result.pointerType)).to.have.length.gt(0);
      expect(String(result.pointee || result.pointee_address || result.pointeeAddress)).to.have.length.gt(0);
    });

    it.skip('missing CLI query: evm params is not exposed by this seid binary');
  });

  describe('CosmJS Tests', function () {
    it('Can associate an EVM address with a Sei address', async () => {
      const freshUser = await UserFactory.createUnassociatedUsers(admin, 'freshAssoc');
      await UserFactory.fundAddressOnSei(freshUser.seiAddress);
      await waitFor(1);

      let response = await queryEvmAddressBySeiAddress(freshUser.seiAddress);
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
      expectTxSuccess(txResult, 'EVM association');
      expect(txResult.transactionHash).to.be.a('string');

      response = await queryEvmAddressBySeiAddress(freshUser.seiAddress);
      expect(response.associated).to.be.true;
      expect(response.evm_address).to.not.be.eq('');
      expect(ethers.isAddress(response.evm_address)).to.eq(true);

      const reverse = await querySeiAddressByEvmAddress(response.evm_address);
      expect(reverse.associated).to.be.true;
      expect(reverse.sei_address).to.eq(freshUser.seiAddress);
    });

    it('Repeated association keeps an already associated address associated', async () => {
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
      expect(txResult.code).to.be.a('number');
      const response = await queryEvmAddressBySeiAddress(user.seiAddress);
      expect(response.associated).to.be.true;
      expect(ethers.isAddress(response.evm_address)).to.eq(true);
    });

    it('Querying unassociated sei address returns empty evm address', async () => {
      const response = await queryEvmAddressBySeiAddress(unassociatedUser.seiAddress);
      expect(response.evm_address).to.be.eq('');
      expect(response.associated).to.be.false;
    });

    it('Querying unassociated evm address returns empty sei address', async () => {
      const randomEvmAddress = ethers.Wallet.createRandom().address;
      const response = await querySeiAddressByEvmAddress(randomEvmAddress);
      expect(response.associated).to.be.false;
    });

    it('Can get pointer version via Querier', async () => {
      // PointerVersion is only exposed by the sei REST gateway (no gRPC method
      // in @sei-js/proto), so this query stays on REST and will reflect the
      // gateway's availability.
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
        value: EVM_FUND_AMOUNT,
      });
      await fundTx.wait();

      const preBal = await admin.evmWallet.signingClient.getBalance(recipient);
      const sendTx = await funded.sendTransaction({
        to: recipient,
        value: EVM_TRANSFER_AMOUNT,
      });
      await sendTx.wait();

      const postBal = await admin.evmWallet.signingClient.getBalance(recipient);
      expect(postBal > preBal).to.be.true;
      expect(postBal - preBal).to.be.eq(EVM_TRANSFER_AMOUNT);
    });

    it('EVM transfer with insufficient balance fails', async () => {
      const poorWallet = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const recipient = ethers.Wallet.createRandom().address;

      await expectFailure(
        poorWallet.sendTransaction({
          to: recipient,
          value: ethers.parseEther('100'),
        }),
        'insufficient',
        'transfer from unfunded wallet'
      );
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
      expect(balance >= 0n).to.be.true;
    });
  });

  describe('Error Cases', function () {
    it('Cannot query EVM address for invalid sei address format via seid', async () => {
      await expectFailure(
        execCommandAndReturnJson('seid q evm evm-addr notavalidaddress'),
        undefined,
        'evm-addr query with invalid sei address'
      );
    });

    it('EVM transfer with exact balance fails due to gas', async () => {
      const fundAmount = EVM_TRANSFER_AMOUNT;
      const funded = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const recipient = ethers.Wallet.createRandom().address;

      const fundTx = await admin.evmWallet.wallet.sendTransaction({
        to: funded.address,
        value: fundAmount,
      });
      await fundTx.wait();

      await expectFailure(
        funded.sendTransaction({
          to: recipient,
          value: fundAmount,
        }),
        'insufficient',
        'transfer of exact balance without gas headroom'
      );
    });

    it('Repeated association returns a result and leaves the account associated', async () => {
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
      expect(txResult.code).to.be.a('number');
      const response = await queryEvmAddressBySeiAddress(user.seiAddress);
      expect(response.associated).to.be.true;
    });
  });

  describe('Cross-Runtime Consistency', function () {
    it('EVM balance via ethers matches seid bank query', async () => {
      const evmBalance = await admin.evmWallet.signingClient.getBalance(admin.evmAddress);
      const seidResult = await execCommandAndReturnJson(
        `seid q bank balances ${admin.seiAddress} --denom usei`
      );
      const seidBalance = BigInt((seidResult.balance ?? seidResult).amount);

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

      const transferAmount = EVM_TRANSFER_AMOUNT;
      const tx = await admin.evmWallet.wallet.sendTransaction({
        to: recipient.evmAddress,
        value: transferAmount,
      });
      await tx.wait();
      await waitFor(2);

      const postBalance = await recipient.seiWallet.queryBalance();
      const postBal = BigInt(postBalance.amount);
      expect(postBal - preBal).to.eq(transferAmount / 10n ** 12n);
    });

    it('Association status consistent between Querier and seid CLI', async () => {
      const querierResp = await queryEvmAddressBySeiAddress(user.seiAddress);
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

  describe('Edge Cases', function () {
    it('A 1 wei transfer preserves sub-usei precision on the EVM side', async () => {
      const recipient = ethers.Wallet.createRandom().address;
      const tx = await admin.evmWallet.wallet.sendTransaction({
        to: recipient,
        value: 1n,
      });
      const receipt = await tx.wait();
      expect(receipt!.status).to.be.eq(1);

      // usei only has 12-decimals-coarser granularity; the wei bank must
      // still track the exact single wei.
      const balance = await admin.evmWallet.signingClient.getBalance(recipient);
      expect(balance).to.eq(1n);
    });

    it('A transfer of 1 usei + 1 wei keeps the exact wei remainder', async () => {
      const recipient = ethers.Wallet.createRandom().address;
      const oneUseiInWei = 10n ** 12n;
      const tx = await admin.evmWallet.wallet.sendTransaction({
        to: recipient,
        value: oneUseiInWei + 1n,
      });
      await tx.wait();

      const balance = await admin.evmWallet.signingClient.getBalance(recipient);
      expect(balance).to.eq(oneUseiInWei + 1n);
    });

    it('Zero-value transfer succeeds and moves no funds', async () => {
      const recipient = ethers.Wallet.createRandom().address;
      const tx = await admin.evmWallet.wallet.sendTransaction({
        to: recipient,
        value: 0n,
      });
      const receipt = await tx.wait();
      expect(receipt!.status).to.be.eq(1);

      const balance = await admin.evmWallet.signingClient.getBalance(recipient);
      expect(balance).to.eq(0n);
    });

    it('Self-transfer only costs gas', async () => {
      const funded = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const fundTx = await admin.evmWallet.wallet.sendTransaction({
        to: funded.address,
        value: EVM_FUND_AMOUNT,
      });
      await fundTx.wait();

      const preBalance = await admin.evmWallet.signingClient.getBalance(funded.address);
      const tx = await funded.sendTransaction({
        to: funded.address,
        value: EVM_TRANSFER_AMOUNT,
      });
      const receipt = await tx.wait();
      expect(receipt!.status).to.be.eq(1);

      const gasCost = receipt!.gasUsed * receipt!.gasPrice;
      const postBalance = await admin.evmWallet.signingClient.getBalance(funded.address);
      expect(preBalance - postBalance).to.eq(gasCost);
    });
  });

  describe('Gas and Fee Tests', function () {
    it('Simple transfer gas used is within expected range', async () => {
      const recipient = ethers.Wallet.createRandom().address;
      const tx = await admin.evmWallet.wallet.sendTransaction({
        to: recipient,
        value: EVM_TRANSFER_AMOUNT,
      });
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;
      const gasUsed = Number(receipt!.gasUsed);
      expect(gasUsed).to.be.gte(21000);
      expect(gasUsed).to.be.lte(100000);
    });

    it('Oversized native transfer is rejected without moving funds', async () => {
      const funded = ethers.Wallet.createRandom().connect(admin.evmWallet.signingClient);
      const fundTx = await admin.evmWallet.wallet.sendTransaction({
        to: funded.address,
        value: EVM_FUND_AMOUNT,
      });
      await fundTx.wait();

      const preBalance = await admin.evmWallet.signingClient.getBalance(funded.address);

      await expectFailure(
        (async () => {
          const failTx = await funded.sendTransaction({
            to: ethers.Wallet.createRandom().address,
            value: ethers.parseEther('100'),
          });
          return failTx.wait();
        })(),
        'insufficient',
        'oversized native transfer'
      );

      const postBalance = await admin.evmWallet.signingClient.getBalance(funded.address);
      expect(postBalance).to.eq(preBalance);
    });
  });
});
