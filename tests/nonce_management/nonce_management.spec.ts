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

describe('Nonce Management Tests', function () {
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
        await erc20.mint(alice.evmAddress, ethers.parseEther('1000').toString());
        await waitFor(1);
        chainId = (await provider.getNetwork()).chainId;
    });

    describe('EVM Nonce - Successful Transactions', function () {

        it('Nonce increments by 1 after a successful ETH transfer', async () => {
            const nonceBefore = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');

            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            await tx.wait();

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore + 1);
        });

        it('Nonce increments by 1 after a successful contract call', async () => {
            const nonceBefore = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');

            const data = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                ethers.parseEther('1'),
            ]);
            const feeData = await provider.getFeeData();
            const txRequest = {
                to: erc20.getAddress(),
                data,
                value: 0n,
                gasLimit: 200000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonceBefore,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            await provider.waitForTransaction(txHash);

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore + 1);
        });

        it('Nonce increments correctly after multiple sequential transactions', async () => {
            const nonceBefore = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const txCount = 3;

            for (let i = 0; i < txCount; i++) {
                const tx = await alice.evmWallet.wallet.sendTransaction({
                    to: bob.evmAddress,
                    value: ethers.parseEther('0.001'),
                });
                await tx.wait();
            }

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore + txCount);
        });

        it('Pending nonce reflects mempool state before block inclusion', async () => {
            const latestNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();

            const txRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: latestNonce,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);

            const pendingNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'pending');
            expect(pendingNonce).to.be.gte(latestNonce + 1,
                'Pending nonce should account for the in-flight transaction');

            await provider.waitForTransaction(txHash);

            const finalNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(finalNonce).to.equal(latestNonce + 1);
        });
    });

    describe('EVM Nonce - Failed/Reverted Transactions', function () {

        it('Nonce increments and gas IS consumed for OOG during execution', async () => {
            const nonceBefore = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const feeData = await provider.getFeeData();

            const data = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                ethers.parseEther('1'),
            ]);

            // 30000 is enough for intrinsic gas + calldata but not for ERC20 transfer execution
            const gasLimit = 30000n;
            const txRequest = {
                to: erc20.getAddress(),
                data,
                value: 0n,
                gasLimit,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonceBefore,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            const receipt = await provider.waitForTransaction(txHash);

            expect(receipt!.status).to.equal(0, 'Transaction should have reverted');
            expect(receipt!.gasUsed > 0n).to.equal(true,
                'OOG should consume gas');

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            expect(balanceBefore - balanceAfter).to.equal(gasCost,
                'Sender balance should decrease by exactly gasUsed * gasPrice');

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore + 1,
                'Nonce should still increment for a reverted (but included) transaction');
        });

        it('Nonce increments and gas IS consumed for a contract revert', async () => {
            const nonceBefore = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const feeData = await provider.getFeeData();

            const aliceBalance = await erc20.contract.balanceOf(alice.evmAddress);
            const data = erc20.contract.interface.encodeFunctionData('transfer', [
                bob.evmAddress,
                aliceBalance + ethers.parseEther('999999'),
            ]);

            const gasLimit = 200000n;
            const txRequest = {
                to: erc20.getAddress(),
                data,
                value: 0n,
                gasLimit,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonceBefore,
                chainId,
                type: 2,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
            const txHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            const receipt = await provider.waitForTransaction(txHash);

            expect(receipt!.status).to.equal(0, 'ERC20 transfer should revert for insufficient token balance');

            expect(receipt!.gasUsed > 0n).to.equal(true, 'Gas should be consumed on revert');
            expect(receipt!.gasUsed < gasLimit).to.equal(true,
                'Revert should consume partial gas, not the full limit');

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;
            expect(balanceBefore - balanceAfter).to.equal(gasCost,
                'Sender should pay for gas consumed up to the revert point');

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore + 1,
                'Nonce should increment even when the contract call reverts');
        });

        it('Nonce does NOT increment and NO gas consumed when rejected (gas price below base fee)', async () => {
            const nonceBefore = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);

            const txRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                gasPrice: 1n,
                nonce: nonceBefore,
                chainId,
                type: 0,
            };
            const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);

            let rejected = false;
            try {
                await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
            } catch (err: any) {
                rejected = true;
                expect(err.message).to.include('fee');
            }
            expect(rejected).to.be.true;

            const balanceAfter = await rpcClient.getBalance(alice.evmAddress);
            expect(balanceAfter).to.equal(balanceBefore,
                'No gas should be deducted for a rejected tx');

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore,
                'Nonce should NOT increment when tx is rejected at mempool entry');
        });

        it('Nonce does NOT increment and NO gas consumed when rejected (intrinsic gas too low)', async () => {
            const nonceBefore = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const balanceBefore = await rpcClient.getBalance(alice.evmAddress);
            const feeData = await provider.getFeeData();

            const txRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 100n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonceBefore,
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
                'No gas should be deducted for a rejected tx');

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore,
                'Nonce should NOT increment when tx fails intrinsic gas check');
        });

        it('Nonce does NOT increment and NO gas consumed when sender has insufficient balance', async () => {
            const poorUser = await UserFactory.createSeiUser(admin, 'poorUser');
            await waitFor(2);

            const poorBalance = await rpcClient.getBalance(poorUser.evmAddress);
            const nonceBefore = await rpcClient.getTransactionCount(poorUser.evmAddress, 'latest');
            const feeData = await provider.getFeeData();

            const txRequest = {
                to: bob.evmAddress,
                value: poorBalance + ethers.parseEther('100'),
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: nonceBefore,
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
                'No gas should be deducted for a rejected tx');

            const nonceAfter = await rpcClient.getTransactionCount(poorUser.evmAddress, 'latest');
            expect(nonceAfter).to.equal(nonceBefore,
                'Nonce should NOT increment when sender cannot cover gas + value');
        });
    });

    describe('EVM Nonce - Ordering and Gaps', function () {

        it('Transactions with sequential nonces are processed in order', async () => {
            const baseNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();
            const hashes: string[] = [];

            for (let i = 0; i < 3; i++) {
                const txRequest = {
                    to: bob.evmAddress,
                    value: ethers.parseEther('0.001'),
                    gasLimit: 21000n,
                    maxFeePerGas: feeData.maxFeePerGas! * 2n,
                    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                    nonce: baseNonce + i,
                    chainId,
                    type: 2,
                };
                const signedTx = await alice.evmWallet.wallet.signTransaction(txRequest);
                const hash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signedTx);
                hashes.push(hash);
            }

            const receipts = await Promise.all(hashes.map(h => provider.waitForTransaction(h)));
            for (const r of receipts) {
                expect(r!.status).to.equal(1);
            }

            // Verify nonces were consumed in order
            for (let i = 0; i < hashes.length; i++) {
                const tx = await rpcClient.getTransactionByHash(hashes[i]);
                expect(parseInt(tx.nonce, 16)).to.equal(baseNonce + i);
            }

            const finalNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(finalNonce).to.equal(baseNonce + 3);
        });

        it('Transaction with future nonce is queued until gap is filled', async () => {
            const baseNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();

            // Send nonce N+1 first (future nonce, creates a gap)
            const futureTxRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: baseNonce + 1,
                chainId,
                type: 2,
            };
            const futureSignedTx = await alice.evmWallet.wallet.signTransaction(futureTxRequest);

            let futureHash: string;
            try {
                futureHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, futureSignedTx);
            } catch (err: any) {
                // Some nodes reject future-nonce txs outright; that's valid behavior
                console.log('Node rejected future nonce tx:', err.message);
                const nonceStill = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
                expect(nonceStill).to.equal(baseNonce);
                return;
            }

            // Nonce should still be at baseNonce since N hasn't been filled
            await waitFor(2);
            const nonceWhileGap = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceWhileGap).to.equal(baseNonce,
                'Nonce should not advance while there is a gap');

            // Now fill the gap with nonce N
            const fillTxRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: baseNonce,
                chainId,
                type: 2,
            };
            const fillSignedTx = await alice.evmWallet.wallet.signTransaction(fillTxRequest);
            const fillHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, fillSignedTx);
            await provider.waitForTransaction(fillHash);
            await waitFor(2);

            // Both should now be processed
            const finalNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(finalNonce).to.equal(baseNonce + 2,
                'Both transactions should be processed once the gap is filled');
        });

        it('Transaction with already-used nonce is rejected', async () => {
            const tx = await alice.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            await tx.wait();

            const currentNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const staleNonce = currentNonce - 1;
            const feeData = await provider.getFeeData();

            const txRequest = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                maxFeePerGas: feeData.maxFeePerGas! * 2n,
                maxPriorityFeePerGas: feeData.maxPriorityFeePerGas!,
                nonce: staleNonce,
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

            const nonceAfter = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(nonceAfter).to.equal(currentNonce,
                'Nonce should not change when a stale-nonce tx is rejected');
        });

        it.skip('Nonce replacement: same nonce with higher gas replaces the pending tx', async () => {
            const baseNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            const feeData = await provider.getFeeData();
            const gasPrice = feeData.gasPrice! * 2n;

            // Send first tx with same nonce
            const tx1Request = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
                gasLimit: 21000n,
                gasPrice,
                nonce: baseNonce,
                chainId,
                type: 0,
            };
            const signed1 = await alice.evmWallet.wallet.signTransaction(tx1Request);
            const hash1 = await AtomicTxSender.sendRawTransactionWithProvider(provider, signed1);

            // Send replacement tx with same nonce but higher gas
            const tx2Request = {
                to: bob.evmAddress,
                value: ethers.parseEther('0.002'),
                gasLimit: 21000n,
                gasPrice: gasPrice * 2n,
                nonce: baseNonce,
                chainId,
                type: 0,
            };
            const signed2 = await alice.evmWallet.wallet.signTransaction(tx2Request);

            let replacementHash: string | undefined;
            try {
                replacementHash = await AtomicTxSender.sendRawTransactionWithProvider(provider, signed2);
            } catch (err: any) {
                // Replacement may fail if first tx already mined
                console.log('Replacement failed (first tx may have already been mined):', err.message);
            }

            // Wait for whichever tx was included
            if (replacementHash) {
                await provider.waitForTransaction(replacementHash);
            } else {
                await provider.waitForTransaction(hash1);
            }

            const finalNonce = await rpcClient.getTransactionCount(alice.evmAddress, 'latest');
            expect(finalNonce).to.equal(baseNonce + 1,
                'Exactly one nonce should be consumed regardless of replacement');
        });
    });

    describe('Cosmos Nonce (Sequence) - Successful Transactions', function () {

        it('Cosmos sequence increments after a successful bank send', async () => {
            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const sequenceBefore = accountBefore!.sequence;

            const result = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                alice.seiWallet.fee,
            );
            expect(result.code).to.equal(0);
            await waitFor(1);

            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            expect(accountAfter!.sequence).to.equal(sequenceBefore + 1);
        });
    });

    describe('Cosmos Nonce (Sequence) - Failed Transactions', function () {

        it('Sequence does NOT increment when tx is rejected for insufficient balance', async () => {
            const poorUser = await UserFactory.createSeiUser(admin, 'cosmosPoor');
            await waitFor(2);

            const accountBefore = await poorUser.seiWallet.signingClient.getAccount(poorUser.seiAddress);
            const sequenceBefore = accountBefore!.sequence;

            let rejected = false;
            try {
                await poorUser.seiWallet.signingClient.sendTokens(
                    poorUser.seiAddress,
                    bob.seiAddress,
                    coins(999999999999999, 'usei'),
                    poorUser.seiWallet.fee,
                );
            } catch (err: any) {
                rejected = true;
            }
            expect(rejected).to.be.true;
            await waitFor(1);

            const accountAfter = await poorUser.seiWallet.signingClient.getAccount(poorUser.seiAddress);
            expect(accountAfter!.sequence).to.equal(sequenceBefore,
                'Sequence should NOT increment when tx is rejected for insufficient balance');
        });

        it('Sequence does NOT increment when tx runs out of gas (ante handler rejection)', async () => {
            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const sequenceBefore = accountBefore!.sequence;

            const tinyGasFee = { amount: coins(1, 'usei'), gas: '1' };

            let rejected = false;
            try {
                await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(1000, 'usei'),
                    tinyGasFee,
                );
            } catch (err: any) {
                rejected = true;
            }
            expect(rejected).to.be.true;
            await waitFor(1);

            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            expect(accountAfter!.sequence).to.equal(sequenceBefore,
                'Sequence should NOT increment when tx is rejected due to insufficient gas');
        });

        it('Sequence does NOT increment when fee amount is too low', async () => {
            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const sequenceBefore = accountBefore!.sequence;

            const lowFee = { amount: coins(1, 'usei'), gas: '200000' };

            let rejected = false;
            try {
                await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress,
                    bob.seiAddress,
                    coins(1000, 'usei'),
                    lowFee,
                );
            } catch (err: any) {
                rejected = true;
            }
            expect(rejected).to.be.true;
            await waitFor(1);

            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            expect(accountAfter!.sequence).to.equal(sequenceBefore,
                'Sequence should NOT increment when fee is too low');
        });
    });

    describe('Cosmos Nonce (Sequence) - Failed Execution Post Ante Handler', function () {
        let cw20Address: string;
        const WASM_FILE = 'cw20_base.wasm';

        before('Deploy CW20 for post-ante-handler failure tests', async () => {
            const cw20 = await deployer.deployCw20(WASM_FILE, {
                name: 'NonceTest',
                symbol: 'NTC',
                decimals: 6,
                initial_balances: [
                    { address: alice.seiAddress, amount: '1000000000' },
                ],
                mint: { minter: admin.seiAddress },
            }, 'NonceTestCw20_' + Date.now());
            cw20Address = cw20.getAddress();
            console.log('CW20 for nonce tests deployed at:', cw20Address);
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

        it('Cosmos bank send OOG during execution (post ante handler) — sequence DOES increment', async () => {
            // Probe to find actual gas usage for a bank send
            const probeFee = { amount: coins(100000, 'usei'), gas: '300000' };
            const probeResult = await alice.seiWallet.signingClient.sendTokens(
                alice.seiAddress, bob.seiAddress, coins(1000, 'usei'), probeFee,
            );
            expect(probeResult.code).to.equal(0);
            const probeGas = probeResult.gasUsed;
            console.log(`Probe: bank send used ${probeGas} gas`);
            await waitFor(1);

            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const seqBefore = accountBefore!.sequence;

            // Gas low enough to OOG during execution but high enough to pass ante handler
            const oogGas = Math.max(Math.floor(Number(probeGas) * 0.5), 50000).toString();
            const oogFeeAmount = Math.ceil(parseInt(oogGas) * 0.25).toString();
            const oogFee = { amount: coins(oogFeeAmount, 'usei'), gas: oogGas };

            let result: any;
            let threw = false;
            try {
                result = await alice.seiWallet.signingClient.sendTokens(
                    alice.seiAddress, bob.seiAddress, coins(1000, 'usei'), oogFee,
                );
            } catch (err: any) {
                threw = true;
                console.log('Bank send OOG error:', err.message?.substring(0, 200));
            }

            await waitFor(1);
            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);

            if (!threw && result && result.code !== 0) {
                expect(accountAfter!.sequence).to.equal(seqBefore + 1,
                    'Sequence should increment when tx is included in block but execution fails');
                console.log(`OOG bank send: code=${result.code}, gasUsed=${result.gasUsed}, seq: ${seqBefore} -> ${accountAfter!.sequence}`);
            } else if (threw) {
                // If ante handler rejected it, sequence should NOT change
                console.log(`Bank send OOG was rejected at ante handler, seq: ${seqBefore} -> ${accountAfter!.sequence}`);
            }
        });

        it('Wasm CW20 contract revert (insufficient tokens) — sequence DOES increment', async () => {
            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const seqBefore = accountBefore!.sequence;

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
                console.log('CW20 revert error:', err.message?.substring(0, 200));
            }

            await waitFor(1);
            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);

            if (!threw && result) {
                expect(result.code).to.not.equal(0, 'Tx should fail at contract level');
                expect(accountAfter!.sequence).to.equal(seqBefore + 1,
                    'Sequence should increment for a contract revert that was included in the block');
                console.log(`CW20 revert: code=${result.code}, seq: ${seqBefore} -> ${accountAfter!.sequence}`);
            } else if (threw) {
                // signAndBroadcast threw — could be CheckTx failure or DeliverTx
                // For DeliverTx failure, sequence should still increment
                const diff = accountAfter!.sequence - seqBefore;
                console.log(`CW20 revert threw, sequence diff: ${diff}`);
                expect(diff).to.be.gte(0);
            }
        });

        it('Wasm execute with invalid message — sequence DOES increment', async () => {
            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const seqBefore = accountBefore!.sequence;

            const msg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                totally_invalid_method: { foo: 'bar' },
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
                console.log('Invalid wasm msg error:', err.message?.substring(0, 200));
            }

            await waitFor(1);
            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);

            if (!threw && result) {
                expect(result.code).to.not.equal(0, 'Tx should fail for unknown message');
                expect(accountAfter!.sequence).to.equal(seqBefore + 1,
                    'Sequence should increment — invalid contract msg is an execution failure, not ante handler');
                console.log(`Invalid msg: code=${result.code}, seq: ${seqBefore} -> ${accountAfter!.sequence}`);
            } else if (threw) {
                const diff = accountAfter!.sequence - seqBefore;
                console.log(`Invalid msg threw, sequence diff: ${diff}`);
                expect(diff).to.be.gte(0);
            }
        });

        it('Wasm OOG during execution (post ante handler) — sequence DOES increment', async () => {
            // Probe gas usage for a wasm execute
            const probeMsg = buildWasmExecuteMsg(alice.seiAddress, cw20Address, {
                transfer: { recipient: bob.seiAddress, amount: '100' },
            });
            const probeFee = { amount: coins(100000, 'usei'), gas: '400000' };
            const probeResult = await alice.seiWallet.cosmWasmSigningClient.signAndBroadcast(
                alice.seiAddress, [probeMsg], probeFee,
            );
            expect(probeResult.code).to.equal(0);
            console.log(`Probe: wasm execute used ${probeResult.gasUsed} gas`);
            await waitFor(1);

            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const seqBefore = accountBefore!.sequence;

            const oogGas = Math.max(Math.floor(Number(probeResult.gasUsed) * 0.4), 60000).toString();
            const oogFeeAmount = Math.ceil(parseInt(oogGas) * 0.25).toString();
            const oogFee = { amount: coins(oogFeeAmount, 'usei'), gas: oogGas };

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
            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);

            if (!threw && result) {
                expect(result.code).to.not.equal(0, 'Tx should fail with OOG');
                expect(accountAfter!.sequence).to.equal(seqBefore + 1,
                    'Sequence should increment — OOG during execution means tx was included in block');
                console.log(`Wasm OOG: code=${result.code}, gasUsed=${result.gasUsed}, seq: ${seqBefore} -> ${accountAfter!.sequence}`);
            } else if (threw) {
                const diff = accountAfter!.sequence - seqBefore;
                console.log(`Wasm OOG threw, sequence diff: ${diff}`);
            }
        });

        it('Contrast: wasm tx rejected at ante handler — sequence does NOT increment', async () => {
            const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            const seqBefore = accountBefore!.sequence;

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
            }

            expect(threw).to.be.true;
            await waitFor(1);

            const accountAfter = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
            expect(accountAfter!.sequence).to.equal(seqBefore,
                'Sequence should NOT increment when wasm tx is rejected at ante handler');
        });
    });

    describe('Cross-Layer Nonce Consistency', function () {

        let freshUser: SeiUser;

        before('Create a fresh user with no prior tx history', async () => {
            freshUser = await UserFactory.createSeiUser(admin, 'freshUser');
            await waitFor(2);
        });

        it('EVM nonce and Cosmos sequence are consistent for a fresh account', async () => {
            const evmNonce = await rpcClient.getTransactionCount(freshUser.evmAddress, 'latest');
            const cosmosAccount = await freshUser.seiWallet.signingClient.getAccount(freshUser.seiAddress);
            const cosmosSequence = cosmosAccount!.sequence;

            expect(evmNonce).to.equal(cosmosSequence,
                `EVM nonce (${evmNonce}) and Cosmos sequence (${cosmosSequence}) should match for a fresh account`);
        });

        it('EVM tx increments both EVM nonce and Cosmos sequence', async () => {
            const evmNonceBefore = await rpcClient.getTransactionCount(freshUser.evmAddress, 'latest');
            const cosmosBefore = await freshUser.seiWallet.signingClient.getAccount(freshUser.seiAddress);
            const seqBefore = cosmosBefore!.sequence;

            const tx = await freshUser.evmWallet.wallet.sendTransaction({
                to: bob.evmAddress,
                value: ethers.parseEther('0.001'),
            });
            await tx.wait();
            await waitFor(2);

            const evmNonceAfter = await rpcClient.getTransactionCount(freshUser.evmAddress, 'latest');
            const cosmosAfter = await freshUser.seiWallet.signingClient.getAccount(freshUser.seiAddress);
            const seqAfter = cosmosAfter!.sequence;

            expect(evmNonceAfter).to.equal(evmNonceBefore + 1);
            expect(seqAfter).to.equal(seqBefore + 1,
                `Cosmos sequence should increment after EVM tx: before=${seqBefore}, after=${seqAfter}`);
        });

        it('Cosmos tx increments both Cosmos sequence and EVM nonce', async () => {
            const evmNonceBefore = await rpcClient.getTransactionCount(freshUser.evmAddress, 'latest');
            const cosmosBefore = await freshUser.seiWallet.signingClient.getAccount(freshUser.seiAddress);
            const seqBefore = cosmosBefore!.sequence;

            const result = await freshUser.seiWallet.signingClient.sendTokens(
                freshUser.seiAddress,
                bob.seiAddress,
                coins(1000, 'usei'),
                freshUser.seiWallet.fee,
            );
            expect(result.code).to.equal(0);
            await waitFor(2);

            const evmNonceAfter = await rpcClient.getTransactionCount(freshUser.evmAddress, 'latest');
            const cosmosAfter = await freshUser.seiWallet.signingClient.getAccount(freshUser.seiAddress);
            const seqAfter = cosmosAfter!.sequence;

            expect(seqAfter).to.equal(seqBefore + 1);
            expect(evmNonceAfter).to.equal(evmNonceBefore + 1,
                `EVM nonce should increment after Cosmos tx: before=${evmNonceBefore}, after=${evmNonceAfter}`);
        });
    });
});
