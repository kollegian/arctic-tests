import { spawn, ChildProcess, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sleep, waitUntil } from './waitFor';

/**
 * Local single-validator Sei harness for tests that need controlled mempool
 * config (capacity caps, TTL, eviction policy). Public testnets won't let us
 * dial `mempool.size` down to 20 or `ttl-num-blocks` down to 3, so we spawn
 * our own node.
 *
 * Gate: only used when LOCAL_CHAIN=1. When unset, the corresponding `describe`
 * blocks skip with a clear reason via `describeLocalOnly`.
 *
 * Requires `seid` on PATH.
 */
export interface LocalChainConfig {
    mempoolSize?: number;            // mempool.size
    pendingPoolSize?: number;        // mempool.pending-size
    ttlNumBlocks?: number;           // mempool.ttl-num-blocks
    ttlDurationSeconds?: number;     // mempool.ttl-duration (seconds)
    maxTxBytes?: number;             // mempool.max-tx-bytes
    chainId?: string;
    moniker?: string;
}

export interface LocalChainHandle {
    home: string;
    rpcEndpoint: string;     // Tendermint RPC, e.g. http://127.0.0.1:26657
    evmRpcEndpoint: string;  // EVM RPC, e.g. http://127.0.0.1:8545
    restEndpoint: string;    // Cosmos REST gateway
    chainId: string;
    stop: () => Promise<void>;
}

export function localChainEnabled(): boolean {
    return process.env.LOCAL_CHAIN === '1';
}

/**
 * Mocha-friendly `describe` wrapper: skips the whole block (with reason) when
 * LOCAL_CHAIN is unset, so the regular CI run against a shared testnet doesn't
 * try to spawn seid.
 */
export function describeLocalOnly(
    title: string,
    body: (this: Mocha.Suite) => void,
): void {
    if (localChainEnabled()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).describe(title, body);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).describe.skip(
            `${title} [skipped: set LOCAL_CHAIN=1 to run local-node-only mempool tests]`,
            body,
        );
    }
}

function applyMempoolOverrides(
    tomlPath: string,
    cfg: LocalChainConfig,
): void {
    let toml = fs.readFileSync(tomlPath, 'utf-8');

    const replace = (key: string, value: string | number): void => {
        const re = new RegExp(`^${key}\\s*=.*$`, 'm');
        const line = `${key} = ${value}`;
        if (re.test(toml)) {
            toml = toml.replace(re, line);
        } else {
            // Append under [mempool] section as a fallback.
            toml = toml.replace(/\[mempool\]/m, `[mempool]\n${line}`);
        }
    };

    if (cfg.mempoolSize !== undefined) replace('size', cfg.mempoolSize);
    if (cfg.pendingPoolSize !== undefined) replace('pending-size', cfg.pendingPoolSize);
    if (cfg.ttlNumBlocks !== undefined) replace('ttl-num-blocks', cfg.ttlNumBlocks);
    if (cfg.ttlDurationSeconds !== undefined)
        replace('ttl-duration', `"${cfg.ttlDurationSeconds}s"`);
    if (cfg.maxTxBytes !== undefined) replace('max-tx-bytes', cfg.maxTxBytes);

    fs.writeFileSync(tomlPath, toml, 'utf-8');
}

/**
 * Spin up a single-validator local Sei chain with mempool overrides.
 * Returns a handle with endpoints + a stop() function.
 */
export async function startLocalChain(
    cfg: LocalChainConfig = {},
): Promise<LocalChainHandle> {
    if (!localChainEnabled()) {
        throw new Error('startLocalChain called without LOCAL_CHAIN=1');
    }

    const chainId = cfg.chainId ?? 'sei-mempool-test';
    const moniker = cfg.moniker ?? 'mempool-test-node';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sei-mempool-'));

    // Initialize chain home.
    execSync(`seid init "${moniker}" --chain-id ${chainId} --home "${home}"`, {
        stdio: 'pipe',
    });

    // Apply mempool overrides to config.toml.
    const cfgToml = path.join(home, 'config', 'config.toml');
    if (fs.existsSync(cfgToml)) {
        applyMempoolOverrides(cfgToml, cfg);
    }

    // NOTE: Real local-chain bring-up requires keys, genesis, gentx, collect-gentxs,
    // and starting seid. That's environment-specific (seid version, modules, etc).
    // Test authors should provide a `scripts/local-chain-bootstrap.sh` that's invoked
    // here when wired up to their environment. We expose the hook with a clear error
    // so the harness signals what's missing instead of silently launching a broken node.
    const bootstrap = process.env.LOCAL_CHAIN_BOOTSTRAP;
    if (!bootstrap || !fs.existsSync(bootstrap)) {
        throw new Error(
            'LOCAL_CHAIN_BOOTSTRAP must point at an executable that finishes ' +
                'genesis setup for the seid home directory. Receives $SEID_HOME, ' +
                '$CHAIN_ID, $MONIKER as env vars; must NOT start the node itself.',
        );
    }
    execSync(`"${bootstrap}"`, {
        env: { ...process.env, SEID_HOME: home, CHAIN_ID: chainId, MONIKER: moniker },
        stdio: 'inherit',
    });

    // Start seid as a child process, piping logs.
    const logPath = path.join(home, 'seid.log');
    const log = fs.openSync(logPath, 'a');
    const child: ChildProcess = spawn(
        'seid',
        ['start', '--home', home, '--minimum-gas-prices', '0.01usei'],
        { stdio: ['ignore', log, log], detached: false },
    );

    const stop = async (): Promise<void> => {
        if (!child.killed) child.kill('SIGTERM');
        await sleep(500);
        if (!child.killed) child.kill('SIGKILL');
        try {
            fs.closeSync(log);
        } catch {
            // ignore
        }
    };

    process.once('exit', () => {
        if (!child.killed) child.kill('SIGKILL');
    });

    // Wait for endpoints to come up.
    const rpcEndpoint = 'http://127.0.0.1:26657';
    const evmRpcEndpoint = 'http://127.0.0.1:8545';
    const restEndpoint = 'http://127.0.0.1:1317';

    await waitUntil(
        async () => {
            try {
                const res = await fetch(`${rpcEndpoint}/status`);
                return res.ok;
            } catch {
                return false;
            }
        },
        120_000,
        1_000,
        'local seid Tendermint RPC to come up',
    );

    return { home, rpcEndpoint, evmRpcEndpoint, restEndpoint, chainId, stop };
}
