import {SeiUser, UserFactory} from "../../shared/User";
import {EvmRpcClient} from "../../shared/RpcClient";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import testConfig from "../../config/testConfig.json";
import ContractAddresses from "./contractAddresses.json";
import {ContractTransactionReceipt, ethers} from "ethers";
import {expect} from "chai";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {ExecuteInstruction, ExecuteResult} from "@cosmjs/cosmwasm-stargate";
import {waitFor} from "../../shared/utils/helpers";

describe('Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let baseCw20: Cw20Token;
    let legacySeiGetBlockEnabled = false;

    before('Initializes', async () => {
        admin = await UserFactory.createAdminUser();
        users = await UserFactory.createSeiUsers(admin, 10, true);
        erc20 = new Erc20Token(admin, ContractAddresses.erc20);
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, admin.evmWallet.signingClient);
        baseCw20 = new Cw20Token(admin, ContractAddresses.cw20);
        try {
            await rpcClient.sei_getBlockByNumber('latest', false);
            legacySeiGetBlockEnabled = true;
        } catch {
            legacySeiGetBlockEnabled = false;
        }
    })

    let multipleTxReceipt: ContractTransactionReceipt;
    let multipleTxBlockNumber: number;
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
        const [blockNumber] = [...txBlocks.entries()]
            .sort((a, b) => b[1] - a[1])[0];
        multipleTxBlockNumber = Number(blockNumber);
        console.log('Sent tx number is ', responses.length);
    });

    let multipleSyntheticAndEvmTxs: { height: number };
    it('Send multiple synthetic and evm tx in the same block', async () => {
        const encodedTx = erc20.contract.interface.encodeFunctionData('mint', [admin.evmAddress, ethers.parseEther('100000000')]);
        const mintMessages: ExecuteInstruction[] = users.map(user => ({
            contractAddress: baseCw20.getAddress(),
            msg: {
                mint: {
                    recipient: user.seiAddress,
                    amount: '100000000',
                },
            },
        }));
        const sameBlock = await AtomicTxSender.sendAtomicSameBlockBatch(
            admin,
            () => Promise.all(users.map(user => AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedTx))),
            testConfig.evmRpcEndpoint,
            () => baseCw20.signExecMultiple(admin, mintMessages).then(tx => [tx]),
            rpcClient,
            10,
        );
        multipleSyntheticAndEvmTxs = { height: sameBlock.blockNumber };
        const txLength = await rpcClient.getBlockByNumber(ethers.toQuantity(multipleSyntheticAndEvmTxs.height), true);
        expect(txLength.transactions.length).to.be.gte(sameBlock.evmTxHashes.length);
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

        await waitFor(1);
        failingTxHash = results[0];
        multipleSyntheticAndOneFailingEvmTx = (await rpcClient.getTransactionReceipt(failingTxHash)).blockNumber;
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
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(multipleSyntheticAndEvmTxs.height), true]);
        expect(blockInfo.transactions.length).to.be.greaterThan(0);
        expect(ethers.toNumber(blockInfo.gasLimit)).to.be.gt(100000);
        console.log(multipleSyntheticAndEvmTxs.height);
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
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(multipleSyntheticAndEvmTxs.height), true]);
        const indexes = blockInfo.transactions.map((tx: any) => ethers.toNumber(tx.transactionIndex));
        expect(indexes.sort((a: number, b: number) => b - a)[0]).to.be.eq(blockInfo.transactions.length - 1);
    });

    it('Given that there are synthetic and evm tx on a block synthetic tx index includes all txs', async function () {
        if (!legacySeiGetBlockEnabled) {
            this.skip();
            return;
        }
        const provider = admin.evmWallet.signingClient;
        const blockInfo = await provider.send('sei_getBlockByNumber', [ethers.toQuantity(multipleSyntheticAndEvmTxs.height), true]);
        const indexes = blockInfo.transactions.map((tx: any) => ethers.toNumber(tx.transactionIndex));
        expect(indexes.sort((a: number, b: number) => b - a)[0]).to.be.eq(blockInfo.transactions.length - 1);
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
        if (!legacySeiGetBlockEnabled) {
            this.skip();
            return;
        }
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
        const blockInfo = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(multipleSyntheticAndOneFailingEvmTx), true]);
        expect(blockInfo.transactions.length).to.be.greaterThan(0);
        expect(ethers.toNumber(blockInfo.gasLimit)).to.be.gt(10000000);
        expect(blockInfo.transactions.map((tx: any) => tx.hash)).to.include(failingTxHash);
    })

    it('Given that heavy txs base gas fee increases on block call', async () =>{
        const resp = await erc20.sendMultipleTxs(users);
        const baseFeePerGases = [];
        for(let blockNum = Number(resp[0].blockNumber) -1; blockNum <= Number(resp[0].blockNumber) + 4; blockNum ++){
            const blockInfo = await rpcClient.getBlockByNumber(ethers.toQuantity(blockNum), true);
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
            void erc20.sendMultipleTxs(users);
            while(tries < 50){
                const results = await provider.send('eth_getBlockByNumber', [tag, true]);
                if(results.transactions.length > 6){
                    const indexes = new Set();
                    for(const tx of results.transactions){
                        indexes.add(tx.transactionIndex);
                    }
                    return expect(results.transactions.length).to.be.greaterThan(6);
                } else {
                    await waitFor(0.02);
                    tries++;
                }
            }
            throw new Error(`Could not find a block with multiple transactions for tag ${tag}`);
        })
    }
})
