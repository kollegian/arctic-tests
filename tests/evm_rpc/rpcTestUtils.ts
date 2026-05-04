import { expect } from 'chai';
import { ethers } from 'ethers';

export const USEI_TO_WEI = 10n ** 12n;
export const SIMPLE_TRANSFER_GAS = 21000n;
export const ZERO_ADDRESS = '0x' + '0'.repeat(40);

const HEX_DATA = /^0x(?:[0-9a-f]{2})*$/;
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const HASH_32 = /^0x[0-9a-f]{64}$/;
const BLOOM_256 = /^0x[0-9a-f]{512}$/;

export function expectQuantity(value: string, label: string): bigint {
    expect(value, `${label} must be a canonical hex quantity`).to.match(HEX_QUANTITY);
    return BigInt(value);
}

function expectQuantityIn(actual: string, allowed: bigint[], label: string) {
    const actualValue = expectQuantity(actual, label);
    expect(allowed, label).to.include(actualValue);
}

export function expectHash(value: string, label: string) {
    expect(value, `${label} must be a 32-byte hash`).to.match(HASH_32);
}

export function expectData(value: string, label: string) {
    expect(value, `${label} must be hex data`).to.match(HEX_DATA);
}

export function expectOptionalData(value: string | undefined, label: string) {
    if (value !== undefined) {
        expectData(value, label);
    }
}

export function expectAddress(actual: string, label: string) {
    expect(ethers.isAddress(actual), `${label} must be a valid EVM address`).to.eq(true);
}

export function expectAddressEq(actual: string, expected: string, label: string) {
    expectAddress(actual, label);
    expect(actual.toLowerCase(), label).to.eq(expected.toLowerCase());
}

export function expectOnlyKnownFields(actual: any, knownFields: string[], label: string) {
    const unknown = Object.keys(actual).filter((field) => !knownFields.includes(field));
    expect(unknown, `${label} returned unasserted fields`).to.deep.eq([]);
}

export function expectQuantityEq(actual: string, expected: bigint | number, label: string) {
    expect(expectQuantity(actual, label), label).to.eq(BigInt(expected));
}

export function expectQuantityGte(actual: string, expected: bigint | number, label: string) {
    expect(expectQuantity(actual, label) >= BigInt(expected), label).to.eq(true);
}

function expectQuantityLte(actual: string, expected: bigint | number, label: string) {
    expect(expectQuantity(actual, label) <= BigInt(expected), label).to.eq(true);
}

export function expectLogFields(log: any, expected: {
    address: string;
    blockHash: string;
    blockNumber: string;
    transactionHash: string;
    topic0: string;
}) {
    expectOnlyKnownFields(log, [
        'address',
        'blockHash',
        'blockNumber',
        'data',
        'logIndex',
        'removed',
        'topics',
        'transactionHash',
        'transactionIndex',
    ], 'log');
    expectAddressEq(log.address, expected.address, 'log.address');
    expect(log.blockHash).to.eq(expected.blockHash);
    expect(log.blockNumber).to.eq(expected.blockNumber);
    expectData(log.data, 'log.data');
    expectQuantity(log.logIndex, 'log.logIndex');
    expect(log.removed).to.eq(false);
    expect(log.topics.length).to.be.within(1, 4);
    expect(log.topics[0]).to.eq(expected.topic0);
    for (const [index, topic] of log.topics.entries()) {
        expectHash(topic, `log.topics[${index}]`);
    }
    expect(log.transactionHash).to.eq(expected.transactionHash);
    expectQuantity(log.transactionIndex, 'log.transactionIndex');
}

