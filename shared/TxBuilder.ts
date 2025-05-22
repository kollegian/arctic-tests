import {TransactionResponse, TransactionReceipt, BigNumberish} from 'ethers';
import { DeliverTxResponse } from '@cosmjs/stargate';
import { waitFor } from '../utils/helpers';
import { EvmRpcClient } from './RpcClient';
import {SeiUser} from "./User";

/**
 * Sends paired EVM and Cosmos transactions atomically,
 * and provides low-level raw EVM tx submission.
 */
export class AtomicTxSender {
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

    /**
     * Send a raw, signed EVM transaction via JSON-RPC (no ethers.js)
     * @param rpcUrl     JSON-RPC endpoint
     * @param signedTx   Raw signed transaction hex
     * @returns          Transaction hash
     *
     * Example:
     * ```ts
     * // Encode the transfer function call
     * const iface = new ethers.utils.Interface(ERC20_ABI.abi);
     * const data = iface.encodeFunctionData('transfer', [recipient, amount]);
     *
     * // Build the transaction object
     * const nonce = await provider.getTransactionCount(wallet.address);
     * const gasPrice = await provider.getGasPrice();
     * const gasLimit = await provider.estimateGas({
     *   to: tokenAddress,
     *   data,
     *   from: wallet.address
     * });
     * const tx = {
     *   to: tokenAddress,
     *   data,
     *   nonce,
     *   gasPrice,
     *   gasLimit,
     *   value: 0
     * };
     *
     * // Sign and serialize the transaction
     * const signedTx = await wallet.signTransaction(tx);
     *
     * // Send raw transaction (will propagate even on failure)
     * const txHash = await AtomicTxSender.sendRawTransaction(rpcUrl, signedTx);
     * console.log('Raw tx hash:', txHash);
     * ```
     */
    static async sendRawTransaction(
        rpcUrl: string,
        signedTx: string
    ): Promise<string> {
        const client = new EvmRpcClient(rpcUrl);
        return client.sendRawTransaction(signedTx);
    }

    static async signEvmTransaction(
        user: SeiUser,
        to: string,
        data: string,
        value: BigNumberish = 0
    ): Promise<string> {
        const provider = user.evmWallet.signingClient;
        const wallet = user.evmWallet.wallet;
        const from = await wallet.getAddress();
        const nonce = await provider.getTransactionCount(from);
        const feeDataOnChain = (await provider.getFeeData()).gasPrice;
        const gasLimit = await provider.estimateGas({ to, data, from, value });
        const tx = { to, data, value, nonce, gasPrice: feeDataOnChain, gasLimit };
        return wallet.signTransaction(tx);
    }
}
