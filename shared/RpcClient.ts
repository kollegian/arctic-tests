/**
 * Lightweight JSON-RPC client for EVM-compatible chains.
 * Allows direct calls to an HTTP JSON-RPC endpoint without ethers.js.
 */
export class EvmRpcClient {
    private url: string;
    private idCounter = 1;

    constructor(url: string) {
        this.url = url;
    }

    private async call(method: string, params: any[] = []): Promise<any> {
        const payload = { jsonrpc: '2.0', id: this.idCounter, method, params };

        const url     = this.url;
        const options = {
            method: 'POST' as const,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        };

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
    async sei_getFilterLogs(filter: {
        fromBlock?: string;
        toBlock?: string;
        address?: string | string[];
        topics?: any[];
    }): Promise<any[]> {
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
    ){
        return this.call('debug_traceBlockByNumber', [blockNumber, options]);
    }

    async getBlockReceipts(blockNumber: string) {
        return this.call('eth_getBlockReceipts', [blockNumber]);
    }
}