export async function expectTransactionFields(provider: ethers.JsonRpcProvider, tx: any, expected: {
    hash: string;
    blockHash: string;
    blockNumber: string;
    from: string;
    to: string | null;
    value: bigint;
    nonce: number;
    input?: string;
    transactionIndex?: bigint | number;
}) {
    expectOnlyKnownFields(tx, [
        'accessList',
        'blockHash',
        'blockNumber',
        'chainId',
        'from',
        'gas',
        'gasPrice',
        'hash',
        'input',
        'maxFeePerGas',
        'maxPriorityFeePerGas',
        'nonce',
        'r',
        's',
        'to',
        'transactionIndex',
        'type',
        'v',
        'value',
        'yParity',
    ], 'transaction');
    expect(tx.hash).to.eq(expected.hash);
    expect(tx.blockHash).to.eq(expected.blockHash);
    expect(tx.blockNumber).to.eq(expected.blockNumber);
    expectAddressEq(tx.from, expected.from, 'transaction.from');
    if (expected.to === null) {
        expect(tx.to).to.eq(null);
    } else {
        expectAddressEq(tx.to, expected.to, 'transaction.to');
    }
    expectQuantityGte(tx.gas, SIMPLE_TRANSFER_GAS, 'transaction.gas');
    expectQuantityGte(tx.gasPrice, 1n, 'transaction.gasPrice');
    if (tx.maxFeePerGas !== undefined) {
        expectQuantityGte(tx.maxFeePerGas, 1n, 'transaction.maxFeePerGas');
        expectQuantityLte(tx.maxPriorityFeePerGas, BigInt(tx.maxFeePerGas), 'transaction.maxPriorityFeePerGas');
    }
    expect(tx.input).to.eq(expected.input ?? '0x');
    expectQuantityEq(tx.nonce, expected.nonce, 'transaction.nonce');
    if (expected.transactionIndex !== undefined) {
        expectQuantityEq(tx.transactionIndex, expected.transactionIndex, 'transaction.transactionIndex');
    } else {
        expectQuantity(tx.transactionIndex, 'transaction.transactionIndex');
    }
    expectQuantityEq(tx.value, expected.value, 'transaction.value');
    expectHash(tx.r, 'transaction.r');
    expectHash(tx.s, 'transaction.s');
    expectQuantity(tx.v, 'transaction.v');
    if (tx.yParity !== undefined) {
        expect([0n, 1n]).to.include(expectQuantity(tx.yParity, 'transaction.yParity'));
    }
    expectQuantityIn(tx.type, [0n, 1n, 2n, 3n], 'transaction.type');
    if (tx.accessList !== undefined) {
        expect(tx.accessList.length).to.eq(0);
    }
    const network = await provider.getNetwork();
    expectQuantityEq(tx.chainId, network.chainId, 'transaction.chainId');
}

export function expectReceiptFields(receipt: any, expected: {
    transactionHash: string;
    blockHash: string;
    blockNumber: string;
    from: string;
    to: string | null;
    status: string;
    gasUsed?: bigint;
    logsLength?: number;
    contractAddress?: string | null;
    transactionIndex?: bigint | number;
}) {
    expectOnlyKnownFields(receipt, [
        'blockHash',
        'blockNumber',
        'blobGasPrice',
        'blobGasUsed',
        'contractAddress',
        'cumulativeGasUsed',
        'effectiveGasPrice',
        'from',
        'gasUsed',
        'logs',
        'logsBloom',
        'root',
        'status',
        'to',
        'transactionHash',
        'transactionIndex',
        'type',
    ], 'receipt');
    expect(receipt.transactionHash).to.eq(expected.transactionHash);
    expect(receipt.blockHash).to.eq(expected.blockHash);
    expect(receipt.blockNumber).to.eq(expected.blockNumber);
    expectAddressEq(receipt.from, expected.from, 'receipt.from');
    if (expected.to === null) {
        expect(receipt.to).to.eq(null);
    } else {
        expectAddressEq(receipt.to, expected.to, 'receipt.to');
    }
    expectQuantityIn(receipt.status, [0n, 1n], 'receipt.status');
    expect(receipt.status).to.eq(expected.status);
    expectQuantityGte(receipt.effectiveGasPrice, 1n, 'receipt.effectiveGasPrice');
    if (receipt.blobGasPrice !== undefined) {
        expectQuantityGte(receipt.blobGasPrice, 0n, 'receipt.blobGasPrice');
    }
    if (receipt.blobGasUsed !== undefined) {
        expectQuantityGte(receipt.blobGasUsed, 0n, 'receipt.blobGasUsed');
    }
    if (receipt.root !== undefined) {
        expectHash(receipt.root, 'receipt.root');
    }
    if (expected.gasUsed !== undefined) {
        expectQuantityEq(receipt.gasUsed, expected.gasUsed, 'receipt.gasUsed');
    } else {
        expectQuantityGte(receipt.gasUsed, 1n, 'receipt.gasUsed');
    }
    expectQuantityGte(receipt.cumulativeGasUsed, BigInt(receipt.gasUsed), 'receipt.cumulativeGasUsed');
    expect(receipt.logsBloom).to.match(BLOOM_256);
    expect(receipt.logs.length).to.eq(expected.logsLength ?? receipt.logs.length);
    expect(receipt.contractAddress).to.eq(expected.contractAddress ?? null);
    if (expected.transactionIndex !== undefined) {
        expectQuantityEq(receipt.transactionIndex, expected.transactionIndex, 'receipt.transactionIndex');
    } else {
        expectQuantity(receipt.transactionIndex, 'receipt.transactionIndex');
    }
    expectQuantityIn(receipt.type, [0n, 1n, 2n, 3n], 'receipt.type');
}

