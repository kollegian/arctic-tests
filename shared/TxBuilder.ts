import {TransactionResponse, TransactionReceipt, BigNumberish, ethers} from 'ethers';
import { DeliverTxResponse } from '@cosmjs/stargate';
import { waitFor } from './utils/helpers';
import { EvmRpcClient } from './RpcClient';
import {SeiUser} from "./User";
import {NonceManager} from "../tests/load_tests/NonceManager";

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

    // Submit a raw EVM tx and a Cosmos tx concurrently, retrying with adaptive
    // delay until both land in the same block. Throws if maxAttempts is
    // exhausted. The thunks are re-invoked on each retry, so they must produce
    // a freshly-signed tx each call (nonce-stale broadcasts are silent failures
    // — re-sign inside the thunk).
    //
    // Use this when a test needs same-block cross-VM inclusion as a setup
    // precondition (typically so a downstream log-range query can assume both
    // events fall inside a tight window). Same-block is NOT a chain guarantee
    // for concurrent submissions; this helper makes the harness produce the
    // condition deterministically rather than depend on hand-tuned delays
    // matching the chain's block cadence.
    static async sendRawUntilSameBlock<C extends { height: number }>(
        evmSubmit: () => Promise<string>,
        cosmosCall: () => Promise<C>,
        rpcClient: EvmRpcClient,
        maxAttempts = 15,
        delaySeconds = 1,
    ): Promise<{ evmReceipt: TransactionReceipt; cosmosResponse: C }> {
        // Bisection on the inter-broadcast delay: halve on overshoot
        // (sign flip vs previous miss), double on undershoot. Always
        // delays whichever side landed earlier.
        const MIN_DELAY = 0.05;
        const MAX_DELAY = 1.0;
        let injectedSide: 'evm' | 'cosmos' | null = null;
        let injectedDelay = 0;
        let prevSign: -1 | 1 | null = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const evmHashPromise: Promise<string> = injectedSide === 'evm'
                ? (async () => { await waitFor(injectedDelay); return evmSubmit(); })()
                : evmSubmit();
            const cosmosTxPromise: Promise<C> = injectedSide === 'cosmos'
                ? (async () => { await waitFor(injectedDelay); return cosmosCall(); })()
                : cosmosCall();

            const [evmHash, cosmosResponse] = await Promise.all([
                evmHashPromise,
                cosmosTxPromise,
            ]);

            // Poll for the EVM receipt; single-shot can return null on a
            // lagging RPC pod and the next line null-derefs.
            let evmReceipt: TransactionReceipt | null = null;
            const receiptDeadline = Date.now() + 10_000;
            while (Date.now() < receiptDeadline && !evmReceipt) {
                evmReceipt = await rpcClient.getTransactionReceipt(evmHash);
                if (!evmReceipt) await waitFor(0.5);
            }
            if (!evmReceipt) {
                console.warn(
                    `sendRawUntilSameBlock attempt ${attempt}: evm receipt for ${evmHash} not produced within 10s; retrying`,
                );
                if (attempt < maxAttempts) await waitFor(delaySeconds);
                continue;
            }
            const evmBlock = Number(evmReceipt.blockNumber);
            const cosmosHeight = cosmosResponse.height;

            if (evmBlock === cosmosHeight) {
                return { evmReceipt, cosmosResponse };
            }

            // +1: cosmos earlier; -1: evm earlier.
            const sign: -1 | 1 = evmBlock > cosmosHeight ? 1 : -1;
            const sideToDelay: 'evm' | 'cosmos' = sign === 1 ? 'cosmos' : 'evm';

            console.warn(
                `sendRawUntilSameBlock attempt ${attempt}: evm=${evmBlock} cosmos=${cosmosHeight} (delayed ${injectedSide ?? 'none'} by ${injectedDelay}s)`,
            );

            if (prevSign === null) {
                injectedSide = sideToDelay;
                injectedDelay = 0.2;
            } else if (sign === prevSign) {
                injectedDelay = Math.min(injectedDelay * 2, MAX_DELAY);
                injectedSide = sideToDelay;
            } else {
                injectedSide = sideToDelay;
                injectedDelay = Math.max(injectedDelay / 2, MIN_DELAY);
            }
            prevSign = sign;

            if (attempt < maxAttempts) {
                await waitFor(delaySeconds);
            }
        }

        throw new Error(
            `sendRawUntilSameBlock: failed to co-locate EVM + Cosmos txs in the same block after ${maxAttempts} attempts`,
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
