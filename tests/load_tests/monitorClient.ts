import { EvmRpcClient } from "../../shared/RpcClient";
import { SigningStargateClient } from "@cosmjs/stargate";
import { waitFor } from "../../shared/utils/helpers";
import { CONFIG } from "./config";

export interface LatencyEntry {
    chain: "evm" | "cosmos";
    txHash: string;
    txBroadcastLatency: number;
    blockInclusionLatency: number;
    blockNumber: number;
    gasUsed?: bigint;
}

export interface BlockStats {
    blockNumber: number;
    txCount: number;
    gasUsed?: bigint;
}

export class MonitorClient {
    readonly queue: LatencyEntry[] = [];
    readonly blockStats: BlockStats[] = [];

    constructor(
        private readonly evm   : EvmRpcClient,
        private readonly cosmos: SigningStargateClient
    ) {}

    private async pushBlockStatsEvm(blockNumber: number) {
        if (this.blockStats.some(b => b.blockNumber === blockNumber)) return;
        const block = await this.evm.getBlockByNumber(blockNumber.toString());
        this.blockStats.push({
            blockNumber,
            txCount: block.transactions.length,
            gasUsed: BigInt(block.gasUsed.toString())
        });
    }

    private async pushBlockStatsCosmos(height: number) {
        if (this.blockStats.some(b => b.blockNumber === height)) return;
        const block = await this.cosmos.getBlock(height);
        this.blockStats.push({
            blockNumber: height,
            txCount: block.txs.length
        });
    }

    async waitEvm(
        txHash: string,
        ackTime: number,
        txBroadcastLatency: number
    ) {
        let totalTried = 0;
        let isFound = false;
        while (totalTried < 5000) {
            const receipt = await this.evm.getTransactionReceipt(txHash);
            if (receipt) {
                console.log('Tx Hash: ', txHash);
                this.queue.push({
                    chain: "evm",                      // ← add
                    txHash,
                    txBroadcastLatency,
                    blockInclusionLatency: Date.now() - ackTime,
                    blockNumber: receipt.blockNumber,
                    gasUsed: BigInt(receipt.gasUsed.toString())
                });
                isFound = true;
                break;
            }
            totalTried++;
            await waitFor(CONFIG.POLL_INTERVAL_MS / 1000);
        }
        if (!isFound){
            console.log('Tx Hash: ', txHash, 'isnt found');
            throw new Error('Tx not found');
        }
    }

    async waitCosmos(
        txHash: string,
        ackTime: number,
        txBroadcastLatency: number
    ) {
        while (true) {
            const tx = await this.cosmos.getTx(txHash);
            if (tx && Number(tx.height) > 0) {
                this.queue.push({
                    chain: 'cosmos',
                    txHash,
                    txBroadcastLatency,
                    blockInclusionLatency: Date.now() - ackTime,
                    blockNumber: Number(tx.height),
                });
                break;
            }
            await waitFor(CONFIG.POLL_INTERVAL_MS / 1000);
        }
    }
}
