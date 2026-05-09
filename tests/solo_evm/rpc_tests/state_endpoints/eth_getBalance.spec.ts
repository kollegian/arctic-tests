import { expect } from 'chai';
import { ethers } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

const network = getNetwork('local');
const RPC_URL = network.url;
let aliceInitialBalance: bigint;

describe('eth_getBalance', function () {
  this.timeout(120 * 1000);

  let provider: ethers.JsonRpcProvider;
  let funder: User;
  let alice: User;
  let bob: User;
  let txBuilder: TxBuilder;
  let erc20Address: string;

  before(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);

    const admin = await SeiUserFactory.createAdminUser();
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, 2);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    [alice, bob] = await Promise.all(
      seiUsers.map(su => User.fromPrivateKey(su.evmWallet.wallet.privateKey, RPC_URL))
    );

    txBuilder = new TxBuilder([alice, bob]);
    const erc20 = await txBuilder.deployErc20(funder);
    erc20Address = await erc20.getAddress();
  });

  describe('Basic balance queries', function () {

    it('returns balance for an address at latest block', async () => {
      aliceInitialBalance = await provider.getBalance(alice.address, 'latest');
      expect(aliceInitialBalance > 0n).to.equal(true);
    });

    it('returns zero balance for non-existent address', async () => {
      const randomAddress = ethers.Wallet.createRandom().address;
      const balance = await provider.getBalance(randomAddress, 'latest');
      expect(balance).to.equal(0n);
    });

    it('returns balance using raw RPC call', async () => {
      const balanceHex = await provider.send('eth_getBalance', [alice.address, 'latest']);
      const balance = BigInt(balanceHex);
      expect(balance).to.equal(aliceInitialBalance);
    });

  });

  describe('Genesis and earliest block queries', function () {

    it('returns zero balance at genesis (block 0) for user address', async () => {
      const unfunded = ethers.Wallet.createRandom().address;
      const balanceAtGenesis = await provider.getBalance(unfunded, 0);
      expect(balanceAtGenesis).to.equal(0n);
    });

    it('returns zero balance with "earliest" tag', async () => {
      const unfunded = ethers.Wallet.createRandom().address;
      const balance = await provider.getBalance(unfunded, 'earliest');
      expect(balance).to.equal(0n);
    });
  });

  describe('Historical balance queries', function () {

    it('queries balance at a previous block number', async () => {
      const currentBlock = await provider.getBlockNumber();
      const previousBlock = Math.max(1, currentBlock - 5);

      const balanceAtPrevious = await provider.getBalance(alice.address, previousBlock);
      const balanceAtLatest = await provider.getBalance(alice.address, 'latest');
      expect(balanceAtPrevious >= 0n).to.equal(true);
      expect(balanceAtLatest > 0n).to.equal(true);
    });

    it('tracks balance change after transfer with exact assertions', async () => {
      const aliceBalanceBefore = await provider.getBalance(alice.address, 'latest');
      const bobBalanceBefore = await provider.getBalance(bob.address, 'latest');

      const transferAmount = ethers.parseEther('0.5');
      const tx = await alice.wallet.sendTransaction({
        to: bob.address,
        value: transferAmount,
      });
      const receipt = await tx.wait();
      const txBlock = receipt!.blockNumber;
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const aliceAtBlockMinus1 = await provider.getBalance(alice.address, txBlock - 1);
      const aliceAtTxBlock = await provider.getBalance(alice.address, txBlock);
      const aliceAtBlockPlus1 = await provider.getBalance(alice.address, txBlock + 1);

      const bobAtBlockMinus1 = await provider.getBalance(bob.address, txBlock - 1);
      const bobAtTxBlock = await provider.getBalance(bob.address, txBlock);

      // Alice assertions
      expect(aliceAtBlockMinus1).to.equal(aliceBalanceBefore);
      expect(aliceAtTxBlock).to.equal(aliceBalanceBefore - transferAmount - gasCost);
      expect(aliceAtBlockPlus1).to.equal(aliceAtTxBlock);

      // Bob assertions
      expect(bobAtBlockMinus1).to.equal(bobBalanceBefore);
      expect(bobAtTxBlock).to.equal(bobBalanceBefore + transferAmount);
    });

    it('returns zero for address at block before it received funds', async () => {
      const newUser = await User.create(RPC_URL);
      const blockBeforeFunding = await provider.getBlockNumber();
      
      const tx = await funder.wallet.sendTransaction({
        to: newUser.address,
        value: ethers.parseEther('1'),
      });
      await tx.wait();

      const balanceBeforeFunding = await provider.getBalance(newUser.address, blockBeforeFunding);
      const balanceAfterFunding = await provider.getBalance(newUser.address, 'latest');

      expect(balanceBeforeFunding).to.equal(0n);
      expect(balanceAfterFunding).to.equal(ethers.parseEther('1'));
    });

    it('balance monotonically decreases across sequential outgoing transfers', async () => {
      const startBalance = await provider.getBalance(alice.address, 'latest');
      const startBlock = await provider.getBlockNumber();

      const tx1 = await alice.wallet.sendTransaction({ to: bob.address, value: ethers.parseEther('0.1') });
      const receipt1 = await tx1.wait();

      const tx2 = await alice.wallet.sendTransaction({ to: bob.address, value: ethers.parseEther('0.1') });
      const receipt2 = await tx2.wait();

      const balanceAtStart = await provider.getBalance(alice.address, startBlock);
      const balanceAfterTx1 = await provider.getBalance(alice.address, receipt1!.blockNumber);
      const balanceAfterTx2 = await provider.getBalance(alice.address, receipt2!.blockNumber);

      expect(balanceAtStart).to.equal(startBalance);
      expect(balanceAfterTx1 < balanceAtStart).to.equal(true);
      expect(balanceAfterTx2 < balanceAfterTx1).to.equal(true);
    });

  });

  describe('Block tag queries', function () {
    let aliceInitialBalance: bigint;

    it('Stores current balance', async () => {
        aliceInitialBalance = await provider.getBalance(alice.address, 'latest');
    });

    it('queries balance with "latest" tag', async () => {
      const balance = await provider.getBalance(alice.address, 'latest');
      expect(balance).to.equal(aliceInitialBalance);
    });

    it('queries balance with "pending" tag', async () => {
      const balance = await provider.getBalance(alice.address, 'pending');
      expect(balance).to.equal(aliceInitialBalance);
    });

    it('queries balance with "earliest" tag returns zero', async () => {
      const unfunded = ethers.Wallet.createRandom().address;
      const balance = await provider.getBalance(unfunded, 'earliest');
      expect(balance).to.equal(0n);
    });

    it('queries balance with "safe" tag', async () => {
      const balance = await provider.getBalance(alice.address, 'safe');
      expect(balance).to.equal(aliceInitialBalance);
    });

    it('queries balance with "finalized" tag', async () => {
      const balance = await provider.getBalance(alice.address, 'finalized');
      expect(balance).to.equal(aliceInitialBalance);
    });

    it('pending balance is greater than or equal to latest balance', async () => {
      const latestBalance = await provider.getBalance(alice.address, 'latest');
      const pendingBalance = await provider.getBalance(alice.address, 'pending');
      expect(pendingBalance).to.equal(latestBalance);
    });

  });

  describe('Contract balance queries', function () {

    it('deployed contract has zero native balance', async () => {
      const balance = await provider.getBalance(erc20Address, 'latest');
      expect(balance).to.equal(0n);
    });

    it('queries balance of precompile address', async () => {
      const stakingPrecompile = '0x0000000000000000000000000000000000001005';
      const balance = await provider.getBalance(stakingPrecompile, 'latest');
      expect(balance >= 0n).to.equal(true);
    });

  });

  describe('Edge cases and error handling', function () {

    it('handles hex block number format', async () => {
      const currentBlock = await provider.getBlockNumber();
      const hexBlock = '0x' + currentBlock.toString(16);

      const balanceHex = await provider.send('eth_getBalance', [alice.address, hexBlock]);
      const balanceNumber = await provider.getBalance(alice.address, currentBlock);

      expect(BigInt(balanceHex)).to.equal(balanceNumber);
    });

    it('zero address returns a valid balance', async () => {
      const balance = await provider.getBalance(ethers.ZeroAddress, 'latest');
      expect(balance >= 0n).to.equal(true);
    });

    it('fails with invalid address format', async () => {
      try {
        await provider.send('eth_getBalance', ['0xinvalid', 'latest']);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e).to.exist;
      }
    });

    it('fails with future block number', async () => {
      const currentBlock = await provider.getBlockNumber();
      const futureBlock = currentBlock + 1000000;

      try {
        await provider.send('eth_getBalance', [alice.address, '0x' + futureBlock.toString(16)]);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.contain('is not yet available');
      }
    });

    it('checksum and lowercase addresses return identical balance', async () => {
      const checksumAddress = ethers.getAddress(alice.address);
      const lowercaseAddress = alice.address.toLowerCase();

      const balanceChecksum = await provider.getBalance(checksumAddress, 'latest');
      const balanceLowercase = await provider.getBalance(lowercaseAddress, 'latest');
      expect(balanceChecksum).to.equal(balanceLowercase);
    });

  });

  describe('Consistency checks', function () {
    it('balance decreases by exact transfer amount plus gas after multiple transfers', async () => {
      const initialBalance = await provider.getBalance(alice.address, 'latest');
      const transferAmount = ethers.parseEther('0.1');
      let totalGasCost = 0n;

      for (let i = 0; i < 3; i++) {
        const tx = await alice.wallet.sendTransaction({
          to: bob.address,
          value: transferAmount,
        });
        const receipt = await tx.wait();
        totalGasCost += receipt!.gasUsed * receipt!.gasPrice;
      }

      const finalBalance = await provider.getBalance(alice.address, 'latest');
      const expectedBalance = initialBalance - (transferAmount * 3n) - totalGasCost;

      expect(finalBalance).to.equal(expectedBalance);
    });

    it('sender loss equals receiver gain plus gas cost', async () => {
      const aliceBefore = await provider.getBalance(alice.address, 'latest');
      const bobBefore = await provider.getBalance(bob.address, 'latest');

      const transferAmount = ethers.parseEther('0.25');
      const tx = await alice.wallet.sendTransaction({
        to: bob.address,
        value: transferAmount,
      });
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      const aliceAfter = await provider.getBalance(alice.address, 'latest');
      const bobAfter = await provider.getBalance(bob.address, 'latest');

      const aliceLoss = aliceBefore - aliceAfter;
      const bobGain = bobAfter - bobBefore;

      expect(aliceLoss).to.equal(transferAmount + gasCost);
      expect(bobGain).to.equal(transferAmount);
    });
  });
});
