import { ethers } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { TokenDeployer } from '../../shared/Deployer';
import { EvmRpcClient } from '../../shared/RpcClient';
import { AtomicTxSender } from '../../shared/TxBuilder';
import { waitFor } from '../../shared/utils/helpers';
import { Erc20Token } from '../../shared/Token';
import testConfig from '../../config/testConfig.json';
import { coins } from '@cosmjs/amino';
import { buildWasmExecuteMsg, ensureCw20Balance, existingWasmAddresses } from './existingWasm';

describe('Transaction Execution Tests', function () {
    this.timeout(10 * 60 * 1000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let provider: ethers.JsonRpcProvider;
    let rpcClient: EvmRpcClient;
    let deployer: TokenDeployer;
    let erc20: Erc20Token;
    let chainId: bigint;

    before('Initialize users and deploy contracts', async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'alice');
        bob = await UserFactory.createSeiUser(admin, 'bob');
        provider = admin.evmWallet.signingClient;
        rpcClient = new EvmRpcClient(testConfig.evmRpcEndpoint, provider);
        deployer = new TokenDeployer(admin);
        erc20 = await deployer.deployErc20();
        await waitFor(2);
        await erc20.mint(admin.evmAddress, ethers.parseEther('10000').toString());
        await erc20.mint(alice.evmAddress, ethers.parseEther('1000').toString());
        await waitFor(1);
        chainId = (await provider.getNetwork()).chainId;
    });

    describe('EVM - Successful Execution', function () {

        it('Simple ETH transfer executes and balances update correctly', async () => {
            const senderBefore = await rpcClient.getBalance(alice.evmAddress);
            const receiverBefore = await rpcClient.getBalance(bob.evmAddress);
            const amount = ethers.parseEther('0.01');

            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: amount,
            });
            const receipt = await tx.wait();

            expect(receipt!.status).to.equal(1);
            expect(receipt!.gasUsed).to.equal(21000n);

            const senderAfter = await rpcClient.getBalance(alice.evmAddress);
            const receiverAfter = await rpcClient.getBalance(bob.evmAddress);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;

            expect(receiverAfter - receiverBefore).to.equal(amount);
            expect(senderBefore - senderAfter).to.equal(amount + gasCost);
        });

        it('ERC20 transfer executes and token balances update correctly', async () => {
            const transferAmount = ethers.parseEther('10');
            const senderTokensBefore = await erc20.contract.balanceOf(alice.evmAddress);
            const receiverTokensBefore = await erc20.contract.balanceOf(bob.evmAddress);

            const data = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                transferAmount,
            ]);
            const nonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();

            const estimatedGas = await provider.estimateGas({
                from: alice.evmAddress,
                to: erc20.getAddress(),
                data,
            });
            const txRequest = {
                to: erc20.getAddress(),
                data,
                value: 0n,
                gasLimit: estimatedGas * 2n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            const receipt = await provider.waitForTransaction(txHash);

            expect(receipt!.status).to.equal(1);

            const senderTokensAfter = await erc20.contract.balanceOf(alice.evmAddress);
            const receiverTokensAfter = await erc20.contract.balanceOf(bob.evmAddress);

            expect(senderTokensBefore - senderTokensAfter).to.equal(transferAmount);
            expect(receiverTokensAfter - receiverTokensBefore).to.equal(transferAmount);
        });

        it('Contract deployment executes and code is stored', async () => {
            const newErc20 = await deployer.deployErc20();
            await waitFor(2);

            const contractAddr = newErc20.getAddress();
            expect(contractAddr).to.match(/^0x[0-9a-fA-F]{40}$/,
                'Deployed contract should have a valid EVM address');

            const code = await provider.send('eth_getCode', [contractAddr, 'latest']);
            expect(code).to.not.equal('0x', 'Deployed contract should have non-empty bytecode');
            expect(code).to.match(/^0x[0-9a-fA-F]+$/,
                'Contract bytecode should be a valid hex string');
            expect(code.length).to.be.above(100,
                'ERC20 contract bytecode should be substantial (> 100 hex chars)');
        });

        it('Receipt contains correct fields after successful execution', async () => {
            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1, 'Simple ETH transfer should succeed');
            expect(receipt!.from.toLowerCase()).to.equal(alice.evmAddress.toLowerCase(),
                'Receipt "from" should match sender');
            expect(receipt!.to!.toLowerCase()).to.equal(bob.evmAddress.toLowerCase(),
                'Receipt "to" should match recipient');
            expect(receipt!.blockNumber).to.be.above(0);
            expect(receipt!.blockHash).to.match(/^0x[0-9a-fA-F]{64}$/,
                'blockHash should be a 32-byte hex string');
            expect(receipt!.hash).to.match(/^0x[0-9a-fA-F]{64}$/,
                'tx hash should be a 32-byte hex string');
            expect(receipt!.gasUsed).to.equal(21000n,
                'Simple ETH transfer should consume exactly 21000 gas');
            expect(Number(receipt!.gasPrice)).to.be.above(0,
                'gasPrice should be positive');
            expect(receipt!.index).to.be.gte(0);
        });
    });

    describe('EVM - Failed Execution (Gas IS Consumed)', function () {

        it('Contract revert consumes partial gas and charges the sender', async () => {
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const aliceTokens = await erc20.contract.balanceOf(alice.evmAddress);

            const data = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                aliceTokens + ethers.parseEther('999999'),
            ]);
            const nonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();
            const gasLimit = 200000n;

            const txRequest = {
                to: erc20.getAddress(),
                data,
                value: 0n,
                gasLimit,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            const receipt = await provider.waitForTransaction(txHash);

            expect(receipt!.status).to.equal(0, 'Tx should revert for insufficient token balance');
            expect(receipt!.gasUsed > 21000n).to.equal(true,
                'Reverted tx should consume more than intrinsic gas (execution started)');
            expect(receipt!.gasUsed < gasLimit).to.equal(true,
                'Reverted tx should consume less than the full gas limit');

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            expect(balanceBefore - balanceAfter).to.equal(gasCost,
                'Sender pays gas consumed up to the revert point');
        });

        it('Out-of-gas during execution consumes the entire gas limit', async () => {
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const data = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                ethers.parseEther('1'),
            ]);
            const nonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();
            const tightGasLimit = 30000n;

            const txRequest = {
                to: erc20.getAddress(),
                data,
                value: 0n,
                gasLimit: tightGasLimit,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            const receipt = await provider.waitForTransaction(txHash);

            expect(receipt!.status).to.equal(0, 'Tx should fail with out of gas');
            expect(receipt!.gasUsed).to.equal(tightGasLimit,
                'OOG should consume the entire gas limit');

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            expect(balanceBefore - balanceAfter).to.equal(gasCost,
                'Sender pays for the full gas limit on OOG');
        });

        it('Sending value to a contract without receive/fallback consumes gas', async () => {
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const nonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();
            const gasLimit = 200000n;

            const txRequest = {
                to: erc20.getAddress(),
                data: '0x',
                value: ethers.parseEther('0.001'),
                gasLimit,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            const receipt = await provider.waitForTransaction(txHash);

            expect(receipt!.status).to.equal(0,
                'Sending ETH to a contract without receive/fallback should revert');
            expect(receipt!.gasUsed >= 21000n).to.equal(true,
                'Reverted tx should consume at least intrinsic gas (21000)');

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            // Value is NOT transferred on revert, only gas is charged
            expect(balanceBefore - balanceAfter).to.equal(gasCost,
                'Only gas cost should be deducted, value should not be transferred on revert');
        });

        it('Successful tx uses less gas than the same tx that reverts', async () => {
            const transferAmount = ethers.parseEther('1');
            const feeData = await provider.getFeeData();

            // Successful transfer
            const successData = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                transferAmount,
            ]);
            const successNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const successEstimate = await provider.estimateGas({
                from: alice.evmAddress,
                to: erc20.getAddress(),
                data: successData,
            });
            const successTx = {
                to: erc20.getAddress(),
                data: successData,
                value: 0n,
                gasLimit: successEstimate * 2n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: successNonce,
                chainId,
                type: 2,
            };
            const successSigned = await alice.evmWallet.wallet.signTransaction(successTx);
            const successHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, successSigned);
            const successReceipt = await provider.waitForTransaction(successHash);
            expect(successReceipt!.status).to.equal(1);

            // Failing transfer (insufficient token balance)
            const aliceTokens = await erc20.contract.balanceOf(alice.evmAddress);
            const failData = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                aliceTokens + ethers.parseEther('999999'),
            ]);
            const failNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const failTx = {
                to: erc20.getAddress(),
                data: failData,
                value: 0n,
                gasLimit: successEstimate * 2n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: failNonce,
                chainId,
                type: 2,
            };
            const failSigned = await alice.evmWallet.wallet.signTransaction(failTx);
            const failHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, failSigned);
            const failReceipt = await provider.waitForTransaction(failHash);
            expect(failReceipt!.status).to.equal(0);

            expect(successReceipt!.gasUsed > 0n).to.equal(true, 'Successful tx should consume gas');
            expect(failReceipt!.gasUsed > 0n).to.equal(true, 'Failed tx should consume gas');
            expect(failReceipt!.gasUsed < successReceipt!.gasUsed).to.equal(true,
                `Reverted tx (${failReceipt!.gasUsed}) should use less gas than successful tx (${successReceipt!.gasUsed})`);
        });
    });

    describe('EVM - Rejected Transactions (NO Gas Consumed)', function () {

        it('Gas price below base fee: rejected, no balance change', async () => {
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const nonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');

            const txRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                gasPrice: 1n,
                nonce,
                chainId,
                type: 0,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);

            let rejected = false;
            let rejectError = '';
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            } catch (err: any) {
                rejected = true;
                rejectError = (err.message || '').toLowerCase();
            }
            expect(rejected).to.be.true;
            expect(rejectError).to.include('insufficient fee',
                'Sei rejects low gas price as insufficient fee');

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            expect(balanceAfter).to.equal(balanceBefore,
                'No gas should be deducted when tx is rejected at mempool');
        });

        it('Intrinsic gas too low: rejected, no balance change', async () => {
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const nonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();

            const txRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 100n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);

            let rejected = false;
            let rejectError = '';
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            } catch (err: any) {
                rejected = true;
                rejectError = (err.message || '').toLowerCase();
            }
            expect(rejected).to.be.true;
            expect(rejectError).to.be.a('string').and.have.length.above(0,
                'Should receive an error message when gas is too low');

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            expect(balanceAfter).to.equal(balanceBefore,
                'No gas should be deducted when tx fails intrinsic gas check');
        });

        it('Insufficient balance for value + gas: rejected, no balance change', async () => {
            const poorUser = await UserFactory.createSeiUser(admin, 'txExecPoor2');
            await waitFor(2);
            const poorBalance = await rpcClient.getBalance(poorUser.evmAddress);
            const nonce = await rpcClient.getTransactionCount(poorUser.evmAddress, 'latest');
            const feeData = await provider.getFeeData();

            const txRequest = {
                to: bob.evmAddress,
                value: poorBalance + ethers.parseEther('100'),
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce,
                chainId,
                type: 2,
            };
            const signedTx = await poorUser.evmWallet.wallet.signTransaction(txRequest);

            let rejected = false;
            let rejectError = '';
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            } catch (err: any) {
                rejected = true;
                rejectError = (err.message || '').toLowerCase();
            }
            expect(rejected).to.be.true;
            expect(rejectError).to.include('insufficient funds',
                'EVM should reject tx with insufficient funds');

            const balanceAfter = await rpcClient.getBalance(poorUser.evmAddress);
            expect(balanceAfter).to.equal(poorBalance,
                'No gas should be deducted when sender cannot cover value + gas');
        });
    });

    describe('Cosmos - Successful Execution', function () {

        it('Bank send executes and balances update correctly', async () => {
            const senderBefore = await alice.seiWallet.queryBalance();
            const receiverBefore = await bob.seiWallet.queryBalance();
            const sendAmount = 100000;
            const feeAmount = parseInt(alice.seiWallet.fee.amount[0].amount);

            const result = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(sendAmount, 'usei'),
                alice.seiWallet.fee,
            );
            expect(result.code).to.equal(0);
            await waitFor(1);

            const senderAfter = await alice.seiWallet.queryBalance();
            const receiverAfter = await bob.seiWallet.queryBalance();

            expect(parseInt(receiverAfter.amount) - parseInt(receiverBefore.amount)).to.equal(sendAmount);
            const senderDiff = parseInt(senderBefore.amount) - parseInt(senderAfter.amount);
            expect(senderDiff).to.equal(sendAmount + feeAmount,
                'Sender pays send amount + full fee');
        });

        it('Cosmos tx result contains correct height and transaction hash', async () => {
            const feeGas = parseInt(alice.seiWallet.fee.gas);
            const result = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                alice.seiWallet.fee,
            );

            expect(result.code).to.equal(0);
            expect(result.height).to.be.above(0);
            expect(result.transactionHash).to.be.a('string');
            expect(result.transactionHash).to.match(/^[0-9A-F]{64}$/,
                'Cosmos tx hash should be 64 hex uppercase chars');
            expect(Number(result.gasUsed)).to.be.above(0);
            expect(Number(result.gasWanted)).to.equal(feeGas,
                'gasWanted should match the gas limit set in fee');
            expect(Number(result.gasUsed)).to.be.lte(Number(result.gasWanted),
                'gasUsed should not exceed gasWanted');
        });
    });

    describe('Cosmos - Failed Execution', function () {

        it('Bank send with insufficient balance fails — fee is deducted by ante handler', async () => {
            const poorUser = await UserFactory.createSeiUser(admin, 'txExecPoor');
            await waitFor(2);

            const balance = await poorUser.seiWallet.queryBalance();
            const balanceBefore = parseInt(balance.amount);
            const feeAmount = parseInt(poorUser.seiWallet.fee.amount[0].amount);

            let failed = false;
            let errorMsg = '';
            try {
                const result = await poorUser.seiWallet.signingClient.sendTokens(
                    poorUser.seiAddress,
                    bob.seiAddress,
                    coins(balanceBefore + 999999999, 'usei'),
                    poorUser.seiWallet.fee,
                );
                if (result.code !== 0) {
                    failed = true;
                    errorMsg = result.rawLog || '';
                } else {
                    expect.fail('Tx should fail for insufficient balance');
                }
            } catch (err: any) {
                failed = true;
                errorMsg = (err.message || '').toLowerCase();
            }
            expect(failed).to.be.true;
            expect(errorMsg.toLowerCase()).to.include('insufficient funds',
                'Error should mention insufficient funds');
            await waitFor(1);

            const balanceAfter = await poorUser.seiWallet.queryBalance();
            const diff = balanceBefore - parseInt(balanceAfter.amount);
            expect(diff).to.equal(feeAmount,
                `User has enough for fee (${feeAmount} usei), so ante handler passes and deducts fee. ` +
                `Send fails during execution but fee is not refunded.`);
        });

        it('Bank send with insufficient fee amount fails and no gas deducted', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const lowFee = { amount: coins(1, 'usei'), gas: '200000' };

            let failed = false;
            let errorMsg = '';
            try {
                const result = await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(1000, 'usei'),
                    lowFee,
                );
                if (result.code !== 0) {
                    failed = true;
                    errorMsg = result.rawLog || '';
                } else {
                    expect.fail('Tx with insufficient fee should not succeed');
                }
            } catch (err: any) {
                failed = true;
                errorMsg = err.message || '';
            }
            expect(failed).to.be.true;
            expect(errorMsg.toLowerCase()).to.include('insufficient fee',
                'Cosmos should reject tx with insufficient fee');
            await waitFor(1);

            const balanceAfter = await alice.seiWallet.queryBalance();
            expect(parseInt(balanceAfter.amount)).to.equal(parseInt(balanceBefore.amount),
                'Balance should not change when tx is rejected for insufficient fee');
        });
    });

    describe('Cosmos - Out of Gas Execution', function () {

        it('Gas limit of 1 with minimal fee is rejected at ante handler, no gas deducted', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const tinyGasFee = { amount: coins(1, 'usei'), gas: '1' };

            let failed = false;
            let errorMsg = '';
            try {
                await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(1000, 'usei'),
                    tinyGasFee,
                );
            } catch (err: any) {
                failed = true;
                errorMsg = err.message.toLowerCase();
            }
            expect(failed).to.be.true;
            expect(errorMsg).to.include('out of gas',
                'Cosmos should reject gas=1 tx with out of gas');
            await waitFor(1);

            const balanceAfter = await alice.seiWallet.queryBalance();
            expect(parseInt(balanceAfter.amount)).to.equal(parseInt(balanceBefore.amount),
                'No gas/fee should be deducted when tx is rejected at ante handler');
        });

        it('Gas limit too low for execution but enough for ante handler — tx fails and gas IS consumed', async () => {
            const probeFee = { amount: coins(100000, 'usei'), gas: '300000' };
            const probeResult = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                probeFee,
            );
            expect(probeResult.code).to.equal(0);
            const actualGasUsed = Number(probeResult.gasUsed);
            await waitFor(1);

            const balanceBefore = await alice.seiWallet.queryBalance();

            const borderlineGas = Math.floor(actualGasUsed * 0.8).toString();
            const feeAmount = Math.ceil(parseInt(borderlineGas) * 0.25).toString();
            const borderlineFee = { amount: coins(feeAmount, 'usei'), gas: borderlineGas };

            let failed = false;
            let errorMsg = '';
            let txResult: any;
            try {
                txResult = await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(1000, 'usei'),
                    borderlineFee,
                );
                if (txResult.code !== 0) {
                    failed = true;
                    errorMsg = txResult.rawLog || '';
                }
            } catch (err: any) {
                failed = true;
                errorMsg = err.message.toLowerCase();
            }

            expect(failed).to.be.true;
            await waitFor(1);

            if (txResult && txResult.code !== 0) {
                expect(txResult.code).to.equal(11, 'OOG error code should be 11');
                // NOTE: On Cosmos SDK, gasUsed can slightly exceed gasWanted on OOG.
                // The gas meter charges for the operation that triggers OOG before the panic fires,
                // so gasUsed overshoots by the cost of that single operation (observed: ~1-2% for native txs).
                expect(Number(txResult.gasUsed)).to.be.above(0,
                    'Gas should be consumed when tx fails during execution');
                expect(Number(txResult.gasWanted)).to.equal(parseInt(borderlineGas),
                    'gasWanted should match the gas limit we set');

                const balanceAfter = await alice.seiWallet.queryBalance();
                const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);
                expect(diff).to.equal(parseInt(feeAmount),
                    'Balance diff should equal the full fee amount (ante handler deducts fee upfront based on gasWanted, not gasUsed)');
            } else {
                const balanceAfter = await alice.seiWallet.queryBalance();
                expect(parseInt(balanceAfter.amount)).to.equal(parseInt(balanceBefore.amount),
                    'No fee deducted when rejected at ante handler');
            }
        });

        it('Successful cosmos tx reports gasUsed <= gasWanted', async () => {
            const feeAmount = 100000;
            const sendAmount = 1000;
            const generousFee = { amount: coins(feeAmount, 'usei'), gas: '300000' };
            const balanceBefore = await alice.seiWallet.queryBalance();

            const result = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(sendAmount, 'usei'),
                generousFee,
            );

            expect(result.code).to.equal(0);
            expect(Number(result.gasUsed)).to.be.above(0, 'gasUsed should be positive');
            expect(Number(result.gasWanted)).to.be.above(0, 'gasWanted should be positive');
            expect(Number(result.gasUsed)).to.be.lte(Number(result.gasWanted),
                'gasUsed should never exceed gasWanted');
            expect(Number(result.gasWanted)).to.equal(300000,
                'gasWanted should match the gas limit we set in the fee');

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();
            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);
            expect(diff).to.equal(feeAmount + sendAmount,
                'Balance diff should equal fee deducted + amount sent');
        });

        it('Cosmos tx with exact gasUsed as gas limit succeeds at the boundary', async () => {
            const probeFee = { amount: coins(100000, 'usei'), gas: '300000' };
            const probeResult = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                probeFee,
            );
            expect(probeResult.code).to.equal(0);
            const actualGasUsed = probeResult.gasUsed;
            await waitFor(1);

            const sendAmount = 1000;
            const tightGas = (Number(actualGasUsed) + 5000).toString();
            const tightFeeAmount = Math.ceil(parseInt(tightGas) * 0.25).toString();
            const tightFee = { amount: coins(tightFeeAmount, 'usei'), gas: tightGas };

            const tightBalanceBefore = await alice.seiWallet.queryBalance();
            const tightResult = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(sendAmount, 'usei'),
                tightFee,
            );
            expect(tightResult.code).to.equal(0, 'Tx should succeed with gas just above actual usage');
            expect(Number(tightResult.gasUsed)).to.be.lte(parseInt(tightGas));
            await waitFor(1);

            const tightBalanceAfter = await alice.seiWallet.queryBalance();
            const tightDiff = parseInt(tightBalanceBefore.amount) - parseInt(tightBalanceAfter.amount);
            expect(tightDiff).to.equal(parseInt(tightFeeAmount) + sendAmount,
                'Balance diff should equal fee + send amount on successful tight-gas tx');

            const tooLowGas = Math.max(Math.floor(Number(actualGasUsed) * 0.5), 50000).toString();
            const tooLowFeeAmount = Math.ceil(parseInt(tooLowGas) * 0.25).toString();
            const tooLowFee = { amount: coins(tooLowFeeAmount, 'usei'), gas: tooLowGas };

            const oogBalanceBefore = await alice.seiWallet.queryBalance();
            let oogFailed = false;
            try {
                const oogResult = await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(sendAmount, 'usei'),
                    tooLowFee,
                );
                if (oogResult.code !== 0) {
                    oogFailed = true;
                    expect(Number(oogResult.gasUsed)).to.be.above(0);

                    await waitFor(1);
                    const oogBalanceAfter = await alice.seiWallet.queryBalance();
                    const oogDiff = parseInt(oogBalanceBefore.amount) - parseInt(oogBalanceAfter.amount);
                    expect(oogDiff).to.equal(parseInt(tooLowFeeAmount),
                        'Failed OOG tx: balance diff should equal fee only (send amount not deducted)');
                }
            } catch (err: any) {
                oogFailed = true;
                await waitFor(1);
                const oogBalanceAfter = await alice.seiWallet.queryBalance();
                expect(parseInt(oogBalanceAfter.amount)).to.equal(parseInt(oogBalanceBefore.amount),
                    'Rejected tx: no balance change');
            }
            expect(oogFailed).to.be.true;
        });
    });

    describe('Cosmos - Wasm Contract Execution', function () {
        let cw20Address: string;

        before('Resolve the existing CW20 and seed alice with tokens', async function () {
            // No wasm store/instantiate here: run against a contract that already
            // exists on this network (uploads are slow/expensive on live chains).
            const existing = existingWasmAddresses().cw20Address;
            if (!existing) this.skip();
            cw20Address = existing;
            // alice is a fresh account each run; the admin is the CW20's minter,
            // so top her up with enough tokens for the transfers below.
            await ensureCw20Balance(admin, cw20Address, alice, 1_000_000n);
        });

        it('Wasm CW20 transfer succeeds with sufficient gas', async () => {
            const feeAmount = 100000;
            const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '1000' },
            });
            const fee = { amount: coins(feeAmount, 'usei'), gas: '400000' };

            const balanceBefore = await alice.seiWallet.queryBalance();
            const result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                alice.seiAddress, [msg], fee,
            );

            expect(result.code).to.equal(0, 'Wasm CW20 transfer should succeed');
            expect(Number(result.gasUsed)).to.be.above(0, 'gasUsed should be positive');
            expect(Number(result.gasWanted)).to.equal(400000,
                'gasWanted should match the gas limit set in fee');
            expect(Number(result.gasUsed)).to.be.lte(400000,
                'gasUsed should not exceed gasWanted');

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();
            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);
            expect(diff).to.equal(feeAmount,
                'Balance diff should equal fee (CW20 transfer moves tokens, not native coins)');
        });

        it('Wasm CW20 transfer with insufficient token balance fails during execution — gas IS consumed', async () => {
            const feeAmount = 100000;
            const balanceBefore = await alice.seiWallet.queryBalance();

            const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '999999999999999' },
            });
            const fee = { amount: coins(feeAmount, 'usei'), gas: '400000' };

            let result: any;
            let threw = false;
            try {
                result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                    alice.seiAddress, [msg], fee,
                );
            } catch (err: any) {
                threw = true;
            }

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();
            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);

            if (!threw && result) {
                expect(result.code).to.not.equal(0,
                    'Tx should fail at contract level for insufficient CW20 balance');
                expect(Number(result.gasUsed)).to.be.above(0,
                    'Gas should be consumed when contract execution reverts');
                expect(Number(result.gasUsed)).to.be.lte(400000,
                    'gasUsed should not exceed gasWanted');
            }
            expect(diff).to.equal(feeAmount,
                'Balance diff should equal full fee (ante handler deducts fee upfront, execution revert does not refund)');
        });

        it('Wasm execute passes ante handler but runs out of gas during execution', async () => {
            const probeMsg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '100' },
            });
            const probeFee = { amount: coins(100000, 'usei'), gas: '400000' };
            const probeResult = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                alice.seiAddress, [probeMsg], probeFee,
            );
            expect(probeResult.code).to.equal(0);
            const actualGasUsed = probeResult.gasUsed;
            await waitFor(1);

            // Gas well below actual usage but above ante handler cost (~40-50k)
            const oogGas = Math.max(Math.floor(Number(actualGasUsed) * 0.4), 60000).toString();
            const oogFeeAmount = Math.ceil(parseInt(oogGas) * 0.25).toString();
            const oogFee = { amount: coins(oogFeeAmount, 'usei'), gas: oogGas };

            const balanceBefore = await alice.seiWallet.queryBalance();
            const oogMsg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '100' },
            });

            let result: any;
            let threw = false;
            try {
                result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                    alice.seiAddress, [oogMsg], oogFee,
                );
            } catch (err: any) {
                threw = true;
            }

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();

            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);

            if (!threw && result) {
                expect(result.code).to.equal(11, 'OOG error code should be 11');
                // NOTE: On CosmWasm, gasUsed can significantly exceed gasWanted on OOG.
                // The Wasm VM checkpoints gas back to the SDK meter in large batches.
                // Between checkpoints the VM can burn tens of thousands of gas that the SDK meter
                // doesn't see yet. When a checkpoint syncs, it charges a huge chunk at once,
                // pushing gasUsed far past gasWanted (observed: ~70% overshoot for wasm vs ~1-2% for native).
                // The fee is based on gasWanted (deducted upfront by ante handler), not gasUsed.
                expect(Number(result.gasUsed)).to.be.above(0, 'Gas should be consumed on OOG');
                expect(Number(result.gasWanted)).to.equal(parseInt(oogGas),
                    'gasWanted should match the gas limit we set');
            }
            expect(diff).to.equal(parseInt(oogFeeAmount),
                'Balance diff should equal fee amount (fee deducted upfront by ante handler based on gasWanted, not refunded on OOG)');
        });

        // NOTE: CosmWasm gas overshoot behavior (observed experimentally):
        // The Wasm VM does NOT meter gas granularly — it checkpoints gas back to the SDK meter
        // at specific points during contract execution (not per-instruction).
        //
        // For a CW20 transfer (~117k gasUsed on success), the first checkpoint syncs ~102k gas
        // in a single batch. This means:
        //   - gasLimit 35k  → rejected at ante handler (threw, no gas consumed)
        //   - gasLimit 47k–94k → ALL report gasUsed = 102,445 (same first checkpoint)
        //   - gasLimit 106k → first checkpoint passes, OOG at second (~106k, 0.7% overshoot)
        //   - gasLimit 111k → passes two checkpoints, OOG at third (~112k, 1.0% overshoot)
        //
        // Consequence: gasUsed can exceed gasWanted by up to ~118% on CosmWasm OOG txs.
        // The fee is always based on gasWanted (deducted upfront by ante handler), not gasUsed.
        // Block-level impact is negligible since block gas limits are in the hundreds of millions.
        it('CosmWasm OOG: fee is deducted correctly regardless of gas overshoot', async () => {
            const probeMsg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '10' },
            });
            const probeFee = { amount: coins(100000, 'usei'), gas: '400000' };
            const probeResult = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                alice.seiAddress, [probeMsg], probeFee,
            );
            expect(probeResult.code).to.equal(0);
            const successGasUsed = Number(probeResult.gasUsed);
            await waitFor(1);

            const gasLimits = [
                { pct: 0.4, label: '40% of actual' },
                { pct: 0.6, label: '60% of actual' },
                { pct: 0.8, label: '80% of actual' },
            ];

            for (const { pct, label } of gasLimits) {
                const gasLimit = Math.max(Math.floor(successGasUsed * pct), 50000);
                const feeAmount = Math.ceil(gasLimit * 0.25);
                const fee = { amount: coins(feeAmount, 'usei'), gas: gasLimit.toString() };
                const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                    transfer: { recipient: bob.seiAddress, amount: '10' },
                });

                const balanceBefore = await alice.seiWallet.queryBalance();

                let code = -1;
                let gasUsed = 0;
                let threw = false;
                try {
                    const result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                        alice.seiAddress, [msg], fee,
                    );
                    code = result.code;
                    gasUsed = Number(result.gasUsed);
                } catch (err: any) {
                    threw = true;
                }
                await waitFor(1);

                const balanceAfter = await alice.seiWallet.queryBalance();
                const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);

                if (!threw) {
                    expect(code).to.equal(11,
                        `[${label}] Tx should fail with OOG (code 11)`);
                    expect(gasUsed).to.be.above(0,
                        `[${label}] Gas should be consumed`);
                    expect(gasUsed).to.be.above(gasLimit,
                        `[${label}] CosmWasm gasUsed should overshoot gasLimit due to batch checkpointing`);
                }
                expect(diff).to.equal(feeAmount,
                    `[${label}] Fee (${feeAmount} usei = gasLimit ${gasLimit} * 0.25) should be deducted exactly, regardless of gasUsed overshoot`);
            }
        });

        it('Wasm execute with unknown/invalid message reverts at contract level — gas consumed', async () => {
            const feeAmount = 100000;
            const balanceBefore = await alice.seiWallet.queryBalance();

            const invalidMsg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                completely_invalid_method: { data: 'garbage' },
            });
            const fee = { amount: coins(feeAmount, 'usei'), gas: '400000' };

            let result: any;
            let threw = false;
            try {
                result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                    alice.seiAddress, [invalidMsg], fee,
                );
            } catch (err: any) {
                threw = true;
            }

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();
            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);

            if (!threw && result) {
                expect(result.code).to.not.equal(0,
                    'Tx should fail for unknown contract message');
                expect(Number(result.gasUsed)).to.be.above(0,
                    'Gas should be consumed even for invalid contract messages');
                expect(Number(result.gasUsed)).to.be.lte(400000,
                    'gasUsed should not exceed gasWanted');
            }
            expect(diff).to.equal(feeAmount,
                'Balance diff should equal fee (invalid message fails during execution, fee not refunded)');
        });

        it('Wasm execute with gas too low for ante handler is rejected — no gas consumed', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '100' },
            });
            const tinyFee = { amount: coins(1, 'usei'), gas: '1' };

            let threw = false;
            let errorMsg = '';
            try {
                await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                    alice.seiAddress, [msg], tinyFee,
                );
            } catch (err: any) {
                threw = true;
                errorMsg = (err.message || '').toLowerCase();
            }

            expect(threw).to.be.true;
            expect(errorMsg).to.include('out of gas',
                'Wasm ante rejection should report out of gas');
            await waitFor(1);

            const balanceAfter = await alice.seiWallet.queryBalance();
            expect(parseInt(balanceAfter.amount)).to.equal(parseInt(balanceBefore.amount),
                'No fee should be deducted when wasm tx is rejected at ante handler');
        });
    });

    describe('Cross-Layer Tx Execution', function () {

        it('EVM tx is visible via sei_getCosmosTx', async () => {
            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();
            await waitFor(1);

            const cosmosTxHash = await provider.send('sei_getCosmosTx', [receipt!.hash]);
            expect(cosmosTxHash).to.be.a('string');
            expect(cosmosTxHash).to.match(/^[0-9A-F]{64}$/,
                'Cosmos tx hash should be 64 hex uppercase chars');
        });

        it('EVM tx hash can be retrieved from its Cosmos tx hash', async () => {
            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();
            await waitFor(1);

            const cosmosTxHash = await provider.send('sei_getCosmosTx', [receipt!.hash]);
            expect(cosmosTxHash).to.be.a('string');
            expect(cosmosTxHash).to.match(/^[0-9A-F]{64}$/,
                'Cosmos tx hash should be 64 hex uppercase chars');

            try {
                const evmTxHash = await provider.send('sei_getEvmTx', [cosmosTxHash]);
                expect(evmTxHash.toLowerCase()).to.equal(receipt!.hash.toLowerCase());
            } catch (e: any) {
                if (e.message?.includes('deprecated') || e.message?.includes('not enabled')) {
                    // sei_getEvmTx is deprecated and may be disabled on this node
                    return;
                }
                throw e;
            }
        });

        it('EVM balance changes are reflected on Cosmos side after transfer', async () => {
            const cosmosBalanceBefore = await alice.seiWallet.queryBalance();
            const amount = ethers.parseEther('0.01');

            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: amount,
            });
            const receipt = await tx.wait();
            await waitFor(2);

            const cosmosBalanceAfter = await alice.seiWallet.queryBalance();
            const diffUsei = BigInt(cosmosBalanceBefore.amount) - BigInt(cosmosBalanceAfter.amount);

            // 1 usei = 10^12 wei, so 0.01 ETH = 10^16 wei = 10000 usei
            const transferAmountUsei = amount / 10n ** 12n;
            const gasCostWei = receipt!.gasUsed * receipt!.gasPrice;
            const gasCostUsei = gasCostWei / 10n ** 12n;
            const expectedDiffUsei = transferAmountUsei + gasCostUsei;

            expect(diffUsei >= expectedDiffUsei).to.equal(true,
                `Cosmos balance diff (${diffUsei} usei) should be >= transfer (${transferAmountUsei}) + gas (${gasCostUsei}) = ${expectedDiffUsei} usei`);
            expect(diffUsei <= expectedDiffUsei + 1n).to.equal(true,
                `Cosmos balance diff (${diffUsei} usei) should not exceed expected (${expectedDiffUsei}) by more than 1 (rounding)`);
        });
    });
});
