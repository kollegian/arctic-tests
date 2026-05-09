import { TransactionReceipt, JsonRpcProvider, ethers } from 'ethers';
import { BlockRecord, TraceTiming } from './types';
import { seidExec } from '../../../shared/utils/seid';

export const TRACER_OPTIONS = {
  callTracer: { tracer: 'callTracer' },
  callTracerOnlyTopCall: { tracer: 'callTracer', tracerConfig: { onlyTopCall: true } },
  prestateTracer: { tracer: 'prestateTracer' },
  prestateTracerDiffMode: { tracer: 'prestateTracer', tracerConfig: { diffMode: true } },
  fourByteTracer: { tracer: '4byteTracer' },
};

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getCliAdminAddress(): Promise<string> {
  const { stdout } = await seidExec('seid keys show admin -a');
  return stdout.trim();
}

export async function fundAddressFromCli(
  toAddress: string,
  amount: string = '100000000000',
  denom: string = 'usei'
): Promise<void> {
  const adminAddress = await getCliAdminAddress();
  console.log(`Funding ${toAddress} from CLI admin ${adminAddress}...`);
  
  const cmd = `seid tx bank send ${adminAddress} ${toAddress} ${amount}${denom} --fees 25000usei -y --broadcast-mode block`;
  const { stdout, stderr } = await seidExec(cmd);
  
  if (stderr && !stderr.includes('gas estimate')) {
    console.warn('CLI warning:', stderr);
  }
  
  await sleep(1000);
  console.log('Funding complete');
}

export async function associateAddress(evmAddress: string): Promise<void> {
  console.log(`Associating EVM address ${evmAddress}...`);
  
  const cmd = `seid tx evm associate-address --from admin --fees 25000usei -y --broadcast-mode block`;
  try {
    await seidExec(cmd);
    await sleep(1000);
    console.log('Association complete');
  } catch (e: any) {
    console.log('Association may have failed or already associated:', e.message);
  }
}

export async function fundFunderFromCli(
  funderPrivateKey: string,
  rpcUrl: string,
  minBalanceWei: string = '500000000000000000000'
): Promise<void> {
  const wallet = new ethers.Wallet(funderPrivateKey);
  const evmAddress = wallet.address;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log('FUNDER SETUP');
  console.log('='.repeat(60));
  console.log(`Funder EVM address: ${evmAddress}`);
  
  const provider = new JsonRpcProvider(rpcUrl);
  const balanceBefore = await provider.getBalance(evmAddress);
  const minBalance = BigInt(minBalanceWei);
  
  console.log(`Balance before: ${ethers.formatEther(balanceBefore)} SEI`);
  console.log(`Required minimum: ${ethers.formatEther(minBalance)} SEI`);
  
  if (balanceBefore < minBalance) {
    console.log('Balance too low, funding from CLI...');
    const amountToFund = (minBalance - balanceBefore + ethers.parseEther('100')).toString();
    await fundAddressFromCli(evmAddress, amountToFund);
    
    await sleep(2000);
    const balanceAfter = await provider.getBalance(evmAddress);
    console.log(`Balance after funding: ${ethers.formatEther(balanceAfter)} SEI`);
  } else {
    console.log('Funder has sufficient balance');
  }
  
  console.log('='.repeat(60) + '\n');
}

export async function logBalance(
  address: string,
  provider: JsonRpcProvider,
  label: string = 'Address'
): Promise<bigint> {
  const balance = await provider.getBalance(address);
  console.log(`${label} (${address}): ${ethers.formatEther(balance)} SEI`);
  return balance;
}

export class BlockRecorder {
  private provider: JsonRpcProvider;
  private blockRecords: BlockRecord[] = [];
  private traceTimings: TraceTiming[] = [];

  constructor(provider: JsonRpcProvider) {
    this.provider = provider;
  }

  async recordBlock(
    receipt: TransactionReceipt | null,
    description: string,
    txType: number
  ): Promise<void> {
    if (!receipt) return;

    const block = await this.provider.getBlock(receipt.blockNumber);
    if (!block) return;

    const existing = this.blockRecords.find(r => r.blockNumber === receipt.blockNumber);
    if (existing) {
      existing.txHashes.push(receipt.hash);
      existing.txTypes.push(txType);
      existing.description += `, ${description}`;
    } else {
      this.blockRecords.push({
        blockNumber: receipt.blockNumber,
        blockHash: block.hash!,
        description,
        txHashes: [receipt.hash],
        txTypes: [txType],
      });
    }
  }

  async recordBlockFromReceipts(
    receipts: TransactionReceipt[],
    description: string,
    txType: number
  ): Promise<void> {
    for (const receipt of receipts) {
      await this.recordBlock(receipt, description, txType);
    }
  }

  async traceBlockByNumber(
    blockNumber: number,
    tracerName: string,
    options: object
  ): Promise<any> {
    const blockHex = '0x' + blockNumber.toString(16);
    const start = Date.now();

    const result = await this.provider.send('debug_traceBlockByNumber', [blockHex, options]);

    const duration = Date.now() - start;
    this.traceTimings.push({ blockNumber, tracer: tracerName, durationMs: duration });

    return result;
  }

  async traceBlockByHash(
    blockHash: string,
    tracerName: string,
    options: object
  ): Promise<any> {
    const start = Date.now();

    const result = await this.provider.send('debug_traceBlockByHash', [blockHash, options]);

    const duration = Date.now() - start;
    this.traceTimings.push({ blockNumber: -1, tracer: `${tracerName} (by hash)`, durationMs: duration });

    return result;
  }

  async traceTransaction(
    txHash: string,
    options: object
  ): Promise<any> {
    const start = Date.now();

    const result = await this.provider.send('debug_traceTransaction', [txHash, options]);

    const duration = Date.now() - start;
    this.traceTimings.push({ blockNumber: -1, tracer: 'debug_traceTransaction', durationMs: duration });

    return result;
  }

  getBlockRecords(): BlockRecord[] {
    return this.blockRecords;
  }

  getTraceTimings(): TraceTiming[] {
    return this.traceTimings;
  }

  printSummary(): void {
    console.log('\n' + '='.repeat(80));
    console.log('TEST SUMMARY');
    console.log('='.repeat(80));

    console.log(`\nBlocks recorded: ${this.blockRecords.length}`);
    for (const record of this.blockRecords) {
      console.log(`  Block ${record.blockNumber}: ${record.description}`);
      console.log(`    Tx types: [${record.txTypes.join(', ')}]`);
      console.log(`    Tx count: ${record.txHashes.length}`);
    }

    console.log(`\nTrace timings (${this.traceTimings.length} traces):`);
    const byTracer = new Map<string, number[]>();
    for (const timing of this.traceTimings) {
      const list = byTracer.get(timing.tracer) || [];
      list.push(timing.durationMs);
      byTracer.set(timing.tracer, list);
    }

    for (const [tracer, times] of byTracer) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const max = Math.max(...times);
      const min = Math.min(...times);
      console.log(`  ${tracer}:`);
      console.log(`    avg: ${avg.toFixed(2)}ms, min: ${min}ms, max: ${max}ms`);
    }

    console.log('\n' + '='.repeat(80));
  }
}
