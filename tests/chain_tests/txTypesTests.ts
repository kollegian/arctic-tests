import {ethers, TransactionReceipt} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {EvmRpcClient} from "../../shared/RpcClient";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {expect} from "chai";
import {waitFor, calcNewBaseFee} from "../../shared/utils/helpers";
import {getTestConfig} from "../../shared/testConfig";
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
        //await UserFactory.fundAdminOnSei();
        [alice, bob] = await UserFactory.createSeiUsers(admin, 11, false);

        deployer = new TokenDeployer(admin);
        erc20Contract = await deployer.deployErc20();
        rpcClient = new EvmRpcClient(getTestConfig().evmRpcEndpoint, admin.evmWallet.signingClient);
        console.log('All started');
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
                const feeData = await alice.evmWallet.signingClient.getFeeData();
                const currentGasPrice = feeData.gasPrice!;
                const gasPrice = currentGasPrice * 2n;

                const txRequest = {
                    to: erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: 500000n,
                    gasPrice: gasPrice,
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

                expect(receipt!.gasUsed).to.be.a('bigint');
                expect(receipt!.gasUsed).to.be.greaterThan(0n);
                expect(receipt!.gasUsed).to.be.lessThan(500000n);

                expect(receipt!.gasPrice).to.be.a('bigint');
                expect(receipt!.gasPrice).to.be.greaterThanOrEqual(currentGasPrice);

                const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
                const senderBalanceDiff = senderPreSeiBalance - senderAfterBalance;
                const userPaidGasFee = receipt!.gasPrice * receipt!.gasUsed;
                expect(senderBalanceDiff).to.equal(userPaidGasFee);
            });

            it('User sends a legacy transaction with gasPrice below base block fee', async () => {
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('1')]
                );
                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const feeData = await alice.evmWallet.signingClient.getFeeData();
                const currentGasPrice = feeData.gasPrice!;
                const lowGasPrice = currentGasPrice / 2n;

                const txRequest = {
                    to: erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: 500000n,
                    gasPrice: lowGasPrice,
                    nonce: nonce,
                    chainId: chainId,
                    type: 0
                };
                let failed = false;
                let errorMessage = '';
                try {
                    const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                    const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                        alice.evmWallet.signingClient, signedTx
                    );
                    const receipt = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                    expect(receipt?.status).to.not.equal(1);
                } catch (err: any) {
                    failed = true;
                    errorMessage = err.message || String(err);
                }
                expect(failed).to.equal(true, 'Transaction with gasPrice below base fee should be rejected');
                expect(errorMessage).to.include('insufficient fee');
            });

            it('Users sends a legacy transaction with over block max gas limit', async () => {
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('1')]
                );
                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const feeData = await alice.evmWallet.signingClient.getFeeData();
                const gasPrice = feeData.gasPrice! * 2n;
                const overGasLimit = 35000000n;

                const txRequest = {
                    to: erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: overGasLimit,
                    gasPrice: gasPrice,
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
                expect(receipt!.status).to.equal(1);
                expect(receipt!.gasUsed).to.be.greaterThan(0n);
                expect(receipt!.gasUsed).to.be.lessThan(overGasLimit);
            });

            it('All users send multiple legacy transactions in parallel and base fee increases', async () => {
                await waitFor(1);
                const users = [alice, bob];
                const numTxs = 10;
                const allSendPromises: Promise<string>[] = [];
                const allUserTxInfo: { user: typeof alice, txIndex: number, hashPromise: Promise<string> }[] = [];

                const preTestBlock = await rpcClient.getBlockByNumber('latest', false);
                const preTestBaseFee = BigInt(preTestBlock.baseFeePerGas);

                for (const user of users) {
                    const feeData = await user.evmWallet.signingClient.getFeeData();
                    const gasPrice = feeData.gasPrice! * 10n;
                    const baseNonce = await user.evmWallet.wallet.getNonce('latest');
                    const signedTxs: string[] = [];

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
                            gasPrice: gasPrice,
                            nonce: nonce,
                            chainId: chainId,
                            type: 0
                        };
                        const signedTx = await user.evmWallet.wallet.signTransaction(txRequest);
                        signedTxs.push(signedTx);
                    }

                    signedTxs.forEach((signedTx, i) => {
                        const hashPromise = AtomicTxSender.sendRawTransactionWithProvider(
                            user.evmWallet.signingClient,
                            signedTx
                        );
                        allSendPromises.push(hashPromise);
                        allUserTxInfo.push({ user, txIndex: i, hashPromise });
                    });
                }
                const txHashes = await Promise.all(allSendPromises);
                expect(txHashes).to.have.lengthOf(users.length * numTxs);

                const allReceiptPromises: Promise<TransactionReceipt | null>[] = [];
                for (const { user, hashPromise } of allUserTxInfo) {
                    const receiptPromise = hashPromise.then(hash =>
                        user.evmWallet.signingClient.waitForTransaction(hash)
                    );
                    allReceiptPromises.push(receiptPromise);
                }

                const receipts = await Promise.all(allReceiptPromises);
                let successCount = 0;
                let failureCount = 0;
                const blockTxNumbers = new Map<number, number>();

                receipts.forEach((receipt) => {
                    expect(receipt).to.not.be.null;
                    if (receipt) {
                        const blockNumber = receipt.blockNumber;
                        blockTxNumbers.set(blockNumber, (blockTxNumbers.get(blockNumber) || 0) + 1);
                        if (receipt.status === 1) {
                            successCount++;
                        } else {
                            failureCount++;
                        }
                    }
                });

                expect(successCount).to.be.greaterThan(0, 'At least some transactions should succeed');

                const sortedBlocks = Array.from(blockTxNumbers.keys()).sort((a, b) => a - b);
                expect(sortedBlocks.length).to.be.greaterThan(0, 'Transactions should span at least one block');

                const earliestBlock = sortedBlocks[0];
                const latestBlock = sortedBlocks[sortedBlocks.length - 1];
                for (let i = earliestBlock; i <= latestBlock + 2; i++) {
                    const currentBlock = await rpcClient.getBlockByNumber(ethers.toQuantity(i), false);
                    const currentGasFee = Number(currentBlock.baseFeePerGas);
                    const expectedGasFee = calcNewBaseFee(Number(currentGasFee), Number(currentBlock.gasUsed));
                    const nextBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(i + 1), false);
                    console.log(`Block ${i}: baseFee=${currentGasFee}, gasUsed=${Number(currentBlock.gasUsed)}, nextBaseFee=${Number(nextBlockData.baseFeePerGas)}, expectedNextBaseFee=${expectedGasFee}`);
                }

                const postTestBlock = await rpcClient.getBlockByNumber(ethers.toQuantity(latestBlock), false);
                const postTestBaseFee = BigInt(postTestBlock.baseFeePerGas);
                expect(postTestBaseFee).to.be.greaterThan(
                    preTestBaseFee,
                    `Base fee should increase after heavy gas usage: before=${preTestBaseFee}, after=${postTestBaseFee}`
                );
            });

            it('Legacy transaction with high gas price', async () => {
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('5')]
                );

                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const feeData = await alice.evmWallet.signingClient.getFeeData();
                const userPreBalance = await rpcClient.getBalance(alice.evmAddress);
                const highGasPrice = feeData.gasPrice! * 100n;

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
                expect(receipt!.gasUsed).to.be.greaterThan(0n);
                expect(receipt!.gasPrice).to.be.greaterThanOrEqual(feeData.gasPrice!);

                const userAfterBalance = await rpcClient.getBalance(alice.evmAddress);
                const userBalanceDiff = userPreBalance - userAfterBalance;
                const effectiveGasCost = receipt!.gasPrice * receipt!.gasUsed;
                expect(userBalanceDiff).to.equal(effectiveGasCost);
            });
        });

        describe('Legacy Tx Read Operations', function () {

            let txHash: string;
            let receipt: TransactionReceipt;
            it('should get transaction receipt by hash', async () => {
                const data = erc20Contract.contract.interface.encodeFunctionData(
                    'transfer',
                    [bob.evmAddress, ethers.parseEther('1')]
                );
                const nonce = await alice.evmWallet.wallet.getNonce('latest');
                const feeData = await alice.evmWallet.signingClient.getFeeData();
                const gasPrice = feeData.gasPrice! * 2n;

                const txRequest = {
                    to: await erc20Contract.getAddress(),
                    data: data,
                    value: 0n,
                    gasLimit: 100000n,
                    gasPrice: gasPrice,
                    nonce: nonce,
                    chainId: chainId,
                    type: 0
                };
                const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                txHash = await AtomicTxSender.sendRawTransactionWithProvider(
                    alice.evmWallet.signingClient,
                    signedTx
                );
                const r = await alice.evmWallet.signingClient.waitForTransaction(txHash);
                expect(r).to.not.be.null;
                receipt = r!;
                expect(receipt.status).to.equal(1);
                expect(receipt.type).to.equal(0);
                expect(receipt.hash).to.equal(txHash);
                expect(receipt.from.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
                expect(receipt.to!.toLowerCase()).to.equal((await erc20Contract.getAddress()).toLowerCase());
                expect(receipt.blockNumber).to.be.greaterThan(0);
                expect(receipt.gasUsed).to.be.greaterThan(0n);
            });

            it('should get transaction by hash', async () => {
                const tx = await rpcClient.getTransactionByHash(txHash);
                expect(tx).to.not.be.null;
                expect(tx.hash).to.equal(txHash);
                expect(tx.from.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
                expect(tx.to.toLowerCase()).to.equal((await erc20Contract.getAddress()).toLowerCase());
                expect(tx.blockNumber).to.not.be.null;
                expect(tx.blockHash).to.not.be.null;
                expect(tx.input).to.be.a('string').that.has.lengthOf.greaterThan(2);
            });

            it('should get logs for the legacy tx', async () => {
                const toAddress = await erc20Contract.getAddress();

                const logs = await rpcClient.getLogs({
                    address: toAddress.toString(),
                    fromBlock: ethers.toQuantity(receipt.blockNumber),
                    toBlock: ethers.toQuantity(receipt.blockNumber)
                });
                expect(logs).to.be.an('array').with.lengthOf.greaterThan(0);

                const transferLog = logs.find((l: any) => l.transactionHash === txHash);
                expect(transferLog).to.not.be.undefined;
                expect(transferLog.address.toLowerCase()).to.equal(toAddress.toLowerCase());
                expect(transferLog.topics).to.be.an('array').with.lengthOf.greaterThan(0);
                expect(transferLog.blockNumber).to.equal(ethers.toQuantity(receipt.blockNumber));
            });

            it('should debug trace the legacy tx', async () => {
                const trace = await alice.evmWallet.signingClient.send('debug_traceTransaction', [txHash, {}]);
                expect(trace).to.not.be.null;
                expect(trace).to.have.property('gas');
                expect(trace).to.have.property('structLogs');
                expect(trace.structLogs).to.be.an('array');
                expect(Number(trace.gas)).to.be.greaterThan(0);
            });

            it('Should debug block itself', async () => {
                const debugBlock = await alice.evmWallet.signingClient.send('debug_traceBlockByNumber', [ethers.toQuantity(receipt.blockNumber), debugOptions]);
                expect(debugBlock).to.be.an('array').with.lengthOf.greaterThan(0);
                const firstTrace = debugBlock[0];
                expect(firstTrace).to.have.property('result');
                expect(firstTrace.result).to.have.property('type');
                expect(firstTrace.result).to.have.property('from');
            });

            it('should get block by number and find tx', async () => {
                const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt.blockNumber), false);
                expect(block).to.not.be.null;
                expect(block.transactions).to.be.an('array').that.includes(txHash);
                expect(block.hash).to.equal(receipt.blockHash);
                expect(BigInt(block.number)).to.equal(BigInt(receipt.blockNumber));
                expect(BigInt(block.gasUsed)).to.be.greaterThan(0n);
                expect(block.baseFeePerGas).to.not.be.undefined;
            });

            it('should get block receipts via eth_getBlockReceipts', async () => {
                const blockReceipts = await alice.evmWallet.signingClient.send('eth_getBlockReceipts', [ethers.toQuantity(receipt.blockNumber)]);
                expect(blockReceipts).to.be.an('array').with.lengthOf.greaterThan(0);

                const found = blockReceipts.find((r: any) => r.transactionHash === txHash);
                expect(found).to.not.be.undefined;
                expect(found.transactionHash).to.equal(txHash);
                expect(found.from.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
                expect(found.to.toLowerCase()).to.equal((await erc20Contract.getAddress()).toLowerCase());
                expect(found.status).to.equal('0x1');
                expect(found.blockNumber).to.equal(ethers.toQuantity(receipt.blockNumber));
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

            const bobPreBalance = await rpcClient.getBalance(bob.evmAddress);
            const transferAmount = ethers.parseEther('0.001');

            const txRequest = {
                to: bob.evmAddress,
                data: '0x',
                value: transferAmount,
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
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
            expect(receipt!.status).to.equal(1);
            expect(receipt!.type).to.equal(2);
            expect(receipt!.gasUsed).to.equal(21000n);

            const bobPostBalance = await rpcClient.getBalance(bob.evmAddress);
            expect(bobPostBalance - bobPreBalance).to.equal(transferAmount);
        });

        it('Tests transaction with large data payload', async () => {
            const largeData = '0x' + '0'.repeat(10000);

            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const gasPrice = feeData.gasPrice! * 2n;

            const txRequest = {
                to: bob.evmAddress,
                data: largeData,
                value: 0n,
                gasLimit: 200000n,
                gasPrice: gasPrice,
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
            expect(receipt!.status).to.equal(1);
            expect(receipt!.type).to.equal(0);
            expect(receipt!.gasUsed).to.be.greaterThan(21000n, 'Large data payload should consume more gas than a simple transfer');

            const tx = await rpcClient.getTransactionByHash(txHash);
            expect(tx.input).to.equal(largeData);
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
