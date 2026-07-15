import { ethers } from 'ethers';

/**
 * Helpers around the EVM-side txpool_* RPC namespace.
 *
 * txpool_content returns:
 *   { pending: { [sender]: { [nonce]: tx } }, queued: { [sender]: { [nonce]: tx } } }
 *
 * "pending" is "ready to mine next" (gap-free nonce sequence).
 * "queued" is "future" (nonce gap blocking promotion).
 */
export interface TxpoolBucket {
    [sender: string]: { [nonceHex: string]: unknown };
}

export interface TxpoolContent {
    pending: TxpoolBucket;
    queued: TxpoolBucket;
}

export async function fetchTxpoolContent(
    provider: ethers.JsonRpcProvider,
): Promise<TxpoolContent> {
    const raw = (await provider.send('txpool_content', [])) as TxpoolContent;
    return { pending: raw.pending ?? {}, queued: raw.queued ?? {} };
}

export function findInBucket(
    bucket: TxpoolBucket,
    addr: string,
    nonce: number,
): unknown | undefined {
    const senderKey = Object.keys(bucket).find(
        (s) => s.toLowerCase() === addr.toLowerCase(),
    );
    if (!senderKey) return undefined;
    const nonceKey = Object.keys(bucket[senderKey]).find(
        (n) => Number(n) === nonce,
    );
    return nonceKey ? bucket[senderKey][nonceKey] : undefined;
}

/** True if a tx with (sender, nonce) currently sits in the pending bucket. */
export async function isPending(
    provider: ethers.JsonRpcProvider,
    sender: string,
    nonce: number,
): Promise<boolean> {
    const content = await fetchTxpoolContent(provider);
    return findInBucket(content.pending, sender, nonce) !== undefined;
}

/** True if a tx with (sender, nonce) currently sits in the queued bucket. */
export async function isQueued(
    provider: ethers.JsonRpcProvider,
    sender: string,
    nonce: number,
): Promise<boolean> {
    const content = await fetchTxpoolContent(provider);
    return findInBucket(content.queued, sender, nonce) !== undefined;
}

/** Number of txs currently in (pending + queued) for a given sender. */
export async function poolDepth(
    provider: ethers.JsonRpcProvider,
    sender: string,
): Promise<{ pending: number; queued: number }> {
    const content = await fetchTxpoolContent(provider);
    const pendingKey = Object.keys(content.pending).find(
        (s) => s.toLowerCase() === sender.toLowerCase(),
    );
    const queuedKey = Object.keys(content.queued).find(
        (s) => s.toLowerCase() === sender.toLowerCase(),
    );
    return {
        pending: pendingKey ? Object.keys(content.pending[pendingKey]).length : 0,
        queued: queuedKey ? Object.keys(content.queued[queuedKey]).length : 0,
    };
}

/** Poll until predicate(content) is true, or timeoutMs elapses. */
export async function waitForTxpool(
    provider: ethers.JsonRpcProvider,
    predicate: (c: TxpoolContent) => boolean,
    timeoutMs = 10_000,
    intervalMs = 250,
): Promise<TxpoolContent> {
    const start = Date.now();
    let last: TxpoolContent = { pending: {}, queued: {} };
    while (Date.now() - start < timeoutMs) {
        last = await fetchTxpoolContent(provider);
        if (predicate(last)) return last;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
        `waitForTxpool timed out after ${timeoutMs}ms; last content had ` +
            `pending=${Object.keys(last.pending).length} senders, ` +
            `queued=${Object.keys(last.queued).length} senders`,
    );
}
