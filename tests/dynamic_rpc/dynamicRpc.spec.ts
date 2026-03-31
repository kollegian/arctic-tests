import {SeiUser, UserFactory} from "../../shared/User";
import {EvmRpcClient} from "../../shared/RpcClient";
import * as TestConfig from "../../config/testConfig.json";
import {Block, ContractTransactionReceipt, ethers, Log, LogDescription, Transaction, TransactionReceipt} from "ethers";
import {expect} from "chai";
import {waitFor} from "../../shared/utils/helpers";
import _ from "lodash";

describe('Dynamic RPC queries', function () {

    this.timeout(10 * 60 * 1000);
    let admin: SeiUser;
    let rpcClient: EvmRpcClient;
    let blockNumber: string;

    before('Initializes clients', async () => {
        admin = await UserFactory.createAdminUser();
        rpcClient = new EvmRpcClient(TestConfig.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    let currentBlock: Block;
    it('Gets current block', async () => {
        currentBlock = await rpcClient.getBlockByNumber('latest', false);
        blockNumber = ethers.toQuantity(Number(currentBlock.number) - 10);
        let blockData = await rpcClient.getBlockByNumber(blockNumber, false);
        while (blockData.transactions.length < 6) {
            blockNumber = ethers.toQuantity(Number(blockNumber) - 1);
            blockData = await rpcClient.getBlockByNumber(blockNumber, false);
        }
        console.log('Selected block is ', blockNumber);
    });

    let txInfoFromGetBlockCall = new Map<string, ContractTransactionReceipt>();
    it('Visits block and stores txs', async () => {
        currentBlock = await rpcClient.getBlockByNumber(blockNumber, true);
        txInfoFromGetBlockCall = storeBlockTransactions(currentBlock);
    });

    it('Visits block by hash and stores txs', async () => {
        const blockDataFromHash = await rpcClient.getBlockByHash(currentBlock.hash as string, true);
        expect(_.isEqual(blockDataFromHash, currentBlock)).to.be.true;
    });

    it('Block txs match with eth_getTransactionByHash returns', async () => {
        const txInfoFromSingleHashCall = await getTxsByHash(Array.from(txInfoFromGetBlockCall.values()), rpcClient);
        for (const txHash of txInfoFromGetBlockCall.keys()) {
            const txFromBlock = txInfoFromGetBlockCall.get(txHash) as TransactionReceipt;
            const txFromReceipt = txInfoFromSingleHashCall.get(txHash) as Transaction;

            expect(txFromBlock.blockHash).to.be.eq(txFromReceipt.blockHash, 'block hash didnt match');
            expect(txFromBlock.blockNumber).to.be.eq(txFromReceipt.blockNumber, 'block number didnt match');
            expect(txFromBlock.from).to.be.eq(txFromReceipt.from, 'tx sent from didnt match');
            expect(Number(txFromBlock.gas)).to.be.eq(Number(txFromReceipt.gas), 'used gas didnt match');
            expect(Number(txFromBlock.gasPrice)).to.be.eq(Number(txFromReceipt.gasPrice), 'used gas didnt match');
            expect(Number(txFromBlock.nonce)).to.be.eq(Number(txFromReceipt.nonce), 'nonce gas didnt match');

            expect(txFromBlock.to).to.be.eq(txFromReceipt.to, 'to didnt match');
            expect(txFromBlock.transactionIndex).to.be.eq(txFromReceipt.transactionIndex, 'tx index didnt match');
            expect(txFromBlock.type).to.be.eq(txFromReceipt.type, 'type didnt match');
            expect(txFromBlock.value).to.be.eq(txFromReceipt.value, 'type didnt match');
            expect(txFromBlock.chainId).to.be.eq(txFromReceipt.chainId, 'type didnt match');
            expect(txFromBlock.v).to.be.eq(txFromReceipt.v, 'v didnt match');
            expect(txFromBlock.r).to.be.eq(txFromReceipt.r, 'r didnt match');
            expect(txFromBlock.c).to.be.eq(txFromReceipt.c, 'c didnt match');
        }
    })

    let txInfoFromSingleReceipt = new Map<string, ContractTransactionReceipt>();
    it('Block transactions should match with eth get transaction receipt', async () => {
        txInfoFromSingleReceipt = await getTxReceipts(Array.from(txInfoFromGetBlockCall.values()), rpcClient);
        expect(txInfoFromGetBlockCall.size).to.be.eq(txInfoFromSingleReceipt.size);

        for (const txHash of txInfoFromGetBlockCall.keys()) {
            const txFromBlock = txInfoFromGetBlockCall.get(txHash) as ContractTransactionReceipt;
            const txFromReceipt = txInfoFromSingleReceipt.get(txHash) as ContractTransactionReceipt;

            expect(txFromBlock.blockHash).to.be.eq(txFromReceipt.blockHash, 'block hash didnt match');
            expect(txFromBlock.blockNumber).to.be.eq(txFromReceipt.blockNumber, 'block number didnt match');
            expect(txFromBlock.from).to.be.eq(txFromReceipt.from, 'tx sent from didnt match');
            expect(Number(txFromBlock.gas)).to.be.gte(Number(txFromReceipt.gasUsed), 'used gas didnt match');
            expect(txFromBlock.to).to.be.eq(txFromReceipt.to, 'to didnt match');
            expect(txFromBlock.transactionIndex).to.be.eq(txFromReceipt.transactionIndex, 'tx hash didnt match');
            expect(txFromBlock.type).to.be.eq(txFromReceipt.type, 'type didnt match');
            expect(txFromBlock.gasPrice).to.be.eq(txFromReceipt.effectiveGasPrice, 'gas price didnt match');
        }
    });

    let txInfoFromGetReceipts = new Map<string, TransactionReceipt>();
    it('Block transactions should match with eth get block receipts', async () => {
        const blockReceipts = await rpcClient.getBlockReceipts(blockNumber);
        txInfoFromGetReceipts = storeBlockReceiptTxs(blockReceipts);
        expect(txInfoFromGetBlockCall.size).to.be.eq(txInfoFromGetReceipts.size);

        for (const txHash of txInfoFromGetBlockCall.keys()) {
            const txFromBlock = txInfoFromGetBlockCall.get(txHash) as ContractTransactionReceipt;
            const txFromReceipt = txInfoFromGetReceipts.get(txHash) as ContractTransactionReceipt;

            expect(txFromBlock.blockHash).to.be.eq(txFromReceipt.blockHash, 'block hash didnt match');
            expect(txFromBlock.blockNumber).to.be.eq(txFromReceipt.blockNumber, 'block number didnt match');
            expect(txFromBlock.from).to.be.eq(txFromReceipt.from, 'tx sent from didnt match');
            expect(txFromBlock.to).to.be.eq(txFromReceipt.to, 'to didnt match');
            expect(txFromBlock.transactionIndex).to.be.eq(txFromReceipt.transactionIndex, 'tx indexes didnt match');
            expect(txFromBlock.type).to.be.eq(txFromReceipt.type, 'type didnt match');
            expect(Number(txFromBlock.gas)).to.be.gt(Number(txFromReceipt.gasUsed), 'used gas didnt match');
            console.log('txFromBlock.gasPrice', txFromBlock.gasPrice, 'txFromReceipt.effectiveGasPrice', txFromReceipt.effectiveGasPrice);
            expect(txFromBlock.gasPrice).to.eq(txFromReceipt.effectiveGasPrice, 'gas price didnt match');
        }
    });

    it('Individual txs should match with block receipts call', async () => {
        expect(txInfoFromSingleReceipt.size).to.be.eq(txInfoFromGetReceipts.size);
        for (const txHash of txInfoFromGetReceipts.keys()) {
            const individualreceipt = txInfoFromSingleReceipt.get(txHash) as TransactionReceipt;
            const receiptFromBlock = txInfoFromGetReceipts.get(txHash) as TransactionReceipt;

            expect(individualreceipt.blockHash).to.be.eq(receiptFromBlock.blockHash, 'block hash didnt match');
            expect(individualreceipt.blockNumber).to.be.eq(receiptFromBlock.blockNumber, 'block number didnt match');
            expect(individualreceipt.from).to.be.eq(receiptFromBlock.from, 'tx sent from didnt match');
            expect(individualreceipt.status).to.be.eq(receiptFromBlock.status, 'status didnt match');
            expect(individualreceipt.to).to.be.eq(receiptFromBlock.to, 'to didnt match');
            expect(individualreceipt.transactionIndex).to.be.eq(receiptFromBlock.transactionIndex, 'tx hash didnt match');
            expect(individualreceipt.type).to.be.eq(receiptFromBlock.type, 'type didnt match');
            expect(individualreceipt.gasUsed).to.be.eq(receiptFromBlock.gasUsed, 'used gas didnt match');
            expect(individualreceipt.cumulativeGasUsed).to.be.eq(receiptFromBlock.cumulativeGasUsed, 'effective gas used didnt match');
            expect(individualreceipt.effectiveGasPrice).to.be.eq(receiptFromBlock.effectiveGasPrice, 'effective gas price didnt match');
            expect(individualreceipt.contractAddress).to.be.eq(receiptFromBlock.contractAddress, 'Contract addresses didnt match');
            expect(individualreceipt.logs.length).to.be.eq(receiptFromBlock.logs.length, 'logs length didnt match');
            expect(individualreceipt.logsBloom).to.be.eq(receiptFromBlock.logsBloom, 'logs bloom didnt match');

            //Validate returned logs
            for (const log of individualreceipt.logs) {
                const blockLog = receiptFromBlock.logs.find(l => l.logIndex === log.logIndex) as Log;
                expect(blockLog.address).to.be.eq(log.address, 'address didnt match');
                expect(blockLog.data).to.be.eq(log.data, 'data didnt match');
                expect(blockLog.blockHash).to.be.eq(log.blockHash, 'block hash didnt match');
                expect(blockLog.blockNumber).to.be.eq(log.blockNumber, 'block number didnt match');
                expect(blockLog.transactionHash).to.be.eq(log.transactionHash, 'tx hash didnt match');
                expect(blockLog.transactionIndex).to.be.eq(log.transactionIndex, 'tx index didnt match');
                expect(blockLog.topics.join(',')).to.be.eq(log.topics.join(','), 'topics didnt match');
            }
        }
    });

    it('Block-level debug trace matches per-tx traces', async () => {
        await waitFor(1);
        const tracerOpts = {tracer: 'callTracer'};
        const blockTraces = await rpcClient.debugTraceByBlockNumber(blockNumber, tracerOpts);
        const fullBlock = await rpcClient.getBlockByNumber(blockNumber, true);
        const txHashes = blockTraces.map((tx: any) => tx.txHash);
        const fullBlockTxHash = (fullBlock.transactions as ContractTransactionReceipt[])
            .map(tx => tx.hash);
        expect(blockTraces).to.have.length(fullBlockTxHash.length);

        // Validate debug fields from different rpc endpoints
        const debugTraceConfig = {
            tracer: 'callTracer',
            tracerConfig: {
                convertParityErrors: true
            }

        }
        for (const tx of txHashes) {
            const blockTxInfo = txInfoFromGetBlockCall.get(tx);
            const singleTxInfo = txInfoFromSingleReceipt.get(tx);
            const receiptTxInfo = txInfoFromGetReceipts.get(tx);
            const traceResult = blockTraces.find(txInf => tx === txInf.txHash);
            expect(traceResult.result.from).to.be.eq(blockTxInfo.from, 'from didnt match');
            expect(traceResult.result.from).to.be.eq(singleTxInfo.from, 'from didnt match');
            expect(traceResult.result.from).to.be.eq(receiptTxInfo.from, 'from didnt match');

            expect(traceResult.result.to).to.be.eq(blockTxInfo.to, 'to didnt match');
            expect(traceResult.result.to).to.be.eq(singleTxInfo.to, 'to didnt match');
            expect(traceResult.result.to).to.be.eq(receiptTxInfo.to, 'to didnt match');

            expect(traceResult.result.gas).to.be.eq(blockTxInfo.gas, 'gas didnt match');
            expect(traceResult.result.gasUsed).to.be.eq(singleTxInfo.gasUsed, 'gas used didnt match');
            expect(traceResult.result.gasUsed).to.be.eq(receiptTxInfo.gasUsed, 'gas used didnt match');

            expect(traceResult.result.input).to.be.eq(blockTxInfo.input, 'input didnt match');
            expect(traceResult.result.value).to.be.eq(blockTxInfo.value, 'value didnt match');
        }

        for (let i = 0; i < txHashes.length; i++) {
            const hash = txHashes[i];
            const singleTrace = await rpcClient.debugTraceTransaction(hash, debugTraceConfig);
            expect(blockTraces[i].result).to.deep.equal(singleTrace, `trace mismatch for tx ${hash}`);
        }
    });

    it('Replays each internal call via eth_call and matches trace.returnValue', async () => {
        for (const tx of txInfoFromGetBlockCall.values()) {
            if (!tx.input || tx.input === '0x') continue;

            const trace = await rpcClient.debugTraceTransaction(tx.hash, {tracer: 'callTracer'});
            const expected = (trace as any).returnValue as string;

            // 2) do the same call via eth_call at that block
            const callObj = {
                to: tx.to,
                data: tx.input,
                from: tx.from,
                value: tx.value,
            };

            const actual = await rpcClient.callTx(callObj, ethers.toQuantity(Number(tx.blockNumber) - 1));
            console.log(actual);
            // expect(_.isEqual(actual, expected)).to.true;
        }
    });

    it('Dynamically checks gas estimates and log reproduction for each tx', async () => {
        for (const tx of txInfoFromGetBlockCall.keys()) {
            const receipt = txInfoFromGetReceipts.get(tx)!;
            for (const log of receipt.logs) {
                const filter = {
                    fromBlock: blockNumber,
                    toBlock: blockNumber,
                    address: log.address,
                    topics: log.topics,
                };
                const logs = await rpcClient.getLogs(filter) as Log[];
                console.log(logs.length);
                const found = logs.find(l => l.data === log.data && l.address === log.address);
                expect(found, `log ${log.logIndex} missing for tx ${tx}`).to.deep.include({
                    address: log.address,
                    data: log.data,
                    topics: log.topics,
                });
                expect(found.transactionIndex).to.be.eq(receipt.transactionIndex, `log ${log.logIndex} has wrong tx index for tx ${tx}`);
                expect(found.blockNumber).to.be.eq(receipt.blockNumber, `log ${log.logIndex} has wrong block number for tx ${tx}`);
                expect(found.blockHash).to.be.eq(receipt.blockHash, `log ${log.logIndex} has wrong block hash for tx ${tx}`);
                expect(found.transactionHash).to.be.eq(receipt.transactionHash, `log ${log.logIndex} has wrong tx hash for tx ${tx}`);
            }
        }
    });

    it.skip('Block cumulative gas used is correct with each receipt', async () => {
        const totalUsed = Array.from(txInfoFromGetReceipts.values())
            .reduce((acc, tx) => acc + Number(tx.gasUsed), 0);
        const individualUsed = Array.from(txInfoFromSingleReceipt.values())
            .reduce((acc, tx) => acc + Number(tx.gasUsed), 0);

        expect(totalUsed).to.be.eq(Number(currentBlock.gasUsed));
        expect(totalUsed).to.be.eq(Number(individualUsed));
    });

    it('Eth get logs return correct info as eth get tx receipt', async () => {
        for (const txHash of Array.from(txInfoFromSingleReceipt.keys())) {
            const txReceipt = txInfoFromSingleReceipt.get(txHash) as TransactionReceipt;
            const logs = await rpcClient.getLogs({
                fromBlock: blockNumber,
                toBlock: blockNumber,
                // address: txReceipt.to,
            }) as Log[];
            for (const log of txReceipt.logs) {
                const expectedLog = logs.find(l => l.logIndex === log.logIndex);
                expect(expectedLog).to.not.be.undefined;
                expect(expectedLog?.blockHash).to.be.eq(txReceipt.blockHash);
                expect(expectedLog?.blockNumber).to.be.eq(txReceipt.blockNumber);
                expect(expectedLog?.transactionHash).to.be.eq(txReceipt.transactionHash);
                expect(expectedLog?.transactionIndex).to.be.eq(txReceipt.transactionIndex);

                // validate log data now
                expect(expectedLog?.data).to.be.eq(log.data);
                expect(expectedLog?.topics).to.be.deep.eq(log.topics);
                expect(expectedLog?.logIndex).to.be.eq(log.logIndex);
                expect(expectedLog?.transactionIndex).to.be.eq(log.transactionIndex);
                expect(expectedLog?.transactionHash).to.be.eq(log.transactionHash);
                expect(expectedLog?.blockHash).to.be.eq(log.blockHash);
                expect(expectedLog?.blockNumber).to.be.eq(log.blockNumber);
                expect(expectedLog?.address).to.be.eq(log.address);
                expect(expectedLog?.removed).to.be.eq(log.removed);
            }
            console.log('Checked tx hash ', txReceipt.transactionHash);
        }
    });

    it('Eth get logs return correct info as eth get block receipts', async () => {
        for (const txHash of Array.from(txInfoFromGetReceipts.keys())) {
            const txReceipt = txInfoFromGetReceipts.get(txHash) as TransactionReceipt;
            const logs = await rpcClient.getLogs({
                fromBlock: blockNumber,
                toBlock: blockNumber,
                // address: txReceipt.to,
            }) as Log[];
            for (const log of txReceipt.logs) {
                const expectedLog = logs.find(l => l.logIndex === log.logIndex);
                expect(expectedLog).to.not.be.undefined;
                expect(expectedLog?.blockHash).to.be.eq(txReceipt.blockHash);
                expect(expectedLog?.blockNumber).to.be.eq(txReceipt.blockNumber);
                expect(expectedLog?.transactionHash).to.be.eq(txReceipt.transactionHash);
                expect(expectedLog?.transactionIndex).to.be.eq(txReceipt.transactionIndex);
                expect(expectedLog?.address).to.be.eq(log.address);

                // validate log data now
                expect(expectedLog?.data).to.be.eq(log.data);
                expect(expectedLog?.topics).to.be.deep.eq(log.topics);
                expect(expectedLog?.logIndex).to.be.eq(log.logIndex);
                expect(expectedLog?.transactionIndex).to.be.eq(log.transactionIndex);
                expect(expectedLog?.transactionHash).to.be.eq(log.transactionHash);
                expect(expectedLog?.blockHash).to.be.eq(log.blockHash);
                expect(expectedLog?.blockNumber).to.be.eq(log.blockNumber);
                expect(expectedLog?.address).to.be.eq(log.address);
                expect(expectedLog?.removed).to.be.eq(log.removed);
            }
            console.log('Checked tx hash ', txReceipt.transactionHash);
        }
    });

    it('Eth get tx by hash and index returns correct index', async () =>{
        for (const txHash of Array.from(txInfoFromGetReceipts.keys())) {
            const txReceipt = txInfoFromGetReceipts.get(txHash) as TransactionReceipt;
            const txData = await rpcClient.getTransactionByBlockHashAndIndex(txReceipt.blockHash, Number(txReceipt.transactionIndex)) as Transaction;
            expect(txData.hash).to.be.eq(txReceipt.transactionHash);
            expect(txData.blockHash).to.be.eq(txReceipt.blockHash);
            expect(txData.blockNumber).to.be.eq(txReceipt.blockNumber);
            expect(txData.transactionIndex).to.be.eq(txReceipt.transactionIndex);
        }
    });
});

function storeBlockTransactions(blockInfo: Block) {
    const txInfoMap = new Map<string, ContractTransactionReceipt>();
    const txs = blockInfo.transactions as unknown as ContractTransactionReceipt[];
    for (const tx of txs) {
        txInfoMap.set(tx.hash, tx);
    }
    return txInfoMap;
}

function storeBlockReceiptTxs(txInfos: TransactionReceipt[]) {
    const txInfoMap = new Map<string, TransactionReceipt>();
    for (const tx of txInfos) {
        txInfoMap.set(tx.transactionHash, tx);
    }
    return txInfoMap;
}

async function getTxsByHash(txs: ContractTransactionReceipt[], rpcClient: EvmRpcClient) {
    const txInfo = new Map<string, Transaction>();
    for (const tx of txs) {
        const receipt = await rpcClient.getTransactionByHash(tx.hash) as Transaction;
        txInfo.set(tx.hash, receipt);
    }
    return txInfo;
}

async function getTxReceipts(txs: ContractTransactionReceipt[], rpcClient: EvmRpcClient) {
    const txInfo = new Map<string, ContractTransactionReceipt>();
    for (const tx of txs) {
        const receipt = await rpcClient.getTransactionReceipt(tx.hash) as ContractTransactionReceipt;
        txInfo.set(tx.hash, receipt);
    }
    return txInfo;
}

async function verifyUsedGas(txInfo: Map<string, ContractTransactionReceipt>) {
    let totalGasUsed = 0;
    txInfo.forEach((receipt, tx) => {
        totalGasUsed += Number(receipt.gasUsed);
    })
    return totalGasUsed;
}

async function compareEthReceipts(txs: ContractTransactionReceipt[], rpcClient: EvmRpcClient, blockNumber: string) {
    const blockReceipts = await rpcClient.getBlockReceipts(blockNumber);
    const maps = getAllIndexes(txs);
    console.log(maps);
    const maps2 = getAllIndexes(blockReceipts);
    console.log(maps2);
}

function getAllIndexes(txs: ContractTransactionReceipt[]) {
    return txs.map((tx) => Number(tx.transactionIndex));
}


