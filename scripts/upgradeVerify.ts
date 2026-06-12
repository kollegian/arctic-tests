/**
 * Post-upgrade RPC verification.
 *
 * Run this AFTER a chain upgrade against the upgraded node. It loads a snapshot
 * produced by `scripts/upgradeSnapshot.ts`, replays every recorded call, and
 * deep-compares the new responses against the recorded ones. A historical block's
 * data and replayed traces must be byte-identical across the upgrade, so any diff is
 * reported as a regression and the process exits non-zero.
 *
 * Run:
 *   VERIFY_RPC=https://<upgraded-rpc> \
 *   VERIFY_SNAPSHOT=scripts/snapshots/block-79123880.json \
 *     npx tsx scripts/upgradeVerify.ts
 *
 * Env:
 *   VERIFY_RPC       EVM JSON-RPC URL to verify against (default: snapshot's rpc)
 *   VERIFY_SNAPSHOT  path to the snapshot json (required)
 *   VERIFY_IGNORE    comma-separated JSON pointer-ish paths to ignore in diffs
 *                    (e.g. "result.totalDifficulty"); rarely needed
 *   VERIFY_MAX_DIFFS max diff lines to print per call (default 20)
 */
import fs from 'node:fs';
import path from 'node:path';

const RPC_OVERRIDE = process.env.VERIFY_RPC;
const SNAPSHOT_PATH = process.env.VERIFY_SNAPSHOT;
const MAX_DIFFS = Number(process.env.VERIFY_MAX_DIFFS ?? '20');
const IGNORE = (process.env.VERIFY_IGNORE ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

if (!SNAPSHOT_PATH) {
    console.error(
        'upgradeVerify: VERIFY_SNAPSHOT is required.\n' +
            '  VERIFY_RPC=https://<rpc> VERIFY_SNAPSHOT=scripts/snapshots/block-<n>.json npx tsx scripts/upgradeVerify.ts',
    );
    process.exit(1);
}

interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
interface RpcEnvelope<T = unknown> {
    result?: T;
    error?: JsonRpcError;
}
interface RecordedCall {
    key: string;
    method: string;
    params: unknown[];
    response: RpcEnvelope;
}
interface Snapshot {
    meta: {
        rpc: string;
        chainId: number;
        blockNumber: string;
        blockHash: string;
        txCount: number;
        withTraces: boolean;
        tracer: string | null;
        capturedAt: string;
    };
    calls: RecordedCall[];
}

const snapshotFile = path.resolve(process.cwd(), SNAPSHOT_PATH);
const snapshot = JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) as Snapshot;
const RPC = RPC_OVERRIDE ?? snapshot.meta.rpc;

let idCounter = 0;
async function rpc<T = unknown>(method: string, params: unknown[]): Promise<RpcEnvelope<T>> {
    const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++idCounter, method, params }),
    });
    return (await res.json()) as RpcEnvelope<T>;
}

// Normalise an envelope to just { result } or { error: {code,message,data} }, so the
// JSON-RPC `id` (which always differs) never registers as a diff.
function normalise(env: RpcEnvelope): unknown {
    if (env.error) {
        return { error: { code: env.error.code, message: env.error.message, data: env.error.data } };
    }
    return { result: env.result ?? null };
}

// Recursive deep diff. Returns a list of human-readable difference descriptions,
// each tagged with the path where expected (snapshot) and actual (live) differ.
function diff(expected: unknown, actual: unknown, at: string, out: string[]): void {
    if (out.length >= MAX_DIFFS) return;
    if (IGNORE.includes(at)) return;

    if (expected === actual) return;

    const te = typeof expected;
    const ta = typeof actual;
    if (te !== ta || expected === null || actual === null) {
        out.push(`  ${at}: expected ${render(expected)} -> got ${render(actual)}`);
        return;
    }

    if (Array.isArray(expected) || Array.isArray(actual)) {
        if (!Array.isArray(expected) || !Array.isArray(actual)) {
            out.push(`  ${at}: array/non-array mismatch`);
            return;
        }
        if (expected.length !== actual.length) {
            out.push(`  ${at}: array length ${expected.length} -> ${actual.length}`);
        }
        const n = Math.max(expected.length, actual.length);
        for (let i = 0; i < n && out.length < MAX_DIFFS; i++) {
            diff(expected[i], actual[i], `${at}[${i}]`, out);
        }
        return;
    }

    if (te === 'object') {
        const ke = Object.keys(expected as object);
        const ka = Object.keys(actual as object);
        const keys = new Set([...ke, ...ka]);
        for (const k of keys) {
            if (out.length >= MAX_DIFFS) break;
            const eHas = k in (expected as any);
            const aHas = k in (actual as any);
            if (!eHas) {
                out.push(`  ${at}.${k}: added in live (${render((actual as any)[k])})`);
            } else if (!aHas) {
                out.push(`  ${at}.${k}: missing in live (was ${render((expected as any)[k])})`);
            } else {
                diff((expected as any)[k], (actual as any)[k], `${at}.${k}`, out);
            }
        }
        return;
    }

    out.push(`  ${at}: expected ${render(expected)} -> got ${render(actual)}`);
}

function render(v: unknown): string {
    const s = JSON.stringify(v);
    if (s === undefined) return String(v);
    return s.length > 120 ? s.slice(0, 117) + '...' : s;
}

async function main() {
    console.log(`==> Verifying snapshot ${path.basename(snapshotFile)}`);
    console.log(`    block:   ${snapshot.meta.blockNumber} (hash ${snapshot.meta.blockHash})`);
    console.log(`    against: ${RPC}`);
    console.log(`    captured at ${snapshot.meta.capturedAt} from ${snapshot.meta.rpc}\n`);

    // Sanity: same chain.
    const idEnv = await rpc<string>('eth_chainId', []);
    if (!idEnv.result) {
        throw new Error(`eth_chainId failed on ${RPC}: ${JSON.stringify(idEnv.error)}`);
    }
    const liveChainId = Number(idEnv.result);
    if (liveChainId !== snapshot.meta.chainId) {
        throw new Error(
            `chainId mismatch: snapshot ${snapshot.meta.chainId} vs live ${liveChainId} — wrong network`,
        );
    }

    let passed = 0;
    const failures: { key: string; method: string; params: unknown[]; diffs: string[] }[] = [];

    for (const call of snapshot.calls) {
        const live = await rpc(call.method, call.params);
        const want = normalise(call.response);
        const got = normalise(live);
        const diffs: string[] = [];
        diff(want, got, '', diffs);
        if (diffs.length === 0) {
            passed++;
            console.log(`  ok   ${call.key}`);
        } else {
            failures.push({ key: call.key, method: call.method, params: call.params, diffs });
            console.log(`  DIFF ${call.key} (${diffs.length} diff${diffs.length === 1 ? '' : 's'})`);
        }
    }

    console.log(
        `\n==> ${passed}/${snapshot.calls.length} calls identical, ${failures.length} changed`,
    );

    if (failures.length > 0) {
        console.log('\n=== Regressions ===');
        for (const f of failures) {
            console.log(`\n${f.key}  [${f.method}]  params=${render(f.params)}`);
            for (const line of f.diffs) console.log(line);
        }
        process.exit(2);
    }

    console.log('All recorded responses are byte-identical post-upgrade.');
}

main().catch(e => {
    console.error('upgradeVerify failed:', e?.message ?? e);
    process.exit(1);
});
