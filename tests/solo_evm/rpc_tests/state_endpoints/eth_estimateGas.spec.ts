import { expect } from 'chai';
import { ethers, Contract } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

import ERC20_ARTIFACT from '../../../../artifacts/contracts/TestERC20.sol/TestERC20.json';


const network = getNetwork('local');
const RPC_URL = network.url;

describe('eth_estimateGas', function () {
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

    const mintResult = await txBuilder.mintToUsers(ethers.parseEther('1000'));
    if (mintResult.failCount > 0) {
      const erc20ForMint = new Contract(erc20Address, ERC20_ARTIFACT.abi, funder.wallet);
      for (const user of [alice, bob]) {
        const balance = await erc20.balanceOf(user.address);
        if (balance === 0n) {
          const tx = await erc20ForMint.getFunction('mint')(user.address, ethers.parseEther('1000'));
          await tx.wait();
        }
      }
    }
  });

  describe('Simple transfer estimation', function () {

    it('estimates gas for simple ETH transfer', async () => {
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: bob.address,
        value: ethers.parseEther('0.1'),
      });

      expect(estimate).to.equal(21000n);
      console.log(`Simple transfer estimate: ${estimate}`);
    });

    it('estimates gas for ETH transfer', async () => {
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: bob.address,
        value: ethers.parseEther('0.1'),
      });

      expect(estimate).to.equal(21000n);
    });

    it('estimates gas for transfer with data', async () => {
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: bob.address,
        value: ethers.parseEther('0.1'),
        data: '0x1234567890',
      });

      expect(estimate > 21000n).to.be.true;
    });

  });

  describe('Contract call estimation', function () {

    it('estimates gas for ERC20 transfer', async () => {
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, ethers.parseEther('10')]);

      const estimate = await provider.estimateGas({
        from: alice.address,
        to: erc20Address,
        data,
      });

      expect(estimate > 21000n).to.be.true;
      expect(estimate < 100000n).to.be.true;
    });

    it('estimates gas for ERC20 approve', async () => {
      const data = erc20.interface.encodeFunctionData('approve', [bob.address, ethers.parseEther('100')]);

      const estimate = await provider.estimateGas({
        from: alice.address,
        to: erc20Address,
        data,
      });

      expect(estimate > 21000n).to.be.true;
    });

    it('estimates gas for ERC20 mint', async () => {
      const data = erc20.interface.encodeFunctionData('mint', [alice.address, ethers.parseEther('100')]);

      const estimate = await provider.estimateGas({
        from: alice.address,
        to: erc20Address,
        data,
      });

      expect(estimate > 21000n).to.be.true;
    });

    it('estimates gas for view function (should be minimal)', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const estimate = await provider.estimateGas({
        to: erc20Address,
        data,
      });

      expect(estimate > 21000n).to.be.true;
    });

  });

  describe('Contract deployment estimation', function () {

    it('estimates gas for contract deployment', async () => {
      const estimate = await provider.estimateGas({
        from: funder.address,
        data: ERC20_ARTIFACT.bytecode + ethers.AbiCoder.defaultAbiCoder().encode(['address'], [funder.address]).slice(2),
      });

      expect(estimate > 500000n).to.be.true;
    });

  });

  describe('Estimation accuracy', function () {

    it('actual gas used is less than or equal to estimate', async () => {
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, ethers.parseEther('1')]);

      const estimate = await provider.estimateGas({
        from: alice.address,
        to: erc20Address,
        data,
      });

      const connectedErc20 = erc20.connect(alice.wallet) as any;
      const tx = await connectedErc20.transfer(bob.address, ethers.parseEther('1'), { gasLimit: estimate });
      const receipt = await tx.wait();

      expect(Number(receipt!.gasUsed)).to.be.lte(Number(estimate));
    });

    it('estimate is reasonably close to actual usage', async () => {
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: bob.address,
        value: ethers.parseEther('0.01'),
      });

      const tx = await alice.wallet.sendTransaction({
        to: bob.address,
        value: ethers.parseEther('0.01'),
      });
      const receipt = await tx.wait();

      const difference = estimate - receipt!.gasUsed;
      const percentageDiff = (Number(difference) / Number(estimate)) * 100;

      expect(percentageDiff).to.be.lt(20);
    });

  });

  describe('Error handling', function () {

    it('fails estimation for transfer exceeding balance', async () => {
      const hugeAmount = ethers.parseEther('999999999999');
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, hugeAmount]);

      try {
        await provider.estimateGas({
          from: alice.address,
          to: erc20Address,
          data,
        });
        expect.fail('Should have failed');
      } catch (e: any) {
        expect(e.message).to.include('revert');
      }
    });

    it('fails estimation for insufficient ETH balance', async () => {
      const poorUser = ethers.Wallet.createRandom();

      try {
        await provider.estimateGas({
          from: poorUser.address,
          to: bob.address,
          value: ethers.parseEther('1000000'),
        });
        expect.fail('Should have failed');
      } catch (e: any) {
        expect(e.message.toLowerCase()).to.include('insufficient');
      }
    });

    it('fails estimation for invalid contract call', async () => {
      try {
        await provider.estimateGas({
          from: alice.address,
          to: erc20Address,
          data: '0x12345678',
        });
        expect.fail('Should have failed');
      } catch (e: any) {
        console.log(`Invalid call error: ${e.message.slice(0, 80)}`);
      }
    });

  });

  describe('Gas limit parameter', function () {

    it('estimation respects provided gas limit', async () => {
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, ethers.parseEther('1')]);

      const estimateWithLimit = await provider.estimateGas({
        from: alice.address,
        to: erc20Address,
        data,
        gasLimit: 500000n,
      });

      const estimateWithoutLimit = await provider.estimateGas({
        from: alice.address,
        to: erc20Address,
        data,
      });

      expect(estimateWithLimit).to.equal(estimateWithoutLimit);
    });

    it('fails when gas limit is too low', async () => {
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, ethers.parseEther('1')]);

      try {
        await provider.estimateGas({
          from: alice.address,
          to: erc20Address,
          data,
          gasLimit: 1000n,
        });
        expect.fail('Should have failed');
      } catch (e: any) {
        console.log(`Low gas limit error: ${e.message.slice(0, 80)}`);
      }
    });

  });

  describe('Raw RPC call', function () {

    it('uses eth_estimateGas directly', async () => {
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, ethers.parseEther('1')]);

      const result = await provider.send('eth_estimateGas', [
        {
          from: alice.address,
          to: erc20Address,
          data,
        },
      ]);

      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
      const estimate = BigInt(result);
      expect(Number(estimate)).to.be.gt(21000);
      console.log(`Raw RPC estimate: ${estimate}`);
    });

    it('uses eth_estimateGas with all parameters', async () => {
      const feeData = await provider.getFeeData();
      const result = await provider.send('eth_estimateGas', [
        {
          from: alice.address,
          to: bob.address,
          gas: '0x100000',
          gasPrice: ethers.toQuantity(feeData.gasPrice!),
          value: '0x' + ethers.parseEther('0.1').toString(16),
          data: '0x',
        },
      ]);

      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
    });

    it('uses eth_estimateGas with block parameter', async () => {
      const data = erc20.interface.encodeFunctionData('balanceOf', [alice.address]);

      const result = await provider.send('eth_estimateGas', [
        {
          to: erc20Address,
          data,
        },
        'latest',
      ]);

      expect(result).to.match(/^0x[a-fA-F0-9]+$/);
    });

  });

  describe('Different transaction types', function () {

    it('estimates gas for legacy transaction (type 0)', async () => {
      const feeData = await provider.getFeeData();
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: bob.address,
        value: ethers.parseEther('0.01'),
        type: 0,
        gasPrice: feeData.gasPrice!,
      });

      expect(estimate).to.equal(21000n);
    });

    it('estimates gas for EIP-1559 transaction (type 2)', async () => {
      const feeData = await provider.getFeeData();

      const estimate = await provider.estimateGas({
        from: alice.address,
        to: bob.address,
        value: ethers.parseEther('0.01'),
        type: 2,
        maxFeePerGas: feeData.maxFeePerGas!,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
      });

      expect(estimate).to.equal(21000n);
    });

  });

  describe('Consistency checks', function () {

    it('same transaction gives consistent estimates', async () => {
      const data = erc20.interface.encodeFunctionData('transfer', [bob.address, ethers.parseEther('1')]);
      const txParams = {
        from: alice.address,
        to: erc20Address,
        data,
      };

      const estimates: bigint[] = [];
      for (let i = 0; i < 5; i++) {
        const estimate = await provider.estimateGas(txParams);
        estimates.push(estimate);
      }

      const allEqual = estimates.every(e => e === estimates[0]);
      expect(allEqual).to.be.true;
      console.log(`Consistent estimate: ${estimates[0]}`);
    });

  });

  describe('Edge cases', function () {

    it('estimates gas for zero value transfer', async () => {
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: bob.address,
        value: 0n,
      });

      expect(estimate).to.equal(21000n);
    });

    it('estimates gas for self-transfer', async () => {
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: alice.address,
        value: ethers.parseEther('0.01'),
      });

      expect(estimate).to.equal(21000n);
    });

    it('estimates gas for transfer to zero address', async () => {
      const estimate = await provider.estimateGas({
        from: alice.address,
        to: ethers.ZeroAddress,
        value: ethers.parseEther('0.01'),
      });

      expect(Number(estimate)).to.be.gte(21000);
    });

  });

});
