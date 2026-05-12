// cosmos-sdk pflag rejects unknown flags, so route by subcommand:
//   tx                                         → --node + --chain-id
//   q | query | status | tendermint | rollback → --node only
//   keys | config | debug | version | genesis  → no flags
//
// Always wait for inclusion: cosmjs's auth/account query reads committed
// state, so a not-yet-committed seid tx races the next admin signer.

import util from "node:util";
import { exec as execCallback } from "node:child_process";

const exec = util.promisify(execCallback);

const TX_RE = /^\s*(?:echo[^|]*\|\s*)?seid\s+tx\b/;
const NODE_RE = /^\s*(?:echo[^|]*\|\s*)?seid\s+(?:q|query|status|tendermint|rollback)\b/;
const BROADCAST_BLOCK_RE = /--broadcast-mode\s+block\b/;
const TXHASH_RE = /"txhash"\s*:\s*"([0-9A-Fa-f]+)"/;
const OUTPUT_FLAG_RE = /--output\s+\S+/;
const GENERATE_ONLY_RE = /--generate-only\b/;

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

export interface SeidExecOptions {
    // Set false to skip the inclusion poll (same-block submission patterns).
    waitForInclusion?: boolean;
}

interface BroadcastResponse {
    code?: number;
    codespace?: string;
    raw_log?: string;
    txhash?: string;
}

export function seidNodeFlag(): string {
    const node = process.env.SEI_TENDERMINT_RPC;
    if (!node) throw new Error('SEI_TENDERMINT_RPC must be set for seid CLI calls');
    return `--node ${node}`;
}

export function seidOnlineFlags(): string {
    const chainId = process.env.SEI_CHAIN_ID;
    if (!chainId) throw new Error('SEI_CHAIN_ID must be set for seid CLI broadcast calls');
    return `${seidNodeFlag()} --chain-id ${chainId}`;
}

// CLI exits 0 on CheckTx rejection; failure is in payload `code`.
function tryParseBroadcastResponse(stdout: string): BroadcastResponse | null {
    try {
        const obj = JSON.parse(stdout.trim());
        if (typeof obj === 'object' && obj !== null && typeof obj.code === 'number') {
            return obj;
        }
        return null;
    } catch {
        return null;
    }
}

async function pollForTxInclusion(txhash: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const { stdout } = await exec(`seid q tx ${txhash} --output json ${seidNodeFlag()}`);
            if (stdout.includes('"txhash"')) return;
        } catch (err: any) {
            // not-yet-found exits non-zero; any other failure should fail fast.
            const out = `${err?.stderr ?? ''}${err?.stdout ?? ''}`;
            if (!/not\s+found/i.test(out)) {
                throw new Error(`seid q tx ${txhash} failed: ${err?.message ?? err}`);
            }
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`seid tx ${txhash} not included within ${POLL_TIMEOUT_MS}ms`);
}

export async function seidExec(
    command: string,
    options: SeidExecOptions = {},
): Promise<{ stdout: string; stderr: string }> {
    let rewritten = command.replace(BROADCAST_BLOCK_RE, '--broadcast-mode sync');
    const isTx = TX_RE.test(rewritten);

    // CheckTx response is parseable only as JSON; cosmos-sdk default is text.
    if (isTx && !OUTPUT_FLAG_RE.test(rewritten) && !GENERATE_ONLY_RE.test(rewritten)) {
        rewritten = `${rewritten} --output json`;
    }

    let result: { stdout: string; stderr: string };
    if (isTx) result = await exec(`${rewritten} ${seidOnlineFlags()}`);
    else if (NODE_RE.test(rewritten)) result = await exec(`${rewritten} ${seidNodeFlag()}`);
    else result = await exec(rewritten);

    if (isTx && options.waitForInclusion !== false) {
        const broadcast = tryParseBroadcastResponse(result.stdout);
        if (broadcast && broadcast.code !== 0) {
            throw new Error(
                `seid tx broadcast rejected: code=${broadcast.code} ` +
                `codespace=${broadcast.codespace ?? '<unknown>'} ` +
                `raw_log=${broadcast.raw_log ?? '<empty>'} ` +
                `(cmd: ${rewritten})`,
            );
        }
        const hash = broadcast?.txhash ?? result.stdout.match(TXHASH_RE)?.[1];
        if (hash) await pollForTxInclusion(hash);
    }
    return result;
}
