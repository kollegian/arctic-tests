import { ethers } from 'ethers';

import { SeiUser } from '../../../shared/User';
import { sendRawTransaction } from './rawTxSender';
import { BuildContext, signTransfer } from './txFactory';
import { waitForMined } from './waitFor';

/**
 * Flush a sender's mempool residue so an aborted test cannot poison the next.
 *
 * Strict tests deliberately create gap-blocked txs and fill the gap inline at
 * the end. If such a test FAILS before its cleanup line, the gap-blocked tx is
 * left in the pool; the next test that reuses the same sender then collides
 * ("tx with this nonce already in mempool"). Gap-blocked txs do NOT advance the
 * pending nonce on Sei, so residue can't be detected via pending-vs-latest —
 * instead we fill at the current `latest` nonce, which promotes any queued
 * successor. Each round that promotes residue advances `latest` by >1; we stop
 * as soon as a round advances it by exactly 1 (nothing left to promote).
 *
 * Best-effort and bounded: never throws, so it can't turn a real test failure
 * into a confusing hook error.
 */
export async function flushSenderPool(
    user: SeiUser,
    ctx: BuildContext,
    maxRounds = 4,
): Promise<void> {
    try {
        for (let round = 0; round < maxRounds; round++) {
            const latest = await ctx.provider.getTransactionCount(user.evmAddress, 'latest');
            const { signed, hash } = await signTransfer(user, ctx, {
                nonce: latest,
                value: ethers.parseEther('0.0001'),
                to: user.evmAddress,
            });
            const r = await sendRawTransaction(user.evmRpcEndpoint, signed);
            if (!r.ok) return; // account already quiescent (nothing to fill)
            await waitForMined(ctx.provider, hash, 20_000).catch(() => undefined);
            const after = await ctx.provider.getTransactionCount(user.evmAddress, 'latest');
            // Only our filler mined => no queued residue remained.
            if (after <= latest + 1) return;
        }
    } catch {
        // best-effort cleanup; swallow everything
    }
}

/**
 * Mocha `afterEach` body: flush the sender only when the just-run test failed
 * (passing tests already clean up their own gaps inline).
 */
export function flushOnFailure(
    getUser: () => SeiUser | undefined,
    getCtx: () => BuildContext | undefined,
) {
    return async function (this: Mocha.Context): Promise<void> {
        if (this.currentTest?.state !== 'failed') return;
        const user = getUser();
        const ctx = getCtx();
        if (user && ctx) await flushSenderPool(user, ctx);
    };
}
