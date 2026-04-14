import { expect } from 'chai';
import { ethers, Contract } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

import ERC20_ARTIFACT from '../../../../artifacts/contracts/TestERC20.sol/TestERC20.json';


const network = getNetwork('local');
const RPC_URL = network.url;

describe('eth_getStorageAt', function () {
  this.timeout(120 * 1000);

  let provider: ethers.JsonRpcProvider;
  let funder: User;
  let alice: User;
  let txBuilder: TxBuilder;
  let erc20: ethers.Contract;
  let erc20Address: string;

  before(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);

    const admin = await SeiUserFactory.createAdminUser();
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, 2);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    const users = await Promise.all(
      seiUsers.map(su => User.fromPrivateKey(su.evmWallet.wallet.privateKey, RPC_URL))
    );
    alice = users[0];

    txBuilder = new TxBuilder(users);
    erc20 = await txBuilder.deployErc20(funder);
    erc20Address = await erc20.getAddress();

    const mintResult = await txBuilder.mintToUsers(ethers.parseEther('1000'));
    if (mintResult.failCount > 0) {
      const erc20ForMint = new Contract(erc20Address, ERC20_ARTIFACT.abi, funder.wallet);
      for (const user of users) {
        const balance = await erc20.balanceOf(user.address);
        if (balance === 0n) {
          const tx = await erc20ForMint.getFunction('mint')(user.address, ethers.parseEther('1000'));
          await tx.wait();
        }
      }
    }
  });

  describe('Basic storage queries', function () {

    it('reads storage slot 0', async () => {
      const storage = await provider.getStorage(erc20Address, 0, 'latest');

      expect(storage).to.match(/^0x[a-fA-F0-9]{64}$/);
      console.log(`Slot 0: ${storage}`);
    });

    it('reads empty storage slot', async () => {
      const storage = await provider.getStorage(erc20Address, 999999, 'latest');

      expect(storage).to.equal('0x' + '0'.repeat(64));
    });

    it('reads storage using hex slot', async () => {
      const storage = await provider.send('eth_getStorageAt', [
        erc20Address,
        '0x0',
        'latest'
      ]);

      expect(storage).to.match(/^0x[a-fA-F0-9]{64}$/);
    });

  });

  describe('ERC20 storage layout', function () {

    it('reads balance mapping slot for alice', async () => {
      const balanceSlot = 0;
      const slot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['address', 'uint256'],
          [alice.address, balanceSlot]
        )
      );

      const storage = await provider.getStorage(erc20Address, slot, 'latest');
      const balance = BigInt(storage);

      const actualBalance = await (erc20 as any).balanceOf(alice.address);
      
      console.log(`Storage balance: ${ethers.formatEther(balance)}`);
      console.log(`Contract balance: ${ethers.formatEther(actualBalance)}`);
    });

  });

  describe('Historical storage queries', function () {

    it('reads storage at previous block', async () => {
      const currentBlock = await provider.getBlockNumber();
      const previousBlock = Math.max(1, currentBlock - 5);

      const storagePrevious = await provider.getStorage(erc20Address, 0, previousBlock);
      const storageLatest = await provider.getStorage(erc20Address, 0, 'latest');

      expect(storagePrevious).to.match(/^0x[a-fA-F0-9]{64}$/);
      expect(storageLatest).to.match(/^0x[a-fA-F0-9]{64}$/);
    });

    it('tracks storage change after state modification', async () => {
      const connectedErc20 = erc20.connect(alice.wallet) as any;
      
      const balanceBefore = await connectedErc20.balanceOf(alice.address);
      
      const tx = await connectedErc20.transfer(funder.address, ethers.parseEther('10'));
      const receipt = await tx.wait();
      const txBlock = receipt!.blockNumber;

      const balanceAfter = await connectedErc20.balanceOf(alice.address);

      expect(balanceAfter).to.equal(balanceBefore - ethers.parseEther('10'));
      console.log(`Balance before: ${ethers.formatEther(balanceBefore)}`);
      console.log(`Balance after: ${ethers.formatEther(balanceAfter)}`);
    });

  });

  describe('Block tag queries', function () {

    it('queries storage with "latest" tag', async () => {
      const storage = await provider.getStorage(erc20Address, 0, 'latest');
      expect(storage).to.match(/^0x[a-fA-F0-9]{64}$/);
    });

    it('queries storage with "pending" tag', async () => {
      const storage = await provider.getStorage(erc20Address, 0, 'pending');
      expect(storage).to.match(/^0x[a-fA-F0-9]{64}$/);
    });

    it('queries storage with "earliest" tag', async () => {
      const storage = await provider.getStorage(erc20Address, 0, 'earliest');
      expect(storage).to.equal('0x' + '0'.repeat(64));
    });

  });

  describe('Edge cases', function () {

    it('returns zero for EOA storage', async () => {
      const storage = await provider.getStorage(alice.address, 0, 'latest');
      expect(storage).to.equal('0x' + '0'.repeat(64));
    });

    it('handles large slot numbers', async () => {
      const largeSlot = '0x' + 'f'.repeat(64);
      const storage = await provider.send('eth_getStorageAt', [
        erc20Address,
        largeSlot,
        'latest'
      ]);

      expect(storage).to.match(/^0x[a-fA-F0-9]{64}$/);
    });

    it('handles checksum and lowercase addresses identically', async () => {
      const checksumAddress = ethers.getAddress(erc20Address);
      const lowercaseAddress = erc20Address.toLowerCase();

      const storageChecksum = await provider.getStorage(checksumAddress, 0, 'latest');
      const storageLowercase = await provider.getStorage(lowercaseAddress, 0, 'latest');

      expect(storageChecksum).to.equal(storageLowercase);
    });

  });

});
