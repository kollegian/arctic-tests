// cosmos-sdk pflag rejects unknown flags, so route by subcommand:
//   tx                                         → --node + --chain-id
//   q | query | status | tendermint | rollback → --node only
//   keys | config | debug | version | genesis  → no flags
//
// cosmos-sdk 0.50 removed --broadcast-mode block. Rewrite to sync and poll
// `seid q tx` for inclusion.

import util from "node:util";
import { exec as execCallback } from "node:child_process";

const exec = util.promisify(execCallback);

const TX_RE = /^\s*(?:echo[^|]*\|\s*)?seid\s+tx\b/;
const NODE_RE = /^\s*(?:echo[^|]*\|\s*)?seid\s+(?:q|query|status|tendermint|rollback)\b/;
const BROADCAST_BLOCK_RE = /--broadcast-mode\s+block\b/;
const TXHASH_RE = /"txhash"\s*:\s*"([0-9A-Fa-f]+)"/;

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 30_000;

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

async function pollForTxInclusion(txhash: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const { stdout } = await exec(`seid q tx ${txhash} --output json ${seidNodeFlag()}`);
            if (stdout.includes('"txhash"')) return;
        } catch {}
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`seid tx ${txhash} not included within ${POLL_TIMEOUT_MS}ms`);
}

export async function seidExec(command: string): Promise<{ stdout: string; stderr: string }> {
    const wantsInclusionWait = TX_RE.test(command) && BROADCAST_BLOCK_RE.test(command);
    const rewritten = wantsInclusionWait
        ? command.replace(BROADCAST_BLOCK_RE, '--broadcast-mode sync')
        : command;

    let result: { stdout: string; stderr: string };
    if (TX_RE.test(rewritten)) result = await exec(`${rewritten} ${seidOnlineFlags()}`);
    else if (NODE_RE.test(rewritten)) result = await exec(`${rewritten} ${seidNodeFlag()}`);
    else result = await exec(rewritten);

    if (wantsInclusionWait) {
        const m = result.stdout.match(TXHASH_RE);
        if (m) await pollForTxInclusion(m[1]);
    }
    return result;
}
