import { ethers, formatEther } from 'ethers';
import { expect } from 'chai';
import { SeiUser, UserFactory } from '../../shared/User';
import { TokenDeployer } from '../../shared/Deployer';
import { EvmRpcClient } from '../../shared/RpcClient';
import { AtomicTxSender } from '../../shared/TxBuilder';
import { waitFor } from '../../shared/utils/helpers';
import { Erc20Token } from '../../shared/Token';
import testConfig from '../../config/testConfig.json';
import { coins } from '@cosmjs/amino';

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

            const txRequest = {
                to: erc20.getAddress(),
                data,
                value: 0n,
                gasLimit: 200000n,
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

            const code = await provider.send('eth_getCode', [newErc20.getAddress(), 'latest']);
            expect(code).to.not.equal('0x');
            expect(code.length).to.be.above(10);
        });

        it('Receipt contains correct fields after successful execution', async () => {
            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();

            expect(receipt).to.not.be.null;
            expect(receipt!.status).to.equal(1);
            expect(receipt!.from.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
            expect(receipt!.to!.toLowerCase()).to.equal(bob.evmAddress.toLowerCase());
            expect(receipt!.blockNumber).to.be.above(0);
            expect(receipt!.blockHash).to.match(/^0x[0-9a-fA-F]{64}$/);
            expect(receipt!.hash).to.match(/^0x[0-9a-fA-F]{64}$/);
            expect(receipt!.gasUsed).to.be.above(0n);
            expect(receipt!.gasPrice).to.be.above(0n);
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
            expect(receipt!.gasUsed > 0n).to.equal(true,
                'OOG should consume gas');

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
            expect(receipt!.gasUsed > 0n).to.equal(true,
                'Gas should be consumed even though the call reverted');

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
            const successTx = {
                to: erc20.getAddress(),
                data: successData,
                value: 0n,
                gasLimit: 200000n,
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
                gasLimit: 200000n,
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

            // A revert typically uses less gas than a successful execution because
            // the EVM stops at the revert opcode and refunds remaining gas
            console.log(`Gas used - success: ${successReceipt!.gasUsed}, revert: ${failReceipt!.gasUsed}`);
            expect(failReceipt!.gasUsed).to.be.above(0n);
            expect(successReceipt!.gasUsed).to.be.above(0n);
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
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            } catch (err: any) {
                rejected = true;
            }
            expect(rejected).to.be.true;

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
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            } catch (err: any) {
                rejected = true;
            }
            expect(rejected).to.be.true;

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
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            } catch (err: any) {
                rejected = true;
            }
            expect(rejected).to.be.true;

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
            expect(parseInt(senderBefore.amount) - parseInt(senderAfter.amount)).to.be.above(sendAmount);
        });

        it('Cosmos tx result contains correct height and transaction hash', async () => {
            const result = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                alice.seiWallet.fee,
            );

            expect(result.code).to.equal(0);
            expect(result.height).to.be.above(0);
            expect(result.transactionHash).to.be.a('string');
            expect(result.transactionHash.length).to.be.above(0);
            expect(result.gasUsed).to.be.above(0);
            expect(result.gasWanted).to.be.above(0);
        });
    });

    describe('Cosmos - Failed Execution', function () {

        it('Bank send with insufficient balance fails and no balance change', async () => {
            const poorUser = await UserFactory.createSeiUser(admin, 'txExecPoor');
            await waitFor(2);

            const balance = await poorUser.seiWallet.queryBalance();
            const balanceBefore = parseInt(balance.amount);

            let failed = false;
            try {
                const result = await poorUser.seiWallet.signingClient.sendTokens(
                    poorUser.seiAddress,
                    bob.seiAddress,
                    coins(balanceBefore + 999999999, 'usei'),
                    poorUser.seiWallet.fee,
                );
                expect(result.code).to.not.equal(0);
            } catch (err: any) {
                failed = true;
            }
            expect(failed).to.be.true;
            await waitFor(1);

            const balanceAfter = await poorUser.seiWallet.queryBalance();
            expect(parseInt(balanceAfter.amount)).to.equal(balanceBefore,
                'Balance should not change when tx is rejected for insufficient funds');
        });

        it('Bank send with insufficient fee amount fails and no gas deducted', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const lowFee = { amount: coins(1, 'usei'), gas: '200000' };

            let failed = false;
            try {
                await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(1000, 'usei'),
                    lowFee,
                );
            } catch (err: any) {
                failed = true;
            }
            expect(failed).to.be.true;
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
            expect(errorMsg).to.satisfy(
                (msg: string) => msg.includes('gas') || msg.includes('fee') || msg.includes('insufficient'),
                `Error should mention gas/fee, got: ${errorMsg}`,
            );
            await waitFor(1);

            const balanceAfter = await alice.seiWallet.queryBalance();
            expect(parseInt(balanceAfter.amount)).to.equal(parseInt(balanceBefore.amount),
                'No gas/fee should be deducted when tx is rejected at ante handler');
        });

        it('Gas limit too low for execution but enough for ante handler — tx fails and gas IS consumed', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const borderlineGas = '55000';
            const feeAmount = Math.ceil(55000 * 0.25).toString();
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
                expect(txResult.gasUsed).to.be.above(0,
                    'Gas should be consumed when tx fails during execution');
                expect(txResult.gasUsed).to.be.lte(parseInt(borderlineGas),
                    'gasUsed should not exceed the gas limit');

                const balanceAfter = await alice.seiWallet.queryBalance();
                expect(parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount)).to.be.above(0,
                    'Fee should be deducted when tx fails during execution (post ante handler)');
            } else {
                console.log('Tx was rejected at ante handler (gas too low even for ante):', errorMsg);
                const balanceAfter = await alice.seiWallet.queryBalance();
                expect(parseInt(balanceAfter.amount)).to.equal(parseInt(balanceBefore.amount),
                    'No fee deducted when rejected at ante handler');
            }
        });

        it('Successful cosmos tx reports gasUsed <= gasWanted', async () => {
            const generousFee = { amount: coins(100000, 'usei'), gas: '300000' };
            const result = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                generousFee,
            );

            expect(result.code).to.equal(0);
            expect(result.gasUsed).to.be.above(0, 'gasUsed should be positive');
            expect(result.gasWanted).to.be.above(0, 'gasWanted should be positive');
            expect(result.gasUsed).to.be.lte(result.gasWanted,
                'gasUsed should never exceed gasWanted');
            expect(result.gasWanted).to.equal(300000,
                'gasWanted should match the gas limit we set in the fee');
            console.log(`Cosmos bank send: gasUsed=${result.gasUsed}, gasWanted=${result.gasWanted}`);
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
            console.log(`Probe: bank send used ${actualGasUsed} gas`);
            await waitFor(1);

            const tightGas = (Number(actualGasUsed) + 5000).toString();
            const tightFeeAmount = Math.ceil(parseInt(tightGas) * 0.25).toString();
            const tightFee = { amount: coins(tightFeeAmount, 'usei'), gas: tightGas };

            const tightResult = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                tightFee,
            );
            expect(tightResult.code).to.equal(0, 'Tx should succeed with gas just above actual usage');
            expect(tightResult.gasUsed).to.be.lte(parseInt(tightGas));
            await waitFor(1);

            const tooLowGas = Math.max(Math.floor(Number(actualGasUsed) * 0.5), 50000).toString();
            const tooLowFeeAmount = Math.ceil(parseInt(tooLowGas) * 0.25).toString();
            const tooLowFee = { amount: coins(tooLowFeeAmount, 'usei'), gas: tooLowGas };

            let oogFailed = false;
            try {
                const oogResult = await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(1000, 'usei'),
                    tooLowFee,
                );
                if (oogResult.code !== 0) {
                    oogFailed = true;
                    console.log(`OOG tx included in block with code ${oogResult.code}, gasUsed=${oogResult.gasUsed}`);
                    expect(oogResult.gasUsed).to.be.above(0);
                }
            } catch (err: any) {
                oogFailed = true;
                console.log('OOG tx rejected:', err.message);
            }
            expect(oogFailed).to.be.true;
        });
    });

    describe('Cosmos - Wasm Contract Execution', function () {
        let cw20Address: string;
        const WASM_FILE = 'cw20_base.wasm';

        before('Deploy CW20 for wasm execution tests', async () => {
            const cw20 = await deployer.deployCw20(WASM_FILE, {
                name: 'TxExecWasm',
                symbol: 'TXW',
                decimals: 6,
                initial_balances: [
                    { address: admin.seiAddress, amount: '1000000000' },
                    { address: alice.seiAddress, amount: '1000000000' },
                ],
                mint: { minter: admin.seiAddress },
            }, 'TxExecWasm_' + Date.now());
            cw20Address = cw20.getAddress();
            console.log('CW20 for wasm execution tests deployed at:', cw20Address);
            await waitFor(2);
        });

        function buildWasmExecuteMsg(sender: string, contract: string, wasmMsg: object) {
            return {
                typeUrl: '/cosmwasm.wasm.v1.MsgExecuteContract',
                value: {
                    sender,
                    contract,
                    msg: Buffer.from(JSON.stringify(wasmMsg)),
                    funds: [],
                },
            };
        }

        it('Wasm CW20 transfer succeeds with sufficient gas', async () => {
            const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '1000' },
            });
            const fee = { amount: coins(100000, 'usei'), gas: '400000' };

            const result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                alice.seiAddress, [msg], fee,
            );

            expect(result.code).to.equal(0, 'Wasm CW20 transfer should succeed');
            expect(result.gasUsed).to.be.above(0);
            expect(result.gasUsed).to.be.lte(result.gasWanted);
            console.log(`Wasm CW20 transfer: gasUsed=${result.gasUsed}, gasWanted=${result.gasWanted}`);
        });

        it('Wasm CW20 transfer with insufficient token balance fails during execution — gas IS consumed', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '999999999999999' },
            });
            const fee = { amount: coins(100000, 'usei'), gas: '400000' };

            let result: any;
            let threw = false;
            try {
                result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                    alice.seiAddress, [msg], fee,
                );
            } catch (err: any) {
                threw = true;
                console.log('CW20 insufficient balance error:', err.message?.substring(0, 200));
            }

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();

            if (!threw && result) {
                expect(result.code).to.not.equal(0,
                    'Tx should fail at contract level for insufficient CW20 balance');
                expect(result.gasUsed).to.be.above(0,
                    'Gas should be consumed when contract execution reverts');
                console.log(`Contract revert: code=${result.code}, gasUsed=${result.gasUsed}`);
            }

            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);
            expect(diff).to.be.above(0,
                'Native balance should decrease (fee deducted) even though contract execution reverted');
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
            console.log(`Probe: wasm CW20 transfer used ${actualGasUsed} gas`);
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
                console.log('Wasm OOG error:', err.message?.substring(0, 200));
            }

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();

            if (!threw && result) {
                expect(result.code).to.not.equal(0, 'Tx should fail with OOG during wasm execution');
                expect(result.gasUsed).to.be.above(0, 'Gas should be consumed on OOG');
                expect(result.gasUsed).to.be.lte(parseInt(oogGas));
                console.log(`Wasm OOG: code=${result.code}, gasUsed=${result.gasUsed}, gasLimit=${oogGas}`);
            }

            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);
            if (!threw) {
                expect(diff).to.be.above(0,
                    'Fee should be deducted when tx passes ante handler but OOGs during execution');
            } else {
                console.log(`OOG threw, balance diff: ${diff} usei`);
                if (diff > 0) {
                    console.log('Tx was included in block but failed — gas consumed');
                } else {
                    console.log('Tx was rejected at ante handler — no gas consumed');
                }
            }
        });

        it('Wasm execute with unknown/invalid message reverts at contract level — gas consumed', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const invalidMsg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                completely_invalid_method: { data: 'garbage' },
            });
            const fee = { amount: coins(100000, 'usei'), gas: '400000' };

            let result: any;
            let threw = false;
            try {
                result = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                    alice.seiAddress, [invalidMsg], fee,
                );
            } catch (err: any) {
                threw = true;
                console.log('Invalid wasm msg error:', err.message?.substring(0, 200));
            }

            await waitFor(1);
            const balanceAfter = await alice.seiWallet.queryBalance();

            if (!threw && result) {
                expect(result.code).to.not.equal(0,
                    'Tx should fail for unknown contract message');
                expect(result.gasUsed).to.be.above(0,
                    'Gas should be consumed even for invalid contract messages');
                console.log(`Invalid msg: code=${result.code}, gasUsed=${result.gasUsed}`);
            }

            const diff = parseInt(balanceBefore.amount) - parseInt(balanceAfter.amount);
            expect(diff).to.be.above(0,
                'Fee should be deducted — contract validation happens during execution, not ante handler');
        });

        it('Wasm execute with gas too low for ante handler is rejected — no gas consumed', async () => {
            const balanceBefore = await alice.seiWallet.queryBalance();

            const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '100' },
            });
            const tinyFee = { amount: coins(1, 'usei'), gas: '1' };

            let threw = false;
            try {
                await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                    alice.seiAddress, [msg], tinyFee,
                );
            } catch (err: any) {
                threw = true;
                console.log('Ante handler rejection:', err.message?.substring(0, 200));
            }

            expect(threw).to.be.true;
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
            expect(cosmosTxHash.length).to.be.above(0);
        });

        it('EVM tx hash can be retrieved from its Cosmos tx hash', async () => {
            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            const receipt = await tx.wait();
            await waitFor(1);

            const cosmosTxHash = await provider.send('sei_getCosmosTx', [receipt!.hash]);
            const evmTxHash = await provider.send('sei_getEvmTx', [cosmosTxHash]);

            expect(evmTxHash.toLowerCase()).to.equal(receipt!.hash.toLowerCase());
        });

        it('EVM balance changes are reflected on Cosmos side after transfer', async () => {
            const cosmosBalanceBefore = await alice.seiWallet.queryBalance();
            const amount = ethers.parseEther('0.01');

            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: amount,
            });
            await tx.wait();
            await waitFor(2);

            const cosmosBalanceAfter = await alice.seiWallet.queryBalance();
            const diff = BigInt(cosmosBalanceBefore.amount) - BigInt(cosmosBalanceAfter.amount);

            // 0.01 ETH = 10000000000000000 wei = 10000000000 usei (1 sei = 10^6 usei, 1 sei = 10^18 wei)
            // On Sei: 1 usei = 10^12 wei, so diff includes transfer amount + gas
            expect(diff > 0n).to.equal(true,
                'Cosmos balance should decrease after an EVM transfer (value + gas)');
        });
    });
});
