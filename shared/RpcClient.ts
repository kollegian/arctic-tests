import {ExecuteResult} from "@cosmjs/cosmwasm-stargate";
import {ContractTransactionReceipt, ethers, JsonRpcProvider} from "ethers";
import {DeliverTxResponse, logs} from "@cosmjs/stargate";

/**
 * Lightweight JSON-RPC client for EVM-compatible chains.
 * Allows direct calls to an HTTP JSON-RPC endpoint without ethers.js.
 */
export class EvmRpcClient {
    private url: string;
    private idCounter = 1;
    private provider: ethers.JsonRpcProvider;

    constructor(url: string, provider: JsonRpcProvider) {
        this.url = url;
        this.provider = provider;
    }

    private async call(method: string, params: any[] = []): Promise<any> {
        const payload = {jsonrpc: '2.0', id: this.idCounter, method, params};
        const url = this.url;
        const options = {
            method: 'POST' as const,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload),
        };
        const curlCommand = `curl -X POST '${url}' \
            -H 'Content-Type: application/json' \
            -d '${JSON.stringify(payload, null, 2)}'`;

        const resp = await fetch(url, options);
        if (!resp.ok) throw new Error(`RPC HTTP error: ${resp.status} ${resp.statusText}`);
        const json = await resp.json();
        if (json.error) throw new Error(`RPC error: ${json.error.code} ${json.error.message}`);
        return json.result;
    }

    // web3 namespace
    async web3ClientVersion(): Promise<string> {
        return this.call('web3_clientVersion');
    }

    async web3Sha3(data: string): Promise<string> {
        return this.call('web3_sha3', [data]);
    }

    // net namespace
    async netVersion(): Promise<string> {
        return this.call('net_version');
    }

    async netListening(): Promise<boolean> {
        return this.call('net_listening');
    }

    async netPeerCount(): Promise<number> {
        const hex = await this.call('net_peerCount');
        return parseInt(hex, 16);
    }

    // eth namespace
    async chainId(): Promise<number> {
        const hex = await this.call('eth_chainId');
        return parseInt(hex, 16);
    }

    async getBlockNumber(): Promise<number> {
        const hex = await this.call('eth_blockNumber');
        return parseInt(hex, 16);
    }

    async getBalance(address: string, blockTag: string = 'latest'): Promise<bigint> {
        const hex = await this.call('eth_getBalance', [address, blockTag]);
        return BigInt(hex);
    }

    async getTransactionCount(address: string, blockTag: string = 'latest'): Promise<number> {
        const hex = await this.call('eth_getTransactionCount', [address, blockTag]);
        return parseInt(hex, 16);
    }

    async getCode(address: string, blockTag: string = 'latest'): Promise<string> {
        return this.call('eth_getCode', [address, blockTag]);
    }

    async getStorageAt(address: string, position: string, blockTag: string = 'latest'): Promise<string> {
        return this.call('eth_getStorageAt', [address, position, blockTag]);
    }

    async gasPrice(): Promise<bigint> {
        const hex = await this.call('eth_gasPrice');
        return BigInt(hex);
    }

    async estimateGas(tx: Record<string, any>): Promise<number> {
        const hex = await this.call('eth_estimateGas', [tx]);
        return parseInt(hex, 16);
    }

    async callTx(tx: Record<string, any>, blockTag: string = 'latest'): Promise<string> {
        return this.call('eth_call', [tx, blockTag]);
    }

    async sendRawTransaction(signedTx: string): Promise<string> {
        return this.call('eth_sendRawTransaction', [signedTx]);
    }

    async getTransactionReceipt(txHash: string): Promise<any> {
        return this.call('eth_getTransactionReceipt', [txHash]);
    }

    async getTransactionByHash(txHash: string): Promise<any> {
        return this.call('eth_getTransactionByHash', [txHash]);
    }

    async getTransactionByBlockHashAndIndex(blockHash: string, index: number): Promise<any> {
        const hexIndex = '0x' + index.toString(16);
        return this.call('eth_getTransactionByBlockHashAndIndex', [blockHash, hexIndex]);
    }

    async getTransactionByBlockNumberAndIndex(blockTag: string, index: number): Promise<any> {
        const hexIndex = '0x' + index.toString(16);
        return this.call('eth_getTransactionByBlockNumberAndIndex', [blockTag, hexIndex]);
    }

    async getBlockByHash(blockHash: string, fullTx: boolean = false): Promise<any> {
        return this.call('eth_getBlockByHash', [blockHash, fullTx]);
    }

    async getBlockByNumber(blockTag: string, fullTx: boolean = false): Promise<any> {
        return this.call('eth_getBlockByNumber', [blockTag, fullTx]);
    }

    async getLogs(filter: {
        fromBlock?: string;
        toBlock?: string;
        address?: string | string[];
        topics?: any[];
    }): Promise<any[]> {
        return this.call('eth_getLogs', [filter]);
    }


    // sei namespace
    async sei_getFilterLogs(filter: string): Promise<any[]> {
        return this.call('sei_getFilterLogs', [filter]);
    }

    async sei_getLogs(filter: {
        fromBlock?: string;
        toBlock?: string;
        address?: string | string[];
        topics?: any[];
    }): Promise<any[]> {
        return this.call('sei_getLogs', [filter]);
    }

    async sei_getBlockByNumber(
        blockTag: string,
        fullTx: boolean = false
    ): Promise<any> {
        return this.call('sei_getBlockByNumber', [blockTag, fullTx]);
    }

    async sei_getBlockByHash(
        blockHash: string,
        fullTx: boolean = false
    ): Promise<any> {
        return this.call('sei_getBlockByHash', [blockHash, fullTx]);
    }

    /**
     * Trace transaction execution with debug_traceTransaction
     */
    async debugTraceTransaction(
        txHash: string,
        options: Record<string, any> = {}
    ): Promise<any> {
        return this.call('debug_traceTransaction', [txHash, options]);
    }

    /**
     * Trace a simulated call with debug_traceCall
     */
    async debugTraceCall(
        tx: Record<string, any>,
        blockTag: string = 'latest',
        options: Record<string, any> = {}
    ): Promise<any> {
        return this.call('debug_traceCall', [tx, blockTag, options]);
    }

    /**
     * Trace a raw signed transaction with debug_traceRawTransaction
     */
    async debugTraceRawTransaction(
        rawTx: string,
        options: Record<string, any> = {}
    ): Promise<any> {
        return this.call('debug_traceRawTransaction', [rawTx, options]);
    }

    /**
     * Query storage entries in range with debug_storageRangeAt
     */
    async debugStorageRangeAt(
        blockHashOrTag: string,
        txIndex: number | string,
        address: string,
        startKey: string,
        maxResults: number
    ): Promise<any> {
        const idx = typeof txIndex === 'number' ? '0x' + txIndex.toString(16) : txIndex;
        return this.call('debug_storageRangeAt', [blockHashOrTag, idx, address, startKey, maxResults]);
    }

    async debugTraceByBlockNumber(
        blockNumber: string,
        options: Record<string, any> = {}
    ) {
        return this.call('debug_traceBlockByNumber', [blockNumber, options]);
    }

    async getBlockReceipts(blockNumber: string) {
        return this.call('eth_getBlockReceipts', [blockNumber]);
    }

    formLogQuery(receipt: ExecuteResult | ContractTransactionReceipt | DeliverTxResponse, topic: string, address: string) {
        let logParams = {};
        if (this.isCosmosReceipt(receipt)) {
            receipt = receipt as ExecuteResult | DeliverTxResponse;
            if (address !== '') {
                logParams = {
                    fromBlock: ethers.toQuantity(Number(receipt.height) - 1),
                    toBlock: ethers.toQuantity(Number(receipt.height) + 1),
                    topics: [topic],
                    address: address
                };
            } else {
                logParams = {
                    fromBlock: ethers.toQuantity(Number(receipt.height) - 1),
                    toBlock: ethers.toQuantity(Number(receipt.height) + 1),
                    topics: [topic],
                };
            }
            return logParams;
        }
        receipt = receipt as ContractTransactionReceipt;
        logParams = {
            fromBlock: ethers.toQuantity(Number(receipt.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(receipt.blockNumber) + 1),
            topics: [topic]
        };
        return logParams;
    }

    async findHashFromReceipt(receipt: ExecuteResult | ContractTransactionReceipt | DeliverTxResponse) {
        if (this.isCosmosReceipt(receipt)) {
            receipt = receipt as ExecuteResult;
            return (await this.provider.getBlock(Number(receipt.height)))!.hash;
        }
        receipt = receipt as ContractTransactionReceipt;
        return receipt.blockHash;

    }

    async findHash(blockNumber: number) {
        return (await this.provider.getBlock(blockNumber))!.hash;
    }

    async findBlockNumber(receipt: ExecuteResult | ContractTransactionReceipt | DeliverTxResponse) {
        if (this.isCosmosReceipt(receipt)) {
            receipt = receipt as ExecuteResult;
            return receipt.height;
        }
        receipt = receipt as ContractTransactionReceipt;
        return receipt.blockNumber;
    }

    isCosmosReceipt(receipt: ExecuteResult | ContractTransactionReceipt | DeliverTxResponse) {
        return !('blobGasPrice' in receipt);
    }

    formLogQueryForBlock(startBlockNumber: number, endBlockNumber: number, topic: string, address = '') {
        let logParams;
        if (address !== '') {
            logParams = {
                fromBlock: ethers.toQuantity(startBlockNumber),
                toBlock: ethers.toQuantity(endBlockNumber),
                topics: [topic],
                address: address
            };
        } else {
            logParams = {
                fromBlock: ethers.toQuantity(startBlockNumber),
                toBlock: ethers.toQuantity(endBlockNumber),
                topics: [topic],
            };
        }
        return logParams;
    }

    async checkAndReturnRpcResultsForBlock(startBlockNumber: number, endBlockNumber: number, endpoint: string, contractAddress: string, topic: string) {
        if (endpoint.includes('FilterLogs')) {
            const logParams = this.formLogQueryForBlock(startBlockNumber, endBlockNumber, topic, contractAddress);
            let transferFilterId;
            if (endpoint.includes('sei')) {
                transferFilterId = await this.call('sei_newFilter', [logParams]);
            } else {
                transferFilterId = await this.call('eth_newFilter', [logParams]);
            }
            return await this.call(endpoint, [transferFilterId]);
        } else if (endpoint.includes('getLogs')) {
            const logParams = this.formLogQueryForBlock(startBlockNumber, endBlockNumber, topic, contractAddress);
            return await this.call(endpoint, [logParams]);
        } else if (endpoint.includes('Hash')) {
            const hash = await this.findHash(endBlockNumber);
            const result = await this.call(endpoint, [hash, true]);
            return result.transactions;
        } else {
            const result = await this.call(endpoint, [ethers.toQuantity(endBlockNumber), true]);
            return result.transactions;
        }
    }

    async sei_newFilter(filter: {}){
        return await this.call('sei_newFilter', [filter]);
    }

    async eth_newFilter(filter: {}){
        return await this.call('eth_newFilter', [filter]);
    }

    async eth_getFilterLogs(filterId: string){
        return await this.call('eth_getFilterLogs', [filterId]);
    }

    /**
     * eth_feeHistory: Returns a collection of historical gas information.
     * @param blockCount Number of blocks in the requested range.
     * @param newestBlock Highest block number. Can be 'latest' or a hex string.
     * @param rewardPercentiles (optional) Array of percentiles for rewards.
     */
    async feeHistory(blockCount: number, newestBlock: string | number = 'latest', rewardPercentiles?: number[]): Promise<any> {
        const params: any[] = [
            '0x' + blockCount.toString(16),
            typeof newestBlock === 'number' ? '0x' + newestBlock.toString(16) : newestBlock
        ];
        if (rewardPercentiles) params.push(rewardPercentiles);
        return this.call('eth_feeHistory', params);
    }

    async checkAndReturnRpcCallResults(syntheticEvent: string,
                                       receipt: ExecuteResult | ContractTransactionReceipt | DeliverTxResponse,
                                       topic: string,
                                       address = ''
    ) {
        if (syntheticEvent.includes('FilterLogs')) {
            const logParams = this.formLogQuery(receipt, topic, address);
            let transferFilterId;
            if (syntheticEvent.includes('sei')) {
                transferFilterId = await this.call('sei_newFilter', [logParams]);
            } else {
                transferFilterId = await this.call('eth_newFilter', [logParams]);
            }
            return await this.call(syntheticEvent, [transferFilterId]);
        } else if (syntheticEvent.includes('getLogs')) {
            const logParams = this.formLogQuery(receipt, topic, address);
            return await this.call(syntheticEvent, [logParams]);
        } else if (syntheticEvent.includes('Hash')) {
            const hash = await this.findHashFromReceipt(receipt);
            const result = await this.call(syntheticEvent, [hash, true]);
            return result.transactions;
        } else {
            const blockNumber = await this.findBlockNumber(receipt);
            const result = await this.call(syntheticEvent, [ethers.toQuantity(blockNumber), true]);
            return result.transactions;
        }
    }
}