export function expectBlockFields(block: any, expected: {
    hash: string;
    number: string;
    transactionHash?: string;
    fullTransactions: boolean;
}) {
    expectOnlyKnownFields(block, [
        'baseFeePerGas',
        'blobGasUsed',
        'difficulty',
        'excessBlobGas',
        'extraData',
        'gasLimit',
        'gasUsed',
        'hash',
        'logsBloom',
        'miner',
        'mixHash',
        'nonce',
        'number',
        'parentBeaconBlockRoot',
        'parentHash',
        'receiptsRoot',
        'sha3Uncles',
        'size',
        'stateRoot',
        'timestamp',
        'totalDifficulty',
        'transactions',
        'transactionsRoot',
        'uncles',
        'withdrawals',
        'withdrawalsRoot',
    ], 'block');
    expect(block.hash).to.eq(expected.hash);
    expect(block.number).to.eq(expected.number);
    expectHash(block.hash, 'block.hash');
    expectHash(block.parentHash, 'block.parentHash');
    expectHash(block.receiptsRoot, 'block.receiptsRoot');
    expectHash(block.sha3Uncles, 'block.sha3Uncles');
    expectHash(block.stateRoot, 'block.stateRoot');
    expectHash(block.transactionsRoot, 'block.transactionsRoot');
    if (block.withdrawalsRoot !== undefined) {
        expectHash(block.withdrawalsRoot, 'block.withdrawalsRoot');
    }
    if (block.parentBeaconBlockRoot !== undefined) {
        expectHash(block.parentBeaconBlockRoot, 'block.parentBeaconBlockRoot');
    }
    expectData(block.extraData, 'block.extraData');
    expectQuantityGte(block.gasLimit, 1n, 'block.gasLimit');
    expectQuantityLte(block.gasUsed, BigInt(block.gasLimit), 'block.gasUsed');
    if (block.logsBloom !== null) {
        expect(block.logsBloom).to.match(BLOOM_256);
    }
    expectAddress(block.miner, 'block.miner');
    expectHash(block.mixHash, 'block.mixHash');
    if (block.nonce !== null) {
        expect(block.nonce).to.match(/^0x[0-9a-f]{16}$/);
    }
    expectQuantity(block.number, 'block.number');
    expectQuantityGte(block.size, 1n, 'block.size');
    expectQuantityGte(block.timestamp, 1n, 'block.timestamp');
    if (block.totalDifficulty !== undefined && block.totalDifficulty !== null) {
        expectQuantityGte(block.totalDifficulty, 0n, 'block.totalDifficulty');
    }
    if (block.baseFeePerGas !== undefined) {
        expectQuantityGte(block.baseFeePerGas, 1n, 'block.baseFeePerGas');
    }
    if (block.difficulty !== undefined) {
        expectQuantityGte(block.difficulty, 0n, 'block.difficulty');
    }
    if (block.blobGasUsed !== undefined) {
        expectQuantityGte(block.blobGasUsed, 0n, 'block.blobGasUsed');
    }
    if (block.excessBlobGas !== undefined) {
        expectQuantityGte(block.excessBlobGas, 0n, 'block.excessBlobGas');
    }
    for (const uncleHash of block.uncles) {
        expectHash(uncleHash, 'block.uncles[]');
    }
    if (block.withdrawals !== undefined) {
        expect(block.withdrawals.length).to.eq(0);
    }
    const txHashes = expected.fullTransactions
        ? block.transactions.map((tx: any) => tx.hash)
        : block.transactions;
    for (const txHash of txHashes) {
        expectHash(txHash, 'block.transactions[]');
    }
    if (expected.transactionHash !== undefined) {
        expect(txHashes).to.include(expected.transactionHash);
    }
}

export function expectEip1898BlockHash(block: any, expectedHash: string) {
    expectOnlyKnownFields(block, ['blockHash', 'requireCanonical'], 'EIP-1898 block hash identifier');
    expect(block.blockHash).to.eq(expectedHash);
    if (block.requireCanonical !== undefined) {
        expect(block.requireCanonical).to.eq(true);
    }
}

export async function rawRpc(endpoint: string, method: string, params: any[] = []) {
    const id = 4242;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const body = await response.json();
    expect(body.jsonrpc).to.eq('2.0');
    expect(body.id).to.eq(id);
    return body;
}
