import { ethers } from "ethers";

/** Filter a receipt's logs down to those emitted by the gov precompile address. */
export const govLogsOf = (receipt: any, govAddress: string) =>
    receipt.logs.filter((l: any) => l.address.toLowerCase() === govAddress.toLowerCase());

/**
 * Poll for a tx receipt with a hard time bound instead of `tx.wait()`.
 *
 * On this endpoint, a tx from an unfunded/unassociated account can be *admitted*
 * to the mempool (RPC trusts the EVM "fiction balance") yet never mine, because
 * the consensus-layer ante check rejects it on real funds. `tx.wait()` then hangs
 * forever. This returns `null` when no receipt lands within `timeoutMs` so callers
 * can treat "wedged / never mined" as a fast, explicit outcome.
 */
export async function waitForReceiptBounded(
    provider: ethers.Provider,
    txHash: string,
    timeoutMs = 30000,
    pollMs = 2000
): Promise<ethers.TransactionReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
        if (receipt) return receipt;
        await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
}
