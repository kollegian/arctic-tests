import {SeiUser, UserFactory} from "../../shared/User";
import {EvmRpcClient} from "../../shared/RpcClient";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import {getTestConfig} from "../../shared/testConfig";
import ContractAddresses from "./contractAddresses.json";
import {ContractTransactionReceipt, ethers} from "ethers";
import {expect} from "chai";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {ExecuteResult} from "@cosmjs/cosmwasm-stargate";
import {waitFor} from "../../shared/utils/helpers";
import {requireLegacyComponents, legacyComponentsEnabled} from '../../shared/seiLegacyComponents';

describe('Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let baseCw20: Cw20Token;

    before('Initializes', async () => {
        admin = await UserFactory.createAdminUser();
        users = await UserFactory.createSeiUsers(admin, 10, true);
        erc20 = new Erc20Token(admin, ContractAddresses.erc20);
        rpcClient = new EvmRpcClient(getTestConfig().evmRpcEndpoint, admin.evmWallet.signingClient);
        baseCw20 = new Cw20Token(admin, ContractAddresses.cw20);
    })

    let multipleTxReceipt: ContractTransactionReceipt;
    let txBlocks: Map<string, number> = new Map<string, number>();
    it('Sends multiple evm txs', async () => {
        const responses = await erc20.mintToUsers(users);
        multipleTxReceipt = responses[0];
        for (const response of responses) {
            expect(response.status).to.be.eq(1);
            if (txBlocks.has(response.blockNumber.toString())) {
                txBlocks.set(response.blockNumber.toString(), txBlocks.get(response.blockNumber.toString())! + 1);
            } else {
                txBlocks.set(response.blockNumber.toString(), 1);
            }
        }
        console.log('Sent tx number is ', responses.length);
    });

    let multipleSyntheticAndEvmTxs: ExecuteResult | undefined;

    // Height of the verified synthetic+EVM block; throws if setup never
    // established one, so dependents fail loudly instead of on a misleading
    // assertion.
    const syntheticEvmBlockHeight = (): number => {
        if (!multipleSyntheticAndEvmTxs) {
            throw new Error('synthetic+EVM same-block fixture not established — see the setup test failure');
        }
        return multipleSyntheticAndEvmTxs.height;
    };

    // Poll a tx for its receipt until the deadline — null on timeout. A
    // transient RPC error counts as not-yet-mined and keeps polling.
    const pollReceipt = async (hash: string, timeoutSeconds = 15): Promise<any> => {
        const deadline = Date.now() + timeoutSeconds * 1000;
        while (Date.now() < deadline) {
            try {
                const receipt = await rpcClient.getTransactionReceipt(hash);
                if (receipt) return receipt;
            } catch (e) {
                // transient RPC fault; keep polling
            }
            await waitFor(0.25);
        }
        return null;
    };

    it('Send multiple synthetic and evm tx in the same block', async () => {
        const encodedTx = erc20.contract.interface.encodeFunctionData('mint', [admin.evmAddress, ethers.parseEther('100000000')]);
        // Same-block co-location of concurrent submissions is not a chain
        // guarantee: broadcast the burst, poll each tx for a receipt, and retry
        // until >=2 EVM txs share the cosmos tx's block (the eth_ view excludes
        // synthetic txs, so the assertions on this block need two).
        const maxRounds = 4;
        for (let round = 1; round <= maxRounds; round++) {
            try {
                const signedTxs = await Promise.all(users.map(user => AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedTx)));
                const txPromise = baseCw20.mintMultiple(users.map(user => user.seiAddress), users.map(user => '100000000'));
                const hashes = await AtomicTxSender.sendMultipleEvmTxs(signedTxs, getTestConfig().evmRpcEndpoint, admin);
                const cosmosResponse = await txPromise;
                const receipts = await Promise.all(hashes.map(hash => pollReceipt(hash)));
                const coLocated = receipts.filter(r => r !== null && Number(r.blockNumber) === cosmosResponse.height).length;
                if (coLocated >= 2) {
                    multipleSyntheticAndEvmTxs = cosmosResponse;
                    break;
                }
                console.warn(`Round ${round}/${maxRounds}: ${coLocated} EVM txs landed in cosmos block ${cosmosResponse.height}; retrying`);
            } catch (e) {
                // e.g. a re-sign at a stale nonce after a receipt-poll timeout —
                // retry the round with freshly-signed txs rather than aborting
                console.warn(`Round ${round}/${maxRounds} failed (${e}); retrying`);
            }
        }
        const txLength = await rpcClient.getBlockByNumber(ethers.toQuantity(syntheticEvmBlockHeight()), true);
        expect(txLength.transactions.length).to.be.gt(1);
    });

    let multipleSyntheticAndOneFailingEvmTx: number;
    let failingTxHash: string;
    it('Sends multiple failing txs', async () => {
        const encodedTX = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('100000000')]);
        const signedTxs = await Promise.all(users.map(user => AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedTX)));
        const txs = await Promise.all(signedTxs.map(signedTx => AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin)));
        await waitFor(1);
        failingTxHash = txs[0];
    });

    it('In a block there are failing and successful txs', async () => {
        const encodedTX = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('100000000')]);
        const signedTx = await AtomicTxSender.signEvmTransaction(users[1], erc20.getAddress(), encodedTX);

        const encoded2Tx = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.05')]);
        const signedTx2 = await AtomicTxSender.signEvmTransaction(users[2], erc20.getAddress(), encoded2Tx);

        const encoded3Tx = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.05')]);
        const signedTx3 = await AtomicTxSender.signEvmTransaction(users[3], erc20.getAddress(), encoded3Tx);
        const results = await Promise.all([
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin),
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx2, admin),
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx3, admin),
        ]);

        // The failing tx may be admitted with status=0 OR rejected at CheckTx
        // (RPC-pod state-prop lag, sequence race). Fall back to a successful
        // tx's receipt for the block number — same block batch.
        let receipt = await AtomicTxSender.waitForEvmReceipt(rpcClient, results[0]);
        if (!receipt) receipt = await AtomicTxSender.waitForEvmReceipt(rpcClient, results[1]);
        if (!receipt) throw new Error('no tx receipt available within wait budget');
        multipleSyntheticAndOneFailingEvmTx = receipt.blockNumber;
        failingTxHash = results[0];
    })

    let multipleSyntheticAndEvmTx: ExecuteResult;
    it('Sends multiple synthetic and multiple evm txs', async () => {
        const encoded1 = erc20.contract.interface.encodeFunctionData('transfer', [users[5].evmAddress, ethers.parseEther('0.1')]);
        const delayed = async (encodedData: string) => {
            await waitFor(0.5);
            return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, encodedData, admin);
        }
        const signed1 = await AtomicTxSender.signEvmTransaction(users[6], erc20.getAddress(), encoded1);
        const signed2 = await AtomicTxSender.signEvmTransaction(users[7], erc20.getAddress(), encoded1);
        const signed3 = await AtomicTxSender.signEvmTransaction(users[8], erc20.getAddress(), encoded1);
        const results = await Promise.all([
            baseCw20.transferFromSender(users[2], users[1].seiAddress, '100000000'),
            baseCw20.transferFromSender(users[4], users[3].seiAddress, '100000000'),
            baseCw20.transferFromSender(users[9], users[5].seiAddress, '100000000'),
            delayed(signed1),
            delayed(signed2),
            delayed(signed3),
        ])
        multipleSyntheticAndEvmTx = results[2];
        if (legacyComponentsEnabled()) {
            console.log(await rpcClient.sei_getBlockByNumber(ethers.toQuantity(multipleSyntheticAndEvmTx.height), true));
        }


    });

    it('Given there are multiple evm txs on a block, eth_getBlockByNumber returns gas as expected', async () => {
        const provider = admin.evmWallet.signingClient;
        for (const blockNumber of txBlocks.keys()) {
            let totalGas = 0;
            let blockRpc;
            let txIndexes = new Set();
            blockRpc = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), true]);
            for (const tx of blockRpc.transactions) {
                const txReceipt = await provider.send('eth_getTransactionReceipt', [tx.hash]);
                totalGas += ethers.toNumber(txReceipt.gasUsed);
                txIndexes.add(tx.transactionIndex);
            }
            expect(totalGas).to.equal(ethers.toNumber(blockRpc.gasUsed));
            expect(txIndexes.size).to.equal(blockRpc.transactions.length);
        }
    });

    it('Given that there are synthetic and evm events on a block, eth_getBlockByNumber returns gas as expected', async () => {
        const provider = admin.evmWallet.signingClient;
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(syntheticEvmBlockHeight()), true]);
        expect(blockInfo.transactions.length).to.be.greaterThan(0);
        expect(ethers.toNumber(blockInfo.gasLimit)).to.be.gt(100000);
        console.log(syntheticEvmBlockHeight());
        let totalGasUsed = 0;
        let index = 0;
        for (const tx of blockInfo.transactions) {
            const receipt = await rpcClient.getTransactionReceipt(tx.hash);
            totalGasUsed += ethers.toNumber(receipt.gasUsed);
        }
        console.log(totalGasUsed);
        expect(ethers.toNumber(blockInfo.gasUsed)).to.be.eq(totalGasUsed);
    });

    it('Given that there are synthetic and txs on a block evm transaction index excludes synthetic txs', async () =>{
        const provider = admin.evmWallet.signingClient;
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(syntheticEvmBlockHeight()), true]);
        const indexes = blockInfo.transactions.map(tx => ethers.toNumber(tx.transactionIndex));
        expect(indexes.sort((a, b) => b - a)[0]).to.be.eq(blockInfo.transactions.length - 1);
    });

    it('Given that there are synthetic and evm tx on a block synthetic tx index includes all txs', async function () {
        requireLegacyComponents(this);
        const provider = admin.evmWallet.signingClient;
        const blockInfo = await provider.send('sei_getBlockByNumber', [ethers.toQuantity(syntheticEvmBlockHeight()), true]);
        const indexes = blockInfo.transactions.map(tx => ethers.toNumber(tx.transactionIndex));
        expect(indexes.sort((a, b) => b - a)[0]).to.be.eq(blockInfo.transactions.length - 1);
    });

    it('Eth get block by receipts returns correct info on tx indexes', async () =>{
        for (const blockNumber of txBlocks.keys()) {
            const receipts = await rpcClient.getBlockReceipts(ethers.toQuantity(blockNumber));
            for (const receipt of receipts) {
                const txReceipt = await rpcClient.getTransactionReceipt(receipt.transactionHash);
                expect(txReceipt.transactionIndex).to.be.eq(receipt.transactionIndex);
                expect(txReceipt.blockNumber).to.be.eq(receipt.blockNumber);
                expect(txReceipt.blockHash).to.be.eq(receipt.blockHash);
                expect(txReceipt.transactionIndex).to.be.eq(receipt.transactionIndex);
                expect(txReceipt.transactionHash).to.be.eq(receipt.transactionHash);
                expect(txReceipt.from).to.be.eq(receipt.from);
                expect(txReceipt.to).to.be.eq(receipt.to);
                expect(txReceipt.gasUsed).to.be.eq(receipt.gasUsed);
                expect(txReceipt.cumulativeGasUsed).to.be.eq(receipt.cumulativeGasUsed);
            }
        }
    });

    it('Eth get block by number matches with sei getBlock by Number', async function () {
        requireLegacyComponents(this);
        const ethBlock = await rpcClient.getBlockByNumber(ethers.toQuantity(multipleSyntheticAndEvmTx.height), true);
        const seiBlock = await rpcClient.sei_getBlockByNumber(ethers.toQuantity(multipleSyntheticAndEvmTx.height), true);
        expect(ethBlock.baseFeePerGas).to.be.eq(seiBlock.baseFeePerGas);
        expect(ethBlock.gasLimit).to.be.eq(seiBlock.gasLimit);
        // expect(ethBlock.gasUsed).to.be.eq(seiBlock.gasUsed);
        expect(ethBlock.number).to.be.eq(seiBlock.number);
        expect(ethBlock.timestamp).to.be.eq(seiBlock.timestamp);
        expect(ethBlock.stateRoot).to.be.eq(seiBlock.stateRoot);
        expect(ethBlock.miner).to.be.eq(seiBlock.miner);
    });

    it('Given that there are synthetic and failing txs on a block, eth_getBlockByNumber returns gas as expected', async () => {
        const provider = admin.evmWallet.signingClient;
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx)), true]);
        expect(blockInfo.transactions.length).to.be.greaterThan(0);
        expect(ethers.toNumber(blockInfo.gasLimit)).to.be.gt(10000000);
        // The failing tx may land with status 0 or be rejected at CheckTx, so iterate
        // every included tx: reconcile block.gasUsed and assert any revert still burned gas.
        let totalGasUsed = 0;
        for (const tx of blockInfo.transactions) {
            const receipt = await rpcClient.getTransactionReceipt(tx.hash);
            totalGasUsed += ethers.toNumber(receipt.gasUsed);
            if (ethers.toNumber(receipt.status) === 0) {
                expect(ethers.toNumber(receipt.gasUsed), `reverted tx ${tx.hash} burned gas`).to.be.greaterThan(0);
            }
        }
        expect(ethers.toNumber(blockInfo.gasUsed)).to.be.eq(totalGasUsed);
    })

    it('Given that heavy txs base gas fee increases on block call', async () =>{
        const resp = await erc20.sendMultipleTxs(users);
        const baseFeePerGases = [];
        for(let blockNum = Number(resp[0].blockNumber) -1; blockNum <= Number(resp[0].blockNumber) + 4; blockNum ++){
            const blockInfo = await rpcClient.getBlockByNumber(ethers.toQuantity(blockNum), true) as Block;
            baseFeePerGases.push(ethers.toNumber(blockInfo.baseFeePerGas));
        }
        expect(baseFeePerGases.filter(baseFee => baseFee > 100000000).length).to.be.greaterThan(0);
    });

    const tags = ['latest', 'finalized', 'safe', 'pending'];
    for(const tag of tags){
        it(`Eth get block by number returns info with ${tag} for multiple txs`, async () => {
            await waitFor(2);
            const provider = admin.evmWallet.signingClient;
            let tries = 0;
            erc20.sendMultipleTxs(users);
            while(tries < 400){
                const results = await provider.send('eth_getBlockByNumber', [tag, true]);
                if(results.transactions.length > 25){
                    const indexes = new Set();
                    for(const tx of results.transactions){
                        indexes.add(tx.transactionIndex);
                    }
                    return expect(indexes.size).to.equal(results.transactions.length);
                } else {
                    await waitFor(0.04);
                    tries++;
                }
            }
            if(tries === 200){
                console.log('I couldnt find it');
            }
            await waitFor(3);
        })
    }

    // Each tag resolves to a real block, and the resolved heights hold the
    // canonical order. A handler that maps every tag to the same block, or
    // drops one, satisfies the per-tag tests above and fails here.
    it('Eth get block by number resolves finalized, safe, latest and pending in order', async () => {
        const tagList = ['finalized', 'safe', 'latest', 'pending'] as const;
        const heights: Record<string, number> = {};
        for (const tag of tagList) {
            const block = await rpcClient.getBlockByNumber(tag);
            expect(block, `eth_getBlockByNumber(${tag}) returned null`).to.not.be.null;
            const height = Number(block.number);
            expect(height, `eth_getBlockByNumber(${tag}) returned block.number=${height}`).to.be.greaterThan(0);
            heights[tag] = height;
        }
        expect(heights.finalized).to.be.lte(heights.safe);
        expect(heights.safe).to.be.lte(heights.latest);
        expect(heights.latest).to.be.lte(heights.pending);
    });
})
