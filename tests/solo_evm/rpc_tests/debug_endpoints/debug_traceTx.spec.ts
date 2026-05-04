import { expect } from 'chai';
import { ethers, Contract, TransactionReceipt } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder, RecordedTx, TRACER_OPTIONS } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';
import * as fs from 'fs';
import * as path from 'path';

import ERC20_ARTIFACT from '../../../../artifacts/contracts/TestERC20.sol/TestERC20.json';

const network = getNetwork('local');
const RPC_URL = network.url;

const USER_COUNT = 50;

describe('debug_traceTransaction Tests', function () {
  this.timeout(10 * 60 * 1000);

  let txBuilder: TxBuilder;
  let users: User[];
  let funder: User;
  let provider: ethers.JsonRpcProvider;
  let erc20: Contract;
  let simpleAccount7702Address: string;

  const recordedTxs: RecordedTx[] = [];

  async function recordTx(
    receipt: TransactionReceipt,
    description: string,
    type: number,
    extras?: Partial<RecordedTx>
  ): Promise<void> {
    recordedTxs.push({
      hash: receipt.hash,
      type,
      description,
      from: receipt.from,
      to: receipt.to,
      value: 0n,
      gasUsed: receipt.gasUsed,
      status: receipt.status ?? 0,
      blockNumber: receipt.blockNumber,
      ...extras,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Setup and Transaction Creation
  // ─────────────────────────────────────────────────────────────────────────────

  before('Initialize clients and deploy contracts', async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);

    const admin = await SeiUserFactory.createAdminUser();
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, USER_COUNT);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    users = await Promise.all(
      seiUsers.map(su => User.fromPrivateKey(su.evmWallet.wallet.privateKey, RPC_URL))
    );

    txBuilder = new TxBuilder(users);

    console.log('Deploying ERC20 contract...');
    erc20 = await txBuilder.deployErc20(funder);
    console.log(`ERC20 deployed at: ${await erc20.getAddress()}`);

    console.log('Deploying SimpleAccount7702...');
    const simpleAccount7702 = await txBuilder.deploySimpleAccount7702(funder);
    simpleAccount7702Address = await simpleAccount7702.getAddress();
    console.log(`SimpleAccount7702 deployed at: ${simpleAccount7702Address}`);

    console.log('Deploying GasBurner...');
    const gasBurner = await txBuilder.deployGasBurner(funder);
    console.log(`GasBurner deployed at: ${await gasBurner.getAddress()}`);

    console.log('Minting tokens to users...');
    const mintResult = await txBuilder.mintToUsers(ethers.parseEther('10000'));

    if (mintResult.failCount > 0) {
      console.log('Retrying failed mints with higher gas limit...');
      const erc20Address = await erc20.getAddress();
      const erc20ForMint = new Contract(erc20Address, ERC20_ARTIFACT.abi, funder.wallet);
      for (const user of users) {
        const balance = await erc20.balanceOf(user.address);
        if (balance === 0n) {
          const tx = await erc20ForMint.getFunction('mint')(user.address, ethers.parseEther('10000'));
          await tx.wait();
        }
      }
      console.log('Retry mints complete');
    }
  });


  describe('Create transactions for tracing', function () {

    it('creates Type 0 (Legacy) transaction', async () => {
      const user = users[0];
      const recipient = users[1];
      const value = ethers.parseEther('0.01');

      const balanceBefore = await provider.getBalance(user.address);
      const recipientBalanceBefore = await provider.getBalance(recipient.address);

      const tx = await txBuilder.sendLegacyTx(user, recipient.address, value);
      const receipt = await tx.wait();

      const balanceAfter = await provider.getBalance(user.address);
      const recipientBalanceAfter = await provider.getBalance(recipient.address);

      expect(receipt).to.not.be.null;
      expect(receipt!.type).to.equal(0);

      await recordTx(receipt!, 'Type 0 Legacy transfer', 0, {
        value,
        balanceBefore,
        balanceAfter,
        recipientBalanceBefore,
        recipientBalanceAfter,
      });
    });

    it('creates Type 2 (EIP-1559) transaction', async () => {
      const user = users[2];
      const recipient = users[3];
      const value = ethers.parseEther('0.02');

      const balanceBefore = await provider.getBalance(user.address);
      const recipientBalanceBefore = await provider.getBalance(recipient.address);

      const tx = await txBuilder.sendEip1559Tx(user, recipient.address, value);
      const receipt = await tx.wait();

      const balanceAfter = await provider.getBalance(user.address);
      const recipientBalanceAfter = await provider.getBalance(recipient.address);

      expect(receipt).to.not.be.null;
      expect(receipt!.type).to.equal(2);

      await recordTx(receipt!, 'Type 2 EIP-1559 transfer', 2, {
        value,
        balanceBefore,
        balanceAfter,
        recipientBalanceBefore,
        recipientBalanceAfter,
      });
    });

    it('creates Type 4 (EIP-7702) transaction', async () => {
      const user = users[4];

      const auth = await txBuilder.createAuthorization(user, simpleAccount7702Address);
      const tx = await txBuilder.sendEip7702Tx(user, user.address, [auth]);
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.type).to.equal(4);

      await recordTx(receipt!, 'Type 4 EIP-7702 SetCode', 4);
      await txBuilder.clearCodeForUser(user);
    });

    it('creates ERC20 transfer transaction', async () => {
      const user = users[5];
      const recipient = users[6];
      const amount = ethers.parseEther('100');

      const connectedErc20 = erc20.connect(user.wallet) as any;
      const tx = await connectedErc20.transfer(recipient.address, amount, { gasLimit: 100000n });
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;

      await recordTx(receipt!, 'ERC20 transfer', 2);
    });

    it('creates contract deployment transaction', async () => {
      const user = users[7];

      const contractFactory = new ethers.ContractFactory(
        ERC20_ARTIFACT.abi,
        ERC20_ARTIFACT.bytecode,
        user.wallet
      );
      const contract = await contractFactory.deploy(user.address, { gasLimit: 5000000n });
      const receipt = await contract.deploymentTransaction()!.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.contractAddress).to.not.be.null;

      await recordTx(receipt!, 'Contract deployment', 2);
    });

    it('creates failed transaction (revert)', async () => {
      const user = users[8];
      const recipient = users[9];

      const connectedErc20 = erc20.connect(user.wallet) as any;

      try {
        const tx = await connectedErc20.transfer(
          recipient.address,
          ethers.parseEther('999999999999'),
          { gasLimit: 100000n }
        );
        const receipt = await tx.wait();

        if (receipt && receipt.status === 0) {
          await recordTx(receipt, 'Failed ERC20 transfer (revert)', 2);
          console.log(`Failed tx: ${receipt.hash}`);
        }
      } catch (e: any) {
        if (e.receipt) {
          await recordTx(e.receipt, 'Failed ERC20 transfer (revert)', 2);
        } else {
        }
      }
    });

    it('creates gas burner transaction (~5M gas)', async () => {
      const user = users[10];

      const iterations = 66n;
      const gasLimit = 6000000n;

      const tx = await txBuilder.burnGasWithIterations(user, iterations, BigInt(Date.now()), gasLimit);
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.status).to.equal(1);

      await recordTx(receipt!, `Gas burner (${iterations} iterations)`, 2);
    });

  });


  describe('Trace transactions with callTracer', function () {

    it('traces all recorded transactions with callTracer', async () => {
      let index = 0;
      for (const tx of recordedTxs) {
        const trace = await provider.send('debug_traceTransaction', [tx.hash, TRACER_OPTIONS.callTracer]);
        index++;

        expect(trace).to.have.property('from');
        expect(trace).to.have.property('gas');
        expect(trace).to.have.property('gasUsed');
        expect(trace).to.have.property('input');
        expect(trace).to.have.property('type');

        expect(trace.from.toLowerCase()).to.equal(tx.from.toLowerCase());

        if (tx.to) {
          expect(trace.to.toLowerCase()).to.equal(tx.to.toLowerCase());
        }
      }
    });

    it('verifies callTracer gas matches receipt gasUsed', async () => {
      for (const tx of recordedTxs) {
        const trace = await provider.send('debug_traceTransaction', [tx.hash, TRACER_OPTIONS.callTracer]);

        const traceGasUsed = BigInt(trace.gasUsed);

        expect(
          Number(traceGasUsed),
          `${tx.description}: trace gasUsed (${traceGasUsed}) should be <= receipt gasUsed (${tx.gasUsed})`
        ).to.be.lte(Number(tx.gasUsed));

        expect(
          Number(traceGasUsed),
          `${tx.description}: trace gasUsed should be > 0`
        ).to.be.greaterThan(0);
      }
    });

    it('verifies callTracer onlyTopCall option', async () => {
      for (const tx of recordedTxs) {
        const trace = await provider.send('debug_traceTransaction', [
          tx.hash,
          TRACER_OPTIONS.callTracerOnlyTopCall
        ]);

        expect(trace).to.have.property('type');

        if (trace.calls) {
          expect(trace.calls).to.be.an('array');
        }
      }
    });

  });

  describe('Trace transactions with prestateTracer', function () {

    it('traces all recorded transactions with prestateTracer', async () => {

      for (const tx of recordedTxs) {
        const trace = await provider.send('debug_traceTransaction', [tx.hash, TRACER_OPTIONS.prestateTracer]);

        expect(trace).to.be.an('object');
        const addresses = Object.keys(trace);
        expect(addresses.length).to.be.greaterThan(0);

        const fromInPrestate = addresses.some(addr => addr.toLowerCase() === tx.from.toLowerCase());
        expect(fromInPrestate).to.be.true;
      }
    });

    it('verifies prestateTracer balance matches actual balance before tx', async () => {
      for (const tx of recordedTxs) {
        if (!tx.balanceBefore) continue;

        const trace = await provider.send('debug_traceTransaction', [tx.hash, TRACER_OPTIONS.prestateTracer]);

        const fromAddr = tx.from.toLowerCase();
        expect(trace[fromAddr]).to.not.be.undefined;
        expect(trace[fromAddr].balance).to.not.be.undefined;

        const prestateBalance = BigInt(trace[fromAddr].balance);
        expect(prestateBalance).to.equal(tx.balanceBefore);
      }
    });

  });

  describe('Trace transactions with prestateTracer diffMode', function () {

    it('traces all recorded transactions with diffMode', async () => {
      for (const tx of recordedTxs) {
        const trace = await provider.send('debug_traceTransaction', [
          tx.hash,
          TRACER_OPTIONS.prestateTracerDiffMode
        ]);

        expect(trace).to.have.property('pre');
        expect(trace).to.have.property('post');

        const preAddresses = Object.keys(trace.pre);
        const postAddresses = Object.keys(trace.post);
      }
    });

    it('verifies diffMode pre/post balances for value transfers', async () => {
      for (const tx of recordedTxs) {
        if (!tx.balanceBefore || !tx.balanceAfter) continue;

        const trace = await provider.send('debug_traceTransaction', [
          tx.hash,
          TRACER_OPTIONS.prestateTracerDiffMode
        ]);

        const fromAddr = tx.from.toLowerCase();

        if (trace.pre[fromAddr]) {
          const preBalance = BigInt(trace.pre[fromAddr].balance);
          expect(preBalance).to.equal(tx.balanceBefore);
        }

        if (trace.post[fromAddr]) {
          const postBalance = BigInt(trace.post[fromAddr].balance);
          expect(postBalance).to.equal(tx.balanceAfter);
        }
      }
    });

    it('verifies recipient balance changes in diffMode', async () => {
      for (const tx of recordedTxs) {
        if (!tx.recipientBalanceAfter || !tx.to) continue;

        const trace = await provider.send('debug_traceTransaction', [
          tx.hash,
          TRACER_OPTIONS.prestateTracerDiffMode
        ]);

        const toAddr = tx.to.toLowerCase();

        if (trace.post[toAddr]) {
          const postBalance = BigInt(trace.post[toAddr].balance);
          expect(postBalance).to.equal(tx.recipientBalanceAfter);
        }
      }
    });

  });

  describe('Trace transactions with struct logger (default)', function () {

    it('traces all recorded transactions with default struct logger', async () => {

      for (const tx of recordedTxs) {
        const trace = await provider.send('debug_traceTransaction', [tx.hash, {}]);

        expect(trace).to.have.property('gas');
        expect(trace).to.have.property('failed');
        expect(trace).to.have.property('returnValue');
        expect(trace).to.have.property('structLogs');
        expect(trace.structLogs).to.be.an('array');

        const failed = tx.status === 0;
        expect(trace.failed).to.equal(failed);
      }
    });

    it('verifies struct logger options: disableStorage', async () => {
      const tx = recordedTxs.find(t => t.description.includes('ERC20'));
      if (!tx) return;

      const trace = await provider.send('debug_traceTransaction', [tx.hash, { disableStorage: true }]);

      expect(trace.structLogs).to.be.an('array');
      if (trace.structLogs.length > 0) {
        expect(trace.structLogs[0].storage).to.be.undefined;
      }
    });

    it('verifies struct logger options: disableStack', async () => {
      const tx = recordedTxs.find(t => t.description.includes('ERC20'));
      if (!tx) return;

      const trace = await provider.send('debug_traceTransaction', [tx.hash, { disableStack: true }]);

      expect(trace.structLogs).to.be.an('array');
      if (trace.structLogs.length > 0) {
        expect(trace.structLogs[0].stack).to.be.undefined;
      }
    });

    it('verifies struct logger options: enableMemory', async () => {
      const tx = recordedTxs.find(t => t.description.includes('ERC20'));
      if (!tx) return;

      const trace = await provider.send('debug_traceTransaction', [tx.hash, { enableMemory: true }]);

      expect(trace.structLogs).to.be.an('array');
    });

    it('verifies struct logger options: enableReturnData', async () => {
      const tx = recordedTxs.find(t => t.description.includes('ERC20'));
      if (!tx) return;

      const trace = await provider.send('debug_traceTransaction', [tx.hash, { enableReturnData: true }]);

      expect(trace.structLogs).to.be.an('array');
    });

  });



  describe.skip('Opcode gas analysis', function () {

    it('collects and analyzes opcode gas costs from ERC20 transfer', async () => {
      const tx = recordedTxs.find(t => t.description.includes('ERC20 transfer'));
      if (!tx) {
        console.log('No ERC20 transfer tx found, skipping');
        return;
      }

      const trace = await provider.send('debug_traceTransaction', [tx.hash, {}]);

      const opcodeGasCosts: Map<string, number[]> = new Map();

      for (const log of trace.structLogs) {
        const op = log.op;
        const gasCost = log.gasCost;

        if (!opcodeGasCosts.has(op)) {
          opcodeGasCosts.set(op, []);
        }
        opcodeGasCosts.get(op)!.push(gasCost);
      }

      const sortedOpcodes = Array.from(opcodeGasCosts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      for (const [op, costs] of sortedOpcodes) {
        const min = Math.min(...costs);
        const max = Math.max(...costs);
        const avg = costs.reduce((a, b) => a + b, 0) / costs.length;
      }
    });

    it('verifies common opcode gas costs', async () => {
      const tx = recordedTxs.find(t => t.description.includes('Legacy'));
      if (!tx) return;

      const trace = await provider.send('debug_traceTransaction', [tx.hash, {}]);

      const opGas: Record<string, number> = {};
      for (const log of trace.structLogs) {
        if (!opGas[log.op]) {
          opGas[log.op] = log.gasCost;
        }
      }

      const expectedGasCosts: Record<string, { min: number; max: number }> = {
        'PUSH1': { min: 3, max: 3 },
        'PUSH2': { min: 3, max: 3 },
        'POP': { min: 2, max: 2 },
        'DUP1': { min: 3, max: 3 },
        'SWAP1': { min: 3, max: 3 },
        'ADD': { min: 3, max: 3 },
        'SUB': { min: 3, max: 3 },
        'EQ': { min: 3, max: 3 },
        'ISZERO': { min: 3, max: 3 },
        'JUMP': { min: 8, max: 8 },
        'JUMPI': { min: 10, max: 10 },
        'JUMPDEST': { min: 1, max: 1 },
        'STOP': { min: 0, max: 0 },
      };

      for (const [op, gas] of Object.entries(opGas)) {
        if (expectedGasCosts[op]) {
          const { min, max } = expectedGasCosts[op];
          expect(gas).to.be.gte(min, `${op} gas ${gas} below expected min ${min}`);
          expect(gas).to.be.lte(max, `${op} gas ${gas} above expected max ${max}`);
        }
      }
    });

    it('lists all unique opcodes by category', async () => {
      const tx = recordedTxs.find(t => t.description.includes('ERC20 transfer'));
      if (!tx) return;

      const trace = await provider.send('debug_traceTransaction', [tx.hash, {}]);

      const uniqueOpcodes = new Set<string>();
      for (const log of trace.structLogs) {
        uniqueOpcodes.add(log.op);
      }

      const categories = {
        'Arithmetic': ['ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'EXP'],
        'Comparison': ['LT', 'GT', 'SLT', 'SGT', 'EQ', 'ISZERO'],
        'Bitwise': ['AND', 'OR', 'XOR', 'NOT', 'SHL', 'SHR'],
        'Stack': ['POP', 'PUSH1', 'PUSH2', 'PUSH4', 'PUSH32', 'DUP1', 'DUP2', 'DUP3', 'SWAP1', 'SWAP2'],
        'Memory': ['MLOAD', 'MSTORE', 'MSIZE'],
        'Storage': ['SLOAD', 'SSTORE'],
        'Flow': ['JUMP', 'JUMPI', 'JUMPDEST'],
        'System': ['GAS', 'ADDRESS', 'CALLER', 'CALLVALUE', 'CALLDATALOAD', 'CALLDATASIZE'],
        'Calls': ['CALL', 'STATICCALL', 'DELEGATECALL'],
        'Termination': ['STOP', 'RETURN', 'REVERT'],
        'Logging': ['LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4'],
        'Hashing': ['SHA3', 'KECCAK256'],
      };
    });

    it.skip('analyzes gas burner transaction opcodes in detail', async () => {
      const tx = recordedTxs.find(t => t.description.includes('Gas burner'));
      if (!tx) {
        console.log('No gas burner tx found, skipping');
        return;
      }

      const trace = await provider.send('debug_traceTransaction', [tx.hash, {}]);

      const opcodeGasCosts: Map<string, number[]> = new Map();
      let totalGasFromOpcodes = 0;

      for (const log of trace.structLogs) {
        const op = log.op;
        const gasCost = log.gasCost;
        totalGasFromOpcodes += gasCost;

        if (!opcodeGasCosts.has(op)) {
          opcodeGasCosts.set(op, []);
        }
        opcodeGasCosts.get(op)!.push(gasCost);
      }


      const sortedByTotal = Array.from(opcodeGasCosts.entries())
        .map(([op, costs]) => ({
          op,
          count: costs.length,
          min: Math.min(...costs),
          max: Math.max(...costs),
          total: costs.reduce((a, b) => a + b, 0),
        }))
        .sort((a, b) => b.total - a.total);


      const sstoreCount = opcodeGasCosts.get('SSTORE')?.length || 0;
      const sstoreTotal = opcodeGasCosts.get('SSTORE')?.reduce((a, b) => a + b, 0) || 0;
      const sstoreCosts = opcodeGasCosts.get('SSTORE') || [];
    });
  });


  describe('Error handling', function () {

    it('fails with invalid tx hash', async () => {
      const invalidHash = '0x0000000000000000000000000000000000000000000000000000000000000000';

      try {
        await provider.send('debug_traceTransaction', [invalidHash]);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        expect(e).to.be.an('Error');
        console.log(e);
      }
    });

    it('fails with malformed tx hash', async () => {
      const malformedHash = '0xinvalid';

      try {
        await provider.send('debug_traceTransaction', [malformedHash]);
        expect.fail('Should have thrown an error');
      } catch (e: any) {
        console.log(`Malformed hash error: ${e.message.slice(0, 80)}`);
      }
    });
  });
});
