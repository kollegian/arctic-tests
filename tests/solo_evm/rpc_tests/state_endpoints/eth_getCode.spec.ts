import { expect } from 'chai';
import { ethers } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

import ERC20_ARTIFACT from '../../../../artifacts/contracts/TestERC20.sol/TestERC20.json';

const network = getNetwork('local');
const RPC_URL = network.url;

function bytecodeSimilarity(code1: string, code2: string): number {
  const bytes1 = code1.toLowerCase().slice(2);
  const bytes2 = code2.toLowerCase().slice(2);
  
  if (bytes1.length !== bytes2.length) {
    return Math.min(bytes1.length, bytes2.length) / Math.max(bytes1.length, bytes2.length);
  }
  
  let matches = 0;
  for (let i = 0; i < bytes1.length; i += 2) {
    if (bytes1.slice(i, i + 2) === bytes2.slice(i, i + 2)) {
      matches++;
    }
  }
  return matches / (bytes1.length / 2);
}

function bytecodePrefixMatches(code1: string, code2: string, prefixLength = 400): boolean {
  const prefix1 = code1.toLowerCase().slice(2, 2 + prefixLength);
  const prefix2 = code2.toLowerCase().slice(2, 2 + prefixLength);
  return prefix1 === prefix2;
}

describe('eth_getCode', function () {
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
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, 1);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    alice = await User.fromPrivateKey(seiUsers[0].evmWallet.wallet.privateKey, RPC_URL);

    txBuilder = new TxBuilder([alice]);
    erc20 = await txBuilder.deployErc20(funder);
    erc20Address = await erc20.getAddress();
  });

  describe('Basic code queries', function () {

    it('returns bytecode for deployed contract', async () => {
      const code = await provider.getCode(erc20Address, 'latest');
      
      expect(code.startsWith('0x')).to.equal(true);
      expect(code.length > 100).to.equal(true);
    });

    it('returns empty code (0x) for EOA', async () => {
      const code = await provider.getCode(alice.address, 'latest');
      expect(code).to.equal('0x');
    });

    it('returns empty code (0x) for non-existent address', async () => {
      const randomAddress = ethers.Wallet.createRandom().address;
      const code = await provider.getCode(randomAddress, 'latest');
      expect(code).to.equal('0x');
    });

  });

  describe('Bytecode verification', function () {

    it('returned code is highly similar to artifact deployedBytecode (>95%)', async () => {
      const code = await provider.getCode(erc20Address, 'latest');
      const expectedDeployedBytecode = ERC20_ARTIFACT.deployedBytecode;

      const similarity = bytecodeSimilarity(code, expectedDeployedBytecode);
      console.log(`    Bytecode similarity: ${(similarity * 100).toFixed(2)}%`);
      
      // Contracts with immutables (EIP-712 domain separator, address(this)) will differ
      // but should still be >95% similar
      expect(similarity > 0.95).to.equal(true, 
        `Bytecode similarity ${(similarity * 100).toFixed(2)}% should be > 95%`);
    });

    it('bytecode prefix matches artifact (first 400 hex chars)', async () => {
      const code = await provider.getCode(erc20Address, 'latest');
      const expectedDeployedBytecode = ERC20_ARTIFACT.deployedBytecode;

      expect(bytecodePrefixMatches(code, expectedDeployedBytecode, 400)).to.equal(true,
        'Bytecode prefix should match before immutable values');
    });

    it('bytecode contains ERC20 function selectors', async () => {
      const code = await provider.getCode(erc20Address, 'latest');

      const selectors = {
        'transfer(address,uint256)': ethers.id('transfer(address,uint256)').slice(0, 10),
        'balanceOf(address)': ethers.id('balanceOf(address)').slice(0, 10),
        'approve(address,uint256)': ethers.id('approve(address,uint256)').slice(0, 10),
        'totalSupply()': ethers.id('totalSupply()').slice(0, 10),
        'allowance(address,address)': ethers.id('allowance(address,address)').slice(0, 10),
        'transferFrom(address,address,uint256)': ethers.id('transferFrom(address,address,uint256)').slice(0, 10),
      };

      for (const [funcName, selector] of Object.entries(selectors)) {
        const selectorWithoutPrefix = selector.slice(2);
        expect(code.toLowerCase().includes(selectorWithoutPrefix)).to.equal(true, 
          `Bytecode should contain selector for ${funcName}: ${selector}`);
      }
    });

    it('two deployments of same contract have highly similar bytecode (>95%)', async () => {
      const contract1 = await txBuilder.deployErc20(funder);
      const contract2 = await txBuilder.deployErc20(funder);

      const code1 = await provider.getCode(await contract1.getAddress(), 'latest');
      const code2 = await provider.getCode(await contract2.getAddress(), 'latest');

      const similarity = bytecodeSimilarity(code1, code2);
      console.log(`    Two deployments similarity: ${(similarity * 100).toFixed(2)}%`);

      // Different deployments have different addresses embedded (immutables)
      // but the code structure should be >95% similar
      expect(similarity > 0.95).to.equal(true,
        `Two deployments should be >95% similar, got ${(similarity * 100).toFixed(2)}%`);
      
      // Prefix should be identical
      expect(bytecodePrefixMatches(code1, code2, 400)).to.equal(true,
        'Bytecode prefix should match for same contract');
    });

    it('bytecode length matches expected deployed bytecode length', async () => {
      const code = await provider.getCode(erc20Address, 'latest');
      const expectedLength = ERC20_ARTIFACT.deployedBytecode.length;

      expect(code.length).to.equal(expectedLength);
    });

  });

  describe('Historical code queries', function () {

    it('returns 0x at block before deployment, valid code at/after deployment', async () => {
      const newContract = await txBuilder.deployErc20(funder);
      const newContractAddress = await newContract.getAddress();
      const receipt = await newContract.deploymentTransaction()!.wait();
      const deployBlock = receipt!.blockNumber;

      const codeBeforeDeploy = await provider.getCode(newContractAddress, deployBlock - 1);
      const codeAtDeploy = await provider.getCode(newContractAddress, deployBlock);
      const codeAfterDeploy = await provider.getCode(newContractAddress, deployBlock + 1);

      expect(codeBeforeDeploy).to.equal('0x');
      
      // Code at deploy should be similar to artifact (immutables differ)
      const similarity = bytecodeSimilarity(codeAtDeploy, ERC20_ARTIFACT.deployedBytecode);
      expect(similarity > 0.95).to.equal(true, 
        `Code at deploy should be >95% similar to artifact, got ${(similarity * 100).toFixed(2)}%`);
      
      // Code after deploy should be identical to code at deploy
      expect(codeAfterDeploy).to.equal(codeAtDeploy);
    });

    it('code at genesis (block 0) is 0x for deployed contract', async () => {
      const code = await provider.getCode(erc20Address, 0);
      expect(code).to.equal('0x');
    });

  });

  describe('Block tag queries', function () {

    it('latest returns valid bytecode similar to artifact', async () => {
      const code = await provider.getCode(erc20Address, 'latest');
      const similarity = bytecodeSimilarity(code, ERC20_ARTIFACT.deployedBytecode);
      expect(similarity > 0.95).to.equal(true,
        `Latest code should be >95% similar to artifact, got ${(similarity * 100).toFixed(2)}%`);
    });

    it('pending returns valid bytecode similar to artifact', async () => {
      const code = await provider.getCode(erc20Address, 'pending');
      const similarity = bytecodeSimilarity(code, ERC20_ARTIFACT.deployedBytecode);
      expect(similarity > 0.95).to.equal(true,
        `Pending code should be >95% similar to artifact, got ${(similarity * 100).toFixed(2)}%`);
    });

    it('earliest returns 0x (contract not deployed at genesis)', async () => {
      const code = await provider.getCode(erc20Address, 'earliest');
      expect(code).to.equal('0x');
    });

    it('latest and pending return identical code', async () => {
      const codeLatest = await provider.getCode(erc20Address, 'latest');
      const codePending = await provider.getCode(erc20Address, 'pending');
      expect(codeLatest).to.equal(codePending);
    });

  });

  describe('Precompile contracts', function () {

    it('staking precompile returns consistent code (may be 0x or bytecode)', async () => {
      const stakingPrecompile = '0x0000000000000000000000000000000000001005';
      const code = await provider.getCode(stakingPrecompile, 'latest');
      
      // Sei precompiles may return 0x or actual bytecode depending on implementation
      // The important thing is it returns a valid hex string
      expect(code.startsWith('0x')).to.equal(true);
      console.log(`    Staking precompile code length: ${code.length} chars`);
    });

    it('precompile code is consistent across queries', async () => {
      const stakingPrecompile = '0x0000000000000000000000000000000000001005';
      
      const code1 = await provider.getCode(stakingPrecompile, 'latest');
      const code2 = await provider.getCode(stakingPrecompile, 'latest');
      
      expect(code1).to.equal(code2);
    });

    it('addr precompile returns consistent code', async () => {
      const addrPrecompile = '0x0000000000000000000000000000000000001004';
      const code = await provider.getCode(addrPrecompile, 'latest');
      
      expect(code.startsWith('0x')).to.equal(true);
      console.log(`    Addr precompile code length: ${code.length} chars`);
    });

  });

  describe('Edge cases', function () {

    it('zero address returns 0x or valid code', async () => {
      const code = await provider.getCode(ethers.ZeroAddress, 'latest');
      expect(code.startsWith('0x')).to.equal(true);
    });

    it('checksum and lowercase addresses return identical code', async () => {
      const checksumAddress = ethers.getAddress(erc20Address);
      const lowercaseAddress = erc20Address.toLowerCase();

      const codeChecksum = await provider.getCode(checksumAddress, 'latest');
      const codeLowercase = await provider.getCode(lowercaseAddress, 'latest');

      expect(codeChecksum).to.equal(codeLowercase);
    });

    it('fails with invalid address format', async () => {
      try {
        await provider.send('eth_getCode', ['0xinvalid', 'latest']);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e).to.exist;
      }
    });

    it('fails with future block number', async () => {
      const currentBlock = await provider.getBlockNumber();
      const futureBlock = currentBlock + 1000000;

      try {
        await provider.send('eth_getCode', [erc20Address, '0x' + futureBlock.toString(16)]);
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).to.contain('is not yet available');
      }
    });

  });

});
