import { ethers } from 'ethers';

import { SeiUser } from '../../../shared/User';
import { queryEip1559Params } from '../../../shared/utils/helpers';

export interface TxOverrides {
    to?: string;
    value?: bigint;
    gasLimit?: bigint;
    nonce?: number;
    type?: 0 | 1 | 2;
    chainId?: number;
    gasPrice?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    data?: string;
    accessList?: ethers.AccessList;
}

export interface BuildContext {
    provider: ethers.JsonRpcProvider;
    chainId: number;
}

export async function buildContext(user: SeiUser): Promise<BuildContext> {
    const provider = new ethers.JsonRpcProvider(user.evmRpcEndpoint);
    const network = await provider.getNetwork();
    return { provider, chainId: Number(network.chainId) };
}

/**
 * Build & sign a sane 1559 transfer with optional overrides. Used everywhere
 * we need a "well-formed" tx and want to tweak exactly one field to drive a
 * specific admission-time outcome.
 */
export async function signTransfer(
    sender: SeiUser,
    ctx: BuildContext,
    overrides: TxOverrides = {},
): Promise<{ signed: string; nonce: number; hash: string }> {
    const feeData = await ctx.provider.getFeeData();
    const nonce =
        overrides.nonce ??
        (await ctx.provider.getTransactionCount(sender.evmAddress, 'pending'));

    const baseRequest: ethers.TransactionRequest = {
        to: overrides.to ?? sender.evmAddress,
        value: overrides.value ?? ethers.parseEther('0.0001'),
        gasLimit: overrides.gasLimit ?? 21000n,
        nonce,
        chainId: overrides.chainId ?? ctx.chainId,
        data: overrides.data ?? '0x',
        type: overrides.type ?? 2,
    };

    if (overrides.type === 0 || overrides.type === 1) {
        baseRequest.gasPrice =
            overrides.gasPrice ?? (feeData.gasPrice ?? 1_000_000_000n) * 2n;
        if (overrides.type === 1) {
            baseRequest.accessList = overrides.accessList ?? [];
        }
    } else {
        baseRequest.maxFeePerGas =
            overrides.maxFeePerGas ?? (feeData.maxFeePerGas ?? 1_000_000_000n) * 2n;
        baseRequest.maxPriorityFeePerGas =
            overrides.maxPriorityFeePerGas ??
            (feeData.maxPriorityFeePerGas ?? 100_000_000n);
        if (overrides.accessList) {
            baseRequest.accessList = overrides.accessList;
        }
    }

    const signed = await sender.evmWallet.wallet.signTransaction(baseRequest);
    const parsed = ethers.Transaction.from(signed);
    return { signed, nonce: nonce as number, hash: parsed.hash! };
}

/** Pre-fetch the live base fee in wei to avoid hard-coded constants. */
export async function suggestedTip(
    provider: ethers.JsonRpcProvider,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const fee = await provider.getFeeData();
    return {
        maxFeePerGas: fee.maxFeePerGas ?? 1_000_000_000n,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 100_000_000n,
    };
}

/** sei-chain's default mempool.max-tx-bytes when no override is in play. */
export const DEFAULT_MEMPOOL_MAX_TX_BYTES = 2 * 1024 * 1024;

/**
 * Compute a per-tx gasLimit that's big enough to cover the intrinsic cost
 * of carrying `payloadBytes` of non-zero calldata, but clamped under the
 * live chain's block gas limit so CheckTx doesn't pre-reject for
 * "exceeds block max gas" before the size check fires.
 *
 * intrinsic = 21_000 (base) + payloadBytes * 16 (non-zero byte cost).
 */
export async function computeOversizeGasLimit(
    payloadBytes: number,
): Promise<bigint> {
    const intrinsic = BigInt(21_000 + payloadBytes * 16);
    let blockGasLimit: bigint;
    try {
        const params = await queryEip1559Params();
        blockGasLimit = BigInt(params.blockGasLimit);
    } catch {
        // `seid` not available locally — fall back to a generous default
        // that matches the EIP-1559 params in shared/utils/helpers.ts.
        blockGasLimit = 5_000_000_000n;
    }
    const buffer = 1_000n;
    if (intrinsic + 100_000n < blockGasLimit - buffer) {
        return intrinsic + 100_000n;
    }
    return blockGasLimit - buffer;
}
