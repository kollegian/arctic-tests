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
import {returnEncodedErc20Data} from "../../shared/utils/evmUtils";


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
    });

    async function sendEIP1559Tx({
                                     fromUser,
                                     to,
                                     data,
                                     value = 0n,
                                     gasLimit = 100000n,
                                     maxFeePerGas,
                                     maxPriorityFeePerGas,
                                     nonce,
                                     chainId
                                 }: {
        fromUser: SeiUser,
        to: string,
        data: string,
        value?: bigint,
        gasLimit?: bigint,
        maxFeePerGas: bigint,
        maxPriorityFeePerGas: bigint,
        nonce: number,
        chainId: bigint
    }) {
        const txRequest = {
            to,
            data,
            value,
            gasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            nonce,
            chainId,
            type: 2
        };
        const signedTx = await fromUser.evmWallet.wallet.signTransaction(txRequest);
        const txHash = await AtomicTxSender.sendRawTransactionWithProvider(
            fromUser.evmWallet.signingClient, signedTx
        );
        return fromUser.evmWallet.signingClient.waitForTransaction(txHash);
    }

    let gasBurnerContract: RealGasBurner;
    describe('EIP-1559 Transactions (Type 2)', function () {
        before('Deploys gas burner', async () => {
            const contractFactory = new ethers.ContractFactory(heavyGasAbi.abi, heavyGasAbi.bytecode, alice.evmWallet.wallet);
            const deploymentTx = await contractFactory.deploy();
            gasBurnerContract = await deploymentTx.waitForDeployment() as unknown as RealGasBurner;
        });

        //toDo add assertions for actual gas price
        it('User sends an EIP-1559 transaction', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const senderPreBalance = await rpcClient.getBalance(alice.evmAddress);
            const receipt = await sendEIP1559Tx({
                fromUser: alice,
                to: erc20Contract.getAddress() as string,
                data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: ethers.parseUnits('9', 'gwei'),
                maxPriorityFeePerGas: ethers.parseUnits('4', 'gwei'),
                nonce,
                chainId: chainId
            })
            expect(receipt!.status).to.equal(1);
            expect(receipt!.type).to.equal(2);
            const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
            const senderBalanceDiff = ethers.formatEther(senderPreBalance - senderAfterBalance);
            const expectedGasPaid = ethers.formatEther(receipt!.gasPrice * receipt!.gasUsed);
            console.log(Number(receipt!.gasPrice));
            expect(senderBalanceDiff).to.eq(expectedGasPaid);
            const contrReceipt = await rpcClient.getTransactionReceipt(receipt!.hash);
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), true);
            expect(Number(contrReceipt?.effectiveGasPrice)).to.eq(Number(block.baseFeePerGas) + 4000000000);
        });

        it('Base fee goes up 0.75% if gas used for block is above 850k', async () => {
            const tx = await gasBurnerContract.burnGas(1002, {gasLimit: 35000000, gasPrice: 1100000000});
            const receipt = await tx.wait();
            const nextBlock = Number(receipt!.blockNumber) + 1;
            const prevGasBlockUsed = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), false);
            await waitFor(0.6);
            const baseGasFee = await rpcClient.getBlockByNumber(ethers.toQuantity(nextBlock), false);
            const expectedBaseFee = calcNewBaseFee(Number(prevGasBlockUsed.baseFeePerGas), Number(prevGasBlockUsed.gasUsed));
            expect(Number(baseGasFee.baseFeePerGas)).to.be.eq(expectedBaseFee);
        });

        it.skip('Base fee only increases 1.89% in a single block', async () => {
            const users = [alice, bob];
            const numTxs = 500;
            const allSendPromises: Promise<string>[] = [];
            const allUserTxInfo: { user: typeof alice, txIndex: number, hashPromise: Promise<string> }[] = [];

            for (const user of users) {
                const toAddress = gasBurnerContract.target;
                const feeData = await user.evmWallet.signingClient.getFeeData();
                const maxFeePerGas = feeData.maxFeePerGas!;
                const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
                const baseNonce = await user.evmWallet.wallet.getNonce('latest');
                const signedTxs: string[] = [];

                // Prepare and sign all transactions for this user
                for (let i = 0; i < numTxs; i++) {
                    const nonce = baseNonce + i;
                    const data = gasBurnerContract.interface.encodeFunctionData(
                        'burnGas',
                        [nonce]
                    );
                    const txRequest = {
                        to: toAddress,
                        data: data,
                        value: 0n,
                        gasLimit: 35000000n,
                        maxFeePerGas: maxFeePerGas,
                        maxPriorityFeePerGas: maxPriorityFeePerGas,
                        nonce: nonce,
                        chainId: chainId,
                        type: 2
                    };
                    const signedTx = await user.evmWallet.wallet.signTransaction(txRequest);
                    signedTxs.push(signedTx);
                }

                signedTxs.forEach((signedTx, i) => {
                    const hashPromise = AtomicTxSender.sendRawTransactionWithProvider(
                        user.evmWallet.signingClient,
                        signedTx
                    ).then(hash => {
                        console.log(`EIP-1559 transaction ${i + 1} sent`);
                        return hash;
                    });
                    allSendPromises.push(hashPromise);
                    allUserTxInfo.push({user, txIndex: i, hashPromise});
                });
            }

            // Wait for all tx hashes
            await Promise.all(allSendPromises);

            const allReceiptPromises: Promise<TransactionReceipt | null>[] = [];
            for (const {user, txIndex, hashPromise} of allUserTxInfo) {
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
                    console.log(`EIP-1559 transaction ${idx + 1} failed: receipt is null`);
                }
            });

            const gasFees: { [blockNumber: number]: { actualFee: number, calculatedFee: number } } = {};
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
            }
        });

        it('should return correct structure from eth_feeHistory', async () => {
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const data = gasBurnerContract.interface.encodeFunctionData(
                'burnGas',
                [nonce]
            );
            const txRequest = {
                to: gasBurnerContract.target,
                data: data,
                value: 0n,
                gasLimit: 35000000n,
                gasPrice: 2000000000n,
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
            // expect(receipt?.status).to.be.eq(1);
            // expect(receipt?.type).to.be.eq(0);
            await waitFor(1);
            const blockReceipt = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), true);
            console.log(blockReceipt);
            console.log('*******');
            const nextBlockReceipt = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber + 1), true);
            console.log(nextBlockReceipt);
            console.log('*******');
            // Get the latest block number
            const latestBlock = await rpcClient.getBlockNumber();
            const blockCount = 40;
            // Query eth_feeHistory for the last 5 blocks
            const result = await rpcClient.feeHistory(blockCount, latestBlock, [5, 50, 95]);

            console.log('Oldest block is ', Number(result.oldestBlock));
            result.reward.map((reward: any) => {
                const stringified = reward.map((r: any) => Number(r)).join(',');
                console.log(stringified);
            })
            const baseFees = result.baseFeePerGas.map((b: any) => Number(b));
            console.log('Base Fees are ', baseFees);
            // Structure checks
            expect(result).to.have.property('baseFeePerGas');
            expect(result).to.have.property('gasUsedRatio');
            expect(result).to.have.property('reward');
            expect(result.baseFeePerGas).to.be.an('array').with.lengthOf(blockCount);
            expect(result.gasUsedRatio).to.be.an('array').with.lengthOf(blockCount);
            expect(result.reward).to.be.an('array').with.lengthOf(blockCount);
            console.log(result.gasUsedRatio);
        });

        it('EIP-1559 transaction with custom fee parameters', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            // Custom fee parameters
            const maxFeePerGas = ethers.parseUnits('50', 'gwei');
            const maxPriorityFeePerGas = ethers.parseUnits('2', 'gwei');
            const receipt = await sendEIP1559Tx({
                fromUser: alice,
                to: erc20Contract.getAddress() as string,
                data: data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: maxFeePerGas,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                nonce: nonce,
                chainId: chainId,
            })

            expect(receipt!.status).to.equal(1);
            expect(receipt!.type).to.equal(2);
        });
    });

    describe('EIP-1559 Advanced Tests', function () {

        it.skip('should pay tip to validator (coinbase)', async () => {
            // Send EIP-1559 tx
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const maxFeePerGas = feeData.maxFeePerGas!;
            const maxPriorityFeePerGas = ethers.parseUnits('2', 'gwei');
            const receipt = await sendEIP1559Tx({
                fromUser: alice,
                to: erc20Contract.getAddress() as string,
                data: data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: maxFeePerGas,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                nonce: nonce,
                chainId: chainId,
            })
            expect(receipt).to.not.be.null;
            const block = await alice.evmWallet.signingClient.getBlock(receipt!.blockNumber);
            if (!block) throw new Error('block is null');
            const coinbase = block.miner;
            console.log(block);
            const balanceAfter = await rpcClient.getBalance(coinbase);
            const balanceBefore = await rpcClient.getBalance(coinbase, ethers.toQuantity(receipt!.blockNumber - 1));
            console.log(balanceAfter);
            console.log(balanceBefore);

            const effectiveGasPrice = (receipt as any).effectiveGasPrice ?? 0n;
            const gasUsed = receipt!.gasUsed ?? 0n;
            const baseFeePerGas = block.baseFeePerGas ?? 0n;
            const expectedTip = (effectiveGasPrice - baseFeePerGas) * gasUsed;
            const actualTip = balanceAfter - balanceBefore;
            console.log(actualTip);
            console.log(expectedTip);
            expect(actualTip).to.be.at.least(expectedTip);
            console.log('Validator tip paid:', actualTip.toString(), 'Expected at least:', expectedTip.toString());
        });

        it('should have correct effective gas price', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const maxFeePerGas = ethers.parseUnits('9', 'gwei');
            const maxPriorityFeePerGas = ethers.parseUnits('2', 'gwei');
            const receipt = await sendEIP1559Tx({
                fromUser: alice,
                to: erc20Contract.getAddress() as string,
                data: data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: maxFeePerGas,
                maxPriorityFeePerGas: maxPriorityFeePerGas,
                nonce: nonce,
                chainId: chainId,
            })
            if (!receipt) throw new Error('No receipt');
            expect(receipt).to.not.be.null;
            const block = await alice.evmWallet.signingClient.getBlock(receipt.blockNumber);
            if (!block) throw new Error('block is null');
            const baseFeePerGas = block.baseFeePerGas ?? 0n;
            const expectedEffectiveGasPrice = baseFeePerGas + maxPriorityFeePerGas;
            const actualEffectiveGasPrice = (receipt as any).gasPrice;
            expect(actualEffectiveGasPrice).to.equal(expectedEffectiveGasPrice);
            console.log('Effective gas price:', actualEffectiveGasPrice.toString(), 'Expected:', expectedEffectiveGasPrice.toString());
        });

        it('should fail EIP-1559 tx with maxFeePerGas < baseFeePerGas', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const block = await alice.evmWallet.signingClient.getBlock('latest');
            if (!block) throw new Error('block is null');
            const baseFeePerGas = block.baseFeePerGas ?? 0n;
            console.log('base fee per gas is ', baseFeePerGas);
            const maxFeePerGas = baseFeePerGas - 1n;
            const maxPriorityFeePerGas = 1n;
            let failed = false;
            try {
                await sendEIP1559Tx({
                    fromUser: alice,
                    to: erc20Contract.getAddress() as string,
                    data: data,
                    value: 0n,
                    gasLimit: 100000n,
                    maxFeePerGas: maxFeePerGas,
                    maxPriorityFeePerGas: maxPriorityFeePerGas,
                    nonce: await alice.evmWallet.wallet.getNonce('latest'),
                    chainId: chainId,
                })
            } catch (e: any) {
                failed = true;
            }
            expect(failed).to.be.true;
        });

        it('should fail EIP-1559 tx with maxPriorityFeePerGas > maxFeePerGas', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const block = await alice.evmWallet.signingClient.getBlock('latest');
            if (!block) throw new Error('block is null');
            const baseFeePerGas = block.baseFeePerGas ?? 0n;
            const maxFeePerGas = baseFeePerGas + 10n;
            const maxPriorityFeePerGas = maxFeePerGas + 1n;

            let failed = false;
            try {
                await sendEIP1559Tx({
                    fromUser: alice,
                    to: erc20Contract.getAddress() as string,
                    data: data,
                    value: 0n,
                    gasLimit: 100000n,
                    maxFeePerGas: maxFeePerGas,
                    maxPriorityFeePerGas: maxPriorityFeePerGas,
                    nonce: await alice.evmWallet.wallet.getNonce('latest'),
                    chainId: chainId,
                })
            } catch (e: any) {
                failed = true;
            }
            expect(failed).to.be.true;
        });

        it('should fail EIP-1559 tx with insufficient balance', async () => {
            // Create a new user with no balance
            const poorUser = (await UserFactory.createSeiUsers(admin, 1, true))[0];
            const data = erc20Contract.contract.interface.encodeFunctionData(
                'transfer', [bob.evmAddress, ethers.parseEther('1')]
            );
            const nonce = await poorUser.evmWallet.wallet.getNonce('latest');
            const feeData = await poorUser.evmWallet.signingClient.getFeeData();
            const txRequest = {
                to: await erc20Contract.getAddress(),
                data: data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: feeData.maxFeePerGas!,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonce,
                chainId: chainId,
                type: 2
            };
            const signedTx = await poorUser.evmWallet.wallet.signTransaction(txRequest);
            let failed = false;
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(
                    poorUser.evmWallet.signingClient, signedTx
                );
            } catch (err: any) {
                failed = true;
            }
            expect(failed).to.be.true;
        });

        it('If base fee is increased and user sends below base fee, the tx should fail', async () => {
            const tx = await gasBurnerContract.connect(bob.evmWallet.wallet)
                .burnGas(1, {gasLimit: 35000000});
            await waitFor(0.2);
            const tx2 = await erc20Contract.contract.connect(alice.evmWallet.wallet).transfer(bob.evmAddress, ethers.parseEther('1'), {gasPrice: 1000000000});
            const receipt1 = await tx.wait();
            const receipt = await tx2.wait();
            console.log(receipt1?.blockNumber);
            console.log(Number(receipt?.gasPrice));
            console.log(receipt?.blockNumber);
            const blockData = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), false);
            console.log(Number(blockData.baseFeePerGas));
        })
    });
});
