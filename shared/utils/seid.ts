// cosmos-sdk pflag rejects unknown flags, so route by subcommand:
//   tx                                         → --node + --chain-id
//   q | query | status | tendermint | rollback → --node only
//   keys | config | debug | version | genesis  → no flags

import util from "node:util";
import { exec as execCallback } from "node:child_process";

const exec = util.promisify(execCallback);

const TX_RE = /^\s*(?:echo[^|]*\|\s*)?seid\s+tx\b/;
const NODE_RE = /^\s*(?:echo[^|]*\|\s*)?seid\s+(?:q|query|status|tendermint|rollback)\b/;

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

export async function seidExec(command: string): Promise<{ stdout: string; stderr: string }> {
    if (TX_RE.test(command)) return exec(`${command} ${seidOnlineFlags()}`);
    if (NODE_RE.test(command)) return exec(`${command} ${seidNodeFlag()}`);
    return exec(command);
}
