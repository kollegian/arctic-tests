import { ethers } from 'ethers';

export async function sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

/** Wait until predicate() returns truthy or timeoutMs elapses. */
export async function waitUntil<T>(
    predicate: () => Promise<T | false | null | undefined>,
    timeoutMs = 30_000,
    intervalMs = 500,
    label = 'condition',
): Promise<T> {
    const start = Date.now();
    let last: T | false | null | undefined = false;
    while (Date.now() - start < timeoutMs) {
        last = await predicate();
        if (last) return last as T;
        await sleep(intervalMs);
    }
    throw new Error(`waitUntil("${label}") timed out after ${timeoutMs}ms`);
}

/** Wait until the chain advances by `n` blocks from the current head. */
export async function waitBlocks(
    provider: ethers.JsonRpcProvider,
    n: number,
    timeoutMs = 120_000,
): Promise<void> {
    const start = await provider.getBlockNumber();
    await waitUntil(
        async () => (await provider.getBlockNumber()) - start >= n,
        timeoutMs,
        500,
        `chain to advance ${n} blocks`,
    );
}

/** Wait until a tx hash is no longer reported as pending. Returns receipt or null. */
export async function waitForMined(
    provider: ethers.JsonRpcProvider,
    txHash: string,
    timeoutMs = 60_000,
): Promise<ethers.TransactionReceipt | null> {
    return waitUntil(
        async () => {
            const receipt = await provider.getTransactionReceipt(txHash);
            return receipt ?? false;
        },
        timeoutMs,
        500,
        `tx ${txHash} to be mined`,
    );
}
