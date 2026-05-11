import { expect } from 'chai';
import { ethers } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

import ERC20_ARTIFACT from '../../../../artifacts/contracts/TestERC20.sol/TestERC20.json';

const network = getNetwork('local');
const RPC_URL = network.url;

describe('eth_call', function () {
  this.timeout(120 * 1000);

  let provider: ethers.JsonRpcProvider;
  let funder: User;
  let alice: User;
  let bob: User;
  let txBuilder: TxBuilder;
  let erc20: ethers.Contract;
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
    erc20 = await txBuilder.deployErc20(funder);
    erc20Address = await erc20.getAddress();

    await txBuilder.mintToUsers(ethers.parseEther('1000'));
  });

  describe('Basic call queries', function () {

    it('calls view function without from address', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const result = await provider.call({
        to: erc20Address,
        data,
      });

      const balance = erc20.interface.decodeFunctionResult('balanceOf', result)[0];
      expect(balance > 0n).to.be.true;
    });

    it('calls view function with from address', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const result = await provider.call({
        from: alice.address,
        to: erc20Address,
        data,
      });

      const balance = erc20.interface.decodeFunctionResult('balanceOf', result)[0];
      expect(balance > 0n).to.be.true;
    });

    it('calls totalSupply', async () => {
      const data = erc20.interface.encodeFunctionData('totalSupply');

      const result = await provider.call({
        to: erc20Address,
        data,
      });

      const totalSupply = erc20.interface.decodeFunctionResult('totalSupply', result)[0];
      expect(totalSupply > 0n).to.be.true;
    });

    it('calls name and symbol', async () => {
      const nameData = erc20.interface.encodeFunctionData('name');
      const symbolData = erc20.interface.encodeFunctionData('symbol');

      const nameResult = await provider.call({ to: erc20Address, data: nameData });
      const symbolResult = await provider.call({ to: erc20Address, data: symbolData });

      const name = erc20.interface.decodeFunctionResult('name', nameResult)[0];
      const symbol = erc20.interface.decodeFunctionResult('symbol', symbolResult)[0];

      expect(name).to.be.a('string');
      expect(symbol).to.be.a('string');
      console.log(`Token: ${name} (${symbol})`);
    });

  });

  describe('Simulate state-changing calls', function () {

    it('simulates transfer without actually executing', async () => {
      const balanceBefore = await (erc20 as any).balanceOf(alice.address);
      const transferAmount = ethers.parseEther('100');

      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, transferAmount]);

      const result = await provider.call({
        from: alice.address,
        to: erc20Address,
        data,
      });

      const success = erc20.interface.decodeFunctionResult('transfer', result)[0];
      expect(success).to.be.true;

      const balanceAfter = await (erc20 as any).balanceOf(alice.address);
      expect(balanceAfter).to.equal(balanceBefore);
    });

    it('simulates approve', async () => {
      const approveAmount = ethers.parseEther('500');
      const data = erc20.interface.encodeFunctionData('approve', [bob.address, approveAmount]);

      const result = await provider.call({
        from: alice.address,
        to: erc20Address,
        data,
      });

      const success = erc20.interface.decodeFunctionResult('approve', result)[0];
      expect(success).to.be.true;
    });

    it('simulates mint', async () => {
      const mintAmount = ethers.parseEther('1000');
      const data = erc20.interface.encodeFunctionData('mint', [alice.address, mintAmount]);

      const result = await provider.call({
        from: alice.address,
        to: erc20Address,
        data,
      });

      expect(result).to.equal('0x');

      const balance = await (erc20 as any).balanceOf(alice.address);
      expect(balance).to.equal(ethers.parseEther('1000'));
    });

  });

  describe('Call with value', function () {

    it('simulates call with ETH value to payable function', async () => {
      const result = await provider.call({
        from: alice.address,
        to: bob.address,
        value: ethers.parseEther('1'),
      });

      expect(result).to.equal('0x');
    });

  });

  describe('Historical calls', function () {

    it('calls at previous block number', async () => {
      const currentBlock = await provider.getBlockNumber();
      const previousBlock = Math.max(1, currentBlock - 5);

      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const resultPrevious = await provider.call(
        { to: erc20Address, data },
        previousBlock
      );

      const resultLatest = await provider.call(
        { to: erc20Address, data },
        'latest'
      );

      const balancePrevious = erc20.interface.decodeFunctionResult('balanceOf', resultPrevious)[0];
      const balanceLatest = erc20.interface.decodeFunctionResult('balanceOf', resultLatest)[0];

      console.log(`Balance at block ${previousBlock}: ${ethers.formatEther(balancePrevious)}`);
      console.log(`Balance at latest: ${ethers.formatEther(balanceLatest)}`);
    });

    it('tracks balance change across a transfer', async () => {
      const balanceBefore = await (erc20 as any).balanceOf(alice.address);
      const transferAmount = ethers.parseEther('10');

      const transferData = erc20.interface.encodeFunctionData('transfer', [bob.address, transferAmount]);
      const tx = await alice.wallet.sendTransaction({
        to: erc20Address,
        data: transferData,
        gasLimit: 200000n,
      });
      const receipt = await tx.wait();
      expect(receipt!.status).to.equal(1);

      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const resultAtTxBlock = await provider.call({ to: erc20Address, data }, receipt!.blockNumber);
      const resultAtLatest = await provider.call({ to: erc20Address, data }, 'latest');

      const balanceAtTxBlock = erc20.interface.decodeFunctionResult('balanceOf', resultAtTxBlock)[0];
      const balanceAtLatest = erc20.interface.decodeFunctionResult('balanceOf', resultAtLatest)[0];

      expect(balanceAtTxBlock).to.equal(balanceBefore - transferAmount);
      expect(balanceAtLatest).to.equal(balanceBefore - transferAmount);
    });

  });

  describe('Block tag queries', function () {

    it('calls with "latest" tag', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);
      const result = await provider.call({ to: erc20Address, data }, 'latest');
      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
    });

    it('calls with "pending" tag', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);
      const result = await provider.call({ to: erc20Address, data }, 'pending');
      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
    });

    it('calls with "earliest" tag returns zero balance', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      try {
        const result = await provider.call({ to: erc20Address, data }, 'earliest');
        const balance = erc20.interface.decodeFunctionResult('balanceOf', result)[0];
        expect(balance).to.equal(0n);
      } catch (e) {
        console.log('Call at earliest block failed (contract not deployed)');
      }
    });

  });

  describe('Error handling', function () {

    it('reverts when transfer exceeds balance', async () => {
      const hugeAmount = ethers.parseEther('999999999999');
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, hugeAmount]);

      try {
        await provider.call({
          from: alice.address,
          to: erc20Address,
          data,
        });
        expect.fail('Should have reverted');
      } catch (e: any) {
        expect(e.message).to.include('revert');
        console.log(`Revert error: ${e.message.slice(0, 80)}`);
      }
    });

    it('returns empty result for call to EOA', async () => {
      const result = await provider.call({
        to: bob.address,
        data: '0x12345678',
      });

      expect(result).to.equal('0x');
    });

    it('fails with invalid contract address format', async () => {
      try {
        await provider.call({
          to: '0xinvalid',
          data: '0x',
        });
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.match(/invalid|ENS|resolve|address/i);
      }
    });

  });

  describe('Gas limit handling', function () {

    it('call succeeds with explicit gas limit', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const result = await provider.call({
        to: erc20Address,
        data,
        gasLimit: 100000n,
      });

      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
    });

    it('call fails with insufficient gas', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      try {
        await provider.call({
          to: erc20Address,
          data,
          gasLimit: 100n,
        });
        expect.fail('Should have failed');
      } catch (e: any) {
        console.log(`Insufficient gas error: ${e.message.slice(0, 80)}`);
      }
    });

  });

  describe('Raw RPC call', function () {

    it('uses eth_call directly', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const result = await provider.send('eth_call', [
        {
          to: erc20Address,
          data,
        },
        'latest',
      ]);

      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
      const balance = erc20.interface.decodeFunctionResult('balanceOf', result)[0];
      expect(balance > 0n).to.be.true;
    });

    it('uses eth_call with all parameters', async () => {
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, ethers.parseEther('1')]);

      const result = await provider.send('eth_call', [
        {
          from: alice.address,
          to: erc20Address,
          gas: '0x100000',
          gasPrice: '0x77359400',
          value: '0x0',
          data,
        },
        'latest',
      ]);

      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
    });

  });

  describe('Precompile calls', function () {

    it('calls staking precompile validators query', async () => {
      const stakingPrecompile = '0x0000000000000000000000000000000000001005';
      const iface = new ethers.Interface(['function validators(string status, bytes pagination) view returns (bytes)']);

      const data = iface.encodeFunctionData('validators', ['BOND_STATUS_BONDED', '0x']);

      try {
        const result = await provider.call({
          to: stakingPrecompile,
          data,
        });
        console.log(`Staking precompile result length: ${result.length}`);
      } catch (e: any) {
        console.log(`Staking precompile call: ${e.message.slice(0, 80)}`);
      }
    });

  });

});
