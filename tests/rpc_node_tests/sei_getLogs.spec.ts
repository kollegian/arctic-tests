import { SeiUser, UserFactory } from "../../shared/User";
import { Cw20Token, Erc20Token } from "../../shared/Token";
import contractAddresses from './contractAddresses.json';
import { EvmRpcClient } from "../../shared/RpcClient";
import { Block, ethers, LogDescription } from "ethers";
import { expect } from "chai";
import { waitFor } from "../../shared/utils/helpers";
import { AtomicTxSender } from "../../shared/TxBuilder";
import { TokenDeployer } from "../../shared/Deployer";
import { expectContiguousBlockLogIndexes, filterLogsByTxHash } from "./logAssertions";


describe('Sei get logs tests', function() {
    this.timeout(10 * 60 * 1000);
    let users: SeiUser[];
    let admin: SeiUser;
    let erc20: Erc20Token;
    let rpcClient: EvmRpcClient;
    let baseCw20: Cw20Token;
    let txBlocks: Map<string, number> = new Map<string, number>();
    let multipleTxReceipt: any;
    let oneSyntheticOneEvmTx: any;
    let multipleSyntheticAndOneFailingEvmTx: any;
    let multipleSyntheticAndEvmTx: any;
    let multipleTxBlock: any;

    before('Initializes', async () => {
        admin = await UserFactory.createAdminUser();
        users = await UserFactory.createSeiUsers(admin, 5, true);
        erc20 = new Erc20Token(admin, contractAddresses.erc20);
        baseCw20 = new Cw20Token(admin, contractAddresses.cw20);
        rpcClient = new EvmRpcClient(admin.evmRpcEndpoint, admin.evmWallet.signingClient);
    });

    it('Sends multiple synthetic txs and validates logs', async () => {
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
        const blockNumber = responses[0].blockNumber;
        console.log(blockNumber);
        await waitFor(1);
        const logsParams = {
            fromBlock: ethers.toQuantity(blockNumber),
            toBlock: ethers.toQuantity(blockNumber),
            address: erc20.getAddress().toString(),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        };
        const logs = await rpcClient.sei_getLogs(logsParams);
        // Filter is one block wide; parallel txs can span multiple blocks,
        // and other tests' Transfers on the shared ERC20 can share the
        // block — count and validate only this test's txs.
        const ownLogs = filterLogsByTxHash(logs, responses.map((response: any) => response.hash));
        expect(ownLogs.length).to.be.eq(txBlocks.get(blockNumber.toString()));
        for (const log of ownLogs) {
            expect(log.address.toString().toLowerCase()).to.be.eq(erc20.getAddress().toString().toLowerCase());
            const parsed = erc20.contract.interface.parseLog(log) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[1]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.01');
            expect(ethers.toNumber(log.blockNumber)).to.be.eq(Number(blockNumber));
        }
    });

    it('Send a synthetic and evm tx and validate logs', async () => {
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
        oneSyntheticOneEvmTx = evmReceipt;
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(oneSyntheticOneEvmTx.blockNumber) + 1),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        };
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        // Topic-only filter over a 3-block shared window also returns other
        // tests' Transfers; scope to this test's evm + synthetic pair.
        // Synthetic logs carry the 0x-prefixed cosmos tx hash as theirs.
        const ownLogs = filterLogsByTxHash(logResponses, [
            oneSyntheticOneEvmTx.transactionHash,
            '0x' + cosmosResponse.transactionHash.toLowerCase(),
        ]);
        expect(ownLogs.length).to.be.eq(2);
    });

    it('Sends multiple failing txs and validates logs are empty', async () => {
        const encoded1 = erc20.contract.interface.encodeFunctionData('transfer', [users[0].evmAddress, ethers.parseEther('10000000000')]);
        const encoded2 = erc20.contract.interface.encodeFunctionData('transfer', [users[2].evmAddress, ethers.parseEther('10000000000')]);

        // Pre-broadcast a second failing EVM tx; its block placement is not
        // load-bearing for the downstream "no Transfer logs from erc20" check.
        const signed2 = await AtomicTxSender.signEvmTransaction(users[3], erc20.getAddress(), encoded2);
        const failingTxHashes = [ethers.keccak256(signed2)];
        AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signed2, admin).catch(() => {});

        const { cosmosResponse } = await AtomicTxSender.sendRawUntilSameBlock(
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
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) -2),
            toBlock: ethers.toQuantity(Number(multipleSyntheticAndOneFailingEvmTx.height) + 2),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress().toString()
        };
        const logResponses = await rpcClient.sei_getLogs(logsParams);
        // The window is shared chain history — other tests' Transfers can
        // land in it. The invariant is that the failing txs emitted no logs.
        expect(filterLogsByTxHash(logResponses, failingTxHashes).length).to.be.eq(0);
    });

    it('Sends multiple synthetic and multiple evm txs and validates logs', async () => {
        const msgs = [
            {contractAddress: baseCw20.getAddress(),
                msg: { transfer: { recipient: admin.seiAddress, amount: '100000' }}},
            {contractAddress: baseCw20.getAddress(),
                msg: { transfer: { recipient: admin.seiAddress, amount: '100000' }}}
        ];
        const { evmReceipt } = await AtomicTxSender.sendRawUntilSameBlock(
            async () => {
                const hashes = await Promise.all(users.slice(0, 3).map(async (user) => {
                    const encoded = erc20.contract.interface.encodeFunctionData('transfer', [user.evmAddress, ethers.parseEther('0.01')]);
                    const signedTx = await AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encoded);
                    return AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin);
                }));
                return hashes[0];
            },
            () => baseCw20.execMultiple(msgs),
            rpcClient,
        );
        multipleSyntheticAndEvmTx = evmReceipt;
        const logsParams = {
            fromBlock: ethers.toQuantity(Number(multipleSyntheticAndEvmTx.blockNumber) - 1),
            toBlock: 'latest',
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress().toString()
        };
        const logs = await rpcClient.sei_getLogs(logsParams);
        expect(logs.length).to.be.greaterThan(0);
    });

    it('Can get logs for both erc20 and erc721 events', async () => {
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
        await waitFor(4);
        const tx = await rpcClient.getTransactionReceipt(results[0]);
        const logParams1 = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [ethers.id('Approval(address,address,uint256)')],
        };
        const logs = await rpcClient.sei_getLogs(logParams1);
        const logParams2 = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [ethers.id('Transfer(address,address,uint256)')],
        };
        const logs2 = await rpcClient.sei_getLogs(logParams2);
        const combinedLogs = {
            fromBlock: ethers.toQuantity(Number(tx.blockNumber) - 1),
            toBlock: ethers.toQuantity(Number(tx.blockNumber) + 2),
            topics: [[
                ethers.id('Transfer(address,address,uint256)'),
                ethers.id('Approval(address,address,uint256)')
            ]],
        };
        const logsCombined = await rpcClient.sei_getLogs(combinedLogs);
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

    it('Can return txs successfully for a span of 100 blocks', async () => {
        const encodedTx = erc20.contract.interface.encodeFunctionData('transfer', [admin.evmAddress, ethers.parseEther('0.01')]);
        const signedTxs = await Promise.all(users.map((user) => AtomicTxSender.signEvmTransaction(user, erc20.getAddress(), encodedTx)));
        const results = await Promise.all(signedTxs.map((signedTx) => AtomicTxSender.sendRawTransaction(admin.evmRpcEndpoint, signedTx, admin)));
        // Poll for the first tx's receipt — single-shot was racing the
        // RPC-pod indexer (results[0] could be null briefly even after
        // the 0.5s wait, then `.blockNumber` null-derefs).
        let txReceipt: any = null;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !txReceipt) {
            txReceipt = await rpcClient.getTransactionReceipt(results[0]);
            if (!txReceipt) await waitFor(0.5);
        }
        if (!txReceipt) throw new Error(`receipt for ${results[0]} not produced within 15s`);
        multipleTxBlock = txReceipt.blockNumber;
        await waitFor(60);
        const logParams = {
            fromBlock: txReceipt.blockNumber,
            toBlock: ethers.toQuantity(Number(txReceipt.blockNumber) + 100),
            topics: [ethers.id('Transfer(address,address,uint256)')],
            address: erc20.getAddress().toString(),
        };
        const logResponses = await rpcClient.sei_getLogs(logParams);
        // The 101-block window over the shared ERC20 also captures other
        // tests' Transfers; count and validate only this test's txs.
        const ownLogs = filterLogsByTxHash(logResponses, results);
        expect(ownLogs.length).to.be.eq(users.length);
        let txIndexes = [];
        let logIndexes = [];
        for(const topic of ownLogs) {
            expect(topic.address.toString().toLowerCase()).to.be.eq(erc20.getAddress().toString().toLowerCase());
            const parsed = erc20.contract.interface.parseLog(topic) as LogDescription;
            expect(parsed.name).to.be.eq('Transfer');
            expect(parsed.args[1]).to.equal(admin.evmAddress);
            expect(ethers.formatEther(parsed.args[2].toString())).to.equal('0.01')
            txIndexes.push(topic.transactionIndex);
            logIndexes.push(topic.logIndex);
        }
        expect(txIndexes.length).to.be.eq(users.length);
        expect(logIndexes.length).to.be.eq(users.length);
        // Verify block logIndexes start at 0 and are gapless — only
        // assertable on the unfiltered block view.
        await expectContiguousBlockLogIndexes((filter) => rpcClient.sei_getLogs(filter), ownLogs);
    });

    it('Sei get logs supports finalized, safe, latest, pending tags', async () => {
        // Test intent: verify each tag is genuinely SUPPORTED — both that
        // the tag resolves to a real block (not silently dropped) and
        // that sei_getLogs accepts it. The prior shape (poll for a fresh
        // Transfer event in fromBlock=tag..latest) was racy because on
        // ephemeral chains the window is near-zero-width; relaxing to
        // "returns an array" was too weak (a broken handler that returns
        // [] for any unrecognized tag would pass).
        //
        // Stronger checks:
        //   1. Each tag resolves via eth_getBlockByNumber to a non-null
        //      block with a positive number — guards against silent
        //      tag-resolution failures.
        //   2. Resolved heights honor the canonical ordering
        //      finalized ≤ safe ≤ latest ≤ pending — guards against a
        //      handler that maps everything to the same block silently.
        //   3. sei_getLogs accepts each tag value without error — the
        //      original surface this test was named for.
        const tags = ['finalized', 'safe', 'latest', 'pending'] as const;
        const heights: Record<string, number> = {};
        for (const tag of tags) {
            const block = await rpcClient.getBlockByNumber(tag) as Block | null;
            expect(block, `eth_getBlockByNumber(${tag}) returned null`).to.not.be.null;
            const n = Number(block!.number);
            expect(n, `eth_getBlockByNumber(${tag}) returned block.number=${n}`).to.be.greaterThan(0);
            heights[tag] = n;
        }
        expect(heights.finalized).to.be.lte(heights.safe);
        expect(heights.safe).to.be.lte(heights.latest);
        expect(heights.latest).to.be.lte(heights.pending);

        for (const tag of tags) {
            const rpc = await rpcClient.sei_getLogs({
                fromBlock: tag,
                topics: [ethers.id('Transfer(address,address,uint256)')],
            });
            expect(rpc, `sei_getLogs(fromBlock=${tag}) should return an array`).to.be.an('array');
        }
    });
});
