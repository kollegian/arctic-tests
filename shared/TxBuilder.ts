import {TransactionResponse, TransactionReceipt, BigNumberish, ethers} from 'ethers';
import { DeliverTxResponse } from '@cosmjs/stargate';
import { waitFor } from './utils/helpers';
import { EvmRpcClient } from './RpcClient';
import {SeiUser} from "./User";
import {NonceManager} from "../tests/load_tests/NonceManager";
import {TxRaw} from "cosmjs-types/cosmos/tx/v1beta1/tx";

export class AtomicTxSender {

    static async sendMultipleEvmTxs(evmCalls: string[], rpcUrl: string, sender: SeiUser) {
        return await Promise.all(evmCalls.map(evmCall => this.sendRawTransaction(rpcUrl, evmCall, sender)));
    }

    static async sendUntilSameBlock(
        evmCall: () => Promise<TransactionResponse>,
        cosmosCall: () => Promise<DeliverTxResponse>,
        maxAttempts = 5,
        delaySeconds = 1
    ): Promise<{ evmReceipt: TransactionReceipt; cosmosResponse: DeliverTxResponse }> {
        let prevEvmEarlier: boolean | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            let evmTxPromise: Promise<TransactionResponse>;
            let cosmosTxPromise: Promise<DeliverTxResponse>;

            if (prevEvmEarlier === true) {
                cosmosTxPromise = cosmosCall();
                evmTxPromise = (async () => {
                    await waitFor(0.1 * attempt);
                    return evmCall();
                })();
            } else if (prevEvmEarlier === false) {
                evmTxPromise = evmCall();
                cosmosTxPromise = (async () => {
                    await waitFor(0.1 * attempt);
                    return cosmosCall();
                })();
            } else {
                evmTxPromise = evmCall();
                cosmosTxPromise = cosmosCall();
            }

            const [evmTx, cosmosResponse] = await Promise.all([
                evmTxPromise,
                cosmosTxPromise,
            ]);

            const evmReceipt = await evmTx.wait();
            const evmBlock = evmReceipt.blockNumber;
            const cosmosHeight = cosmosResponse.height;

            if (evmBlock === cosmosHeight) {
                return { evmReceipt, cosmosResponse };
            }

            console.warn(
                `Attempt ${attempt}: EVM block ${evmBlock}, Cosmos height ${cosmosHeight}.`
            );

            prevEvmEarlier = evmBlock < cosmosHeight;

            if (attempt < maxAttempts) {
                await waitFor(delaySeconds);
            }
        }

