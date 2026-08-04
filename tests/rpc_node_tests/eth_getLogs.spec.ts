import {SeiUser, UserFactory } from "../../shared/User";
import {Cw20Token, Erc20Token} from "../../shared/Token";
import contractAddresses from './contractAddresses.json'
import { EvmRpcClient } from "../../shared/RpcClient";
import {Block, ContractTransactionReceipt, ethers, LogDescription} from "ethers";
import {expect} from "chai";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {waitFor} from "../../shared/utils/helpers";
import {ExecuteResult} from "@cosmjs/cosmwasm-stargate";
import {TokenDeployer} from "../../shared/Deployer";
import {expectContiguousBlockLogIndexes, filterLogsByTxHash} from "./logAssertions";
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
    let multipleTxHashes: string[] = [];
    let txBlocks: Map<string, number> = new Map<string, number>();
    it('Sends multiple evm txs', async () => {
        const responses = await erc20.sendMultipleTxs(users);
        multipleTxReceipt = responses[0];
        multipleTxHashes = responses.map((response) => response.hash);
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
    let oneSyntheticOneEvmTxHashes: string[] = [];
    it('Send a synthetic and evm tx', async () => {
        const encodedData = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('1')]);
        baseCw20.setSigner(users[1]);
        const { evmReceipt, cosmosResponse } = await AtomicTxSender.sendRawUntilSameBlock(
            async () => {
                const signedTx = await AtomicTxSender.signEvmTransaction(users[0], erc20.getAddress(), encodedData);
                return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, users[0]);
            },
            () => baseCw20.transfer(admin.seiAddress, '100000'),
            rpcClient,
        );
        oneSyntheticOneEvmTx = evmReceipt as ContractTransactionReceipt;
        // Synthetic logs carry the 0x-prefixed cosmos tx hash as their
        // transactionHash; the evm receipt here is raw RPC JSON.
        oneSyntheticOneEvmTxHashes = [
            (evmReceipt as any).transactionHash,
            '0x' + cosmosResponse.transactionHash.toLowerCase(),
        ];
    });

    let multipleSyntheticAndOneFailingEvmTx: ExecuteResult;
    let failingTxHashes: string[] = [];
    it('Sends multiple failing txs', async () => {
        const encoded1 = erc20.contract.interface.encodeFunctionData('transfer', [users[0].evmAddress, ethers.parseEther('10000000000')]);
        const encoded2 = erc20.contract.interface.encodeFunctionData('transfer', [users[2].evmAddress, ethers.parseEther('10000000000')]);

        // Pre-broadcast a second failing EVM tx so it's in the mempool when the
        // helper runs. Its block placement is not load-bearing — the downstream
        // assertion is "no Transfer logs from address=erc20 in the queried
        // range," which holds regardless of where signed2 lands.
        const signed2 = await AtomicTxSender.signEvmTransaction(users[3], erc20.getAddress(), encoded2);
        failingTxHashes.push(ethers.keccak256(signed2));
        AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signed2, admin).catch(() => {});

        const { evmReceipt, cosmosResponse } = await AtomicTxSender.sendRawUntilSameBlock(
            async () => {
                const signed = await AtomicTxSender.signEvmTransaction(users[1], erc20.getAddress(), encoded1);
                // tx hash = keccak of the signed raw tx; every retry attempt
                // broadcasts a fresh failing tx, so capture them all.
                failingTxHashes.push(ethers.keccak256(signed));
                return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signed, admin);
            },
            () => baseCw20.transfer(admin.seiAddress, '100000'),
            rpcClient,
        );
        multipleSyntheticAndOneFailingEvmTx = cosmosResponse;
    });

    let multipleSyntheticAndEvmTx: ContractTransactionReceipt;
    it('Sends multiple synthetic and multiple evm txs', async () => {
        const msgs = [
            {contractAddress: baseCw20.getAddress(),
                msg: { transfer: { recipient: admin.seiAddress, amount: '100000' }}},
            {contractAddress: baseCw20.getAddress(),
                msg: { transfer: { recipient: admin.seiAddress, amount: '100000' }}}
        ];
        const { evmReceipt, cosmosResponse } = await AtomicTxSender.sendRawUntilSameBlock(
            async () => {
                const hashes = await Promise.all(users.slice(0, 3).map(async (user, i) => {
                    const encoded = erc20.contract.interface.encodeFunctionData('transfer', [user.evmAddress, ethers.parseEther('0.01')]);
                    const signedTx = await AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encoded);
                    return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin);
                }));
                return hashes[0];
            },
            () => baseCw20.execMultiple(msgs),
            rpcClient,
        );
        multipleSyntheticAndEvmTx = evmReceipt as ContractTransactionReceipt;
    });

    it('Can read topics with multiple logs and validate indexes', async () => {
        const provider = admin.evmWallet.signingClient;
        for (const blockNumber of txBlocks.keys()) {
            const blockHash = (await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false])).hash;
            let blockRpc;
            let txIndexes = new Set();
            let logIndexes = new Set();
            const logParams = {
                fromBlock: ethers.toQuantity(blockNumber),
                toBlock: ethers.toQuantity(blockNumber),
                topics: [ethers.id('Transfer(address,address,uint256)')],
                address: erc20.getAddress().toString()
            }
            blockRpc = await provider.send('eth_getLogs', [logParams]);
            // Concurrent tests' Transfers on the shared ERC20 can share the
            // block; count and validate only this test's txs.
            const ownLogs = filterLogsByTxHash(blockRpc, multipleTxHashes);
            expect(ownLogs.length).to.be.eq(txBlocks.get(blockNumber));

            // Get block details for additional validation
            const blockDetails = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), true]);
            const blockReceipts = await provider.send('eth_getBlockReceipts', [ethers.toQuantity(blockNumber)]);

            for(const topic of ownLogs) {
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

                console.log(`✅ Log validation passed for tx ${topic.transactionHash}: txIndex=${topic.transactionIndex}, logIndex=${topic.logIndex}`);
            }
            expect(txIndexes.size).to.be.eq(txBlocks.get(blockNumber));
            expect(logIndexes.size).to.be.eq(txBlocks.get(blockNumber));
            // Verify block logIndexes start at 0 and are gapless — only
            // assertable on the unfiltered block view.
            await expectContiguousBlockLogIndexes((filter) => rpcClient.getLogs(filter), ownLogs);
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
        // The window is shared chain history — other tests' Transfers can
        // land in it. The invariant is that the failing txs emitted no logs.
        expect(filterLogsByTxHash(logResponses, failingTxHashes).length).to.be.eq(0);
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
        // Topic-only filter over a 3-block shared window also returns other
        // tests' Transfers; scope to this test's evm + synthetic pair.
        const ownLogs = filterLogsByTxHash(logResponses, oneSyntheticOneEvmTxHashes);
        expect(ownLogs.length).to.be.eq(2);
    });

    it('Can read topics with both erc20 and erc721 events', async () => {
        const deployer = new TokenDeployer(admin);
        const erc721 = await deployer.deployErc721('TestCw721', 'TestCw721', 'http://example.com');
        const mintReceipt = await (await erc721.safeMint(admin.evmAddress, '1')).wait();
        const encodedErc20 = erc20.contract.interface.encodeFunctionData('transfer', [users[0].evmAddress, ethers.parseEther('0.1')]);
        const signedErc20 = await AtomicTxSender.signEvmTransaction(users[1], erc20.getAddress(), encodedErc20);
        const encodedErc721 = erc721.contract.interface.encodeFunctionData('approve', [users[0].evmAddress, '1']);
        const signedErc721 = await AtomicTxSender.signEvmTransaction(admin, erc721.getAddress(), encodedErc721);
        const results= await Promise.all([
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedErc20, admin),
            AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedErc721, admin),
        ]);
        const tx = await AtomicTxSender.requireEvmReceipt(rpcClient, results[0]);
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
        // The three queries race ambient activity landing in the shared
        // window, so the union identity (combined == approvals + transfers)
        // is only stable on this test's own txs.
        const ownHashes = [mintReceipt.hash, ...results];
        const ownApprovals = filterLogsByTxHash(logs, ownHashes);
        const ownTransfers = filterLogsByTxHash(logs2, ownHashes);
        const ownCombined = filterLogsByTxHash(logsCombined, ownHashes);
        // results[0]'s Transfer anchors the window, so it must be visible.
        expect(filterLogsByTxHash(logs2, [results[0]]).length).to.be.greaterThan(0);
        // A fully lagged RPC could satisfy the identity vacuously at 0 == 0 + 0;
        // the anchor transfer defines the window, so at least it must resolve.
        expect(ownCombined.length).to.be.greaterThan(0);
        expect(ownCombined.length).to.be.eq(ownApprovals.length + ownTransfers.length);
    });

    let multipleTxBlock;
    it('Can return txs successfully for a span of 100 blocks', async () => {
        const encodedTx = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.01')]);
        const signedTxs = await Promise.all(users.map((user) => AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedTx)));
        const results = await Promise.all(signedTxs.map((signedTx) => AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin)));

        let txReceipt: any = null;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !txReceipt) {
            txReceipt = await rpcClient.getTransactionReceipt(results[0]);
            if (!txReceipt) await waitFor(0.5);
        }
        expect(txReceipt, `receipt not produced within 30s for tx=${results[0]}`).to.not.be.null;
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
        // The 105-block window over the shared ERC20 also captures other
        // tests' Transfers; count and validate only this test's txs.
        const ownLogs = filterLogsByTxHash(logResponses, results);
        expect(ownLogs.length).to.be.eq(users.length);
        let txIndexes = new Set();
        let logIndexes = [];
        for(const topic of ownLogs) {
            expect(topic.address.toLowerCase()).to.be.eq(erc20.getAddress().toLowerCase());
            const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[1]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.01')
            txIndexes.add(topic.transactionIndex);
            console.log(topic.transactionIndex);
            logIndexes.push(topic.logIndex);
        }
        // expect(txIndexes.size).to.be.eq(users.length);
        expect(logIndexes.length).to.be.eq(users.length);
        // Verify block logIndexes start at 0 and are gapless — only
        // assertable on the unfiltered block view.
        await expectContiguousBlockLogIndexes((filter) => rpcClient.getLogs(filter), ownLogs);
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
            throw new Error(`eth_getLogs returned no Transfer events from block ${tag} after ${index} polls`);
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
            throw new Error(`eth_getLogs returned no Transfer events to block ${tag} after ${index} polls`);
        });
    }

    it('Eth get logs tx indexes alongside with log indexes return correct data', async () =>{
        const blockTxs = await rpcClient.getBlockByNumber(ethers.toQuantity(multipleTxBlock), true);
        const logParams = {
            fromBlock: ethers.toQuantity(Number(multipleTxBlock) - 1),
            toBlock: ethers.toQuantity(Number(multipleTxBlock) + 3),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress()
        }
        const logs = await rpcClient.getLogs(logParams);

        for (const tx of blockTxs.transactions) {
            const txReceipt = await rpcClient.getTransactionReceipt(tx.hash);
            // verify that the tx index matches
            const logTxIndex = logs.find(log => log.transactionIndex === txReceipt.transactionIndex);

            // verify that log index matches
            console.log(logTxIndex);
            console.log(txReceipt.logs);
        }
    });
})
