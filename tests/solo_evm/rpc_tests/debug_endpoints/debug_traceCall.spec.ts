import { expect } from 'chai';
import { ethers, Contract } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder, CallScenario, TRACER_OPTIONS } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';


const network = getNetwork('local');
const RPC_URL = network.url;

const USER_COUNT = 20;

describe('debug_traceCall Tests', function () {
  this.timeout(10 * 60 * 1000);

  let txBuilder: TxBuilder;
  let users: User[];
  let funder: User;
  let provider: ethers.JsonRpcProvider;
  let erc20: Contract;
  let erc20Address: string;

  const callScenarios: CallScenario[] = [];


  before('Initialize clients and deploy contracts', async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);

    const admin = await SeiUserFactory.createAdminUser();
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, USER_COUNT);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    users = await Promise.all(
      seiUsers.map(su => User.fromPrivateKey(su.evmWallet.wallet.privateKey, RPC_URL))
    );

    console.log(`Admin EVM address: ${funder.address}`);
    console.log(`Created ${users.length} funded users`);

    txBuilder = new TxBuilder(users);

    console.log('Deploying ERC20 contract...');
    erc20 = await txBuilder.deployErc20(funder);
    erc20Address = await erc20.getAddress();
    console.log(`ERC20 deployed at: ${erc20Address}`);

    console.log('Minting tokens to users...');
    const mintResult = await txBuilder.mintToUsers(ethers.parseEther('10000'));
    console.log(`Mint results: ${mintResult.successCount} success, ${mintResult.failCount} failed`);

    if (mintResult.failCount > 0) {
      console.log('Retrying failed mints with higher gas limit...');
      for (const user of users) {
        const balance = await erc20.balanceOf(user.address);
        if (balance === 0n) {
          const tx = await (erc20.connect(funder.wallet) as Contract).getFunction('mint')(user.address, ethers.parseEther('10000'));
          await tx.wait();
        }
      }
      console.log('Retry mints complete');
    }

    setupCallScenarios();
  });

  function setupCallScenarios() {
    // Simple ETH transfer
    callScenarios.push({
      name: 'simple_transfer',
      callParams: {
        from: funder.address,
        to: users[0].address,
        value: ethers.toQuantity(ethers.parseEther('0.01')),
      },
      expectedSuccess: true,
      description: 'Simple ETH transfer',
    });

    // ETH transfer with no from (uses zero address)
    callScenarios.push({
      name: 'transfer_no_from',
      callParams: {
        to: users[0].address,
        value: ethers.toQuantity(ethers.parseEther('0.01')),
      },
      expectedSuccess: true,
      description: 'ETH transfer without from address',
    });

    // ERC20 balanceOf call
    callScenarios.push({
      name: 'erc20_balanceOf',
      callParams: {
        from: funder.address,
        to: erc20Address,
        data: erc20.interface.encodeFunctionData('balanceOf', [users[0].address]),
      },
      expectedSuccess: true,
      description: 'ERC20 balanceOf call',
    });

    // ERC20 transfer simulation
    callScenarios.push({
      name: 'erc20_transfer',
      callParams: {
        from: users[0].address,
        to: erc20Address,
        data: erc20.interface.encodeFunctionData('transfer', [users[1].address, ethers.parseEther('10')]),
      },
      expectedSuccess: true,
      description: 'ERC20 transfer simulation',
    });

    // ERC20 transfer that should fail (insufficient balance)
    callScenarios.push({
      name: 'erc20_transfer_fail',
      callParams: {
        from: users[10].address,
        to: erc20Address,
        data: erc20.interface.encodeFunctionData('transfer', [users[1].address, ethers.parseEther('999999999')]),
      },
      expectedSuccess: false,
      description: 'ERC20 transfer with insufficient balance (should fail)',
    });

    // Call with explicit gas limit
    callScenarios.push({
      name: 'with_gas_limit',
      callParams: {
        from: funder.address,
        to: users[0].address,
        gas: ethers.toQuantity(50000),
      },
      expectedSuccess: true,
      description: 'Call with explicit gas limit',
    });

    // Call to non-contract address with data
    callScenarios.push({
      name: 'call_with_data_to_eoa',
      callParams: {
        from: funder.address,
        to: users[0].address,
        data: '0x12345678',
      },
      expectedSuccess: true,
      description: 'Call with data to EOA',
    });
  }


  describe('Trace call scenarios with callTracer', function () {

    it('traces all scenarios with callTracer', async () => {
      console.log(`\nTracing ${callScenarios.length} call scenarios with callTracer...`);

      for (const scenario of callScenarios) {
        const result = await provider.send('debug_traceCall', [
          scenario.callParams,
          'latest',
          TRACER_OPTIONS.callTracer
        ]);

        expect(result).to.have.property('type');
        expect(result).to.have.property('gas');
        expect(result).to.have.property('gasUsed');

        const hasError = !!result.error;
        if (scenario.expectedSuccess) {
          expect(hasError, `${scenario.name} should succeed but got error: ${result.error}`).to.be.false;
        }

        console.log(`  ${scenario.description}: type=${result.type}, gasUsed=${result.gasUsed}, error=${result.error || 'none'}`);
      }
    });

    it('verifies callTracer output fields', async () => {
      for (const scenario of callScenarios) {
        const result = await provider.send('debug_traceCall', [
          scenario.callParams,
          'latest',
          TRACER_OPTIONS.callTracer
        ]);

        expect(result.type).to.equal('CALL');
        expect(result.gas).to.match(/^0x[a-fA-F0-9]+$/);
        expect(result.gasUsed).to.match(/^0x[a-fA-F0-9]+$/);
        expect(result.input).to.match(/^0x([a-fA-F0-9]*)?$/);

        if (scenario.callParams.from) {
          expect(result.from.toLowerCase()).to.equal(scenario.callParams.from.toLowerCase());
        }

        expect(result.to.toLowerCase()).to.equal(scenario.callParams.to.toLowerCase());
      }
    });

  });

  describe('Trace call scenarios with prestateTracer', function () {

    it('traces all scenarios with prestateTracer', async () => {
      console.log(`\nTracing ${callScenarios.length} call scenarios with prestateTracer...`);

      for (const scenario of callScenarios) {
        const result = await provider.send('debug_traceCall', [
          scenario.callParams,
          'latest',
          TRACER_OPTIONS.prestateTracer
        ]);

        expect(result).to.be.an('object');
        const addresses = Object.keys(result);
        expect(addresses.length).to.be.greaterThan(0);

        console.log(`  ${scenario.description}: ${addresses.length} addresses in prestate`);
      }
    });

    it('verifies prestate contains relevant addresses', async () => {
      for (const scenario of callScenarios) {
        const result = await provider.send('debug_traceCall', [
          scenario.callParams,
          'latest',
          TRACER_OPTIONS.prestateTracer
        ]);

        const addresses = Object.keys(result).map(a => a.toLowerCase());

        expect(addresses).to.include(scenario.callParams.to.toLowerCase());

        if (scenario.callParams.from) {
          expect(addresses).to.include(scenario.callParams.from.toLowerCase());
        }
      }
    });

  });

  describe('Trace call scenarios with prestateTracer diffMode', function () {

    it('traces all scenarios with diffMode', async () => {
      console.log(`\nTracing ${callScenarios.length} call scenarios with prestateTracer diffMode...`);

      for (const scenario of callScenarios) {
        const result = await provider.send('debug_traceCall', [
          scenario.callParams,
          'latest',
          TRACER_OPTIONS.prestateTracerDiffMode
        ]);

        expect(result).to.have.property('pre');
        expect(result).to.have.property('post');

        const preCount = Object.keys(result.pre).length;
        const postCount = Object.keys(result.post).length;

        console.log(`  ${scenario.description}: pre=${preCount}, post=${postCount} addresses`);
      }
    });

    it('verifies balance changes in diffMode for value transfers', async () => {
      const transferScenario = callScenarios.find(s => s.name === 'simple_transfer');
      if (!transferScenario) return;

      const result = await provider.send('debug_traceCall', [
        transferScenario.callParams,
        'latest',
        TRACER_OPTIONS.prestateTracerDiffMode
      ]);

      const fromAddr = transferScenario.callParams.from!.toLowerCase();
      const toAddr = transferScenario.callParams.to.toLowerCase();

      expect(result.post[fromAddr] || result.pre[fromAddr]).to.not.be.undefined;
      expect(result.post[toAddr]).to.not.be.undefined;

      console.log('Value transfer diffMode verified');
    });

  });

  describe('Block number parameter tests', function () {

    it('traces with "latest" block', async () => {
      const result = await provider.send('debug_traceCall', [
        { from: funder.address, to: users[0].address },
        'latest',
        TRACER_OPTIONS.callTracer
      ]);

      expect(result).to.have.property('type');
      console.log(`latest block: gasUsed=${result.gasUsed}`);
    });

    it('traces with "pending" block - not supported on Sei', async () => {
      try {
        await provider.send('debug_traceCall', [
          { from: funder.address, to: users[0].address },
          'pending',
          TRACER_OPTIONS.callTracer
        ]);
        expect.fail('Expected error: tracing on top of pending is not supported on Sei');
      } catch (e: any) {
        expect(e.message).to.include('pending');
        console.log(`Confirmed: Sei rejects pending block tracing`);
      }
    });

    it('traces with specific block number', async () => {
      const latestBlock = await provider.getBlockNumber();

      const result = await provider.send('debug_traceCall', [
        { from: funder.address, to: users[0].address },
        ethers.toQuantity(latestBlock),
        TRACER_OPTIONS.callTracer
      ]);

      expect(result).to.have.property('type');
      console.log(`block ${latestBlock}: gasUsed=${result.gasUsed}`);
    });

    it('traces with earlier block number', async () => {
      const latestBlock = await provider.getBlockNumber();
      const earlierBlock = Math.max(1, latestBlock - 10);

      const result = await provider.send('debug_traceCall', [
        { from: funder.address, to: users[0].address },
        ethers.toQuantity(earlierBlock),
        TRACER_OPTIONS.callTracer
      ]);

      expect(result).to.have.property('type');
      console.log(`block ${earlierBlock}: gasUsed=${result.gasUsed}`);
    });

  });

  describe('State override tests - not supported on Sei', function () {

    it('rejects state override for account balance (4th param not supported)', async () => {
      const poorUser = users[15];
      const overrideBalance = ethers.parseEther('1000000');

      try {
        await provider.send('debug_traceCall', [
          {
            from: poorUser.address,
            to: users[0].address,
            value: ethers.toQuantity(ethers.parseEther('100'))
          },
          'latest',
          TRACER_OPTIONS.callTracer,
          {
            [poorUser.address]: {
              balance: ethers.toQuantity(overrideBalance)
            }
          }
        ]);
        expect.fail('Expected error: Sei does not support state overrides');
      } catch (e: any) {
        expect(e.message).to.include('too many arguments');
        console.log(`Confirmed: Sei rejects state override (balance)`);
      }
    });

    it('rejects state override for contract code (4th param not supported)', async () => {
      try {
        await provider.send('debug_traceCall', [
          {
            from: funder.address,
            to: erc20Address,
            data: '0x'
          },
          'latest',
          TRACER_OPTIONS.callTracer,
          {
            [erc20Address]: {
              code: '0x6080604052600080fd'
            }
          }
        ]);
        expect.fail('Expected error: Sei does not support state overrides');
      } catch (e: any) {
        expect(e.message).to.include('too many arguments');
        console.log(`Confirmed: Sei rejects state override (code)`);
      }
    });

    it('rejects state override for account nonce (4th param not supported)', async () => {
      try {
        await provider.send('debug_traceCall', [
          {
            from: funder.address,
            to: users[0].address,
          },
          'latest',
          TRACER_OPTIONS.prestateTracer,
          {
            [funder.address]: {
              nonce: ethers.toQuantity(999)
            }
          }
        ]);
        expect.fail('Expected error: Sei does not support state overrides');
      } catch (e: any) {
        expect(e.message).to.include('too many arguments');
        console.log(`Confirmed: Sei rejects state override (nonce)`);
      }
    });

  });

  describe('Gas estimation comparison', function () {

    it('compares debug_traceCall gas with eth_estimateGas for simple transfer', async () => {
      const callParams = {
        from: funder.address,
        to: users[0].address,
        value: ethers.toQuantity(ethers.parseEther('0.01'))
      };

      const traceResult = await provider.send('debug_traceCall', [
        callParams,
        'latest',
        TRACER_OPTIONS.callTracer
      ]);

      const traceGasUsed = BigInt(traceResult.gasUsed);

      console.log(`Simple transfer - debug_traceCall gasUsed: ${traceGasUsed}`);
      expect(Number(traceGasUsed)).to.equal(21000);
    });

    it('compares debug_traceCall gas with eth_estimateGas for contract call', async () => {
      const senderBalance = await erc20.balanceOf(users[0].address);
      const sender = senderBalance > 0n ? users[0] : funder;

      const callParams = {
        from: sender.address,
        to: erc20Address,
        data: erc20.interface.encodeFunctionData('balanceOf', [users[1].address])
      };

      const traceResult = await provider.send('debug_traceCall', [
        callParams,
        'latest',
        TRACER_OPTIONS.callTracer
      ]);

      const estimateGas = await provider.estimateGas(callParams);

      const traceGasUsed = BigInt(traceResult.gasUsed);

      console.log(`Contract call - debug_traceCall gasUsed: ${traceGasUsed}`);
      console.log(`Contract call - eth_estimateGas: ${estimateGas}`);

      expect(Number(traceGasUsed)).to.be.lte(Number(estimateGas));
    });

  });

  describe('Struct logger tests', function () {

    it('traces with default struct logger', async () => {
      const result = await provider.send('debug_traceCall', [
        {
          from: users[0].address,
          to: erc20Address,
          data: erc20.interface.encodeFunctionData('balanceOf', [users[0].address])
        },
        'latest',
        {}
      ]);

      expect(result).to.have.property('gas');
      expect(result).to.have.property('failed');
      expect(result).to.have.property('structLogs');
      expect(result.structLogs).to.be.an('array');

      console.log(`Struct logger: gas=${result.gas}, ops=${result.structLogs.length}`);
    });

    it('collects opcodes from contract call', async () => {
      const result = await provider.send('debug_traceCall', [
        {
          from: users[0].address,
          to: erc20Address,
          data: erc20.interface.encodeFunctionData('balanceOf', [users[0].address])
        },
        'latest',
        {}
      ]);

      const uniqueOpcodes = new Set<string>();
      for (const log of result.structLogs) {
        uniqueOpcodes.add(log.op);
      }

      console.log(`Unique opcodes (${uniqueOpcodes.size}): ${Array.from(uniqueOpcodes).sort().join(', ')}`);
    });

  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error Handling
  // ─────────────────────────────────────────────────────────────────────────────

  describe('Error handling', function () {

    it('handles call to non-existent contract gracefully', async () => {
      const nonExistentAddress = '0x1234567890123456789012345678901234567890';

      const result = await provider.send('debug_traceCall', [
        {
          from: funder.address,
          to: nonExistentAddress,
          data: '0x12345678'
        },
        'latest',
        TRACER_OPTIONS.callTracer
      ]);

      expect(result).to.have.property('type');
      console.log(`Non-existent contract: type=${result.type}, gasUsed=${result.gasUsed}`);
    });

    it('handles invalid block number', async () => {
      const futureBlock = (await provider.getBlockNumber()) + 1000000;

      try {
        await provider.send('debug_traceCall', [
          { from: funder.address, to: users[0].address },
          ethers.toQuantity(futureBlock),
          TRACER_OPTIONS.callTracer
        ]);
        expect.fail('Expected error for future block number');
      } catch (e: any) {
        expect(e.message).to.include('height');
        console.log(`Future block error: ${e.message.slice(0, 80)}`);
      }
    });

  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────────────────────────────────

  after('Print summary', function () {
    console.log('\n' + '='.repeat(80));
    console.log('CALL SCENARIOS SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total scenarios: ${callScenarios.length}`);
    for (const scenario of callScenarios) {
      console.log(`  [${scenario.expectedSuccess ? 'SUCCESS' : 'FAIL'}] ${scenario.description}`);
    }
    console.log('='.repeat(80));
  });

});