        throw new Error(
            'Failed to include both transactions in the same block after ' +
            maxAttempts +
            ' attempts'
        );
    }

    static async sendCosmosEvmTxs(
        evmTransfer: (user: string) => Promise<TransactionResponse>,
        cosmosTransfer: (user: string) => Promise<DeliverTxResponse>,
        users: string[],
        durationSec = 20,
        blockTimeSec = 0.2
    ): Promise<{ evmReceipts: TransactionReceipt[]; cosmosResponses: DeliverTxResponse[] }> {
        const mid = Math.ceil(users.length / 2);
        const evmUsers = users.slice(0, mid);
        const cosmosUsers = users.slice(mid);

        const evmReceipts: TransactionReceipt[] = [];
        const cosmosResponses: DeliverTxResponse[] = [];

        const start = Date.now();
        while ((Date.now() - start) / 1000 < durationSec) {
            const evmPromises = evmUsers.map((u) => evmTransfer(u).then((tx) => tx.wait()));
            const cosmosPromises = cosmosUsers.map((u) => cosmosTransfer(u));

            const [evmRes, cosmosRes] = await Promise.all([
                Promise.all(evmPromises),
                Promise.all(cosmosPromises),
            ]);

            evmReceipts.push(...evmRes);
            cosmosResponses.push(...cosmosRes);

            await waitFor(blockTimeSec);
        }
        return { evmReceipts, cosmosResponses };
    }


    static async sendRawTransaction(
        rpcUrl: string,
        signedTx: string,
        sender: SeiUser,
    ): Promise<string> {
        const client = new EvmRpcClient(rpcUrl, sender.evmWallet.signingClient);
        return client.sendRawTransaction(signedTx);
    }

    // Polls until the EVM head ticks over (i.e. a new block has been committed)
    // and returns that new height. Used to align a broadcast to the start of a
    // fresh block window, maximizing the chance that subsequent txs land in the
    // same next block.
    static async waitForNextBlock(user: SeiUser, pollMs = 30): Promise<number> {
        const start = await user.evmWallet.signingClient.getBlockNumber();
        while (true) {
            const cur = await user.evmWallet.signingClient.getBlockNumber();
            if (cur > start) return cur;
            await waitFor(pollMs / 1000);
        }
    }

    // Polls eth_getTransactionReceipt until the tx is mined. `sendRawTransaction`
    // only waits for mempool admission, so the receipt is null until a block
    // containing it has been committed.
    static async waitForEvmReceipt(
        rpcClient: EvmRpcClient,
        txHash: string,
        timeoutMs = 10_000,
        pollMs = 100,
    ): Promise<any> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const receipt = await rpcClient.getTransactionReceipt(txHash);
            if (receipt && receipt.blockNumber != null) return receipt;
            await waitFor(pollMs / 1000);
        }
        throw new Error(`evm tx ${txHash} not mined within ${timeoutMs}ms`);
    }

    // Broadcasts a pre-signed cosmos TxRaw via broadcastTxSync (returns after
    // CheckTx, NOT after inclusion) and then polls for the committed tx so we
    // can read its final height. Using sync semantics makes the cosmos side
    // truly concurrent with the EVM `eth_sendRawTransaction` call.
    static async broadcastCosmosAndResolve(
        user: SeiUser,
        signedTx: TxRaw,
        timeoutMs = 10_000,
        pollMs = 100,
    ): Promise<{ txhash: string; height: number }> {
        const raw = TxRaw.encode(signedTx).finish();
        const txhash = await user.seiWallet.cosmWasmSigningClient.broadcastTxSync(raw);
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const found = await user.seiWallet.cosmWasmSigningClient.getTx(txhash);
            if (found) {
                if (found.code !== 0) {
                    throw new Error(`cosmos tx ${txhash} failed with code ${found.code}: ${found.rawLog}`);
                }
                return { txhash, height: found.height };
            }
            await waitFor(pollMs / 1000);
        }
        throw new Error(`cosmos tx ${txhash} not included within ${timeoutMs}ms`);
    }

    // Reliably lands an EVM tx and a Cosmos tx in the same block.
    //
    // Strategy:
    //   1. Wait for a fresh block boundary (maximizes mempool time before the
    //      next proposer builds).
    //   2. Re-sign both txs via the provided factories (each retry must use a
    //      fresh nonce / account sequence).
    //   3. Fire both in parallel using sync broadcast semantics so neither side
    //      blocks on inclusion.
    //   4. Compare heights; retry on mismatch. Each attempt is ~1 block (~400 ms
    //      on Sei), so a handful of retries makes this effectively 100% reliable.
    static async sendAtomicSameBlock(
        user: SeiUser,
        signEvm: () => Promise<string>,
        evmRpcUrl: string,
        signCosmos: () => Promise<TxRaw>,
        rpcClient: EvmRpcClient,
        maxAttempts = 5,
    ): Promise<{ evmTxHash: string; evmReceipt: any; cosmosTxHash: string; blockNumber: number }> {
        const result = await AtomicTxSender.sendAtomicSameBlockBatch(
            user,
            async () => [await signEvm()],
            evmRpcUrl,
            async () => [await signCosmos()],
            rpcClient,
            maxAttempts,
        );
        return {
            evmTxHash: result.evmTxHashes[0],
            evmReceipt: result.evmReceipts[0],
            cosmosTxHash: result.cosmosTxHashes[0],
            blockNumber: result.blockNumber,
        };
    }

    // Batch variant: reliably lands N EVM txs and M cosmos txs in the same
    // block. Same retry/alignment strategy as sendAtomicSameBlock. All EVM
    // receipts and cosmos heights must match the same block number; otherwise
    // we retry with fresh nonces / sequences.
    static async sendAtomicSameBlockBatch(
        user: SeiUser,
        signEvms: () => Promise<string[]>,
        evmRpcUrl: string,
        signCosmoses: () => Promise<TxRaw[]>,
        rpcClient: EvmRpcClient,
        maxAttempts = 5,
    ): Promise<{
        evmTxHashes: string[];
        evmReceipts: any[];
        cosmosTxHashes: string[];
        blockNumber: number;
    }> {
        let lastMismatch: { evm: number[]; cosmos: number[] } | undefined;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await AtomicTxSender.waitForNextBlock(user);

            const [signedEvms, signedCosmoses] = await Promise.all([signEvms(), signCosmoses()]);

            const [evmHashes, cosmosResults] = await Promise.all([
                Promise.all(signedEvms.map((s) => AtomicTxSender.sendRawTransaction(evmRpcUrl, s, user))),
                Promise.all(signedCosmoses.map((s) => AtomicTxSender.broadcastCosmosAndResolve(user, s))),
            ]);

            const evmReceipts = await Promise.all(
                evmHashes.map((h) => AtomicTxSender.waitForEvmReceipt(rpcClient, h)),
            );
            const evmBlocks = evmReceipts.map((r) => Number(r.blockNumber));
            const cosmosHeights = cosmosResults.map((r) => r.height);
            const all = [...evmBlocks, ...cosmosHeights];
            const allSame = all.every((h) => h === all[0]);

            if (allSame) {
                return {
                    evmTxHashes: evmHashes,
                    evmReceipts,
                    cosmosTxHashes: cosmosResults.map((r) => r.txhash),
                    blockNumber: all[0],
                };
            }
            lastMismatch = { evm: evmBlocks, cosmos: cosmosHeights };
            console.warn(
                `sendAtomicSameBlockBatch attempt ${attempt}/${maxAttempts}: evm=[${evmBlocks.join(',')}] cosmos=[${cosmosHeights.join(',')}], retrying`
            );
        }
        throw new Error(
            `failed to land EVM + cosmos in same block after ${maxAttempts} attempts` +
            (lastMismatch ? ` (last: evm=[${lastMismatch.evm.join(',')}] cosmos=[${lastMismatch.cosmos.join(',')}])` : '')
        );
    }

    static async sendRawTransactionWithProvider(
        provider: ethers.JsonRpcProvider,    // ◀ change
        signedTx: string,
    ) {
        const { hash } = await provider.broadcastTransaction(signedTx);
        return hash;
    }

    static async signEvmTransaction(
        user: SeiUser,
        to: string | ethers.Addressable,
        data: string,
        maxPriorityFeePerGas: BigNumberish = 0,
        maxFeePerGas: BigNumberish = 0,
        increaseNonce = false,
        nonceManager?: NonceManager,
        noncePassed?: number,
        value: BigNumberish = 0,
    ): Promise<string> {
        const provider = user.evmWallet.signingClient;
        const wallet = user.evmWallet.wallet;
        const from = await wallet.getAddress();

        // ── Nonce handling ─────────────────────────────────────────────────────────
        let nonce: number;
        if (noncePassed !== undefined) {
            nonce = noncePassed;
        } else if (nonceManager) {
            nonce = await nonceManager.take(from);
        } else {
            nonce = await provider.getTransactionCount(from);
        }
        if (increaseNonce) nonce += 1;

        // ── Gas / fee ──────────────────────────────────────────────────────────────
        const gasLimit = 2_000_000;
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice;
        const {chainId} = await provider.getNetwork();
        const type = '0x2';
        const maxFeePerGasToSend = maxFeePerGas || feeData.maxFeePerGas!;
        const maxPriorityFeePerGasToSend = maxPriorityFeePerGas || feeData.maxPriorityFeePerGas!;
        const tx = {to, data, value, nonce, maxFeePerGas: maxFeePerGasToSend, maxPriorityFeePerGas: maxPriorityFeePerGasToSend, gasLimit, type, chainId};
        return wallet.signTransaction(tx);
    }
}
