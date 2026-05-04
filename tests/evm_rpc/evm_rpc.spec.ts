import { ethers, formatEther } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { TokenDeployer } from '../../shared/Deployer';
import { queryEip1559Params, waitFor } from '../../shared/utils/helpers';
import STORAGE_ARTIFACT from '../../artifacts/contracts/storage.sol/StorageTest.json';
import ERC20_ARTIFACT from '../../artifacts/contracts/TestERC20.sol/TestERC20.json';
import {
    SIMPLE_TRANSFER_GAS,
    USEI_TO_WEI,
    ZERO_ADDRESS,
    expectAddress,
    expectAddressEq,
    expectBlockFields,
    expectData,
    expectEip1898BlockHash,
    expectHash,
    expectLogFields,
    expectOnlyKnownFields,
    expectOptionalData,
    expectQuantity,
    expectQuantityEq,
    expectQuantityGte,
    expectReceiptFields,
    expectTransactionFields,
    rawRpc,
} from './rpcTestUtils';

/**
 * Happy-path coverage of every EVM JSON-RPC method documented at
 * https://docs.sei.io/evm/reference, plus the default-enabled legacy sei_* helpers.
 *
 * Assertions cross-validate results against:
 *   - internally consistent RPCs (eth_chainId <-> net_version, getBlockByHash <-> getBlockByNumber, ...)
 *   - the Cosmos side (eth_blockNumber <-> cosmos height, eth_getBalance <-> bank usei * 10^12)
 *   - known values we just produced (exact gasUsed, exact nonce, decoded Transfer log, ...)
 */

