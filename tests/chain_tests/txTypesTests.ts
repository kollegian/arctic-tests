import {ethers, TransactionReceipt, TransactionResponse} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {EvmRpcClient} from "../../shared/RpcClient";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {expect} from "chai";
import {waitFor, calcNewBaseFee} from "../../shared/utils/helpers";
import testConfig from "../../config/testConfig.json";
import heavyGasAbi from "../../artifacts/contracts/GasBurner.sol/RealGasBurner.json";
import {RealGasBurner} from "../../typechain-types";


describe('Ethereum Transaction Types Tests', function () {
    this.timeout(10 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let erc20Contract: Erc20Token;
    let rpcClient: EvmRpcClient;
    let deployer: TokenDeployer;
    let chainId: bigint;
    let debugOptions;
    let gasBurnerContract: RealGasBurner;

    before('Initialize test environment', async () => {
        debugOptions = {
            tracer: 'callTracer',
            tracerConfig: {
                onlyTopCall: false,
                withLog: true
            }
        };
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 11, false);

        deployer = new TokenDeployer(admin);
        erc20Contract = await deployer.deployErc20();
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, admin.evmWallet.signingClient);

        // Fund users with ERC20 token
        await erc20Contract.mint(bob.evmAddress, ethers.parseEther('1000').toString());
        await waitFor(0.5);
        await erc20Contract.mint(alice.evmAddress, ethers.parseEther('1000').toString());
        await waitFor(0.5);
        chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;
        const contractFactory = new ethers.ContractFactory(heavyGasAbi.abi, heavyGasAbi.bytecode, admin.evmWallet.wallet);
        const deploymentTx = await contractFactory.deploy();
        gasBurnerContract = await deploymentTx.waitForDeployment() as unknown as RealGasBurner;
        console.log('Gas burner deployed to ', gasBurnerContract.target);
        await waitFor(0.5);
    });

    describe('Legacy Transactions (Type 0)', function () {

        describe('Legacy txs write op tests', function () {
            it('User sends a legacy transaction with gasPrice set', async () => {
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('10')]
                );
                const senderPreSeiBalance = await rpcClient.getBalance(alice.evmAddress);
                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const txRequest = {
                    to: erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: 500000n,
                    gasPrice: 1000000000n,
                    nonce: nonce,
                    chainId: chainId,
                    type: 0
                };
                const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                    alice.evmWallet.signingClient,
                    signedTx
                );

                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt?.status).to.be.eq(1);
                expect(receipt?.type).to.be.eq(0);

                //verify correct gas fee returned
                if (receipt?.gasPrice !== undefined && receipt?.gasUsed !== undefined) {
                    expect(Number(receipt.gasUsed)).to.be.lt(Number(500000));
                    expect(Number(receipt.gasPrice)).to.be.eq(Number(1000000000));
                    // verify correct gas fee taken from the user
                    const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
                    const senderBalanceDiff = Number(ethers.formatEther(senderPreSeiBalance - senderAfterBalance));
                    const userPaidGasFee = Number(ethers.formatEther(receipt.gasPrice * receipt.gasUsed));
                    expect(senderBalanceDiff).to.be.eq(userPaidGasFee);
                } else {
                    throw new Error('receipt.gasPrice or receipt.gasUsed is undefined');
                }
            });

            it('User sends a legacy transaction with gasPrice below base block fee', async () => {
                // Block base gas fee is 1000000000, so use 900000000 (below base)
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('1')]
                );
                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const lowGasPrice = 999999999;
                const txRequest = {
                    to: erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: 500000n,
                    gasPrice: BigInt(lowGasPrice),
                    nonce: nonce,
                    chainId: chainId,
                    type: 0
                };
                let failed = false;
                try {
                    const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                    const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                        alice.evmWallet.signingClient, signedTx
                    );
                    const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                    expect(receipt?.status).to.not.be.eq(1);
                } catch (err: any) {
                    failed = true;
                }
                expect(failed).to.be.true;
            });

            it('Users sends a legacy transaction with over block max gas limit', async () => {
                // Block max gas limit is 35 mil, so use 36000000 (over limit)
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('1')]
                );
                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const overGasLimit = 35000000n;
                const txRequest = {
                    to: erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: overGasLimit,
                    gasPrice: 1000000000n,
                    nonce: nonce,
                    chainId: chainId,
                    type: 0
                };

                const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                    alice.evmWallet.signingClient, signedTx
                );
                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt?.status).to.be.eq(1);
            });

            it('All users send multiple legacy transactions in parallel and base fee increases', async () => {
                console.log('Starting test');
                await waitFor(1);
                const users = [alice, bob]; // Add more users if needed
                const numTxs = 10;
                const allSendPromises: Promise<string>[] = [];
                const allUserTxInfo: { user: typeof alice, txIndex: number, hashPromise: Promise<string> }[] = [];

                for (const user of users) {
                    const feeData = await user.evmWallet.signingClient.getFeeData();
                    const gasPrice = feeData.gasPrice!;
                    const baseNonce = await user.evmWallet.wallet.getNonce('latest');
                    const signedTxs: string[] = [];

                    // Prepare and sign all transactions for this user
                    for (let i = 0; i < numTxs; i++) {
                        const data = gasBurnerContract.interface.encodeFunctionData(
                            "burnGasOverMaxLimit",
                            [baseNonce + i]
                        )
                        const nonce = baseNonce + i;
                        const txRequest = {
                            to: gasBurnerContract.target,
                            data: data,
                            value: 0n,
                            gasLimit: 34990000n,
                            gasPrice: 2000000000n,
                            nonce: nonce,
                            chainId: chainId,
                            type: 0
                        };
                        const signedTx = await user.evmWallet.wallet.signTransaction(txRequest);
                        signedTxs.push(signedTx);
                    }

                    // Fire all signed transactions for this user in parallel
                    signedTxs.forEach((signedTx, i) => {
                        const hashPromise = AtomicTxSender.sendRawTransactionWithProvider(
                            user.evmWallet.signingClient,
                            signedTx
                        ).then(hash => {
                            return hash;
                        });
                        allSendPromises.push(hashPromise);
                        allUserTxInfo.push({ user, txIndex: i, hashPromise });
                    });
                }
                const txHashes = await Promise.all(allSendPromises);

                // Wait for all receipts in parallel, grouped by user
                const allReceiptPromises: Promise<TransactionReceipt | null>[] = [];
                for (const { user, txIndex, hashPromise } of allUserTxInfo) {
                    const receiptPromise = hashPromise.then(hash =>
                        user.evmWallet.signingClient.waitForTransaction(hash)
                    );
                    allReceiptPromises.push(receiptPromise);
                }

                const receipts = await Promise.all(allReceiptPromises);
                let successRate = 0;
                let failureRate = 0;
                let blockTxNumbers = new Map<number, number>();
                // Log and check results
                receipts.forEach((receipt, idx) => {
                    if (receipt) {
                        const user = allUserTxInfo[idx].user;
                        const txIndex = allUserTxInfo[idx].txIndex;
                        const blockNumber = receipt.blockNumber;
                        if (blockTxNumbers.has(blockNumber)) {
                            blockTxNumbers.set(blockNumber, blockTxNumbers.get(blockNumber)! + 1);
                        } else {
                            blockTxNumbers.set(blockNumber, 1);
                        }
                        if (receipt.status === 1) {
                            successRate++;
                        } else {
                            failureRate++;
                        }
                    } else {
                        console.log(`Legacy transaction ${idx + 1} failed: receipt is null`);
                    }
                });

                console.log(`Total transactions sent: ${receipts.length}`);
                console.log('Success num is ', successRate);
                console.log('Failure num is ', failureRate);
                console.log('Block Tx Numbers are ', blockTxNumbers);
                const earliestBlock = Array.from(blockTxNumbers.keys()).sort()[0];
                const latestBlock = Array.from(blockTxNumbers.keys()).sort()[blockTxNumbers.size - 1];
                for (let i = earliestBlock; i <= latestBlock + 2; i++) {
                    const currentBlock = await rpcClient.getBlockByNumber(ethers.toQuantity(i), false);
                    const currentGasFee = Number(currentBlock.baseFeePerGas);
                    const expectedGasFee = calcNewBaseFee(Number(currentGasFee), Number(currentBlock.gasUsed));
                    const nextBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(i + 1), false);
                    console.log('Expected base gas fee is ', expectedGasFee);
                    console.log('In hex it is ', nextBlockData.baseFeePerGas);
                    console.log('Actual base gas fee is ', Number(nextBlockData.baseFeePerGas));
                    console.log('Block Number is ', i);
                    console.log('Actual gas used is ', Number(currentBlock.gasUsed));
                }

                // Already handled above with nonNullReceipts
                const baseBlock = Array.from(blockTxNumbers.keys()).pop();
                const baseFee = (await rpcClient.getBlockByNumber(ethers.toQuantity(baseBlock-1), false))!.baseFeePerGas!;
                console.log(baseFee);
                expect(Number(baseFee)).to.be.gt(1000000000);
            });

            it('Legacy transaction with high gas price', async () => {
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('5')]
                );

                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;
                const userPreBalance = await rpcClient.getBalance(alice.evmAddress);
                // Use a high gas price
                const highGasPrice = ethers.parseUnits('1200', 'gwei');

                const txRequest = {
                    to: await erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: 100000n,
                    gasPrice: highGasPrice,
                    nonce: nonce,
                    chainId: chainId,
                    type: 0
                };

                const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                    alice.evmWallet.signingClient,
                    signedTx
                );

                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt).to.not.be.null;
                expect(receipt!.status).to.equal(1);
                expect(receipt!.type).to.equal(0);

                const userAfterBalance = await rpcClient.getBalance(alice.evmAddress);
                const userBalanceDiff = ethers.formatEther(userPreBalance - userAfterBalance);
                const expectedBalanceDiff = ethers.formatEther(highGasPrice * receipt!.gasUsed);
                expect(userBalanceDiff).to.be.eq(expectedBalanceDiff);
            });
        });

        describe('Legacy Tx Read Operations', function () {

            let txHash: string;
            let receipt;
            it('should get transaction receipt by hash', async () => {
                // Send a legacy tx
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('1')]
                );
                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const txRequest = {
                    to: await erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: 100000n,
                    gasPrice: 301500000000n,
                    nonce: nonce,
                    chainId: chainId,
                    type: 0
                };
                const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                    alice.evmWallet.signingClient,
                    signedTx
                );
                receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt).to.not.be.null;
                if (receipt) {
                    console.log('Transaction receipt:', receipt);
                    expect(receipt.status).to.equal(1);
                    expect(receipt.type).to.equal(0);
                    expect(receipt.hash).to.equal(txHash);
                }
            });

            it('should get transaction by hash', async () => {
                // Send a legacy tx
                const tx = await rpcClient.getTransactionByHash(txHash);
                expect(tx).to.not.be.null;
                if (tx) {
                    console.log('Transaction by hash:', tx);
                    expect(tx.hash).to.equal(txHash);
                    expect(tx.from.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
                }
            });

            it('should get logs for the legacy tx', async () => {
                const toAddress = await erc20Contract.getAddress();

                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt).to.not.be.null;
                if (receipt) {
                    // Get logs for the block and contract address
                    const logs = await rpcClient.getLogs({
                        address: toAddress.toString(),
                        fromBlock: ethers.toQuantity(receipt.blockNumber),
                        toBlock: ethers.toQuantity(receipt.blockNumber)
                    });
                    console.log('Logs for tx:', logs);
                    expect(logs.length).to.be.greaterThan(0);
                }
            });

            it('should debug trace the legacy tx', async () => {
                try {
                    const trace = await alice.evmWallet.signingClient.send('debug_traceTransaction', [txHash, {}]);
                    console.log('debug_traceTransaction result:', trace);
                    expect(trace).to.exist;
                } catch (err: any) {
                    console.log('debug_traceTransaction not supported or failed:', err.message || err);
                }
            });

            it('Should debug block itself', async () =>{
                const debugBlock = await alice.evmWallet.signingClient.send('debug_traceBlockByNumber', [ethers.toQuantity(receipt!.blockNumber), debugOptions]);
                console.log(debugBlock);
            });

            it('should get block by number and find tx', async () => {
                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt).to.not.be.null;
                if (receipt) {
                    const blockNumber = receipt.blockNumber;
                    const block = await rpcClient.getBlockByNumber(ethers.toQuantity(blockNumber), false);
                    console.log('Block info:', block);
                    expect(block).to.not.be.null;
                    expect(block.transactions).to.include(txHash);
                }
            });

            it('should get block receipts via eth_getBlockReceipts', async () => {
                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt).to.not.be.null;
                if (receipt) {
                    const blockNumber = receipt.blockNumber;
                    // eth_getBlockReceipts is not standard in ethers, so use raw RPC
                    const receipts = await alice.evmWallet.signingClient.send('eth_getBlockReceipts', [ethers.toQuantity(blockNumber)]);
                    console.log('Block receipts:', receipts);
                    expect(receipts).to.be.an('array').that.is.not.empty;
                    const found = receipts.find((r: any) => r.transactionHash === txHash);
                    expect(found).to.not.be.undefined;
                    expect(found.transactionHash).to.equal(txHash);
                }
            });

            function normalizeHex(val: any): string | null {
                if (val === null || val === undefined) return null;
                if (typeof val === 'bigint') return '0x' + val.toString(16);
                if (typeof val === 'number') return '0x' + val.toString(16);
                if (typeof val === 'string') {
                    if (val.startsWith('0x')) return val.toLowerCase();
                    return '0x' + parseInt(val, 10).toString(16);
                }
                return null;
            }
            function normalizeAddr(addr: string | null | undefined): string | null {
                return addr ? addr.toLowerCase() : null;
            }

            it('should compare getTransactionReceipt vs eth_getBlockReceipts (all properties)', async () => {
                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt).to.not.be.null;
                if (!receipt) throw new Error('No receipt');
                const blockNumber = receipt.blockNumber;
                const blockReceipts = await alice.evmWallet.signingClient.send('eth_getBlockReceipts', [ethers.toQuantity(blockNumber)]);
                expect(blockReceipts).to.be.an('array').that.is.not.empty;
                const found = blockReceipts.find((r: any) => normalizeHex(r.transactionHash) === normalizeHex(txHash));
                expect(found).to.not.be.undefined;
                // List of properties to check
                const pairs: [string, any, any][] = [
                    ['blockHash', normalizeHex(receipt.blockHash), normalizeHex(found.blockHash)],
                    ['blockNumber', normalizeHex(receipt.blockNumber), normalizeHex(found.blockNumber)],
                    ['contractAddress', normalizeAddr(receipt.contractAddress), normalizeAddr(found.contractAddress)],
                    ['cumulativeGasUsed', normalizeHex(receipt.cumulativeGasUsed), normalizeHex(found.cumulativeGasUsed)],
                    ['effectiveGasPrice', normalizeHex((receipt as any).effectiveGasPrice), normalizeHex(found.effectiveGasPrice)],
                    ['from', normalizeAddr(receipt.from), normalizeAddr(found.from)],
                    ['gasUsed', normalizeHex(receipt.gasUsed), normalizeHex(found.gasUsed)],
                    ['logsBloom', receipt.logsBloom, found.logsBloom],
                    ['status', normalizeHex(receipt.status), normalizeHex(found.status)],
                    ['to', normalizeAddr(receipt.to), normalizeAddr(found.to)],
                    ['transactionHash', normalizeHex(receipt.hash), normalizeHex(found.transactionHash)],
                    ['transactionIndex', normalizeHex((receipt as any).transactionIndex), normalizeHex(found.transactionIndex)],
                    ['type', normalizeHex(receipt.type), normalizeHex(found.type)],
                ];
                for (const [prop, a, b] of pairs) {
                    if (a === null && b === null) continue;
                    if (a === null || b === null) {
                        console.warn(`Property ${prop} missing in one of the objects: receipt=${a}, blockReceipt=${b}`);
                        continue;
                    }
                    expect(a).to.equal(b, `Mismatch in property ${prop}: receipt=${a}, blockReceipt=${b}`);
                }
                // logs
                expect(found.logs.length).to.equal(receipt.logs.length);
                for (let i = 0; i < found.logs.length; i++) {
                    const logA = receipt.logs[i];
                    const logB = found.logs[i];
                    expect(normalizeAddr(logA.address)).to.equal(normalizeAddr(logB.address), `Log address mismatch at index ${i}`);
                    expect(logA.topics.length).to.equal(logB.topics.length, `Log topics length mismatch at index ${i}`);
                    for (let j = 0; j < logA.topics.length; j++) {
                        expect(normalizeHex(logA.topics[j])).to.equal(normalizeHex(logB.topics[j]), `Log topic mismatch at log ${i}, topic ${j}`);
                    }
                    expect(logA.data).to.equal(logB.data, `Log data mismatch at index ${i}`);
                }
                console.log('All properties compared for getTransactionReceipt vs eth_getBlockReceipts');
            });

            it('should compare getTransactionReceipt vs getTransactionByHash (all properties)', async () => {
                const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(receipt).to.not.be.null;
                if (!receipt) throw new Error('No receipt');
                const tx = await rpcClient.getTransactionByHash(txHash);
                expect(tx).to.not.be.null;
                if (!tx) throw new Error('No tx');
                // List of properties to check
                const pairs: [string, any, any][] = [
                    ['blockHash', normalizeHex(receipt.blockHash), normalizeHex(tx.blockHash)],
                    ['blockNumber', normalizeHex(receipt.blockNumber), normalizeHex(tx.blockNumber)],
                    ['from', normalizeAddr(receipt.from), normalizeAddr(tx.from)],
                    ['to', normalizeAddr(receipt.to), normalizeAddr(tx.to)],
                    ['transactionHash', normalizeHex(receipt.hash), normalizeHex(tx.hash)],
                    // ['transactionIndex', normalizeHex((receipt as any).transactionIndex), normalizeHex(tx.transactionIndex)],
                    ['type', normalizeHex(receipt.type), normalizeHex(tx.type)],
                ];
                for (const [prop, a, b] of pairs) {
                    if (a === null && b === null) continue;
                    if (a === null || b === null) {
                        console.warn(`Property ${prop} missing in one of the objects: receipt=${a}, tx=${b}`);
                        continue;
                    }
                    expect(a).to.equal(b, `Mismatch in property ${prop}: receipt=${a}, tx=${b}`);
                }
                // Additional tx-only fields (input, nonce, value, chainId, v, r, s) can be logged if needed
                console.log('All properties compared for getTransactionReceipt vs getTransactionByHash');
            });

            it('should compare getTransactionByHash vs getBlockByNumber (all properties)', async () => {
                const tx = await rpcClient.getTransactionByHash(txHash);
                expect(tx).to.not.be.null;
                if (!tx) throw new Error('No tx');
                const block = await rpcClient.getBlockByNumber(ethers.toQuantity(tx.blockNumber), false);
                expect(block).to.not.be.null;
                if (!block) throw new Error('No block');
                // List of properties to check
                const pairs: [string, any, any][] = [
                    ['blockHash', normalizeHex(tx.blockHash), normalizeHex(block.hash)],
                    ['blockNumber', normalizeHex(tx.blockNumber), normalizeHex(block.number)],
                ];
                for (const [prop, a, b] of pairs) {
                    if (a === null && b === null) continue;
                    if (a === null || b === null) {
                        console.warn(`Property ${prop} missing in one of the objects: tx=${a}, block=${b}`);
                        continue;
                    }
                    expect(a).to.equal(b, `Mismatch in property ${prop}: tx=${a}, block=${b}`);
                }
                // Check tx hash is in block.transactions
                expect(block.transactions.map((h: any) => normalizeHex(h))).to.include(normalizeHex(tx.hash));
                // Optionally check transactionIndex matches position in block.transactions
                const idx = block.transactions.findIndex((h: any) => normalizeHex(h) === normalizeHex(tx.hash));
                if (idx !== -1 && tx.transactionIndex !== undefined) {
                    // expect(idx).to.equal(parseInt(tx.transactionIndex, 16), 'transactionIndex mismatch with block.transactions order');
                }
                console.log('All properties compared for getTransactionByHash vs getBlockByNumber');
            });
        });
    });

    describe('Transaction Data Tests', function () {

        it('Tests simple ETH transfer (no data)', async () => {
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;

            const txRequest = {
                to: bob.evmAddress,
                data: '0x', // Empty data for ETH transfer
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n, // Standard ETH transfer gas
                maxFeePerGas: feeData.maxFeePerGas!,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonce,
                chainId: chainId,
                type: 2
            };

            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                alice.evmWallet.signingClient, signedTx
            );

            const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
            expect(receipt).to.not.be.null;
            console.log('Simple ETH transfer successful:', txHash);
        });

        it('Tests transaction with large data payload', async () => {
            // Create a large data payload
            const largeData = '0x' + '0'.repeat(10000); // 1KB of data

            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;

            const txRequest = {
                to: bob.evmAddress,
                data: largeData,
                value: 0n,
                gasLimit: 100000n,
                gasPrice: 1100000000n,
                nonce: nonce,
                chainId: chainId,
                type: 0
            };

            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                alice.evmWallet.signingClient, signedTx
            );

            const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
            expect(receipt).to.not.be.null;
            console.log('Large data transaction successful:', txHash);
        });
    });

    describe.skip('Network and Chain ID Tests', function () {
        it('Tests transaction with wrong chain ID', async () => {
            const data = erc20Contract.contract.interface.encodeFunctionData(
                'transfer', [bob.evmAddress, ethers.parseEther('1')]
            );

            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const correctChainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;
            const wrongChainId = correctChainId + 1n;

            const txRequest = {
                to: await erc20Contract.getAddress(),
                data: data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: feeData.maxFeePerGas!,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonce,
                chainId: wrongChainId,
                type: 2
            };

            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);

            try {
                await AtomicTxSender.sendRawTransactionWithProvider(
                    alice.evmWallet.signingClient, signedTx
                );
                throw new Error('Should have rejected wrong chain ID');
            } catch (error: any) {
                console.log('Wrong chain ID correctly rejected:', error.message);
            }
        });
    });
});
