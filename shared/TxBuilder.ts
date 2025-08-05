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
        increaseNonce = false,
        nonceManager?: NonceManager,
        noncePassed?: number,// <── new
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
        const gasPrice = feeData.gasPrice!;
        const {chainId} = await provider.getNetwork();
        const type = '0x2';
        const maxFeePerGas = feeData.maxFeePerGas!;
        const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas!;
        console.log(Number(maxFeePerGas), Number(maxPriorityFeePerGas));
        const tx = {to, data, value, nonce, maxFeePerGas, maxPriorityFeePerGas, gasLimit, type, chainId};
        return wallet.signTransaction(tx);
    }
}
