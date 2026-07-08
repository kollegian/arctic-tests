import { expect } from "chai";
import { ethers } from "ethers";

// Every spec in this suite reuses the shared ERC20 contract, so a getLogs
// window can contain Transfers from concurrently running tests. Count and
// shape assertions must therefore be scoped to the logs a test submitted
// itself, matched by transactionHash (case-insensitive: RPC hex casing is
// not guaranteed to match locally computed hashes).
export function filterLogsByTxHash(logs: any[], txHashes: string[]): any[] {
    const wanted = new Set(txHashes.map((hash) => hash.toLowerCase()));
    return logs.filter((log) => wanted.has(log.transactionHash.toLowerCase()));
}

// logIndex is positional across ALL logs in a block regardless of emitting
// contract, so it can only be asserted on the unfiltered block view: an
// address/topic filter (or a foreign tx sharing the block) hides logs and
// leaves visible indexes non-contiguous. For each block containing one of
// ownLogs, fetches that block's logs with no filter through the endpoint
// under test and asserts the indexes are exactly 0..n-1, with every own log
// present at its reported index. Assumes the node returns a block's logs
// un-truncated (block gas bounds logs-per-block far below any response cap).
export async function expectContiguousBlockLogIndexes(
    fetchBlockLogs: (filter: { fromBlock: string; toBlock: string }) => Promise<any[]>,
    ownLogs: any[],
): Promise<void> {
    const blockNumbers = new Set(ownLogs.map((log) => Number(log.blockNumber)));
    for (const blockNumber of blockNumbers) {
        const blockTag = ethers.toQuantity(blockNumber);
        const blockLogs = await fetchBlockLogs({ fromBlock: blockTag, toBlock: blockTag });
        const indexes = blockLogs.map((log) => Number(log.logIndex)).sort((a, b) => a - b);
        expect(indexes, `block ${blockNumber} logIndexes are not contiguous from 0`)
            .to.deep.eq(indexes.map((_, i) => i));
        for (const own of ownLogs.filter((log) => Number(log.blockNumber) === blockNumber)) {
            const match = blockLogs.find((log) =>
                log.transactionHash.toLowerCase() === own.transactionHash.toLowerCase()
                && Number(log.logIndex) === Number(own.logIndex));
            expect(match, `own log ${own.transactionHash} logIndex=${own.logIndex} missing from unfiltered block ${blockNumber}`)
                .to.not.be.undefined;
        }
    }
}
