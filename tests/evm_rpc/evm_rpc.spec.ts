import { ethers, formatEther } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { TokenDeployer } from '../../shared/Deployer';
import { waitFor } from '../../shared/utils/helpers';

describe('EVM RPC Tests', function () {
    this.timeout(5 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let provider: ethers.JsonRpcProvider;
    let deployer: TokenDeployer;

    before('Initialize users', async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'alice');
        provider = admin.evmWallet.signingClient;
        deployer = new TokenDeployer(admin);
    });

    describe('Info RPC calls', function () {
        it('eth_blockNumber returns a positive block number', async () => {
            const blockNumber = await provider.send('eth_blockNumber', []);
            expect(parseInt(blockNumber)).to.be.above(0);
        });

        it('eth_chainId returns a valid chain id', async () => {
            const chainId = await provider.send('eth_chainId', []);
            expect(parseInt(chainId)).to.be.above(0);
        });

        it('eth_gasPrice returns a reasonable gas price', async () => {
            const gasPrice = await provider.send('eth_gasPrice', []);
            expect(parseInt(gasPrice)).to.be.above(0);
        });

        it('eth_feeHistory returns valid fee data', async () => {
            const lastBlock = await provider.getBlockNumber();
            const feeHistory = await provider.send('eth_feeHistory', [
                ethers.toQuantity(10),
                ethers.toQuantity(lastBlock),
                [10.0],
            ]);

            expect(parseInt(feeHistory.oldestBlock)).to.be.above(0);
            expect(feeHistory.baseFeePerGas).to.be.an('array').with.length.above(0);
            expect(feeHistory.gasUsedRatio).to.be.an('array').with.length.above(0);
        });

        it('eth_maxPriorityFeePerGas returns a value', async () => {
            const maxPriority = await provider.send('eth_maxPriorityFeePerGas', []);
            expect(parseInt(maxPriority)).to.be.gte(0);
        });

        it('eth_accounts returns an array', async () => {
            const accounts = await provider.send('eth_accounts', []);
            expect(accounts).to.be.an('array');
        });
    });

    describe('Block RPC calls', function () {
        let blockNumber: string;
        let blockHash: string;
        let txHash: string;

        before('Send a transfer to generate a block with a tx', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.01'),
            });
            const receipt = await tx.wait();
            txHash = receipt!.hash;
            blockNumber = ethers.toQuantity(receipt!.blockNumber);
            blockHash = receipt!.blockHash;
        });

        it('eth_getBlockReceipts returns receipts by block number', async () => {
            const receipts = await provider.send('eth_getBlockReceipts', [blockNumber]);
            expect(receipts).to.be.an('array').with.length.above(0);

            const txReceipt = receipts.find((r: any) => r.transactionHash === txHash);
            expect(txReceipt).to.not.be.undefined;
            expect(txReceipt.from).to.eq(admin.evmAddress.toLowerCase());
            expect(txReceipt.to).to.eq(alice.evmAddress.toLowerCase());
        });

        it('eth_getBlockReceipts returns receipts by block hash', async () => {
            const receipts = await provider.send('eth_getBlockReceipts', [blockHash]);
            expect(receipts).to.be.an('array').with.length.above(0);
            const txReceipt = receipts.find((r: any) => r.transactionHash === txHash);
            expect(txReceipt).to.not.be.undefined;
        });

        it('eth_getBlockTransactionCountByNumber returns correct count', async () => {
            const txCount = await provider.send('eth_getBlockTransactionCountByNumber', [blockNumber]);
            expect(parseInt(txCount)).to.be.gte(1);
        });

        it('eth_getBlockTransactionCountByHash returns correct count', async () => {
            const txCount = await provider.send('eth_getBlockTransactionCountByHash', [blockHash]);
            expect(parseInt(txCount)).to.be.gte(1);
        });

        it('eth_getBlockByHash returns block with transactions', async () => {
            const block = await provider.send('eth_getBlockByHash', [blockHash, true]);
            expect(block.transactions).to.have.length.gte(1);
            expect(block.hash).to.eq(blockHash);
        });

        it('eth_getBlockByNumber returns block with transactions', async () => {
            const block = await provider.send('eth_getBlockByNumber', [blockNumber, false]);
            expect(block.transactions).to.have.length.gte(1);
            expect(block.hash).to.eq(blockHash);
        });
    });

    describe('State RPC calls', function () {
        let latestBalance: string;
        let latestBlockNumber: number;

        before('Record latest balance', async () => {
            latestBlockNumber = await provider.getBlockNumber();
            latestBalance = await provider.send('eth_getBalance', [admin.evmAddress, 'latest']);
        });

        it('eth_getBalance returns a non-zero balance for funded account', async () => {
            expect(BigInt(latestBalance) > 0n).to.equal(true, 'Admin should have a balance');
        });

        it('eth_getBalance returns balance at a specific block number', async () => {
            const balance = await provider.send('eth_getBalance', [
                admin.evmAddress,
                ethers.toQuantity(latestBlockNumber),
            ]);
            expect(balance).to.eq(latestBalance);
        });

        it('eth_getBalance returns balance at a block hash', async () => {
            const block = await provider.send('eth_getBlockByNumber', [
                ethers.toQuantity(latestBlockNumber),
                false,
            ]);
            const balance = await provider.send('eth_getBalance', [admin.evmAddress, block.hash]);
            expect(balance).to.eq(latestBalance);
        });

        it('eth_getBalance reflects changes after a transfer', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.1'),
            });
            await tx.wait();
            await waitFor(2);

            const newBalance = await provider.send('eth_getBalance', [admin.evmAddress, 'latest']);
            const diff = BigInt(latestBalance) - BigInt(newBalance);
            expect(Number(formatEther(diff.toString()))).to.be.gte(0.1);
        });

        it('eth_getCode returns bytecode for a deployed contract', async () => {
            const erc20 = await deployer.deployErc20();
            await waitFor(2);
            const code = await provider.send('eth_getCode', [erc20.getAddress(), 'latest']);
            expect(code).to.not.eq('0x');
            expect(code.length).to.be.above(10);
        });

        it('eth_getTransactionCount returns nonce for admin', async () => {
            const nonce = await provider.send('eth_getTransactionCount', [admin.evmAddress, 'latest']);
            expect(parseInt(nonce)).to.be.above(0);
        });

        it('eth_estimateGas returns a reasonable estimate for a transfer', async () => {
            const estimate = await provider.send('eth_estimateGas', [
                {
                    from: admin.evmAddress,
                    to: alice.evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.001')),
                },
            ]);
            expect(parseInt(estimate)).to.be.within(21000, 100000);
        });
    });

    describe('Transaction RPC calls', function () {
        let txHash: string;
        let blockNumber: string;
        let blockHash: string;

        before('Send a transfer', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.01'),
            });
            const receipt = await tx.wait();
            txHash = receipt!.hash;
            blockNumber = ethers.toQuantity(receipt!.blockNumber);
            blockHash = receipt!.blockHash;
        });

        it('eth_getTransactionReceipt returns receipt with correct fields', async () => {
            const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);
            expect(receipt).to.have.property('blockHash');
            expect(receipt).to.have.property('blockNumber');
            expect(receipt).to.have.property('gasUsed');
            expect(receipt.from).to.eq(admin.evmAddress.toLowerCase());
            expect(receipt.to).to.eq(alice.evmAddress.toLowerCase());
        });

        it('eth_getTransactionByHash returns correct tx details', async () => {
            const txDetails = await provider.send('eth_getTransactionByHash', [txHash]);
            expect(txDetails).to.have.property('blockHash');
            expect(txDetails).to.have.property('blockNumber');
            expect(txDetails.from).to.eq(admin.evmAddress.toLowerCase());
            expect(txDetails.to).to.eq(alice.evmAddress.toLowerCase());
        });

        it('eth_getTransactionByBlockNumberAndIndex returns correct tx', async () => {
            const txDetails = await provider.send('eth_getTransactionByBlockNumberAndIndex', [
                blockNumber,
                ethers.toQuantity(0),
            ]);
            expect(txDetails).to.not.be.null;
            expect(txDetails).to.have.property('blockHash');
            expect(txDetails.from).to.eq(admin.evmAddress.toLowerCase());
        });

        it('eth_getTransactionByBlockHashAndIndex returns correct tx', async () => {
            const txDetails = await provider.send('eth_getTransactionByBlockHashAndIndex', [
                blockHash,
                ethers.toQuantity(0),
            ]);
            expect(txDetails).to.not.be.null;
            expect(txDetails).to.have.property('blockHash');
            expect(txDetails.from).to.eq(admin.evmAddress.toLowerCase());
        });

        it('eth_getTransactionByBlockHashAndIndex returns null for non-existent index', async () => {
            const txDetails = await provider.send('eth_getTransactionByBlockHashAndIndex', [
                blockHash,
                ethers.toQuantity(999),
            ]);
            expect(txDetails).to.be.null;
        });

        it('eth_getTransactionCount increases after a new transaction', async () => {
            const countBefore = await provider.send('eth_getTransactionCount', [admin.evmAddress, 'latest']);

            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            await tx.wait();

            const countAfter = await provider.send('eth_getTransactionCount', [admin.evmAddress, 'latest']);
            expect(parseInt(countAfter)).to.be.above(parseInt(countBefore));
        });
    });

    describe('Sei-specific RPC calls', function () {
        it('sei_getSeiAddress returns the associated sei address for an EVM address', async () => {
            const seiAddr = await provider.send('sei_getSeiAddress', [admin.evmAddress]);
            expect(seiAddr).to.be.a('string');
            expect(seiAddr).to.match(/^sei1/);
            expect(seiAddr).to.eq(admin.seiAddress);
        });

        it('sei_getEVMAddress returns the associated EVM address for a Sei address', async () => {
            const evmAddr = await provider.send('sei_getEVMAddress', [admin.seiAddress]);
            expect(evmAddr).to.be.a('string');
            expect(evmAddr).to.match(/^0x/);
            expect(evmAddr.toLowerCase()).to.eq(admin.evmAddress.toLowerCase());
        });

        it('sei_getCosmosTx returns cosmos tx hash for an EVM tx', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();
            await waitFor(1);

            const cosmosTxHash = await provider.send('sei_getCosmosTx', [receipt!.hash]);
            expect(cosmosTxHash).to.be.a('string');
            expect(cosmosTxHash.length).to.be.above(0);
        });

        it('sei_getEvmTx returns EVM tx hash for a cosmos tx hash', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();
            await waitFor(1);

            const cosmosTxHash = await provider.send('sei_getCosmosTx', [receipt!.hash]);
            const evmTxHash = await provider.send('sei_getEvmTx', [cosmosTxHash]);
            expect(evmTxHash).to.be.a('string');
            expect(evmTxHash).to.match(/^0x/);
        });
    });

    describe('eth_getLogs', function () {
        let erc20Address: string;
        let erc20Contract: ethers.Contract;
        let transferBlockNumber: number;

        before('Deploy ERC20 and make a transfer', async () => {
            const erc20 = await deployer.deployErc20();
            erc20Address = erc20.getAddress();
            erc20Contract = erc20.contract;
            await waitFor(2);

            const tx = await erc20.mint(alice.evmAddress, ethers.parseEther('100').toString());
            await tx.wait();
            transferBlockNumber = await provider.getBlockNumber();
        });

        it('eth_getLogs returns logs for a contract within a block range', async () => {
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const logs = await provider.send('eth_getLogs', [
                {
                    fromBlock: ethers.toQuantity(transferBlockNumber - 5),
                    toBlock: 'latest',
                    address: erc20Address,
                    topics: [transferTopic],
                },
            ]);
            expect(logs).to.be.an('array').with.length.above(0);
            expect(logs[0].address.toLowerCase()).to.eq(erc20Address.toLowerCase());
            expect(logs[0].topics[0]).to.eq(transferTopic);
        });

        it('eth_getLogs returns empty array for non-matching filter', async () => {
            const fakeTopic = ethers.keccak256(ethers.toUtf8Bytes('FakeEvent(uint256)'));
            const logs = await provider.send('eth_getLogs', [
                {
                    fromBlock: ethers.toQuantity(transferBlockNumber - 5),
                    toBlock: 'latest',
                    address: erc20Address,
                    topics: [fakeTopic],
                },
            ]);
            expect(logs).to.be.an('array').with.length(0);
        });
    });

    describe('eth_call', function () {
        let erc20Address: string;
        let erc20Contract: ethers.Contract;

        before('Deploy ERC20 and mint', async () => {
            const erc20 = await deployer.deployErc20();
            erc20Address = erc20.getAddress();
            erc20Contract = erc20.contract;
            await waitFor(2);

            const tx = await erc20.mint(admin.evmAddress, ethers.parseEther('1000').toString());
            await tx.wait();
        });

        it('eth_call returns correct balanceOf result', async () => {
            const callData = erc20Contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
            const response = await provider.send('eth_call', [
                { to: erc20Address, data: callData },
                'latest',
            ]);
            const decoded = erc20Contract.interface.decodeFunctionResult('balanceOf', response);
            expect(decoded[0] > 0n).to.equal(true);
        });

        it('eth_call does not modify state', async () => {
            const balanceBefore = await erc20Contract.balanceOf(admin.evmAddress);
            const callData = erc20Contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
            await provider.send('eth_call', [{ to: erc20Address, data: callData }, 'latest']);
            const balanceAfter = await erc20Contract.balanceOf(admin.evmAddress);
            expect(balanceAfter).to.eq(balanceBefore);
        });

        it('eth_call reverts with invalid call data', async () => {
            try {
                await provider.send('eth_call', [
                    { from: admin.evmAddress, to: erc20Address, data: '0x1234' },
                    'latest',
                ]);
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        it('eth_call reverts with non-existent function selector', async () => {
            try {
                await provider.send('eth_call', [
                    { from: admin.evmAddress, to: erc20Address, data: '0xdeadbeef' },
                    'latest',
                ]);
                throw new Error('Should have reverted');
            } catch (e: any) {
                expect(e.message).to.not.contain('Should have reverted');
            }
        });

        const blockTags = ['latest', 'finalized', 'safe'];
        for (const tag of blockTags) {
            it(`eth_call works with block tag ${tag}`, async () => {
                const callData = erc20Contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
                const response = await provider.send('eth_call', [
                    { to: erc20Address, data: callData },
                    tag,
                ]);
                const decoded = erc20Contract.interface.decodeFunctionResult('balanceOf', response);
                expect(decoded[0] > 0n).to.equal(true);
            });
        }
    });

    describe('Debug RPC calls', function () {
        let txHash: string;

        before('Send a transaction to trace', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.01'),
            });
            const receipt = await tx.wait();
            txHash = receipt!.hash;
        });

        it('debug_traceTransaction returns trace with default params', async () => {
            const debugResult = await provider.send('debug_traceTransaction', [txHash]);
            expect(debugResult).to.have.property('gas');
            expect(debugResult.gas).to.be.above(0);
            expect(debugResult).to.have.property('structLogs').that.is.an('array');
            expect(debugResult).to.have.property('returnValue');
        });

        it('debug_traceTransaction with callTracer returns call info', async () => {
            const debugResult = await provider.send('debug_traceTransaction', [
                txHash,
                { tracer: 'callTracer' },
            ]);
            expect(debugResult.from.toLowerCase()).to.eq(admin.evmAddress.toLowerCase());
            expect(debugResult.to.toLowerCase()).to.eq(alice.evmAddress.toLowerCase());
            expect(debugResult.type).to.eq('CALL');
            expect(parseInt(debugResult.gas)).to.be.above(0);
        });

        it('debug_traceTransaction fails with non-existent tx hash', async () => {
            const fakeHash = '0x' + '0'.repeat(64);
            try {
                await provider.send('debug_traceTransaction', [fakeHash]);
                throw new Error('Should have failed');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should have failed');
            }
        });

        it('debug_traceCall succeeds with finalized block tag', async () => {
            const debugResult = await provider.send('debug_traceCall', [
                {
                    from: admin.evmAddress,
                    to: alice.evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.001')),
                },
                'finalized',
            ]);
            expect(debugResult).to.have.property('gas');
            expect(debugResult.gas).to.be.gte(21000);
        });

        it('debug_traceCall with callTracer returns call structure', async () => {
            const debugResult = await provider.send('debug_traceCall', [
                {
                    from: admin.evmAddress,
                    to: alice.evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.001')),
                },
                'latest',
                { tracer: 'callTracer' },
            ]);
            expect(debugResult.from.toLowerCase()).to.eq(admin.evmAddress.toLowerCase());
            expect(debugResult.to.toLowerCase()).to.eq(alice.evmAddress.toLowerCase());
            expect(debugResult.type).to.eq('CALL');
        });

        it('debug_traceCall fails with non-existent block hash', async () => {
            const fakeHash = '0x' + '0'.repeat(64);
            try {
                await provider.send('debug_traceCall', [
                    { from: admin.evmAddress, to: alice.evmAddress, value: '0x0' },
                    fakeHash,
                ]);
                throw new Error('Should have failed');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should have failed');
            }
        });

        it('debug_traceBlockByNumber returns traces for a block', async () => {
            const receipt = await provider.getTransactionReceipt(txHash);
            const traces = await provider.send('debug_traceBlockByNumber', [
                ethers.toQuantity(receipt!.blockNumber),
            ]);
            expect(traces).to.be.an('array').with.length.above(0);
            const entry = traces[0];
            expect(entry).to.have.property('txHash');
            expect(entry).to.have.property('result');
            expect(entry.result).to.have.property('gas');
        });

        it('debug_traceBlockByHash returns traces for a block', async () => {
            const receipt = await provider.getTransactionReceipt(txHash);
            const traces = await provider.send('debug_traceBlockByHash', [receipt!.blockHash]);
            expect(traces).to.be.an('array').with.length.above(0);
            const entry = traces[0];
            expect(entry).to.have.property('txHash');
            expect(entry).to.have.property('result');
        });

        it('debug_traceBlockByNumber fails with non-existent block', async () => {
            const currentBlock = await provider.getBlockNumber();
            try {
                await provider.send('debug_traceBlockByNumber', [
                    ethers.toQuantity(currentBlock + 100000),
                ]);
                throw new Error('Should have failed');
            } catch (e: any) {
                expect(e.message).to.not.eq('Should have failed');
            }
        });
    });
});
