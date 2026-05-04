import {SeiUser, UserFactory } from "../../shared/User";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import contractAddresses from './contractAddresses.json'
import { EvmRpcClient } from "../../shared/RpcClient";
import {Block, ContractTransactionReceipt, ethers, LogDescription} from "ethers";
import {expect} from "chai";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {waitFor} from "../../shared/utils/helpers";
import {TokenDeployer} from "../../shared/Deployer";
import fs from "fs";

describe('Evm Rpc Tests', function () {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let pointerCw20: Cw20Token;
    let baseCw20: Cw20Token;

    before('Initializes', async () => {
        admin = await UserFactory.createAdminUser();
        users = await UserFactory.createSeiUsers(admin, 5, true);
        erc20 = new Erc20Token(admin, contractAddresses.erc20);
        pointerCw20 = new Cw20Token(admin, contractAddresses.ercPointerOnCosmos);
        baseCw20 = new Cw20Token(admin, contractAddresses.cw20);
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    })

    let multipleTxReceipt: ContractTransactionReceipt;
    let txBlocks: Map<string, number> = new Map<string, number>();
    it('Sends multiple evm txs', async () => {
        const responses = await erc20.sendMultipleTxs(users);
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

    let oneSyntheticOneEvmTx: ContractTransactionReceipt;
    it('Send a synthetic and evm tx', async () => {
        baseCw20.setSigner(users[1]);
        const { evmReceipt, blockNumber } = await AtomicTxSender.sendAtomicSameBlock(
            admin,
            () => {
                const encoded = erc20.contract.interface.encodeFunctionData(
                    'transfer', [admin.evmAddress, ethers.parseEther('1')]);
                return AtomicTxSender.signEvmTransaction(users[0], erc20.getAddress(), encoded);
            },
            admin.evmRpcEndpoint,
            () => baseCw20.signTransfer(users[1], admin.seiAddress, '100000'),
            rpcClient,
        );
        oneSyntheticOneEvmTx = evmReceipt;
        console.log('shared block is', blockNumber);
        expect(Number(evmReceipt.blockNumber)).to.be.eq(blockNumber);
    });

    let multipleSyntheticAndOneFailingEvmTx: { height: number };
    it('Sends multiple failing txs', async () => {
        baseCw20.setSigner(admin);
        const { evmReceipts, blockNumber } = await AtomicTxSender.sendAtomicSameBlockBatch(
            admin,
            async () => {
                const encoded1 = erc20.contract.interface.encodeFunctionData(
                    'transfer', [users[0].evmAddress, ethers.parseEther('10000000000')]);
                const encoded2 = erc20.contract.interface.encodeFunctionData(
                    'transfer', [users[2].evmAddress, ethers.parseEther('10000000000')]);
                return Promise.all([
                    AtomicTxSender.signEvmTransaction(users[1], erc20.getAddress(), encoded1),
                    AtomicTxSender.signEvmTransaction(users[3], erc20.getAddress(), encoded2),
                ]);
            },
            admin.evmRpcEndpoint,
            async () => [await baseCw20.signTransfer(admin, admin.seiAddress, '100000')],
            rpcClient,
        );
        multipleSyntheticAndOneFailingEvmTx = { height: blockNumber };
        console.log('shared block is', blockNumber);
        expect(Number(evmReceipts[0].blockNumber)).to.be.eq(blockNumber);
    });

    let multipleSyntheticAndEvmTx: ContractTransactionReceipt;
    it('Sends multiple synthetic and multiple evm txs', async () => {
        baseCw20.setSigner(admin);
        const { evmReceipts, blockNumber } = await AtomicTxSender.sendAtomicSameBlockBatch(
            admin,
            async () => {
                const signed: string[] = [];
                for (let i = 0; i < 3; i++) {
                    const encoded = erc20.contract.interface.encodeFunctionData(
                        'transfer', [users[i].evmAddress, ethers.parseEther('0.01')]);
                    signed.push(await AtomicTxSender.signEvmTransaction(users[i], erc20.getAddress(), encoded));
                }
                return signed;
            },
            admin.evmRpcEndpoint,
            async () => {
                const msgs = [
                    { contractAddress: baseCw20.getAddress(),
                      msg: { transfer: { recipient: admin.seiAddress, amount: '100000' } } },
                    { contractAddress: baseCw20.getAddress(),
                      msg: { transfer: { recipient: admin.seiAddress, amount: '100000' } } },
                ];
                return [await baseCw20.signExecMultiple(admin, msgs)];
            },
            rpcClient,
        );
        multipleSyntheticAndEvmTx = evmReceipts[0];
        console.log('shared block is', blockNumber);
        expect(Number(multipleSyntheticAndEvmTx.blockNumber)).to.be.eq(blockNumber);
    });

    it('Can read topics with multiple logs and validate indexes', async () => {
        const provider = admin.evmWallet.signingClient;
        for (const blockNumber of txBlocks.keys()) {
            const blockHash = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])).hash;
            let blockRpc;
            let txIndexes = new Set();
            let logIndexes = new Set();
            const expectedLogIndexes = new Array(txBlocks.get(blockNumber)).fill(0)
                .map((_, index) => ethers.toQuantity(index));
            const logParams = {
                fromBlock: ethers.toQuantity(blockNumber),
                toBlock: ethers.toQuantity(blockNumber),
                topics: [ethers.id('Transfer(address,address,uint256)')],
                address: erc20.getAddress().toString()
            }
            blockRpc = await provider.send('eth_getLogs', [logParams]);
            expect(blockRpc.length).to.be.eq(txBlocks.get(blockNumber));

            // Get block details for additional validation
            const blockDetails = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), true]);
            const blockReceipts = await provider.send('eth_getBlockReceipts', [ethers.toQuantity(blockNumber)]);

            for(const topic of blockRpc) {
                expect(topic.address.toLowerCase()).to.be.eq(erc20.getAddress().toString().toLowerCase());
                const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
                expect(parsed.name).to.be.eq('Transfer');
                expect(parsed.args[1]).to.equal(admin.evmAddress);
                expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.01')
                expect(ethers.toNumber(topic.blockNumber)).to.be.eq(Number(blockNumber));
                expect(topic.blockHash).to.be.eq(blockHash);

                // Validate transaction index from multiple sources
                const txIndexFromReceipt = await rpcClient.getTransactionReceipt(topic.transactionHash);
                expect(txIndexFromReceipt.transactionIndex).to.be.eq(topic.transactionIndex);

                // Validate against block receipts
                const blockReceipt = blockReceipts.find((receipt: any) => receipt.transactionHash === topic.transactionHash);
                expect(blockReceipt).to.not.be.undefined;
                expect(blockReceipt.transactionIndex).to.be.eq(topic.transactionIndex);

                // Validate against block details
                const blockTx = blockDetails.transactions.find((tx: any) => tx.hash === topic.transactionHash);
                expect(blockTx).to.not.be.undefined;
                expect(blockTx.transactionIndex).to.be.eq(topic.transactionIndex);

                // Validate log index consistency
                const receiptLogs = blockReceipt.logs.filter((log: any) => log.transactionHash === topic.transactionHash);
                const matchingLog = receiptLogs.find((log: any) => log.logIndex === topic.logIndex);
                expect(matchingLog).to.not.be.undefined;
                expect(matchingLog.address.toLowerCase()).to.be.eq(topic.address.toString().toLowerCase());
                expect(matchingLog.topics).to.deep.eq(topic.topics);
                expect(matchingLog.data).to.be.eq(topic.data);

                txIndexes.add(topic.transactionIndex);
                logIndexes.add(topic.logIndex);

                // Verify that log indexes start from 0
                const found = expectedLogIndexes.find(index => index === topic.logIndex);
                expect(found).to.not.be.undefined;

                console.log(`✅ Log validation passed for tx ${topic.transactionHash}: txIndex=${topic.transactionIndex}, logIndex=${topic.logIndex}`);
            }
            expect(txIndexes.size).to.be.eq(txBlocks.get(blockNumber));
            expect(logIndexes.size).to.be.eq(txBlocks.get(blockNumber));
        }
    });

    it('Cant read topics given that there are failing txs and multiple cosmos txs from pointer on cosmos', async () => {
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) -2),
            toBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) + 2),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress()
        }
        const logResponses = await rpcClient.getLogs(logsParams);
        expect(logResponses.length).to.be.eq(0);
    });


    it.skip('Cant read topics given that there are failing txs and multiple cosmos txs from pointer on cosmos', async () => {
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) -1),
            toBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) + 1),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress()
        }
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        let txIndexes = new Set();
        let logIndexes = new Set();
        const expectedLogIndexes = new Array(users.length).fill(0)
            .map((_, index) => ethers.toQuantity(index));
        for(const topic of logResponses) {
            expect(topic.address.toLowerCase()).to.be.eq(erc20.getAddress().toLowerCase());
            const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[0]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.0000000000001')
            txIndexes.add(topic.transactionIndex);
            logIndexes.add(topic.logIndex);
            // Verify that log indexes start from 0
            expect(topic.logIndex).to.be.oneOf(expectedLogIndexes);
        }
        expect(txIndexes.size).to.be.eq(1);
        expect(logIndexes.size).to.be.eq(users.length);
    });

    it('Can read topics with both synthetic and evm txs', async () => {
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) -1),
            toBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) + 1),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        }
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        expect(logResponses.length).to.be.eq(2);
    });

    it('Can read topics with both erc20 and erc721 events', async () => {
        const deployer = new TokenDeployer(admin);
        const erc721 = await deployer.deployErc721('TestCw721', 'TestCw721', 'http://example.com');
        await (await erc721.safeMint(admin.evmAddress, '1')).wait();
        const encodedErc20 = erc20.contract.interface.encodeFunctionData('transfer', [users[0].evmAddress, ethers.parseEther('0.1')]);
        const signedErc20 = await AtomicTxSender.signEvmTransaction(users[1], erc20.getAddress(), encodedErc20);
        const encodedErc721 = erc721.contract.interface.encodeFunctionData('approve', [users[0].evmAddress, '1']);
        const signedErc721 = await AtomicTxSender.signEvmTransaction(admin, erc721.getAddress(), encodedErc721);
        const results= await Promise.all([
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedErc20, admin),
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedErc721, admin),
        ]);
        await waitFor(4);
        const tx = await rpcClient.getTransactionReceipt(results[0]);
        const logParams1 = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [ethers.id('Approval(address,address,uint256)')],
        }
        const logs = await rpcClient.getLogs(logParams1);
        const logParams2 = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        }
        const logs2 = await rpcClient.getLogs(logParams2);

        const combinedLogs = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            // topics: [ethers.id('Transfer(address,address,uint256)'), ethers.id('Approval(address, address,uint256)')],
            topics: [[
                ethers.id('Transfer(address,address,uint256)'),
                ethers.id('Approval(address,address,uint256)')
            ]],
        }
        const logsCombined = await rpcClient.getLogs(combinedLogs);
        expect(logsCombined.length).to.be.eq(logs.length + logs2.length);
    });

    let multipleTxBlock;
    it('Can return txs successfully for a span of 100 blocks', async () => {
        const encodedTx = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.01')]);
        const signedTxs = await Promise.all(users.map((user) => AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedTx)));
        const results = await Promise.all(signedTxs.map((signedTx) => AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin)));
        await waitFor(0.5);
        const txReceipt = await rpcClient.getTransactionReceipt(results[0]);
        for (const result of results){
            console.log(result);
        }
        multipleTxBlock = txReceipt.blockNumber;
        await waitFor(60);
        console.log('Current block number is ', Number(await admin.evmWallet.signingClient.getBlockNumber()));
        console.log('Sent block number is ', Number(txReceipt.blockNumber));
        const logParams = {
            fromBlock: ethers.toQuantity(Number(txReceipt.blockNumber) -5),
            toBlock: ethers.toQuantity(Number(txReceipt.blockNumber) + 100),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress(),
        };
        const logResponses = await rpcClient.getLogs(logParams);
        fs.writeFileSync('logs.json', JSON.stringify(logResponses, null, 2));
        expect(logResponses.length).to.be.eq(users.length);
        let txIndexes = new Set();
        let logIndexes = [];
        const expectedLogIndexes = new Array(users.length).fill(0)
            .map((_, index) => ethers.toQuantity(index));
        for(const topic of logResponses) {
            expect(topic.address.toLowerCase()).to.be.eq(erc20.getAddress().toLowerCase());
            const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[1]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.01')
            txIndexes.add(topic.transactionIndex);
            console.log(topic.transactionIndex);
            logIndexes.push(topic.logIndex);
            // Verify that log indexes start from 0
            expect(topic.logIndex).to.be.oneOf(expectedLogIndexes);
        }
        // expect(txIndexes.size).to.be.eq(users.length);
        expect(logIndexes.length).to.be.eq(users.length);
    });

    let i = 0;
    const tags = ['finalized', 'safe', 'latest', 'pending'];
    for(const tag of tags) {
        it(`From block ${tag} return info as expected`, async () => {
            await waitFor(2);
            const tx = erc20.transfer(users[0].evmAddress, ethers.parseEther('0.1'));
            let index = 0;
            while(index < 200){
                const logParams = {
                    fromBlock: tag,
                    topics: [ethers.id('Transfer(address,address,uint256)')],
                    address: erc20.getAddress()
                }
                const rpc = await rpcClient.getLogs(logParams);
                if(rpc.length > 0){
                    i++;
                    return true;
                } else {
                    await waitFor(0.02);
                    index++;
                }
            }
            throw new Error('I threw this error occurred.');
        });

        it(`To block ${tag} return info as expected`, async () => {
            await waitFor(2);
            const blockNum = await admin.evmWallet.signingClient.getBlock('latest') as unknown as Block;

            const tx = erc20.transfer(users[0].evmAddress, ethers.parseEther('0.1'));
            let index = 0;
            while(index < 200){
                const logParams = {
                    fromBlock: ethers.toQuantity(blockNum.number - 2),
                    toBlock: tag,
                    topics: [ethers.id('Transfer(address,address,uint256)')],
                    address: erc20.getAddress()
                }
                const rpc = await rpcClient.getLogs(logParams);
                if(rpc.length > 0){
                    return true;
                } else {
                    await waitFor(0.02);
                    index++;
                }
            }
            throw new Error('I threw this error occurred.');
        });
    }

    it('Eth get logs tx indexes alongside with log indexes return correct data', async () =>{
        const blockTxs = await rpcClient.getBlockByNumber(multipleTxBlock, true);
        const blockReceipts = await rpcClient.getBlockReceipts(ethers.toQuantity(multipleTxBlock));
        const logParams = {
            fromBlock: ethers.toQuantity(Number(multipleTxBlock) - 1),
            toBlock: ethers.toQuantity(Number(multipleTxBlock) + 3),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress()
        }
        const logs = await rpcClient.getLogs(logParams);

        for (const tx of blockTxs.transactions) {
            const txReceipt = await rpcClient.getTransactionReceipt(tx.hash);
            const receiptFromBlock = blockReceipts.find((receipt: any) => receipt.transactionHash === tx.hash);
            expect(receiptFromBlock, `missing block receipt for ${tx.hash}`).to.not.be.undefined;
            expect(receiptFromBlock.transactionIndex).to.eq(tx.transactionIndex);
            expect(txReceipt.transactionIndex).to.eq(tx.transactionIndex);
            expect(txReceipt.blockHash).to.eq(blockTxs.hash);
            expect(txReceipt.blockNumber).to.eq(blockTxs.number);

            for (const receiptLog of txReceipt.logs) {
                const matchingLog = logs.find(log =>
                    log.transactionHash === receiptLog.transactionHash &&
                    log.logIndex === receiptLog.logIndex
                );
                expect(matchingLog, `missing log ${receiptLog.logIndex} for ${tx.hash}`).to.not.be.undefined;
                expect(matchingLog.transactionIndex).to.eq(txReceipt.transactionIndex);
                expect(matchingLog.blockHash).to.eq(txReceipt.blockHash);
                expect(matchingLog.blockNumber).to.eq(txReceipt.blockNumber);
                expect(matchingLog.address.toLowerCase()).to.eq(receiptLog.address.toLowerCase());
                expect(matchingLog.topics).to.deep.eq(receiptLog.topics);
                expect(matchingLog.data).to.eq(receiptLog.data);
            }
        }
    });
})
