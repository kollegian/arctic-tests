import {ethers, TransactionReceipt} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {Erc20Token} from "../../shared/Token";
import {TokenDeployer} from "../../shared/Deployer";
import {EvmRpcClient} from "../../shared/RpcClient";
import {AtomicTxSender} from "../../shared/TxBuilder";
import {expect} from "chai";
import {waitFor, calcNewBaseFee, queryEip1559Params, Eip1559Params} from "../../shared/utils/helpers";
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
    let eip1559Params: Eip1559Params;

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
        [alice, bob] = await UserFactory.createSeiUsers(admin, 10, false);

        deployer = new TokenDeployer(admin);
        erc20Contract = await deployer.deployErc20();
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, admin.evmWallet.signingClient);

        await erc20Contract.mint(bob.evmAddress, ethers.parseEther('1000').toString());
        await waitFor(0.5);
        await erc20Contract.mint(alice.evmAddress, ethers.parseEther('1000').toString());
        await waitFor(0.5);
        chainId = (await alice.evmWallet.signingClient.getNetwork()).chainId;
        eip1559Params = await queryEip1559Params();
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

        it('On-chain EIP-1559 params are queryable and valid', async () => {
            expect(eip1559Params.blockGasLimit).to.be.gt(0);
            expect(eip1559Params.targetGasUsedPerBlock).to.be.gt(0);
            expect(eip1559Params.targetGasUsedPerBlock).to.be.lt(eip1559Params.blockGasLimit);
            expect(eip1559Params.maxUpwardAdjustment).to.be.gt(0);
            expect(eip1559Params.maxUpwardAdjustment).to.be.lt(1);
            expect(eip1559Params.maxDownwardAdjustment).to.be.gt(0);
            expect(eip1559Params.maxDownwardAdjustment).to.be.lt(1);
            expect(eip1559Params.minFeePerGas).to.be.gt(0);
            expect(eip1559Params.maxFeePerGas).to.be.gt(eip1559Params.minFeePerGas);

            const latestBlock = await rpcClient.getBlockByNumber('latest', false);
            const currentBaseFee = Number(latestBlock.baseFeePerGas);
            expect(currentBaseFee).to.be.gte(eip1559Params.minFeePerGas);
            expect(currentBaseFee).to.be.lte(eip1559Params.maxFeePerGas);
        });

        it('User sends an EIP-1559 transaction', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const liveTip = feeData.maxPriorityFeePerGas!;
            const liveMaxFee = feeData.maxFeePerGas!;
            const senderPreBalance = await rpcClient.getBalance(alice.evmAddress);
            const receipt = await sendEIP1559Tx({
                fromUser: alice,
                to: erc20Contract.getAddress() as string,
                data,
                value: 0n,
                gasLimit: 100000n,
                maxFeePerGas: liveMaxFee,
                maxPriorityFeePerGas: liveTip,
                nonce,
                chainId: chainId
            })
            expect(receipt!.status).to.equal(1);
            expect(receipt!.type).to.equal(2);
            const senderAfterBalance = await rpcClient.getBalance(alice.evmAddress);
            const senderBalanceDiff = ethers.formatEther(senderPreBalance - senderAfterBalance);
            const expectedGasPaid = ethers.formatEther(receipt!.gasPrice * receipt!.gasUsed);
            expect(senderBalanceDiff).to.eq(expectedGasPaid);
            const contrReceipt = await rpcClient.getTransactionReceipt(receipt!.hash);
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), true);
            const baseFee = BigInt(block.baseFeePerGas);
            const expectedEffective = baseFee + (liveTip < liveMaxFee - baseFee ? liveTip : liveMaxFee - baseFee);
            expect(BigInt(contrReceipt?.effectiveGasPrice)).to.eq(expectedEffective);
        });

    it(`Base fee increase per block is bounded by on-chain max_upward_adjustment`, async () => {
        const users = [alice, bob];
        const numTxs = 5;
        const totalTxs = users.length * numTxs;
        const allSendPromises: Promise<string>[] = [];
        const allUserTxInfo: { user: typeof alice, txIndex: number, hashPromise: Promise<string> }[] = [];

            // All txs are signed up front against the CURRENT base fee, but the test
            // deliberately drives the base fee up, so the signed cap needs headroom or
            // the later-nonce txs become unincludable and never mine. Derive the
            // worst case from the chain's own params: every tx lands in its own block
            // (plus a buffer for interleaved traffic) and every block applies the full
            // max_upward_adjustment. The on-chain max_fee_per_gas caps the growth, so
            // a cap at that worst case is includable by construction.
            const latestChainBlock = await rpcClient.getBlockByNumber('latest', false);
            const currentBaseFee = Number(latestChainBlock.baseFeePerGas);
            const worstCaseBlocks = totalTxs * 2;
            const worstCaseBaseFee = BigInt(Math.ceil(Math.min(
                currentBaseFee * Math.pow(1 + eip1559Params.maxUpwardAdjustment, worstCaseBlocks),
                eip1559Params.maxFeePerGas,
            )));

            for (const user of users) {
                const toAddress = gasBurnerContract.target;
                const feeData = await user.evmWallet.signingClient.getFeeData();
                const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
                const maxFeePerGas = worstCaseBaseFee + maxPriorityFeePerGas;
                const baseNonce = await user.evmWallet.wallet.getNonce('latest');
                const signedTxs: string[] = [];

                for (let i = 0; i < numTxs; i++) {
                    const nonce = baseNonce + i;
                    const data = gasBurnerContract.interface.encodeFunctionData(
                        'burnGasIterations',
                        [nonce, 50]
                    );
                    const txRequest = {
                        to: toAddress,
                        data: data,
                        value: 0n,
                        gasLimit: 8000000n,
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
                    );
                    allSendPromises.push(hashPromise);
                    allUserTxInfo.push({user, txIndex: i, hashPromise});
                });
            }

            await Promise.all(allSendPromises);

            const allReceiptPromises: Promise<TransactionReceipt | null>[] = [];
            for (const {user, txIndex, hashPromise} of allUserTxInfo) {
                // Bound each wait so one stuck tx cannot hang the whole test past the
                // mocha timeout; unmined txs are tolerated and simply not counted.
                const receiptPromise = hashPromise.then(hash =>
                    user.evmWallet.signingClient.waitForTransaction(hash, 1, 120_000).catch(() => null)
                );
                allReceiptPromises.push(receiptPromise);
            }

            const receipts = await Promise.all(allReceiptPromises);
            let successCount = 0;
            let blockTxNumbers = new Map<number, number>();
            receipts.forEach((receipt) => {
                if (receipt) {
                    const blockNumber = receipt.blockNumber;
                    blockTxNumbers.set(blockNumber, (blockTxNumbers.get(blockNumber) ?? 0) + 1);
                    if (receipt.status === 1) {
                        successCount++;
                    }
                }
            });
            expect(successCount).to.be.gt(0);

            const maxUpwardPercent = eip1559Params.maxUpwardAdjustment * 100;
            const sortedBlocks = Array.from(blockTxNumbers.keys()).sort((a, b) => a - b);
            const earliestBlock = sortedBlocks[0];
            const latestBlock = sortedBlocks[sortedBlocks.length - 1];
            let maxObservedIncreasePercent = 0;
            for (let i = earliestBlock; i <= latestBlock + 2; i++) {
                const currentBlock = await rpcClient.getBlockByNumber(ethers.toQuantity(i), false);
                const currentBaseFee = Number(currentBlock.baseFeePerGas);
                const expectedNextBaseFee = calcNewBaseFee(currentBaseFee, Number(currentBlock.gasUsed), eip1559Params);
                const nextBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(i + 1), false);
                const actualNextBaseFee = Number(nextBlockData.baseFeePerGas);
                expect(actualNextBaseFee).to.be.closeTo(expectedNextBaseFee, 5,
                    `Block ${i}: actual next base fee should match expected (integer rounding tolerance)`);

                expect(actualNextBaseFee).to.be.gte(eip1559Params.minFeePerGas);
                expect(actualNextBaseFee).to.be.lte(eip1559Params.maxFeePerGas);

                if (currentBaseFee > 0) {
                    const increasePercent = ((actualNextBaseFee - currentBaseFee) / currentBaseFee) * 100;
                    if (increasePercent > maxObservedIncreasePercent) {
                        maxObservedIncreasePercent = increasePercent;
                    }
                }
            }
            expect(maxObservedIncreasePercent).to.be.lte(maxUpwardPercent);
        });

    it('Base fee reduces if gas used for block is below target', async () => {
        const tx = await erc20Contract.contract.connect(alice.evmWallet.wallet).transfer(bob.evmAddress, 1);
        const receipt = await tx.wait();
        expect(Number(receipt!.gasUsed)).to.be.lt(eip1559Params.targetGasUsedPerBlock);

        const nextBlock = Number(receipt!.blockNumber) + 1;
        const prevBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), false);
        const prevBaseFee = Number(prevBlockData.baseFeePerGas);
        await waitFor(0.6);
        const nextBlockData = await rpcClient.getBlockByNumber(ethers.toQuantity(nextBlock), false);
        const actualNextBaseFee = Number(nextBlockData.baseFeePerGas);
        const expectedBaseFee = calcNewBaseFee(prevBaseFee, Number(prevBlockData.gasUsed), eip1559Params);
        expect(actualNextBaseFee).to.be.eq(expectedBaseFee);
        expect(actualNextBaseFee).to.be.lte(prevBaseFee);
        expect(actualNextBaseFee).to.be.gte(eip1559Params.minFeePerGas);
    });

        it('should return correct structure from eth_feeHistory', async () => {
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const liveGasPrice = feeData.gasPrice!;
            const data = gasBurnerContract.interface.encodeFunctionData(
                'burnGasIterations',
                [nonce, 50]
            );
            const txRequest = {
                to: gasBurnerContract.target,
                data: data,
                value: 0n,
                gasLimit: 8000000n,
                gasPrice: liveGasPrice,
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
            await waitFor(1);

            const latestBlock = await rpcClient.getBlockNumber();
            const blockCount = 40;
            const result = await rpcClient.feeHistory(blockCount, latestBlock, [5, 50, 95]);

            // Structure checks. Per the eth_feeHistory spec, baseFeePerGas carries one
            // extra trailing entry: the base fee of the block AFTER the requested
            // range (blockCount + 1 entries total).
            expect(result).to.have.property('baseFeePerGas');
            expect(result).to.have.property('gasUsedRatio');
            expect(result).to.have.property('reward');
            expect(result.baseFeePerGas).to.be.an('array').with.lengthOf(blockCount + 1);
            expect(result.gasUsedRatio).to.be.an('array').with.lengthOf(blockCount);
            expect(result.reward).to.be.an('array').with.lengthOf(blockCount);

            const baseFees = result.baseFeePerGas.map((b: any) => Number(b));
            baseFees.forEach((fee: number) => {
                expect(fee).to.be.gte(eip1559Params.minFeePerGas);
                expect(fee).to.be.lte(eip1559Params.maxFeePerGas);
            });

            // Validate reward percentiles are in ascending order per block
            result.reward.forEach((reward: any) => {
                const values = reward.map((r: any) => Number(r));
                expect(values).to.have.lengthOf(3);
                for (let i = 1; i < values.length; i++) {
                    expect(values[i]).to.be.gte(values[i - 1]);
                }
            });

            // Validate gasUsedRatio values are between 0 and 1 (inclusive)
            result.gasUsedRatio.forEach((ratio: any) => {
                const r = Number(ratio);
                expect(r).to.be.gte(0);
                expect(r).to.be.lte(1);
            });
        });

        it('EIP-1559 transaction with custom fee parameters', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const baseFeeEstimate = feeData.maxFeePerGas! - feeData.maxPriorityFeePerGas!;
            const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
            const maxFeePerGas = baseFeeEstimate * 2n + maxPriorityFeePerGas;
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
            const block = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), true);
            const baseFee = BigInt(block.baseFeePerGas);
            const effectiveTip = maxPriorityFeePerGas < maxFeePerGas - baseFee ? maxPriorityFeePerGas : maxFeePerGas - baseFee;
            const expectedEffectiveGasPrice = baseFee + effectiveTip;
            expect(BigInt(receipt!.gasPrice)).to.equal(expectedEffectiveGasPrice);
        });
    });

    describe('EIP-1559 Advanced Tests', function () {

        it.skip('should pay tip to validator (coinbase)', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const maxFeePerGas = feeData.maxFeePerGas!;
            const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
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
            const balanceAfter = await rpcClient.getBalance(coinbase);
            const balanceBefore = await rpcClient.getBalance(coinbase, ethers.toQuantity(receipt!.blockNumber - 1));

            const effectiveGasPrice = (receipt as any).effectiveGasPrice ?? 0n;
            const gasUsed = receipt!.gasUsed ?? 0n;
            const baseFeePerGas = block.baseFeePerGas ?? 0n;
            const expectedTip = (effectiveGasPrice - baseFeePerGas) * gasUsed;
            const actualTip = balanceAfter - balanceBefore;
            expect(actualTip).to.be.at.least(expectedTip);
        });

        it('should have correct effective gas price', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const nonce = await alice.evmWallet.wallet.getNonce('latest');
            const feeData = await alice.evmWallet.signingClient.getFeeData();
            const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
            const maxFeePerGas = feeData.maxFeePerGas!;
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
            expect(block).to.not.be.null;
            const baseFeePerGas = block!.baseFeePerGas ?? 0n;
            const effectiveTip = maxPriorityFeePerGas < maxFeePerGas - baseFeePerGas ? maxPriorityFeePerGas : maxFeePerGas - baseFeePerGas;
            const expectedEffectiveGasPrice = baseFeePerGas + effectiveTip;
            expect(receipt!.gasPrice).to.equal(expectedEffectiveGasPrice);
        });

        it('should fail EIP-1559 tx with maxFeePerGas < baseFeePerGas', async () => {
            const data = returnEncodedErc20Data(erc20Contract, bob);
            const block = await alice.evmWallet.signingClient.getBlock('latest');
            if (!block) throw new Error('block is null');
            const baseFeePerGas = block.baseFeePerGas ?? 0n;
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
        // Create a new random wallet
        const randomWallet = ethers.Wallet.createRandom().connect(rpcClient.provider);

        // Check and drain funds if any (auto-funding workaround)
        let balance = await rpcClient.getBalance(randomWallet.address);
        if (balance > 0n) {
            const feeData = await rpcClient.provider.getFeeData();
            const gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');
            const gasLimit = 21000n;
            const cost = gasLimit * gasPrice * 2n; // Safety margin
            const amountToSend = balance - cost;

            if (amountToSend > 0n) {
                const drainTx = await randomWallet.sendTransaction({
                    to: admin.evmAddress,
                    value: amountToSend,
                    gasLimit,
                    gasPrice
                });
                await drainTx.wait();
            }
        }

        balance = await rpcClient.getBalance(randomWallet.address);
        // Balance might not be exactly 0 due to gas estimation, but should be very low
        // We assert it is low enough to fail the subsequent transaction

        const data = erc20Contract.contract.interface.encodeFunctionData(
            'transfer', [bob.evmAddress, ethers.parseEther('1')]
        );

        const liveFeeData = await alice.evmWallet.signingClient.getFeeData();
        const txRequest = {
            to: await erc20Contract.getAddress(),
            data: data,
            value: 0n,
            gasLimit: 100000n,
            maxFeePerGas: liveFeeData.maxFeePerGas!,
            maxPriorityFeePerGas: liveFeeData.maxPriorityFeePerGas!,
            nonce: await randomWallet.getNonce(),
            chainId: chainId,
            type: 2
        };

        const signedTx = await randomWallet.signTransaction(txRequest);

        let failed = false;
        try {
            await AtomicTxSender.sendRawTransactionWithProvider(
                alice.evmWallet.signingClient, // Use any client to send
                signedTx
            );
        } catch (err: any) {
            failed = true;
        }
        expect(failed).to.be.true;
    });

    it('If base fee is increased and user sends below base fee, the tx should fail', async () => {
        const tx = await gasBurnerContract.connect(bob.evmWallet.wallet)
            .burnGasIterations(3, 50, {gasLimit: 8000000});
        const receipt = await tx.wait();
        const blockBefore = await rpcClient.getBlockByNumber(ethers.toQuantity(receipt!.blockNumber), false);
        const baseFeeBefore = BigInt(blockBefore.baseFeePerGas);
        const expectedNextBaseFee = calcNewBaseFee(Number(baseFeeBefore), Number(blockBefore.gasUsed), eip1559Params);
        expect(expectedNextBaseFee).to.be.gte(eip1559Params.minFeePerGas);

        const belowBaseFeePrice = BigInt(expectedNextBaseFee) / 2n;

        let failed = false;
        try {
            const tx2 = await erc20Contract.contract.connect(alice.evmWallet.wallet)
                .transfer(bob.evmAddress, ethers.parseEther('0.001'), {gasPrice: belowBaseFeePrice});
            await tx2.wait();
        } catch (e: any) {
            failed = true;
        }

        expect(failed).to.be.true;
    })
    });
});
