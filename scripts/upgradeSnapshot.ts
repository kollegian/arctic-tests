/**
 * Pre-upgrade RPC snapshot.
 *
 * Run this BEFORE a chain upgrade, pointed at a node that serves the target block,
 * to record the full set of RPC responses for that block (block bodies, receipts,
 * per-tx lookups, and debug traces). It writes a single JSON file. After the
 * upgrade, run `scripts/upgradeVerify.ts` against the (upgraded) node to prove the
 * historical responses did not change.
 *
 * A historical block's data and its replayed traces must be byte-identical across an
 * upgrade — any diff is a serialisation/replay regression.
 *
 * Run:
 *   SNAPSHOT_RPC=https://<archive-or-live-rpc> \
 *   SNAPSHOT_BLOCK=79123880 \
 *     npx tsx scripts/upgradeSnapshot.ts
 *
 * Env:
 *   SNAPSHOT_RPC     EVM JSON-RPC URL to read from (required)
 *   SNAPSHOT_BLOCK   block number (decimal or 0x-hex) to snapshot (required)
 *   SNAPSHOT_OUT     output path (default scripts/snapshots/block-<n>.json)
 *   SNAPSHOT_TRACES  "0" to skip debug_trace* (e.g. node without debug) (default on)
 *   SNAPSHOT_TRACER  block/tx tracer (default "callTracer"; "struct" for opcode logs)
 */
import fs from 'node:fs';
import path from 'node:path';

const RPC = process.env.SNAPSHOT_RPC;
const BLOCK_RAW = process.env.SNAPSHOT_BLOCK;
const WITH_TRACES = process.env.SNAPSHOT_TRACES !== '0';
const TRACER = process.env.SNAPSHOT_TRACER ?? 'callTracer';

if (!RPC || !BLOCK_RAW) {
    console.error(
        'upgradeSnapshot: SNAPSHOT_RPC and SNAPSHOT_BLOCK are required.\n' +
            '  SNAPSHOT_RPC=https://<rpc> SNAPSHOT_BLOCK=<number> npx tsx scripts/upgradeSnapshot.ts',
    );
    process.exit(1);
}

const blockNumber = BigInt(BLOCK_RAW);
const blockTag = '0x' + blockNumber.toString(16);

const OUT_PATH =
    process.env.SNAPSHOT_OUT ??
    path.resolve(__dirname, 'snapshots', `block-${blockNumber.toString()}.json`);

interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
interface RpcEnvelope<T = unknown> {
    result?: T;
    error?: JsonRpcError;
}

let idCounter = 0;
async function rpc<T = unknown>(method: string, params: unknown[]): Promise<RpcEnvelope<T>> {
    const res = await fetch(RPC as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params }),
    });
    const body = (await res.json()) as RpcEnvelope<T>;
    return body;
}

// Each recorded call keeps the method + params so the verifier replays it exactly,
// and the full envelope (result or error) so both success and error shapes are pinned.
interface RecordedCall {
    key: string;
    method: string;
    params: unknown[];
    response: RpcEnvelope;
}

async function record(calls: RecordedCall[], key: string, method: string, params: unknown[]) {
    const response = await rpc(method, params);
    calls.push({ key, method, params, response });
    const status = response.error ? `error ${response.error.code}` : 'ok';
    console.log(`  [${status}] ${key}`);
    return response;
}

async function main() {
    console.log(`==> Snapshotting block ${blockNumber} from ${RPC}`);

    const chainIdEnv = await rpc<string>('eth_chainId', []);
    if (chainIdEnv.error || !chainIdEnv.result) {
        throw new Error(`eth_chainId failed: ${JSON.stringify(chainIdEnv.error)}`);
    }
    const chainId = Number(chainIdEnv.result);

    const calls: RecordedCall[] = [];

    // Block bodies, both tx-detail forms, plus by-hash and receipts.
    const blockFull = await record(calls, 'getBlockByNumber:full', 'eth_getBlockByNumber', [
        blockTag,
        true,
    ]);
    await record(calls, 'getBlockByNumber:hashes', 'eth_getBlockByNumber', [blockTag, false]);

    const block = blockFull.result as any;
    if (!block) {
        throw new Error(
            `block ${blockNumber} not available on ${RPC}: ${JSON.stringify(blockFull.error)}`,
        );
    }
    const blockHash: string = block.hash;
    await record(calls, 'getBlockByHash:full', 'eth_getBlockByHash', [blockHash, true]);
    await record(calls, 'getBlockTxCount', 'eth_getBlockTransactionCountByNumber', [blockTag]);
    await record(calls, 'getBlockReceipts', 'eth_getBlockReceipts', [blockTag]);

    const txs: any[] = Array.isArray(block.transactions) ? block.transactions : [];
    const txHashes: string[] = txs.map(t => (typeof t === 'string' ? t : t.hash));
    console.log(`==> Block has ${txHashes.length} transaction(s)`);

    // Per-transaction lookups + receipts.
    for (let i = 0; i < txHashes.length; i++) {
        const h = txHashes[i];
        await record(calls, `tx:${i}:byHash`, 'eth_getTransactionByHash', [h]);
        await record(calls, `tx:${i}:receipt`, 'eth_getTransactionReceipt', [h]);
        await record(calls, `tx:${i}:byBlockIndex`, 'eth_getTransactionByBlockNumberAndIndex', [
            blockTag,
            '0x' + i.toString(16),
        ]);
    }

    // Debug traces — block-level and per-tx. These are the replay-sensitive parts.
    if (WITH_TRACES) {
        const tracerCfg = TRACER === 'struct' ? {} : { tracer: TRACER };
        await record(calls, 'trace:block', 'debug_traceBlockByNumber', [blockTag, tracerCfg]);
        for (let i = 0; i < txHashes.length; i++) {
            await record(calls, `trace:tx:${i}`, 'debug_traceTransaction', [txHashes[i], tracerCfg]);
        }
    } else {
        console.log('==> Skipping debug_trace* (SNAPSHOT_TRACES=0)');
    }

    const snapshot = {
        meta: {
            rpc: RPC,
            chainId,
            blockNumber: blockNumber.toString(),
            blockTag,
            blockHash,
            txCount: txHashes.length,
            withTraces: WITH_TRACES,
            tracer: WITH_TRACES ? TRACER : null,
            capturedAt: new Date().toISOString(),
        },
        calls,
    };

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(
        `\n==> Wrote ${calls.length} recorded calls for block ${blockNumber} (hash ${blockHash})`,
    );
    console.log(`    ${OUT_PATH}`);
}

main()
    .then(() => process.exit(0))
    .catch(e => {
        console.error('upgradeSnapshot failed:', e?.message ?? e);
        process.exit(1);
    });
