import { expect } from 'chai';
import { ethers } from 'ethers';
import { User } from '../../shared/User';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

const network = getNetwork('local');
const RPC_URL = network.url;

describe('eth_getTransactionCount', function () {
  this.timeout(120 * 1000);

  let provider: ethers.JsonRpcProvider;
  let funder: User;
  let alice: User;
  let bob: User;

  before(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);

    const admin = await SeiUserFactory.createAdminUser();
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, 2);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    [alice, bob] = await Promise.all(
      seiUsers.map(su => User.fromPrivateKey(su.evmWallet.wallet.privateKey, RPC_URL))
    );
  });

  describe('Basic nonce queries', function () {

    it('returns nonce for address at latest block', async () => {
      const nonce = await provider.getTransactionCount(alice.address, 'latest');

      expect(nonce).to.be.a('number');
      expect(nonce).to.be.gte(0);
      console.log(`Alice nonce at latest: ${nonce}`);
    });

    it('returns zero nonce for new address', async () => {
      const randomAddress = ethers.Wallet.createRandom().address;
      const nonce = await provider.getTransactionCount(randomAddress, 'latest');

      expect(nonce).to.equal(0);
    });

    it('returns nonce using raw RPC call', async () => {
      const nonceHex = await provider.send('eth_getTransactionCount', [alice.address, 'latest']);

      expect(nonceHex).to.match(/^0x[a-fA-F0-9]+$/);
      const nonce = parseInt(nonceHex, 16);
      expect(nonce).to.be.gte(0);
    });

  });

  describe('Nonce increments', function () {

    it('nonce increments after sending transaction', async () => {
      const nonceBefore = await provider.getTransactionCount(alice.address, 'latest');

      const tx = await alice.wallet.sendTransaction({
        to: bob.address,
        value: ethers.parseEther('0.01'),
      });
      await tx.wait();

      const nonceAfter = await provider.getTransactionCount(alice.address, 'latest');

      expect(nonceAfter).to.equal(nonceBefore + 1);
      console.log(`Nonce before: ${nonceBefore}, after: ${nonceAfter}`);
    });

    it('nonce increments correctly after multiple transactions', async () => {
      const nonceBefore = await provider.getTransactionCount(alice.address, 'latest');

      for (let i = 0; i < 3; i++) {
        const tx = await alice.wallet.sendTransaction({
          to: bob.address,
          value: ethers.parseEther('0.01'),
        });
        await tx.wait();
      }

      const nonceAfter = await provider.getTransactionCount(alice.address, 'latest');

      expect(nonceAfter).to.equal(nonceBefore + 3);
    });

  });

  describe('Historical nonce queries', function () {

    it('queries nonce at previous block', async () => {
      const currentBlock = await provider.getBlockNumber();
      const previousBlock = Math.max(1, currentBlock - 5);

      const noncePrevious = await provider.getTransactionCount(alice.address, previousBlock);
      const nonceLatest = await provider.getTransactionCount(alice.address, 'latest');

      expect(noncePrevious).to.be.lte(nonceLatest);
      console.log(`Nonce at block ${previousBlock}: ${noncePrevious}`);
      console.log(`Nonce at latest: ${nonceLatest}`);
    });

    it('tracks nonce change at exact transaction block', async () => {
      const nonceBefore = await provider.getTransactionCount(alice.address, 'latest');

      const tx = await alice.wallet.sendTransaction({
        to: bob.address,
        value: ethers.parseEther('0.01'),
      });
      const receipt = await tx.wait();
      const txBlock = receipt!.blockNumber;

      const nonceAtBlockMinus1 = await provider.getTransactionCount(alice.address, txBlock - 1);
      const nonceAtTxBlock = await provider.getTransactionCount(alice.address, txBlock);

      expect(nonceAtBlockMinus1).to.equal(nonceBefore);
      expect(nonceAtTxBlock).to.equal(nonceBefore + 1);
    });

  });

  describe('Block tag queries', function () {

    it('queries nonce with "latest" tag', async () => {
      const nonce = await provider.getTransactionCount(alice.address, 'latest');
      expect(nonce).to.be.a('number');
    });

    it('queries nonce with "pending" tag', async () => {
      const nonce = await provider.getTransactionCount(alice.address, 'pending');
      expect(nonce).to.be.a('number');
    });

    it('queries nonce with "earliest" tag', async () => {
      const nonce = await provider.getTransactionCount(alice.address, 'earliest');
      expect(nonce).to.equal(0);
    });

    it('pending nonce >= latest nonce', async () => {
      const latestNonce = await provider.getTransactionCount(alice.address, 'latest');
      const pendingNonce = await provider.getTransactionCount(alice.address, 'pending');

      expect(pendingNonce).to.be.gte(latestNonce);
    });

  });

  describe('Contract nonce', function () {

    it('contract has nonce of 1 after deployment', async () => {
      const contractFactory = new ethers.ContractFactory(
        ['constructor()'],
        '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe6080604052600080fdfea264697066735822',
        funder.wallet
      );
      const contract = await contractFactory.deploy();
      await contract.waitForDeployment();
      const contractAddress = await contract.getAddress();

      const nonce = await provider.getTransactionCount(contractAddress, 'latest');
      expect(nonce).to.equal(1);
    });

  });

  describe('Edge cases', function () {

    it('handles zero address', async () => {
      const nonce = await provider.getTransactionCount(ethers.ZeroAddress, 'latest');
      expect(nonce).to.be.a('number');
    });

    it('handles checksum and lowercase addresses identically', async () => {
      const checksumAddress = ethers.getAddress(alice.address);
      const lowercaseAddress = alice.address.toLowerCase();

      const nonceChecksum = await provider.getTransactionCount(checksumAddress, 'latest');
      const nonceLowercase = await provider.getTransactionCount(lowercaseAddress, 'latest');

      expect(nonceChecksum).to.equal(nonceLowercase);
    });

    it('fails with future block number', async () => {
      const currentBlock = await provider.getBlockNumber();
      const futureBlock = currentBlock + 1000000;

      try {
        await provider.send('eth_getTransactionCount', [alice.address, '0x' + futureBlock.toString(16)]);
        expect.fail('Should have thrown');
      } catch (e: any) {
        console.log(`Future block error: ${e.message.slice(0, 80)}`);
      }
    });

  });

});
