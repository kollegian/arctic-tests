import { TransactionReceipt } from 'ethers';

export interface BlockRecord {
  blockNumber: number;
  blockHash: string;
  description: string;
  txHashes: string[];
  txTypes: number[];
}

export interface TraceTiming {
  blockNumber: number;
  tracer: string;
  durationMs: number;
}

export interface BatchTxResult {
  receipts: TransactionReceipt[];
  blockNumbers: number[];
  successCount: number;
  failCount: number;
}

export interface BlockFillResult {
  blockNumber: number;
  txCount: number;
  gasUsed: bigint;
  gasLimit: bigint;
  fillPercentage: number;
}

export interface FillBlocksResult {
  blocks: BlockFillResult[];
  totalTxs: number;
  totalGasUsed: bigint;
  averageFillPercentage: number;
}

export enum TxType {
  LEGACY = 0,
  ACCESS_LIST = 1,
  EIP1559 = 2,
  EIP7702 = 4,
}

export interface RecordedTx {
  hash: string;
  type: number;
  description: string;
  from: string;
  to: string | null;
  value: bigint;
  gasUsed: bigint;
  status: number;
  blockNumber: number;
  balanceBefore?: bigint;
  balanceAfter?: bigint;
  recipientBalanceBefore?: bigint;
  recipientBalanceAfter?: bigint;
}

export interface CallScenario {
  name: string;
  callParams: {
    from?: string;
    to: string;
    value?: string;
    data?: string;
    gas?: string;
  };
  expectedSuccess: boolean;
  description: string;
}
