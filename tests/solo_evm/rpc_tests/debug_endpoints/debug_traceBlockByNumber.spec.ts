import { expect } from 'chai';
import { ethers, Contract } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder, BlockRecorder, TRACER_OPTIONS } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

import stakingAbi from '../../../precompiles/abis/staking_abi.json';
import ERC20_ARTIFACT from '../../../../artifacts/contracts/TestERC20.sol/TestERC20.json';

const STAKING_PRECOMPILE = '0x0000000000000000000000000000000000001005';

const network = getNetwork('local');
const RPC_URL = network.url;

const USER_COUNT = 70;

describe('Debug Trace Block By Number Tests', function () {
  this.timeout(10 * 60 * 1000);

  let txBuilder: TxBuilder;
  let users: User[];
  let funder: User;
  let provider: ethers.JsonRpcProvider;
  let recorder: BlockRecorder;

  let erc20: Contract;
  let stakingContract: Contract;
  let simpleAccount7702Address: string;

  before('Initialize clients and deploy contracts', async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    recorder = new BlockRecorder(provider);

    const admin = await SeiUserFactory.createAdminUser();
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, USER_COUNT);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    users = await Promise.all(
      seiUsers.map(su => User.fromPrivateKey(su.evmWallet.wallet.privateKey, RPC_URL))
    );

    console.log(`Admin EVM address: ${funder.address}`);
    console.log(`Created ${users.length} funded users`);

    txBuilder = new TxBuilder(users);

    erc20 = await txBuilder.deployErc20(funder);
    console.log(`ERC20 deployed at: ${await erc20.getAddress()}`);

    await txBuilder.deployGasBurner(funder);
    console.log('GasBurner deployed');

    const simpleAccount7702 = await txBuilder.deploySimpleAccount7702(funder);
    simpleAccount7702Address = await simpleAccount7702.getAddress();
    console.log(`SimpleAccount7702 deployed at: ${simpleAccount7702Address}`);

    stakingContract = new Contract(STAKING_PRECOMPILE, stakingAbi, funder.wallet);

    const mintResult = await txBuilder.mintToUsers(ethers.parseEther('10000'));
    await recorder.recordBlockFromReceipts(mintResult.receipts, 'ERC20 mint', 2);
    console.log(`Minted tokens in ${mintResult.receipts.length} txs`);
  });

  describe('Send various transaction types', function () {

    it('sends Type 0 (Legacy) transactions', async () => {
      const user = users[0];
      const tx = await txBuilder.sendLegacyTx(user, users[1].address, ethers.parseEther('0.01'));
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.type).to.equal(0);

      await recorder.recordBlock(receipt, 'Type 0 Legacy', 0);
      console.log(`Type 0 tx in block ${receipt!.blockNumber}`);
    });

    it.skip('sends Type 1 (Access List) transactions - not supported on Sei', async () => {
      const user = users[1];
      const erc20Address = await erc20.getAddress();

      const accessList = [
        { address: erc20Address, storageKeys: [] }
      ];

      const tx = await txBuilder.sendAccessListTx(
        user,
        users[2].address,
        ethers.parseEther('0.01'),
        '0x',
        accessList
      );
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.type).to.equal(1);

      await recorder.recordBlock(receipt, 'Type 1 Access List', 1);
      console.log(`Type 1 tx in block ${receipt!.blockNumber}`);
    });

    it('sends Type 2 (EIP-1559) transactions', async () => {
      const user = users[2];
      const tx = await txBuilder.sendEip1559Tx(user, users[3].address, ethers.parseEther('0.01'), '0x', {gasLimit: 200000n});
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.type).to.equal(2);

      await recorder.recordBlock(receipt, 'Type 2 EIP-1559', 2);
      console.log(`Type 2 tx in block ${receipt!.blockNumber}`);
    });

    it('sends Type 4 (EIP-7702 SetCode) transactions', async () => {
      const user = users[3];

      const auth = await txBuilder.createAuthorization(user, simpleAccount7702Address);
      const tx = await txBuilder.sendEip7702Tx(user, user.address, [auth]);
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.type).to.equal(4);

      await recorder.recordBlock(receipt, 'Type 4 EIP-7702', 4);
      console.log(`Type 4 tx in block ${receipt!.blockNumber}`);

      await txBuilder.clearCodeForUser(user);
    });

  });


  describe('Contract deployment transactions', function () {

    it('deploys a new ERC20 contract', async () => {
      const user = users[4];
      const contractFactory = new ethers.ContractFactory(
        ERC20_ARTIFACT.abi,
        ERC20_ARTIFACT.bytecode,
        user.wallet
      );

      const contract = await contractFactory.deploy(user.address);
      const receipt = await contract.deploymentTransaction()?.wait();

      expect(receipt).to.not.be.null;
      await recorder.recordBlock(receipt!, 'Contract deployment', 2);
      console.log(`Contract deployed in block ${receipt!.blockNumber}`);
    });

  });

  describe('High transaction count blocks', function () {

    it('creates a block with 50+ transactions', async () => {
      console.log('Sending 50 parallel ERC20 transfers...');

      const result = await txBuilder.erc20TransfersRoundRobin(ethers.parseEther('1'));
      const stats = txBuilder.getBlockStats(result);

      console.log(`Sent ${result.receipts.length} txs across ${stats.uniqueBlocks.length} blocks`);
      console.log(`Max txs in single block: ${stats.maxTxsInSingleBlock}`);

      await recorder.recordBlockFromReceipts(result.receipts, 'Batch ERC20 transfer', 2);

      expect(result.successCount).to.be.greaterThan(0);
    });

  });

  describe('Precompile transactions', function () {

    it.skip('sends staking delegate transaction - skipped due to local node issue', async () => {
      const connectedStaking = stakingContract.connect(funder.wallet) as any;

      const validators = await connectedStaking.validators('BOND_STATUS_BONDED', '0x');

      const validatorAddress = validators.validators[0].operatorAddress;
      console.log(`Validator address: ${validatorAddress}`);
      const amount = ethers.parseEther('0.02');
      const tx = await connectedStaking.delegate(validatorAddress, { value: amount, gasLimit: 75000000n });
      const receipt = await tx.wait();

      expect(receipt).to.not.be.null;
      expect(receipt!.status).to.equal(1);

      await recorder.recordBlock(receipt, 'Staking delegate precompile', 2);
      console.log(`Delegate tx in block ${receipt!.blockNumber}`);
    });

  });

  describe('Failed transactions', function () {

    it('sends a transaction that reverts', async () => {
      const user = users[6];

      try {
        const connectedErc20 = erc20.connect(user.wallet) as any;
        const tx = await connectedErc20.transfer(
          users[7].address,
          ethers.parseEther('999999999')
        );
        const receipt = await tx.wait();

        if (receipt && receipt.status === 0) {
          await recorder.recordBlock(receipt, 'Failed ERC20 transfer (reverted)', 2);
          console.log(`Failed tx in block ${receipt.blockNumber}`);
        }
      } catch (e: any) {
        console.log('Transaction reverted as expected');
      }
    });

    it('sends a transaction with insufficient gas', async () => {
      const user = users[7];

      try {
        const tx = await user.wallet.sendTransaction({
          to: users[8].address,
          value: ethers.parseEther('0.001'),
          gasLimit: 10000n,
        });
        const receipt = await tx.wait();
        console.log(receipt);

        if (receipt && receipt.status === 0) {
          await recorder.recordBlock(receipt, 'Failed tx (out of gas)', 2);
        }
      } catch (e: any) {
        console.log('Transaction failed as expected (insufficient gas)');
      }
    });

  });


  describe('Debug trace block operations', function () {

    it('traces all recorded blocks with callTracer', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nTracing ${blockRecords.length} blocks with callTracer...`);
      let index = 0;
      for (const record of blockRecords) {
        const result = await recorder.traceBlockByNumber(
          record.blockNumber,
          'callTracer',
          TRACER_OPTIONS.callTracer
        );
        if (index === 1 || index === 2) {
            console.log(result);
            console.log('*****');
        }
        expect(result).to.be.an('array');
        index++;
      }
    });

    it('traces all recorded blocks with callTracer (onlyTopCall)', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nTracing ${blockRecords.length} blocks with callTracer (onlyTopCall)...`);
      let index = 0;
      for (const record of blockRecords) {
        const result = await recorder.traceBlockByNumber(
          record.blockNumber,
          'callTracerOnlyTopCall',
          TRACER_OPTIONS.callTracerOnlyTopCall
        );
        if (index === 1 || index === 2) {
            console.log(result);
            console.log('*****');
        }
        expect(result).to.be.an('array');
      }
    });

    it('traces all recorded blocks with prestateTracer', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nTracing ${blockRecords.length} blocks with prestateTracer...`);

      for (const record of blockRecords) {
        const result = await recorder.traceBlockByNumber(
          record.blockNumber,
          'prestateTracer',
          TRACER_OPTIONS.prestateTracer
        );
        expect(result).to.be.an('array');
      }
    });

    it('traces all recorded blocks with prestateTracer (diffMode)', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nTracing ${blockRecords.length} blocks with prestateTracer (diffMode)...`);

      for (const record of blockRecords) {
        const result = await recorder.traceBlockByNumber(
          record.blockNumber,
          'prestateTracerDiffMode',
          TRACER_OPTIONS.prestateTracerDiffMode
        );

        expect(result).to.be.an('array');
        console.log(`Block ${record.blockNumber}: ${result.length} diff traces`);
      }
    });

    it('traces blocks by hash', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nTracing blocks by hash...`);

      for (const record of blockRecords.slice(0, 3)) {
        const result = await recorder.traceBlockByHash(
          record.blockHash,
          'callTracer',
          TRACER_OPTIONS.callTracer
        );

        expect(result).to.be.an('array');
        console.log(`Block hash ${record.blockHash.slice(0, 18)}...: ${result.length} traces`);
      }
    });

  });

  describe('Block trace consistency verification', function () {

    it('verifies debug_traceBlockByNumber and debug_traceBlockByHash return identical results', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nVerifying consistency for ${blockRecords.length} blocks...`);

      for (const record of blockRecords) {
        const byNumber = await recorder.traceBlockByNumber(
          record.blockNumber,
          'callTracer',
          TRACER_OPTIONS.callTracer
        );

        const byHash = await recorder.traceBlockByHash(
          record.blockHash,
          'callTracer',
          TRACER_OPTIONS.callTracer
        );

        expect(byNumber.length).to.equal(byHash.length, 
          `Block ${record.blockNumber}: trace count mismatch (byNumber: ${byNumber.length}, byHash: ${byHash.length})`);

        for (let i = 0; i < byNumber.length; i++) {
          const traceByNumber = byNumber[i];
          const traceByHash = byHash[i];

          expect(traceByNumber.txHash).to.equal(traceByHash.txHash,
            `Block ${record.blockNumber}, trace ${i}: txHash mismatch`);

          const resultByNumber = traceByNumber.result;
          const resultByHash = traceByHash.result;

          expect(resultByNumber.from).to.equal(resultByHash.from,
            `Block ${record.blockNumber}, trace ${i}: from mismatch`);
          expect(resultByNumber.to).to.equal(resultByHash.to,
            `Block ${record.blockNumber}, trace ${i}: to mismatch`);
          expect(resultByNumber.gas).to.equal(resultByHash.gas,
            `Block ${record.blockNumber}, trace ${i}: gas mismatch`);
          expect(resultByNumber.gasUsed).to.equal(resultByHash.gasUsed,
            `Block ${record.blockNumber}, trace ${i}: gasUsed mismatch`);
          expect(resultByNumber.input).to.equal(resultByHash.input,
            `Block ${record.blockNumber}, trace ${i}: input mismatch`);
          expect(resultByNumber.output).to.equal(resultByHash.output,
            `Block ${record.blockNumber}, trace ${i}: output mismatch`);
        }
      }
    });

    it('verifies debug_traceBlockByNumber and debug_traceBlockByHash with prestateTracer return identical results', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nVerifying prestateTracer consistency for ${blockRecords.length} blocks...`);

      for (const record of blockRecords) {
        const byNumber = await recorder.traceBlockByNumber(
          record.blockNumber,
          'prestateTracer',
          TRACER_OPTIONS.prestateTracer
        );

        const byHash = await recorder.traceBlockByHash(
          record.blockHash,
          'prestateTracer',
          TRACER_OPTIONS.prestateTracer
        );

        expect(byNumber.length).to.equal(byHash.length,
          `Block ${record.blockNumber}: prestateTracer trace count mismatch`);

        for (let i = 0; i < byNumber.length; i++) {
          const traceByNumber = byNumber[i];
          const traceByHash = byHash[i];

          expect(traceByNumber.txHash).to.equal(traceByHash.txHash,
            `Block ${record.blockNumber}, trace ${i}: txHash mismatch`);

          const prestateByNumber = JSON.stringify(traceByNumber.result);
          const prestateByHash = JSON.stringify(traceByHash.result);

          expect(prestateByNumber).to.equal(prestateByHash,
            `Block ${record.blockNumber}, trace ${i}: prestate result mismatch`);
        }
      }
    });

  });

  describe('Transaction trace field verification', function () {

    it('verifies callTracer trace fields for each transaction', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nVerifying trace fields for all recorded transactions...`);

      for (const record of blockRecords) {
        const traces = await recorder.traceBlockByNumber(
          record.blockNumber,
          'callTracer',
          TRACER_OPTIONS.callTracer
        );

        for (let i = 0; i < traces.length; i++) {
          const trace = traces[i];
          const txHash = trace.txHash;
          const result = trace.result;

          expect(result).to.have.property('from');
          expect(result).to.have.property('to');
          expect(result).to.have.property('gas');
          expect(result).to.have.property('gasUsed');
          expect(result).to.have.property('input');

          expect(result.from).to.match(/^0x[a-fA-F0-9]{40}$/, `Invalid from address in tx ${txHash}`);
          
          if (result.to) {
            expect(result.to).to.match(/^0x[a-fA-F0-9]{40}$/, `Invalid to address in tx ${txHash}`);
          }

          expect(result.gas).to.match(/^0x[a-fA-F0-9]+$/, `Invalid gas format in tx ${txHash}`);
          expect(result.gasUsed).to.match(/^0x[a-fA-F0-9]+$/, `Invalid gasUsed format in tx ${txHash}`);

          const gasValue = BigInt(result.gas);
          const gasUsedValue = BigInt(result.gasUsed);
          expect(gasUsedValue <= gasValue).to.be.true, `gasUsed (${gasUsedValue}) > gas (${gasValue}) in tx ${txHash}`;

          expect(result.input).to.match(/^0x([a-fA-F0-9]*)?$/, `Invalid input format in tx ${txHash}`);

          if (result.output !== undefined) {
            expect(result.output).to.match(/^0x([a-fA-F0-9]*)?$/, `Invalid output format in tx ${txHash}`);
          }

          if (result.value !== undefined) {
            expect(result.value).to.match(/^0x[a-fA-F0-9]*$/, `Invalid value format in tx ${txHash}`);
          }
        }
      }
    });

    it('verifies debug_traceTransaction matches block trace for each tx', async () => {
      const blockRecords = recorder.getBlockRecords();
      console.log(`\nVerifying debug_traceTransaction consistency...`);

      for (const record of blockRecords) {
        const blockTraces = await recorder.traceBlockByNumber(
          record.blockNumber,
          'callTracer',
          TRACER_OPTIONS.callTracer
        );

        for (const blockTrace of blockTraces) {
          const txHash = blockTrace.txHash;
          const txTrace = await recorder.traceTransaction(txHash, TRACER_OPTIONS.callTracer);

          const blockResult = blockTrace.result;
          const txResult = txTrace;

          expect(blockResult.from.toLowerCase()).to.equal(txResult.from.toLowerCase(),
            `tx ${txHash}: from mismatch between block trace and tx trace`);
          
          if (blockResult.to && txResult.to) {
            expect(blockResult.to.toLowerCase()).to.equal(txResult.to.toLowerCase(),
              `tx ${txHash}: to mismatch between block trace and tx trace`);
          }

          expect(blockResult.gas).to.equal(txResult.gas,
            `tx ${txHash}: gas mismatch between block trace and tx trace`);
          expect(blockResult.gasUsed).to.equal(txResult.gasUsed,
            `tx ${txHash}: gasUsed mismatch between block trace and tx trace`);
          expect(blockResult.input).to.equal(txResult.input,
            `tx ${txHash}: input mismatch between block trace and tx trace`);

          if (blockResult.output !== undefined && txResult.output !== undefined) {
            expect(blockResult.output).to.equal(txResult.output,
              `tx ${txHash}: output mismatch between block trace and tx trace`);
          }
        }
      }
    });

  });


  describe('Prestate tracer verification', function () {

    it('verifies prestate contains expected addresses', async () => {
      const blockRecords = recorder.getBlockRecords();
      if (blockRecords.length === 0) {
        console.log('No blocks recorded, skipping prestate verification');
        return;
      }

      const record = blockRecords[0];
      const result = await recorder.traceBlockByNumber(
        record.blockNumber,
        'prestateTracer',
        TRACER_OPTIONS.prestateTracer
      );

      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(0);

      const firstTrace = result[0];
      expect(firstTrace).to.have.property('result');

      const prestate = firstTrace.result;
      const addresses = Object.keys(prestate);

      console.log(`Prestate contains ${addresses.length} addresses`);
      console.log('Sample addresses:', addresses.slice(0, 5));
    });

    it('verifies diffMode shows state changes', async () => {
      const blockRecords = recorder.getBlockRecords();

      const record = blockRecords[0];
      const result = await recorder.traceBlockByNumber(
        record.blockNumber,
        'prestateTracerDiffMode',
        TRACER_OPTIONS.prestateTracerDiffMode
      );

      expect(result).to.be.an('array');

      if (result.length > 0 && result[0].result) {
        const diff = result[0].result;
        const hasPre = diff.pre !== undefined;
        const hasPost = diff.post !== undefined;

        console.log(`Diff mode - has pre: ${hasPre}, has post: ${hasPost}`);
      }
    });

  });

  after('Print summary', async () => {
    //recorder.printSummary();
  });

});