describe('EVM RPC Tests', function () {
    this.timeout(5 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    // Fresh user with a known balance and zero outgoing txs; used for the
    // eth_getBalance <-> bank-balance cross-check.
    let wallet: SeiUser;
    let provider: ethers.JsonRpcProvider;
    let deployer: TokenDeployer;

    before('Initialize users', async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'alice');
        wallet = await UserFactory.createSeiUser(admin, 'walletForBalanceCheck');
        provider = admin.evmWallet.signingClient;
        deployer = new TokenDeployer(admin);
    });

    
    describe('Blockchain Information', function () {
        it('JSON-RPC responses use a spec-compliant envelope and echo the request id', async () => {
            const body = await rawRpc(admin.evmRpcEndpoint, 'eth_chainId');
            expectOnlyKnownFields(body, ['jsonrpc', 'id', 'result'], 'JSON-RPC success response');
            expect(body.result).to.eq(await provider.send('eth_chainId', []));
        });

        it('JSON-RPC unknown methods return the standard method-not-found error', async () => {
            const body = await rawRpc(admin.evmRpcEndpoint, 'eth_methodThatDoesNotExist');
            expectOnlyKnownFields(body, ['jsonrpc', 'id', 'error'], 'JSON-RPC error response');
            expectOnlyKnownFields(body.error, ['code', 'data', 'message'], 'JSON-RPC error object');
            expect(body.error.code).to.eq(-32601);
            expect(body.error.message.toLowerCase()).to.include('method');
        });

        it('eth_blockNumber matches the Cosmos block height (Sei has 1:1 mapping)', async () => {
            const rawBlock = await provider.send('eth_blockNumber', []);
            const evmBlock = Number(expectQuantity(rawBlock, 'eth_blockNumber'));
            const cosmosHeight = await admin.seiWallet.signingClient.getHeight();
            expect(evmBlock).to.be.above(0);
            // Small tolerance to account for a block arriving between the two calls.
            expect(Math.abs(evmBlock - cosmosHeight)).to.be.lte(2,
                `EVM block ${evmBlock} should equal cosmos height ${cosmosHeight} within 2 blocks`);
        });

        it('eth_chainId and net_version return the same chain id in hex/decimal', async () => {
            const hexId = await provider.send('eth_chainId', []);
            const decId = await provider.send('net_version', []);
            expectQuantity(hexId, 'eth_chainId');
            expect(parseInt(hexId, 16)).to.eq(parseInt(decId, 10),
                `eth_chainId (${hexId}) should equal net_version (${decId}) when normalized`);
            // Sanity: the runtime-configured network matches this id
            const network = await provider.getNetwork();
            expect(Number(network.chainId)).to.eq(parseInt(hexId, 16));
        });

        it.skip('SKIP missing implementation: eth_protocolVersion should return the Ethereum protocol version', async () => {
            const protocolVersion = await provider.send('eth_protocolVersion', []);
            expectQuantity(protocolVersion, 'eth_protocolVersion');
        });

        it('web3_clientVersion returns a version identifying a Sei node', async () => {
            const clientVersion = await provider.send('web3_clientVersion', []);
            expect(clientVersion.length).to.be.above(0);
            expect(clientVersion.toLowerCase()).to.match(/sei|evm|ethereum|geth/);
        });

        it.skip('SKIP missing implementation: web3_sha3 should return the keccak256 hash of the supplied bytes', async () => {
            const payload = ethers.hexlify(ethers.toUtf8Bytes('sei-evm-rpc'));
            const hash = await provider.send('web3_sha3', [payload]);
            expect(hash).to.eq(ethers.keccak256(payload));
        });

        it.skip('SKIP missing implementation: net_listening and net_peerCount should report public RPC node status', async () => {
            const listening = await provider.send('net_listening', []);
            const peerCount = await provider.send('net_peerCount', []);
            expect(listening).to.eq(true);
            expectQuantityGte(peerCount, 0n, 'net_peerCount');
        });

        it.skip('SKIP missing implementation: eth_syncing should report false or a coherent sync range', async () => {
            const syncing = await provider.send('eth_syncing', []);
            if (syncing === false) {
                expect(syncing).to.eq(false);
                return;
            }

            expectOnlyKnownFields(syncing, [
                'currentBlock',
                'healedBytecodeBytes',
                'healedBytecodes',
                'healedTrienodeBytes',
                'healedTrienodes',
                'healingBytecode',
                'healingTrienodes',
                'highestBlock',
                'startingBlock',
                'syncedAccountBytes',
                'syncedAccounts',
                'syncedBytecodeBytes',
                'syncedBytecodes',
                'syncedStorage',
                'syncedStorageBytes',
            ], 'eth_syncing');
            const startingBlock = expectQuantity(syncing.startingBlock, 'eth_syncing.startingBlock');
            const currentBlock = expectQuantity(syncing.currentBlock, 'eth_syncing.currentBlock');
            const highestBlock = expectQuantity(syncing.highestBlock, 'eth_syncing.highestBlock');
            expect(currentBlock >= startingBlock).to.eq(true);
            expect(highestBlock >= currentBlock).to.eq(true);
            for (const field of Object.keys(syncing)) {
                if (!['startingBlock', 'currentBlock', 'highestBlock'].includes(field)) {
                    expectQuantityGte(syncing[field], 0n, `eth_syncing.${field}`);
                }
            }
        });

        it.skip('SKIP missing implementation: eth_mining and eth_hashrate should reflect non-PoW execution', async () => {
            const mining = await provider.send('eth_mining', []);
            const hashrate = await provider.send('eth_hashrate', []);
            expect(mining).to.eq(false);
            expectQuantityEq(hashrate, 0n, 'eth_hashrate');
        });

        it('eth_coinbase returns a valid 20-byte address', async () => {
            const coinbase = await provider.send('eth_coinbase', []);
            expectAddress(coinbase, 'eth_coinbase');
        });

        it('eth_gasPrice is positive and within the seid-configured [min, max] fee range', async () => {
            const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
            const params = await queryEip1559Params();
            const minFeePerGas = BigInt(Math.trunc(params.minFeePerGas));
            const maxFeePerGas = BigInt(Math.trunc(params.maxFeePerGas));
            expect(gasPrice > 0n).to.eq(true);
            expect(gasPrice >= minFeePerGas).to.eq(true,
                `gasPrice ${gasPrice} below seid KeyMinFeePerGas ${minFeePerGas}`);
            expect(gasPrice <= maxFeePerGas).to.eq(true,
                `gasPrice ${gasPrice} above seid KeyMaximumFeePerGas ${maxFeePerGas}`);
        });

        it('eth_maxPriorityFeePerGas returns a non-negative value <= gasPrice', async () => {
            const priority = BigInt(await provider.send('eth_maxPriorityFeePerGas', []));
            const gasPrice = BigInt(await provider.send('eth_gasPrice', []));
            expect(priority >= 0n).to.eq(true);
            expect(priority <= gasPrice).to.eq(true,
                `priority fee ${priority} should not exceed gasPrice ${gasPrice}`);
        });

        it.skip('SKIP missing implementation: eth_blobBaseFee should return the current blob gas base fee', async () => {
            const blobBaseFee = await provider.send('eth_blobBaseFee', []);
            expectQuantityGte(blobBaseFee, 0n, 'eth_blobBaseFee');
        });

        it('eth_feeHistory returns arrays with the requested number of blocks', async () => {
            const blockCount = 5;
            const lastBlock = await provider.getBlockNumber();
            const feeHistory = await provider.send('eth_feeHistory', [
                ethers.toQuantity(blockCount),
                ethers.toQuantity(lastBlock),
                [10, 50, 90],
            ]);

            expect(parseInt(feeHistory.oldestBlock, 16)).to.be.gte(lastBlock - blockCount);
            // Ethereum fee history includes one extra base fee for the next block.
            // Returning only blockCount entries is a conformance failure.
            expect(feeHistory.baseFeePerGas).to.have.length(blockCount + 1);
            expect(feeHistory.gasUsedRatio).to.have.length(blockCount);
            for (const ratio of feeHistory.gasUsedRatio) {
                expect(ratio).to.be.within(0, 1);
            }
            for (const baseFee of feeHistory.baseFeePerGas) {
                expect(BigInt(baseFee) > 0n).to.eq(true);
            }
            // One reward tuple per block, one entry per requested percentile
            expect(feeHistory.reward).to.have.length(blockCount);
            for (const tuple of feeHistory.reward) {
                expect(tuple).to.have.length(3);
                for (const reward of tuple) {
                    expectQuantityGte(reward, 0n, 'eth_feeHistory.reward[]');
                }
            }
        });

        it.skip('SKIP missing implementation: eth_accounts should return [] when the node has no unlocked accounts', async () => {
            const accounts = await provider.send('eth_accounts', []);
            expect(accounts.length).to.eq(0);
        });

        it('eth_sign returns an RPC error for accounts that are not unlocked on the node', async () => {
            const body = await rawRpc(admin.evmRpcEndpoint, 'eth_sign', [
                admin.evmAddress,
                ethers.hexlify(ethers.toUtf8Bytes('sei-rpc-conformance')),
            ]);
            expectOnlyKnownFields(body, ['jsonrpc', 'id', 'error'], 'eth_sign locked-account response');
            expectOnlyKnownFields(body.error, ['code', 'data', 'message'], 'eth_sign error object');
            expect(body.error.code).to.be.oneOf([-32000, -32602]);
            expect(body.error.message.toLowerCase()).to.match(/account|hosted key|key|unlock|sign|invalid/);
        });

        it('eth_signTransaction returns an RPC error because the public node has no hosted key', async () => {
            const body = await rawRpc(admin.evmRpcEndpoint, 'eth_signTransaction', [{
                from: admin.evmAddress,
                to: alice.evmAddress,
                value: ethers.toQuantity(ethers.parseEther('0.001')),
            }]);
            expectOnlyKnownFields(body, ['jsonrpc', 'id', 'error'], 'eth_signTransaction hosted-key response');
            expectOnlyKnownFields(body.error, ['code', 'data', 'message'], 'eth_signTransaction error object');
            expect(body.error.code).to.be.oneOf([-32000, -32602]);
            expect(body.error.message.toLowerCase()).to.match(/account|hosted key|key|unlock|sign|invalid/);
        });

        it('eth_sendTransaction returns an RPC error because the public node has no unlocked accounts', async () => {
            const body = await rawRpc(admin.evmRpcEndpoint, 'eth_sendTransaction', [{
                from: admin.evmAddress,
                to: alice.evmAddress,
                value: ethers.toQuantity(ethers.parseEther('0.001')),
            }]);
            expectOnlyKnownFields(body, ['jsonrpc', 'id', 'error'], 'eth_sendTransaction locked-account response');
            expectOnlyKnownFields(body.error, ['code', 'data', 'message'], 'eth_sendTransaction error object');
            expect(body.error.code).to.be.oneOf([-32000, -32602]);
            expect(body.error.message.toLowerCase()).to.match(/account|hosted key|key|unlock|sign|invalid/);
        });
    });

    /* ------------------------------------------------------------------ *
     * Account Information
     * ------------------------------------------------------------------ */
    describe('Account Information', function () {
        it('eth_getBalance equals the Cosmos bank balance in wei (usei * 10^12)', async () => {
            const evmWei = BigInt(await provider.send('eth_getBalance', [wallet.evmAddress, 'latest']));
            const bank = await wallet.seiWallet.queryBalance();
            const expectedWei = BigInt(bank.amount) * USEI_TO_WEI;
            expect(evmWei).to.eq(expectedWei,
                `EVM balance ${evmWei} wei != bank ${bank.amount} usei * 10^12 (${expectedWei})`);
        });

        it('eth_getBalance is identical when queried by number and by hash of the same block', async () => {
            const blockNumber = await provider.getBlockNumber();
            const blockTag = ethers.toQuantity(blockNumber);
            const byNumber = await provider.send('eth_getBalance', [admin.evmAddress, blockTag]);
            const block = await provider.send('eth_getBlockByNumber', [blockTag, false]);
            const blockIdentifier = { blockHash: block.hash, requireCanonical: true };
            expectEip1898BlockHash(blockIdentifier, block.hash);
            const byHash = await provider.send('eth_getBalance', [admin.evmAddress, blockIdentifier]);
            expect(byNumber).to.eq(byHash);
        });

        it('eth_getBalance decreases by >= transferred value after a transfer', async () => {
            const before = BigInt(await provider.send('eth_getBalance', [admin.evmAddress, 'latest']));
            const value = ethers.parseEther('0.1');
            const tx = await admin.evmWallet.wallet.sendTransaction({ to: alice.evmAddress, value });
            await tx.wait();
            await waitFor(1);
            const after = BigInt(await provider.send('eth_getBalance', [admin.evmAddress, 'latest']));
            const diff = before - after;
            expect(diff >= value).to.eq(true,
                `admin balance should drop by at least ${value} wei, dropped ${diff}`);
            expect(Number(formatEther(diff.toString()))).to.be.lt(1,
                'drop should be transfer + gas, far less than 1 SEI');
        });

        it('eth_getBalance returns historical balances at pre- and post-transfer block numbers', async () => {
            const beforeBlock = await provider.getBlockNumber();
            const aliceBefore = BigInt(await provider.send('eth_getBalance', [alice.evmAddress, ethers.toQuantity(beforeBlock)]));
            const value = ethers.parseEther('0.004');

            const tx = await admin.evmWallet.wallet.sendTransaction({ to: alice.evmAddress, value });
            const receipt = await tx.wait();
            const transferBlock = ethers.toQuantity(receipt!.blockNumber);

            const historicalBefore = BigInt(await provider.send('eth_getBalance', [alice.evmAddress, ethers.toQuantity(beforeBlock)]));
            const historicalAfter = BigInt(await provider.send('eth_getBalance', [alice.evmAddress, transferBlock]));

            expect(historicalBefore).to.eq(aliceBefore);
            expect(historicalAfter).to.eq(aliceBefore + value);
        });

        it('eth_getCode returns 0x for an EOA and deployed runtime bytecode for a contract', async () => {
            const eoaCode = await provider.send('eth_getCode', [alice.evmAddress, 'latest']);
            expect(eoaCode).to.eq('0x');

            const erc20 = await deployer.deployErc20();
            await waitFor(1);
            const contractCode = await provider.send('eth_getCode', [erc20.getAddress(), 'latest']);
            expect(contractCode).to.match(/^0x6080604052/i,
                'runtime bytecode should start with standard Solidity free-memory-pointer prelude');
            expect(contractCode.length).to.be.above(200);
        });

        it('eth_getCode returns 0x before deployment and runtime bytecode at the deployment block', async () => {
            const beforeBlock = await provider.getBlockNumber();
            const deployNonce = await admin.evmWallet.wallet.getNonce();
            const expectedAddress = ethers.getCreateAddress({
                from: admin.evmAddress,
                nonce: deployNonce,
            });

            const factory = new ethers.ContractFactory(
                ERC20_ARTIFACT.abi,
                ERC20_ARTIFACT.bytecode,
                admin.evmWallet.wallet,
            );
            const erc20 = await factory.deploy(admin.evmWallet.wallet);
            const deployedAddress = await erc20.getAddress();
            expect(deployedAddress.toLowerCase()).to.eq(expectedAddress.toLowerCase());

            const deploymentTx = erc20.deploymentTransaction();
            expect(deploymentTx, 'deployment transaction should be available').to.not.be.null;
            const deploymentReceipt = await deploymentTx!.wait();
            const beforeCode = await provider.send('eth_getCode', [deployedAddress, ethers.toQuantity(beforeBlock)]);
            const deployedCode = await provider.send('eth_getCode', [deployedAddress, ethers.toQuantity(deploymentReceipt!.blockNumber)]);

            expect(beforeCode).to.eq('0x');
            expect(deployedCode.length).to.be.above(200);
        });

        it('eth_getStorageAt reads known slots of a contract with a controlled layout', async () => {
            // Deploy `StorageTest` (slot 0 = `value: uint256`, slot 1 = `balances` mapping)
            // so the test isn't coupled to OpenZeppelin's inheritance linearization.
            const factory = new ethers.ContractFactory(
                STORAGE_ARTIFACT.abi,
                STORAGE_ARTIFACT.bytecode,
                admin.evmWallet.wallet,
            );
            const contract = await factory.deploy();
            await contract.waitForDeployment();
            const address = await contract.getAddress();

            // 1. Before any write, slot 0 is zero.
            const rawZero = await provider.send('eth_getStorageAt', [address, ethers.toBeHex(0, 32), 'latest']);
            expect(BigInt(rawZero)).to.eq(0n);

            // 2. After setValue(42), slot 0 reads exactly 42.
            const uniqueValue = 42n;
            await (await (contract as any).setValue(uniqueValue)).wait();
            await waitFor(1);
            const rawValue = await provider.send('eth_getStorageAt', [address, ethers.toBeHex(0, 32), 'latest']);
            expect(BigInt(rawValue)).to.eq(uniqueValue);

            // 3. Mapping slot itself (slot 1) is always zero; the entry lives at
            // keccak256(abi.encode(key, slot)).
            const mappingSlot = ethers.toBeHex(1, 32);
            const mappingBase = await provider.send('eth_getStorageAt', [address, mappingSlot, 'latest']);
            expect(BigInt(mappingBase)).to.eq(0n);

            const balanceAmount = 12345n;
            await (await (contract as any).setBalance(admin.evmAddress, balanceAmount)).wait();
            await waitFor(1);
            const entrySlot = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [admin.evmAddress, 1]),
            );
            const rawBalance = await provider.send('eth_getStorageAt', [address, entrySlot, 'latest']);
            expect(BigInt(rawBalance)).to.eq(balanceAmount);
        });

        it('eth_getStorageAt returns historical storage before and after a slot update', async () => {
            const factory = new ethers.ContractFactory(
                STORAGE_ARTIFACT.abi,
                STORAGE_ARTIFACT.bytecode,
                admin.evmWallet.wallet,
            );
            const contract = await factory.deploy();
            const deploymentReceipt = await contract.deploymentTransaction()!.wait();
            const address = await contract.getAddress();
            const deploymentBlock = ethers.toQuantity(deploymentReceipt!.blockNumber);

            const updatedValue = 777n;
            const updateTx = await (contract as any).setValue(updatedValue);
            const updateReceipt = await updateTx.wait();
            const updateBlock = ethers.toQuantity(updateReceipt.blockNumber);

            const valueAtDeployment = await provider.send('eth_getStorageAt', [address, ethers.toBeHex(0, 32), deploymentBlock]);
            const valueAtUpdate = await provider.send('eth_getStorageAt', [address, ethers.toBeHex(0, 32), updateBlock]);

            expect(BigInt(valueAtDeployment)).to.eq(0n);
            expect(BigInt(valueAtUpdate)).to.eq(updatedValue);
        });

        it.skip('SKIP missing implementation: eth_getStorageValues should return batched storage slot values', async () => {
            const values = await provider.send('eth_getStorageValues', [
                {
                    [admin.evmAddress]: [ethers.toBeHex(0, 32)],
                },
                'latest',
            ]);
            expectOnlyKnownFields(values, [admin.evmAddress], 'eth_getStorageValues');
        });

        it.skip('SKIP missing implementation: eth_getProof should return account/storage proof data', async () => {
            const seed = await admin.evmWallet.wallet.sendTransaction({ to: admin.evmAddress, value: 0 });
            await seed.wait();
            await waitFor(1);

            const proof = await provider.send('eth_getProof', [admin.evmAddress, [], 'latest']);
            expectOnlyKnownFields(proof, [
                'accountProof',
                'address',
                'balance',
                'codeHash',
                'nonce',
                'storageHash',
                'storageProof',
            ], 'eth_getProof');
            expectAddressEq(proof.address, admin.evmAddress, 'proof.address');
            expectQuantityGte(proof.balance, 0n, 'proof.balance');
            expectHash(proof.codeHash, 'proof.codeHash');
            expectQuantityGte(proof.nonce, 0n, 'proof.nonce');
            expectHash(proof.storageHash, 'proof.storageHash');
            expect(proof.storageProof.length).to.eq(0);
            for (const [index, proofNode] of proof.accountProof.entries()) {
                expectData(proofNode, `proof.accountProof[${index}]`);
            }
        });

        it('eth_getTransactionCount reflects the exact number of txs sent by the account', async () => {
            const nonceBefore = parseInt(
                await provider.send('eth_getTransactionCount', [admin.evmAddress, 'latest']),
                16,
            );
            const n = 2;
            for (let i = 0; i < n; i++) {
                const tx = await admin.evmWallet.wallet.sendTransaction({
                    to: alice.evmAddress,
                    value: ethers.parseEther('0.001'),
                });
                await tx.wait();
            }
            const nonceAfter = parseInt(
                await provider.send('eth_getTransactionCount', [admin.evmAddress, 'latest']),
                16,
            );
            expect(nonceAfter).to.eq(nonceBefore + n,
                `nonce should grow by exactly ${n}, grew by ${nonceAfter - nonceBefore}`);
        });

        it('eth_getTransactionCount returns historical nonces before and after a transaction', async () => {
            const beforeBlock = await provider.getBlockNumber();
            const nonceBefore = Number(expectQuantity(
                await provider.send('eth_getTransactionCount', [admin.evmAddress, ethers.toQuantity(beforeBlock)]),
                'historical nonce before',
            ));

            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();

            const historicalBefore = Number(expectQuantity(
                await provider.send('eth_getTransactionCount', [admin.evmAddress, ethers.toQuantity(beforeBlock)]),
                'historical nonce before re-read',
            ));
            const historicalAfter = Number(expectQuantity(
                await provider.send('eth_getTransactionCount', [admin.evmAddress, ethers.toQuantity(receipt!.blockNumber)]),
                'historical nonce after',
            ));

            expect(historicalBefore).to.eq(nonceBefore);
            expect(historicalAfter).to.eq(nonceBefore + 1);
        });

        it('eth_getTransactionCount for an unused EOA equals 0', async () => {
            const freshWallet = ethers.Wallet.createRandom();
            const nonce = await provider.send('eth_getTransactionCount', [freshWallet.address, 'latest']);
            expect(parseInt(nonce, 16)).to.eq(0);
        });
    });

    /* ------------------------------------------------------------------ *
     * Block Information
     * ------------------------------------------------------------------ */
    describe('Block Information', function () {
        let blockNumber: string;
        let blockHash: string;
        let txHash: string;
        let value: bigint;

        before('Send a transfer to pin the block under test', async () => {
            value = ethers.parseEther('0.01');
            const tx = await admin.evmWallet.wallet.sendTransaction({ to: alice.evmAddress, value });
            const receipt = await tx.wait();
            txHash = receipt!.hash;
            blockNumber = ethers.toQuantity(receipt!.blockNumber);
            blockHash = receipt!.blockHash;
        });

        it('eth_getBlockByNumber and eth_getBlockByHash return the same block', async () => {
            const byNumber = await provider.send('eth_getBlockByNumber', [blockNumber, true]);
            const byHash = await provider.send('eth_getBlockByHash', [blockHash, true]);

            expectBlockFields(byNumber, { hash: blockHash, number: blockNumber, transactionHash: txHash, fullTransactions: true });
            expectBlockFields(byHash, { hash: blockHash, number: blockNumber, transactionHash: txHash, fullTransactions: true });
            expect(byNumber.hash).to.eq(byHash.hash);
            const tx = byNumber.transactions.find((candidate: any) => candidate.hash === txHash);
            const txIndex = byNumber.transactions.findIndex((candidate: any) => candidate.hash === txHash);
            await expectTransactionFields(provider, tx, {
                hash: txHash,
                blockHash,
                blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                value,
                nonce: Number(expectQuantity(tx.nonce, 'transaction.nonce')),
                transactionIndex: txIndex,
            });
        });

        it('eth_getBlockByNumber chain integrity: parentHash(N) == hash(N-1)', async () => {
            const parent = await provider.send('eth_getBlockByNumber', [
                ethers.toQuantity(parseInt(blockNumber, 16) - 1),
                false,
            ]);
            const current = await provider.send('eth_getBlockByNumber', [blockNumber, false]);
            expectBlockFields(parent, { hash: parent.hash, number: parent.number, fullTransactions: false });
            expectBlockFields(current, { hash: blockHash, number: blockNumber, transactionHash: txHash, fullTransactions: false });
            expect(current.parentHash).to.eq(parent.hash);
            expect(parseInt(current.number, 16)).to.eq(parseInt(parent.number, 16) + 1);
        });

        it.skip('SKIP missing implementation: eth_getBlockAccessList should return block access list data', async () => {
            const accessList = await provider.send('eth_getBlockAccessList', [blockNumber]);
            for (const entry of accessList) {
                expectAddress(entry.address, 'block access list address');
            }
        });

        it('eth_getBlockTransactionCountByNumber == getBlockByNumber(.txs).length', async () => {
            const count = parseInt(
                await provider.send('eth_getBlockTransactionCountByNumber', [blockNumber]),
                16,
            );
            const block = await provider.send('eth_getBlockByNumber', [blockNumber, false]);
            expectBlockFields(block, { hash: blockHash, number: blockNumber, transactionHash: txHash, fullTransactions: false });
            expect(count).to.eq(block.transactions.length);
            expect(count).to.be.gte(1);
        });

        it('eth_getBlockTransactionCountByHash == getBlockByHash(.txs).length', async () => {
            const count = parseInt(
                await provider.send('eth_getBlockTransactionCountByHash', [blockHash]),
                16,
            );
            const block = await provider.send('eth_getBlockByHash', [blockHash, false]);
            expectBlockFields(block, { hash: blockHash, number: blockNumber, transactionHash: txHash, fullTransactions: false });
            expect(count).to.eq(block.transactions.length);
            expect(count).to.be.gte(1);
        });

        it.skip('SKIP missing implementation: uncle RPCs should return zero/null for Sei blocks', async () => {
            const countByNumber = await provider.send('eth_getUncleCountByBlockNumber', [blockNumber]);
            const countByHash = await provider.send('eth_getUncleCountByBlockHash', [blockHash]);
            const uncleByNumber = await provider.send('eth_getUncleByBlockNumberAndIndex', [blockNumber, '0x0']);
            const uncleByHash = await provider.send('eth_getUncleByBlockHashAndIndex', [blockHash, '0x0']);

            expectQuantityEq(countByNumber, 0n, 'eth_getUncleCountByBlockNumber');
            expectQuantityEq(countByHash, 0n, 'eth_getUncleCountByBlockHash');
            expect(uncleByNumber).to.eq(null);
            expect(uncleByHash).to.eq(null);
        });

        it('eth_getBlockReceipts returns one receipt per tx, aggregating correctly', async () => {
            const receipts = await provider.send('eth_getBlockReceipts', [blockNumber]);
            const block = await provider.send('eth_getBlockByNumber', [blockNumber, false]);
            expectBlockFields(block, { hash: blockHash, number: blockNumber, transactionHash: txHash, fullTransactions: false });
            expect(receipts).to.have.length(block.transactions.length);

            const ours = receipts.find((r: any) => r.transactionHash === txHash);
            expect(ours, 'our tx must appear in block receipts').to.not.be.undefined;
            expectReceiptFields(ours, {
                transactionHash: txHash,
                blockHash,
                blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                status: '0x1',
                gasUsed: SIMPLE_TRANSFER_GAS,
                logsLength: 0,
            });

            // cumulativeGasUsed must be monotonic and final one equals block.gasUsed
            let prev = 0;
            for (const r of receipts) {
                const cum = parseInt(r.cumulativeGasUsed, 16);
                expect(cum >= prev).to.eq(true);
                prev = cum;
            }
            expect(prev).to.eq(parseInt(block.gasUsed, 16));
        });
    });

    /* ------------------------------------------------------------------ *
     * Transaction Lookup
     * ------------------------------------------------------------------ */
    describe('Transaction Lookup', function () {
        let txHash: string;
        let blockNumber: string;
        let blockHash: string;
        let value: bigint;
        let nonce: number;
        let transactionIndex: number;

        before('Send a known-value transfer', async () => {
            nonce = await admin.evmWallet.wallet.getNonce();
            value = ethers.parseEther('0.02');
            const tx = await admin.evmWallet.wallet.sendTransaction({ to: alice.evmAddress, value });
            const receipt = await tx.wait();
            txHash = receipt!.hash;
            blockNumber = ethers.toQuantity(receipt!.blockNumber);
            blockHash = receipt!.blockHash;
            transactionIndex = receipt!.index;
        });

        it('eth_getTransactionReceipt contains the exact values we sent', async () => {
            const receipt = await provider.send('eth_getTransactionReceipt', [txHash]);
            expectReceiptFields(receipt, {
                transactionHash: txHash,
                blockHash,
                blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                status: '0x1',
                gasUsed: SIMPLE_TRANSFER_GAS,
                logsLength: 0,
                transactionIndex,
            });
        });

        it('eth_getTransactionByHash contains the exact tx fields', async () => {
            const tx = await provider.send('eth_getTransactionByHash', [txHash]);
            await expectTransactionFields(provider, tx, {
                hash: txHash,
                blockHash,
                blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                value,
                nonce,
                transactionIndex,
            });
        });

        it('eth_getTransactionByBlockNumberAndIndex returns the same tx as byHash', async () => {
            const block = await provider.send('eth_getBlockByNumber', [blockNumber, false]);
            const idx = block.transactions.indexOf(txHash);
            expect(idx).to.be.gte(0);
            const tx = await provider.send('eth_getTransactionByBlockNumberAndIndex', [
                blockNumber,
                ethers.toQuantity(idx),
            ]);
            await expectTransactionFields(provider, tx, {
                hash: txHash,
                blockHash,
                blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                value,
                nonce,
                transactionIndex: idx,
            });
        });

        it('eth_getTransactionByBlockHashAndIndex returns the same tx as byHash', async () => {
            const block = await provider.send('eth_getBlockByHash', [blockHash, false]);
            const idx = block.transactions.indexOf(txHash);
            expect(idx).to.be.gte(0);
            const tx = await provider.send('eth_getTransactionByBlockHashAndIndex', [
                blockHash,
                ethers.toQuantity(idx),
            ]);
            await expectTransactionFields(provider, tx, {
                hash: txHash,
                blockHash,
                blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                value,
                nonce,
                transactionIndex: idx,
            });
        });

        it('eth_sendRawTransaction broadcasts a signed transfer and state changes on-chain', async () => {
            const rawNonce = await provider.send('eth_getTransactionCount', [admin.evmAddress, 'pending']);
            const gasPrice = await provider.send('eth_gasPrice', []);
            const network = await provider.getNetwork();
            const rawValue = ethers.parseEther('0.003');
            const aliceBefore = BigInt(await provider.send('eth_getBalance', [alice.evmAddress, 'latest']));
            const signed = await admin.evmWallet.wallet.signTransaction({
                chainId: network.chainId,
                gasLimit: SIMPLE_TRANSFER_GAS,
                gasPrice: BigInt(gasPrice),
                nonce: Number(expectQuantity(rawNonce, 'pending nonce')),
                to: alice.evmAddress,
                value: rawValue,
            });
            const expectedHash = ethers.Transaction.from(signed).hash!;

            const broadcastHash = await provider.send('eth_sendRawTransaction', [signed]);
            expect(broadcastHash).to.eq(expectedHash);
            const receipt = await provider.waitForTransaction(broadcastHash);
            expect(receipt).to.not.eq(null);
            await waitFor(1);

            const rpcReceipt = await provider.send('eth_getTransactionReceipt', [broadcastHash]);
            const rpcTx = await provider.send('eth_getTransactionByHash', [broadcastHash]);
            const aliceAfter = BigInt(await provider.send('eth_getBalance', [alice.evmAddress, 'latest']));

            expect(aliceAfter - aliceBefore).to.eq(rawValue);
            expectReceiptFields(rpcReceipt, {
                transactionHash: broadcastHash,
                blockHash: rpcReceipt.blockHash,
                blockNumber: rpcReceipt.blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                status: '0x1',
                gasUsed: SIMPLE_TRANSFER_GAS,
                logsLength: 0,
            });
            await expectTransactionFields(provider, rpcTx, {
                hash: broadcastHash,
                blockHash: rpcReceipt.blockHash,
                blockNumber: rpcReceipt.blockNumber,
                from: admin.evmAddress,
                to: alice.evmAddress,
                value: rawValue,
                nonce: Number(expectQuantity(rawNonce, 'raw tx nonce')),
                transactionIndex: expectQuantity(rpcReceipt.transactionIndex, 'raw tx receipt.transactionIndex'),
            });
        });

        it('eth_getTransactionByBlockHashAndIndex returns null for an out-of-range index', async () => {
            const result = await provider.send('eth_getTransactionByBlockHashAndIndex', [
                blockHash,
                ethers.toQuantity(999),
            ]);
            expect(result).to.be.null;
        });

        it('eth_getTransactionReceipt returns null for an unknown hash', async () => {
            const fake = '0x' + '0'.repeat(64);
            const receipt = await provider.send('eth_getTransactionReceipt', [fake]);
            expect(receipt).to.be.null;
        });
    });

    /* ------------------------------------------------------------------ *
     * Simulation: eth_call & eth_estimateGas
     * ------------------------------------------------------------------ */
    describe('Simulation (eth_call, eth_estimateGas)', function () {
        let erc20Address: string;
        let erc20Contract: ethers.Contract;
        const MINT_AMOUNT = ethers.parseEther('1000');

        before('Deploy ERC20 and mint to admin', async () => {
            const erc20 = await deployer.deployErc20();
            erc20Address = erc20.getAddress() as string;
            erc20Contract = erc20.contract;
            await waitFor(1);
            const tx = await erc20.mint(admin.evmAddress, MINT_AMOUNT.toString());
            await tx.wait();
        });

        it('eth_estimateGas for a plain value transfer is exactly 21000', async () => {
            const estimate = BigInt(
                await provider.send('eth_estimateGas', [
                    {
                        from: admin.evmAddress,
                        to: alice.evmAddress,
                        value: ethers.toQuantity(ethers.parseEther('0.001')),
                    },
                ]),
            );
            expect(estimate).to.eq(SIMPLE_TRANSFER_GAS);
        });

        it('eth_estimateGas for an ERC20 transfer is close to actual gasUsed', async () => {
            const callData = erc20Contract.interface.encodeFunctionData('transfer', [
                alice.evmAddress,
                ethers.parseEther('1'),
            ]);
            const estimate = BigInt(
                await provider.send('eth_estimateGas', [
                    { from: admin.evmAddress, to: erc20Address, data: callData },
                ]),
            );

            const tx = await erc20Contract.transfer(alice.evmAddress, ethers.parseEther('1'));
            const receipt = await tx.wait();
            const gasUsed = BigInt(receipt.gasUsed);

            // Estimate must cover actual gasUsed and must not overshoot absurdly (<2x).
            expect(estimate >= gasUsed).to.eq(true,
                `estimate ${estimate} should cover gasUsed ${gasUsed}`);
            expect(estimate <= gasUsed * 2n).to.eq(true,
                `estimate ${estimate} should be within 2x of gasUsed ${gasUsed}`);
        });

        it('eth_createAccessList returns gas and an access list for a simple call', async () => {
            const result = await provider.send('eth_createAccessList', [
                {
                    from: admin.evmAddress,
                    to: alice.evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.001')),
                },
                'latest',
            ]);
            expectOnlyKnownFields(result, ['accessList', 'error', 'gasUsed'], 'eth_createAccessList');
            expectQuantityGte(result.gasUsed, SIMPLE_TRANSFER_GAS, 'eth_createAccessList.gasUsed');
            for (const entry of result.accessList) {
                expectOnlyKnownFields(entry, ['address', 'storageKeys'], 'eth_createAccessList entry');
                expectAddress(entry.address, 'eth_createAccessList.address');
                for (const key of entry.storageKeys) {
                    expectHash(key, 'eth_createAccessList.storageKeys[]');
                }
            }
        });

        it('eth_call balanceOf returns the exact minted amount', async () => {
            const callData = erc20Contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
            const raw = await provider.send('eth_call', [
                { to: erc20Address, data: callData },
                'latest',
            ]);
            const [balance] = erc20Contract.interface.decodeFunctionResult('balanceOf', raw);
            // We may have transferred 1 SEI worth of the token out in the previous test.
            expect(balance <= MINT_AMOUNT).to.eq(true);
            expect(balance >= MINT_AMOUNT - ethers.parseEther('2')).to.eq(true);
        });

        it('eth_call totalSupply equals the minted amount', async () => {
            const callData = erc20Contract.interface.encodeFunctionData('totalSupply', []);
            const raw = await provider.send('eth_call', [{ to: erc20Address, data: callData }, 'latest']);
            const [total] = erc20Contract.interface.decodeFunctionResult('totalSupply', raw);
            expect(total).to.eq(MINT_AMOUNT);
        });

        it('eth_call is a no-op on state (balanceOf before == balanceOf after)', async () => {
            const before = await erc20Contract.balanceOf(admin.evmAddress);
            const callData = erc20Contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
            await provider.send('eth_call', [{ to: erc20Address, data: callData }, 'latest']);
            const after = await erc20Contract.balanceOf(admin.evmAddress);
            expect(after).to.eq(before);
        });

        it('eth_call returns historical ERC20 state before and after a transfer', async () => {
            const mintedAmount = ethers.parseEther('5');
            const transferAmount = ethers.parseEther('2');
            const mintTx = await erc20Contract.mint(admin.evmAddress, mintedAmount);
            const mintReceipt = await mintTx.wait();
            const balanceOfAdmin = erc20Contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);

            const balanceAtMintRaw = await provider.send('eth_call', [
                { to: erc20Address, data: balanceOfAdmin },
                ethers.toQuantity(mintReceipt.blockNumber),
            ]);
            const [balanceAtMint] = erc20Contract.interface.decodeFunctionResult('balanceOf', balanceAtMintRaw);

            const transferTx = await erc20Contract.transfer(alice.evmAddress, transferAmount);
            const transferReceipt = await transferTx.wait();

            const historicalMintRaw = await provider.send('eth_call', [
                { to: erc20Address, data: balanceOfAdmin },
                ethers.toQuantity(mintReceipt.blockNumber),
            ]);
            const historicalTransferRaw = await provider.send('eth_call', [
                { to: erc20Address, data: balanceOfAdmin },
                ethers.toQuantity(transferReceipt.blockNumber),
            ]);
            const [historicalMintBalance] = erc20Contract.interface.decodeFunctionResult('balanceOf', historicalMintRaw);
            const [historicalTransferBalance] = erc20Contract.interface.decodeFunctionResult('balanceOf', historicalTransferRaw);

            expect(historicalMintBalance).to.eq(balanceAtMint);
            expect(historicalTransferBalance).to.eq(balanceAtMint - transferAmount);
        });

        for (const tag of ['latest', 'finalized', 'safe']) {
            it(`eth_call works with block tag '${tag}'`, async () => {
                const callData = erc20Contract.interface.encodeFunctionData('balanceOf', [admin.evmAddress]);
                const raw = await provider.send('eth_call', [{ to: erc20Address, data: callData }, tag]);
                const [balance] = erc20Contract.interface.decodeFunctionResult('balanceOf', raw);
                expect(balance > 0n).to.eq(true);
            });
        }

        it('eth_call surfaces a revert for an unknown selector', async () => {
            let reverted = false;
            try {
                await provider.send('eth_call', [
                    { from: admin.evmAddress, to: erc20Address, data: '0xdeadbeef' },
                    'latest',
                ]);
            } catch (e: any) {
                reverted = true;
                expect(e.message.toLowerCase()).to.match(/revert|execution|data/);
            }
            expect(reverted).to.eq(true, 'eth_call with unknown selector should throw');
        });

        it.skip('SKIP missing implementation: eth_simulateV1 should simulate a sequence of calls', async () => {
            const simulation = await provider.send('eth_simulateV1', [
                {
                    blockStateCalls: [{
                        calls: [{
                            from: admin.evmAddress,
                            to: alice.evmAddress,
                            value: ethers.toQuantity(ethers.parseEther('0.001')),
                        }],
                    }],
                },
                'latest',
            ]);
            expect(simulation.length).to.eq(1);
        });
    });

    /* ------------------------------------------------------------------ *
     * Logs & Filters
     * ------------------------------------------------------------------ */
    describe('Logs and Filters', function () {
        let erc20Address: string;
        let erc20Contract: ethers.Contract;
        let transferBlockNumber: number;
        let transferBlockHash: string;
        let transferTxHash: string;
        let transferTransactionIndex: number;
        const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
        const MINT_AMOUNT = ethers.parseEther('100');

        before('Deploy ERC20 and mint a known amount to alice', async () => {
            const erc20 = await deployer.deployErc20();
            erc20Address = erc20.getAddress() as string;
            erc20Contract = erc20.contract;
            await waitFor(1);
            const tx = await erc20.mint(alice.evmAddress, MINT_AMOUNT.toString());
            const receipt = await tx.wait();
            transferBlockNumber = receipt.blockNumber;
            transferBlockHash = receipt.blockHash;
            transferTxHash = receipt.hash;
            transferTransactionIndex = receipt.index;
        });

        it('eth_getLogs decodes the Transfer event with the exact from/to/value', async () => {
            const logs = await provider.send('eth_getLogs', [
                {
                    fromBlock: ethers.toQuantity(transferBlockNumber),
                    toBlock: ethers.toQuantity(transferBlockNumber),
                    address: erc20Address,
                    topics: [TRANSFER_TOPIC],
                },
            ]);
            expect(logs).to.have.length(1, 'expected exactly one Transfer event for the mint');
            const log = logs[0];
            expectLogFields(log, {
                address: erc20Address,
                blockHash: transferBlockHash,
                blockNumber: ethers.toQuantity(transferBlockNumber),
                transactionHash: transferTxHash,
                topic0: TRANSFER_TOPIC,
            });

            const parsed = erc20Contract.interface.parseLog({ topics: log.topics, data: log.data })!;
            expect(parsed.name).to.eq('Transfer');
            // Mint => from=0x0, to=alice, value=MINT_AMOUNT
            expect(parsed.args.from.toLowerCase()).to.eq(ZERO_ADDRESS);
            expect(parsed.args.to.toLowerCase()).to.eq(alice.evmAddress.toLowerCase());
            expect(parsed.args.value).to.eq(MINT_AMOUNT);
        });

        it('eth_getTransactionReceipt for an ERC20 mint returns the full emitted log object', async () => {
            const receipt = await provider.send('eth_getTransactionReceipt', [transferTxHash]);
            expectReceiptFields(receipt, {
                transactionHash: transferTxHash,
                blockHash: transferBlockHash,
                blockNumber: ethers.toQuantity(transferBlockNumber),
                from: admin.evmAddress,
                to: erc20Address,
                status: '0x1',
                logsLength: 1,
                transactionIndex: transferTransactionIndex,
            });
            expectLogFields(receipt.logs[0], {
                address: erc20Address,
                blockHash: transferBlockHash,
                blockNumber: ethers.toQuantity(transferBlockNumber),
                transactionHash: transferTxHash,
                topic0: TRANSFER_TOPIC,
            });
            expectQuantityEq(receipt.logs[0].transactionIndex, transferTransactionIndex, 'receipt log transactionIndex');
        });

        it('eth_getBlockReceipts includes the ERC20 mint receipt with the exact emitted log', async () => {
            const receipts = await provider.send('eth_getBlockReceipts', [ethers.toQuantity(transferBlockNumber)]);
            const receipt = receipts.find((candidate: any) => candidate.transactionHash === transferTxHash);
            expect(receipt, 'mint receipt should be in eth_getBlockReceipts response').to.not.eq(undefined);
            expectReceiptFields(receipt, {
                transactionHash: transferTxHash,
                blockHash: transferBlockHash,
                blockNumber: ethers.toQuantity(transferBlockNumber),
                from: admin.evmAddress,
                to: erc20Address,
                status: '0x1',
                logsLength: 1,
                transactionIndex: transferTransactionIndex,
            });
            expectLogFields(receipt.logs[0], {
                address: erc20Address,
                blockHash: transferBlockHash,
                blockNumber: ethers.toQuantity(transferBlockNumber),
                transactionHash: transferTxHash,
                topic0: TRANSFER_TOPIC,
            });
        });

        it('eth_getLogs returns an empty array for a topic that was never emitted', async () => {
            const fakeTopic = ethers.keccak256(ethers.toUtf8Bytes('FakeEvent(uint256)'));
            const logs = await provider.send('eth_getLogs', [
                {
                    fromBlock: ethers.toQuantity(transferBlockNumber),
                    toBlock: 'latest',
                    address: erc20Address,
                    topics: [fakeTopic],
                },
            ]);
            expect(logs).to.have.length(0);
        });

        it('eth_newFilter + eth_getFilterLogs returns the same historical logs as eth_getLogs', async () => {
            const filterId = await provider.send('eth_newFilter', [
                {
                    fromBlock: ethers.toQuantity(transferBlockNumber),
                    toBlock: 'latest',
                    address: erc20Address,
                    topics: [TRANSFER_TOPIC],
                },
            ]);
            expectQuantityGte(filterId, 0n, 'eth_newFilter id');

            try {
                const direct = await provider.send('eth_getLogs', [
                    {
                        fromBlock: ethers.toQuantity(transferBlockNumber),
                        toBlock: 'latest',
                        address: erc20Address,
                        topics: [TRANSFER_TOPIC],
                    },
                ]);
                const viaFilter = await provider.send('eth_getFilterLogs', [filterId]);
                expect(viaFilter).to.have.length(direct.length);
                for (const [index, log] of viaFilter.entries()) {
                    expect(log.transactionHash).to.eq(direct[index].transactionHash);
                    expect(log.logIndex).to.eq(direct[index].logIndex);
                    expectLogFields(log, {
                        address: erc20Address,
                        blockHash: log.blockHash,
                        blockNumber: log.blockNumber,
                        transactionHash: log.transactionHash,
                        topic0: TRANSFER_TOPIC,
                    });
                }
            } finally {
                const removed = await provider.send('eth_uninstallFilter', [filterId]);
                expect(removed).to.eq(true);
            }
        });

        it.skip('SKIP missing implementation: eth_getFilterChanges should return new log changes for eth_newFilter', async () => {
            const filterId = await provider.send('eth_newFilter', [
                { address: erc20Address, topics: [TRANSFER_TOPIC] },
            ]);
            try {
                const tx = await erc20Contract.mint(alice.evmAddress, ethers.parseEther('7'));
                await tx.wait();
                await waitFor(1);

                const changes = await provider.send('eth_getFilterChanges', [filterId]);
                const matchingLog = changes.find((log: any) => log.transactionHash === tx.hash);
                expect(matchingLog, 'filter should have picked up the new Transfer').to.not.eq(undefined);
                const receipt = await tx.wait();
                expectLogFields(matchingLog, {
                    address: erc20Address,
                    blockHash: receipt!.blockHash,
                    blockNumber: ethers.toQuantity(receipt!.blockNumber),
                    transactionHash: tx.hash,
                    topic0: TRANSFER_TOPIC,
                });
                const parsed = erc20Contract.interface.parseLog({
                    topics: matchingLog.topics,
                    data: matchingLog.data,
                })!;
                expect(parsed.name).to.eq('Transfer');
                expect(parsed.args.value).to.eq(ethers.parseEther('7'));
            } finally {
                await provider.send('eth_uninstallFilter', [filterId]);
            }
        });

        it('eth_newBlockFilter + eth_getFilterChanges yields block hashes for newly produced blocks', async () => {
            const filterId = await provider.send('eth_newBlockFilter', []);
            try {
                const tx = await admin.evmWallet.wallet.sendTransaction({
                    to: alice.evmAddress,
                    value: ethers.parseEther('0.001'),
                });
                const receipt = await tx.wait();
                await waitFor(1);

                const hashes = await provider.send('eth_getFilterChanges', [filterId]);
                expect(hashes).to.include(receipt!.blockHash);
                for (const hash of hashes) {
                    expectHash(hash, 'eth_newBlockFilter hash');
                }
            } finally {
                await provider.send('eth_uninstallFilter', [filterId]);
            }
        });

        it.skip('SKIP missing implementation: eth_newPendingTransactionFilter should report pending transaction hashes', async function () {
            const filterId = await provider.send('eth_newPendingTransactionFilter', []);
            expectQuantityGte(filterId, 0n, 'eth_newPendingTransactionFilter id');
            try {
                const tx = await admin.evmWallet.wallet.sendTransaction({
                    to: alice.evmAddress,
                    value: ethers.parseEther('0.001'),
                });
                let changes: string[] = [];
                for (let attempt = 0; attempt < 5 && !changes.includes(tx.hash); attempt++) {
                    await waitFor(0.2);
                    changes = changes.concat(await provider.send('eth_getFilterChanges', [filterId]));
                }
                for (const hash of changes) {
                    expectHash(hash, 'pending transaction hash');
                }
                expect(changes).to.include(tx.hash);
                await tx.wait();
            } catch (e: any) {
                expect(e.message).to.match(/not supported|not enabled|filter/i);
                this.skip();
            } finally {
                await provider.send('eth_uninstallFilter', [filterId]);
            }
        });

        it('eth_uninstallFilter on an unknown id returns false', async () => {
            const removed = await provider.send('eth_uninstallFilter', ['0xdeadbeef']);
            expect(removed).to.eq(false);
        });
    });

    /* ------------------------------------------------------------------ *
     * Debugging
     * ------------------------------------------------------------------ */
    describe('Debug', function () {
        let txHash: string;
        let blockNumber: number;
        let blockHash: string;
        let gasUsed: bigint;

        before('Send a transfer to trace', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.01'),
            });
            const receipt = await tx.wait();
            txHash = receipt!.hash;
            blockNumber = receipt!.blockNumber;
            blockHash = receipt!.blockHash;
            gasUsed = BigInt(receipt!.gasUsed);
        });

        it('debug_traceTransaction returns a struct-log trace matching receipt.gasUsed', async () => {
            const trace = await provider.send('debug_traceTransaction', [txHash]);
            expectOnlyKnownFields(trace, ['failed', 'gas', 'returnValue', 'structLogs'], 'debug_traceTransaction');
            expect(trace.failed).to.eq(false);
            expect(BigInt(trace.gas)).to.eq(gasUsed);
            expect(trace.structLogs.length).to.be.gte(0);
            expect(['', '0x']).to.include(trace.returnValue);
        });

        it('debug_traceTransaction with callTracer returns from/to/value matching the tx', async () => {
            const trace = await provider.send('debug_traceTransaction', [txHash, { tracer: 'callTracer' }]);
            expectOnlyKnownFields(trace, ['from', 'gas', 'gasUsed', 'input', 'output', 'to', 'type', 'value'], 'callTracer trace');
            expect(trace.type).to.eq('CALL');
            expectAddressEq(trace.from, admin.evmAddress, 'trace.from');
            expectAddressEq(trace.to, alice.evmAddress, 'trace.to');
            expect(BigInt(trace.value)).to.eq(ethers.parseEther('0.01'));
            expect(BigInt(trace.gasUsed)).to.eq(gasUsed);
            expectData(trace.input, 'trace.input');
            expectOptionalData(trace.output, 'trace.output');
        });

        it('debug_traceTransaction throws for an unknown hash', async () => {
            const fake = '0x' + '0'.repeat(64);
            let threw = false;
            try {
                await provider.send('debug_traceTransaction', [fake]);
            } catch {
                threw = true;
            }
            expect(threw).to.eq(true);
        });

        it('debug_traceCall for a value transfer returns gas >= 21000 and failed=false', async () => {
            const trace = await provider.send('debug_traceCall', [
                {
                    from: admin.evmAddress,
                    to: alice.evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.001')),
                },
                'latest',
            ]);
            expectOnlyKnownFields(trace, ['failed', 'gas', 'returnValue', 'structLogs'], 'debug_traceCall');
            expect(BigInt(trace.gas) >= SIMPLE_TRANSFER_GAS).to.eq(true);
            expect(trace.failed).to.eq(false);
            expect(['', '0x']).to.include(trace.returnValue);
            expect(trace.structLogs.length).to.be.gte(0);
        });

        it('debug_traceCall with callTracer returns CALL structure', async () => {
            const trace = await provider.send('debug_traceCall', [
                {
                    from: admin.evmAddress,
                    to: alice.evmAddress,
                    value: ethers.toQuantity(ethers.parseEther('0.001')),
                },
                'latest',
                { tracer: 'callTracer' },
            ]);
            expectOnlyKnownFields(trace, ['from', 'gas', 'gasUsed', 'input', 'output', 'to', 'type', 'value'], 'debug_traceCall callTracer');
            expect(trace.type).to.eq('CALL');
            expectAddressEq(trace.from, admin.evmAddress, 'trace.from');
            expectAddressEq(trace.to, alice.evmAddress, 'trace.to');
            expect(BigInt(trace.value)).to.eq(ethers.parseEther('0.001'));
            expectData(trace.input, 'trace.input');
            expectOptionalData(trace.output, 'trace.output');
        });

        it('debug_traceBlockByNumber returns a trace entry for our tx with gas == gasUsed', async () => {
            const traces = await provider.send('debug_traceBlockByNumber', [ethers.toQuantity(blockNumber)]);
            expect(traces.length).to.be.gte(1);
            const entry = traces.find((t: any) => t.txHash === txHash);
            expect(entry, 'our tx must be in the block trace').to.not.be.undefined;
            expectOnlyKnownFields(entry, ['result', 'txHash'], 'debug_traceBlockByNumber entry');
            expect(BigInt(entry.result.gas)).to.eq(gasUsed);
            expect(entry.result.failed).to.eq(false);
        });

        it('debug_traceBlockByHash returns the same trace set as debug_traceBlockByNumber', async () => {
            const byHash = await provider.send('debug_traceBlockByHash', [blockHash]);
            const byNumber = await provider.send('debug_traceBlockByNumber', [ethers.toQuantity(blockNumber)]);
            expect(byHash.length).to.eq(byNumber.length);
            const ourByHash = byHash.find((t: any) => t.txHash === txHash);
            expect(ourByHash, 'our tx must be in the by-hash trace').to.not.be.undefined;
            expectOnlyKnownFields(ourByHash, ['result', 'txHash'], 'debug_traceBlockByHash entry');
            expect(BigInt(ourByHash.result.gas)).to.eq(gasUsed);
            expect(ourByHash.result.failed).to.eq(false);
        });

        it('debug_traceBlockByNumber throws for a future block', async () => {
            const current = await provider.getBlockNumber();
            let threw = false;
            try {
                await provider.send('debug_traceBlockByNumber', [
                    ethers.toQuantity(current + 1_000_000),
                ]);
            } catch {
                threw = true;
            }
            expect(threw).to.eq(true);
        });

        it.skip('SKIP missing implementation: debug_getRawHeader should return an RLP encoded header', async () => {
            const rawHeader = await provider.send('debug_getRawHeader', [ethers.toQuantity(blockNumber)]);
            expectData(rawHeader, 'debug_getRawHeader');
        });

        it.skip('SKIP missing implementation: debug_getRawBlock should return an RLP encoded block', async () => {
            const rawBlock = await provider.send('debug_getRawBlock', [ethers.toQuantity(blockNumber)]);
            expectData(rawBlock, 'debug_getRawBlock');
        });

        it.skip('SKIP missing implementation: debug_getRawTransaction should return an RLP encoded transaction', async () => {
            const rawTx = await provider.send('debug_getRawTransaction', [txHash]);
            expectData(rawTx, 'debug_getRawTransaction');
        });

        it.skip('SKIP missing implementation: debug_getRawReceipts should return RLP encoded receipts', async () => {
            const rawReceipts = await provider.send('debug_getRawReceipts', [ethers.toQuantity(blockNumber)]);
            expectData(rawReceipts, 'debug_getRawReceipts');
        });

        it.skip('SKIP missing implementation: debug_getBadBlocks should return invalid blocks known to the client', async () => {
            const badBlocks = await provider.send('debug_getBadBlocks', []);
            expect(badBlocks.length).to.eq(0);
        });
    });

    /* ------------------------------------------------------------------ *
     * Txpool
     * ------------------------------------------------------------------ */
    describe('Txpool', function () {
        it.skip('SKIP missing implementation: txpool_status should return pending and queued transaction counts', async () => {
            const status = await provider.send('txpool_status', []);
            expectOnlyKnownFields(status, ['pending', 'queued'], 'txpool_status');
            expectQuantityGte(status.pending, 0n, 'txpool_status.pending');
            expectQuantityGte(status.queued, 0n, 'txpool_status.queued');
        });

        it('txpool_content returns pending and queued transaction maps', async () => {
            const content = await provider.send('txpool_content', []);
            expectOnlyKnownFields(content, ['pending', 'queued'], 'txpool_content');
            for (const bucket of [content.pending, content.queued]) {
                for (const sender of Object.keys(bucket)) {
                    expectAddress(sender, 'txpool_content sender');
                    for (const nonce of Object.keys(bucket[sender])) {
                        expect(Number.isInteger(Number(nonce))).to.eq(true);
                    }
                }
            }
        });

        it.skip('SKIP missing implementation: txpool_contentFrom should return txpool transactions for one sender', async () => {
            const content = await provider.send('txpool_contentFrom', [admin.evmAddress]);
            expectOnlyKnownFields(content, ['pending', 'queued'], 'txpool_contentFrom');
        });
    });

    /* ------------------------------------------------------------------ *
     * Legacy Sei helpers (default-enabled per sei docs)
     * ------------------------------------------------------------------ */
    describe('Sei-specific helpers (legacy, default-enabled)', function () {
        it('sei_getSeiAddress(admin.evm) returns admin.sei exactly', async () => {
            const seiAddr = await provider.send('sei_getSeiAddress', [admin.evmAddress]);
            expect(seiAddr).to.eq(admin.seiAddress);
        });

        it('sei_getEVMAddress(admin.sei) returns admin.evm exactly', async () => {
            const evmAddr = await provider.send('sei_getEVMAddress', [admin.seiAddress]);
            expect(evmAddr.toLowerCase()).to.eq(admin.evmAddress.toLowerCase());
        });

        it('sei_getCosmosTx returns a 64-char hex cosmos hash for an EVM tx', async () => {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();
            await waitFor(1);
            const cosmosTxHash = await provider.send('sei_getCosmosTx', [receipt!.hash]);
            expect(cosmosTxHash).to.match(/^[0-9A-Fa-f]{64}$/,
                `expected a 64-char hex cosmos hash, got ${cosmosTxHash}`);
        });

        it('sei_getCosmosTx round-trips via sei_getEvmTx (when enabled on the node)', async function () {
            const tx = await admin.evmWallet.wallet.sendTransaction({
                to: alice.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();
            await waitFor(1);
            const cosmosTxHash = await provider.send('sei_getCosmosTx', [receipt!.hash]);
            try {
                const evmTxHash = await provider.send('sei_getEvmTx', [cosmosTxHash]);
                expect(evmTxHash.toLowerCase()).to.eq(receipt!.hash.toLowerCase());
            } catch (e: any) {
                // sei_getEvmTx isn't in the default allowlist on every node.
                expect(e.message).to.match(/legacy_sei_deprecated|not enabled/i,
                    `sei_getEvmTx failed for an unexpected reason: ${e.message}`);
                this.skip();
            }
        });
    });
});
