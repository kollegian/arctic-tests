/**
 * Thin wrapper over CometBFT (Tendermint) RPC mempool endpoints.
 *
 * Sei wraps every EVM tx as MsgEVMTransaction, so it shows up in the
 * Tendermint mempool too. These endpoints are how we cross-check the
 * dual-pool coherency invariants.
 *
 *   GET /num_unconfirmed_txs
 *   GET /unconfirmed_txs?limit=N
 */

export interface NumUnconfirmedTxsResponse {
    n_txs: string;
    total: string;
    total_bytes: string;
}

export interface UnconfirmedTxsResponse {
    n_txs: string;
    total: string;
    total_bytes: string;
    txs: string[] | null; // base64-encoded tx bytes
}

async function rpc<T>(seiRpcEndpoint: string, path: string): Promise<T> {
    const url = `${seiRpcEndpoint.replace(/\/$/, '')}${path}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`tendermint rpc ${path} failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.result) {
        return body.result;
    }
    // Some Sei front-end RPCs (e.g. the public arctic endpoint) flatten the
    // JSON-RPC envelope and return the payload at the top level.
    if (body && typeof body === 'object' && !('error' in body) && !('result' in body)) {
        return body as T;
    }
    throw new Error(`tendermint rpc ${path} returned no result: ${JSON.stringify(body)}`);
}

export async function numUnconfirmedTxs(
    seiRpcEndpoint: string,
): Promise<{ count: number; totalBytes: number }> {
    const r = await rpc<NumUnconfirmedTxsResponse>(seiRpcEndpoint, '/num_unconfirmed_txs');
    return { count: Number(r.n_txs), totalBytes: Number(r.total_bytes) };
}

export async function unconfirmedTxs(
    seiRpcEndpoint: string,
    limit = 100,
): Promise<{ count: number; rawBase64: string[] }> {
    const r = await rpc<UnconfirmedTxsResponse>(
        seiRpcEndpoint,
        `/unconfirmed_txs?limit=${limit}`,
    );
    return { count: Number(r.n_txs), rawBase64: r.txs ?? [] };
}

/** True if any unconfirmed tx's base64 payload contains the given substring. */
export async function unconfirmedHas(
    seiRpcEndpoint: string,
    needle: string,
    limit = 200,
): Promise<boolean> {
    const { rawBase64 } = await unconfirmedTxs(seiRpcEndpoint, limit);
    return rawBase64.some((tx) => tx.includes(needle));
}

/**
 * Byte-level search: true if any unconfirmed Tendermint tx's decoded bytes
 * contain `hexBytes` as a contiguous subsequence. Sei embeds the raw signed
 * EVM RLP inside the MsgEVMTransaction wrapper, so an in-flight EVM tx's
 * wire bytes must be findable inside exactly one Tendermint mempool entry.
 */
export async function unconfirmedContainsBytes(
    seiRpcEndpoint: string,
    hexBytes: string,
    limit = 500,
): Promise<boolean> {
    const { rawBase64 } = await unconfirmedTxs(seiRpcEndpoint, limit);
    const needle = Buffer.from(hexBytes.replace(/^0x/, ''), 'hex');
    return rawBase64.some((b64) => Buffer.from(b64, 'base64').includes(needle));
}

/* ------------------------------------------------------------------ *
 * /consensus_params — block-level caps. block.max_bytes is the only
 * authoritative upper bound on a single tx's wire size that we can read
 * over RPC (the per-tx mempool cap lives in each node's config.toml and
 * is not exposed over any RPC).
 * ------------------------------------------------------------------ */

export interface ConsensusParamsResponse {
    block_height: string;
    consensus_params: {
        block: { max_bytes: string; max_gas: string };
        evidence: { max_age_num_blocks: string; max_age_duration: string };
        validator: { pub_key_types: string[] };
        version: { app: string };
    };
}

export async function consensusParams(
    seiRpcEndpoint: string,
): Promise<ConsensusParamsResponse> {
    // Some Sei front-end RPCs (e.g. the public arctic endpoint) flatten
    // the JSON-RPC envelope and return the consensus_params object at the
    // top level instead of under `.result`. Accept both shapes.
    const url = `${seiRpcEndpoint.replace(/\/$/, '')}/consensus_params`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(
            `tendermint rpc /consensus_params failed: ${res.status} ${res.statusText}`,
        );
    }
    const body = (await res.json()) as
        | { result: ConsensusParamsResponse }
        | ConsensusParamsResponse;
    if ('result' in body && body.result) {
        return body.result;
    }
    if ('consensus_params' in body) {
        return body as ConsensusParamsResponse;
    }
    throw new Error(
        `tendermint rpc /consensus_params unrecognized shape: ${JSON.stringify(body)}`,
    );
}

/** The consensus-enforced block size cap. A tx larger than this can never be included. */
export async function blockMaxBytes(seiRpcEndpoint: string): Promise<number> {
    const p = await consensusParams(seiRpcEndpoint);
    return Number(p.consensus_params.block.max_bytes);
}

/** The consensus-enforced block gas cap. A tx with gasLimit > this can never be included. */
export async function blockMaxGas(seiRpcEndpoint: string): Promise<bigint> {
    const p = await consensusParams(seiRpcEndpoint);
    return BigInt(p.consensus_params.block.max_gas);
}
