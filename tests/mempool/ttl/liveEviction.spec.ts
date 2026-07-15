import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { poolDepth } from '../helpers/txpoolView';
import { sleep, waitForMined } from '../helpers/waitFor';

/**
 * Pool-bloat guard, runnable against any live network (no LOCAL_CHAIN gate).
 *
 * Strict eviction contract (geth reference), asserted with no tolerances:
 *
 *   1. an unmineable (gap-blocked / unaffordable) tx is EVICTED within the
 *      bound — otherwise the pool grows without limit under such traffic;
 *   2. evicted bytes are FORGOTTEN — resubmission is accepted and mines
 *      (a pool that refuses the resend while never mining it wedges the
 *      nonce for standard tooling; observed on atlantic-2, fails here);
 *   3. dropped/unaffordable txs are fully purged — a fresh same-nonce tx at
 *      normal fees is accepted without any replacement fee bump.
 *
 * Measured lifetimes (scripts/mempoolDivergenceProbe.ts, probe E):
 * arctic-1 evicts within <=180s, atlantic-2 within ~11s.
 */
describe('Mempool / TTL / Gapped-tx eviction on a live network (pool-bloat guard)', function () {
    const EVICTION_BOUND_SECS = Number(process.env.MEMPOOL_EVICTION_BOUND_SECS ?? 240);
    this.timeout((EVICTION_BOUND_SECS + 240) * 1_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    const tryWaitMined = async (hash: string, timeoutMs: number): Promise<boolean> => {
        try {
            await waitForMined(provider, hash, timeoutMs);
            return true;
        } catch {
            return false;
        }
    };

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-evictlive');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    /**
     * Strict eviction contract (geth reference): evicted bytes are simply
     * forgotten — a resubmission must be accepted and mine. A pool that
     * refuses the resend while never mining it ("cache-poisoned", observed on
     * atlantic-2) wedges the nonce for standard tooling and FAILS here.
     */
    async function recoverNonce(
        user: SeiUser,
        original: { signed: string; hash: string },
        nonce: number,
    ): Promise<void> {
        const resent = await sendRawTransaction(user.evmRpcEndpoint, original.signed);
        expect(
            resent.ok,
            `evicted tx at nonce ${nonce} must be resubmittable, got: ${
                resent.ok ? '' : (resent as { message: string }).message
            }`,
        ).to.equal(true);
        expect(await tryWaitMined(original.hash, 30_000)).to.equal(
            true,
            `resubmitted tx at nonce ${nonce} must mine once executable`,
        );
    }

    it(`gap-blocked txs (and the child of an evicted parent) are evicted within ${EVICTION_BOUND_SECS}s and every nonce stays recoverable`, async () => {
        const n0 = await provider.getTransactionCount(alice.evmAddress, 'latest');
        // Pool a CHAIN of two gapped txs: n+1 (parent) and n+2 (child). Both
        // are unmineable while nonce n is missing; if eviction takes the
        // parent, the child becomes an orphan and must not wedge its nonce.
        const gappedParent = await signTransfer(alice, ctx, {
            nonce: n0 + 1,
            value: ethers.parseEther('0.000101'),
        });
        const gappedChild = await signTransfer(alice, ctx, {
            nonce: n0 + 2,
            value: ethers.parseEther('0.000102'),
        });
        for (const tx of [gappedParent, gappedChild]) {
            const sent = await sendRawTransaction(alice.evmRpcEndpoint, tx.signed);
            expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);
        }

        // Hold for the bound; neither gapped tx may mine while the gap exists.
        const deadline = Date.now() + EVICTION_BOUND_SECS * 1_000;
        while (Date.now() < deadline) {
            for (const tx of [gappedParent, gappedChild]) {
                expect(
                    await provider.getTransactionReceipt(tx.hash),
                ).to.equal(null, 'a gap-blocked tx must not mine while its gap exists');
            }
            await sleep(10_000);
        }

        // Fill the gap. If the gapped txs were still pooled they would mine now.
        const filler = await signTransfer(alice, ctx, {
            nonce: n0,
            value: ethers.parseEther('0.000103'),
        });
        const fillSent = await sendRawTransaction(alice.evmRpcEndpoint, filler.signed);
        expect(fillSent.ok, fillSent.ok ? '' : (fillSent as { message: string }).message).to.equal(true);
        await waitForMined(provider, filler.hash, 60_000);

        expect(await tryWaitMined(gappedParent.hash, 15_000)).to.equal(
            false,
            `gapped parent was STILL POOLED after ${EVICTION_BOUND_SECS}s — the mempool is not ` +
                'evicting unmineable txs within the bound (pool-bloat risk)',
        );

        // Standard contract: evicted bytes are forgotten, so resubmitting the
        // parent must be accepted and mine. The child may either still be
        // pooled (then it mines by itself once the parent lands — a timing
        // outcome, not a divergence) or evicted (then its resubmission must
        // work too); both paths MUST end with the child mined.
        await recoverNonce(alice, gappedParent, n0 + 1);
        if (!(await tryWaitMined(gappedChild.hash, 15_000))) {
            await recoverNonce(alice, gappedChild, n0 + 2);
        }
        expect(
            (await provider.getTransactionReceipt(gappedChild.hash))?.status,
        ).to.equal(1, 'the orphaned child must end up mined');

        // No residue: the account's pool footprint must be fully drained.
        const finalLatest = await provider.getTransactionCount(alice.evmAddress, 'latest');
        expect(finalLatest).to.equal(n0 + 3, 'all three nonces must be consumed after recovery');
        expect(
            await provider.getTransactionCount(alice.evmAddress, 'pending'),
        ).to.equal(finalLatest, 'nothing may remain in flight');
        const depth = await poolDepth(provider, alice.evmAddress);
        expect(depth.pending + depth.queued).to.equal(0, 'no pool residue for the sender');
    });

    it('a pooled tx that becomes unaffordable after an earlier tx drains the balance is dropped, and its nonce stays recoverable', async function () {
        this.timeout(5 * 60 * 1000);
        // Fresh account so the balance is fully under our control.
        const dave = await UserFactory.createSeiUser(admin, 'mempool-dave-drain');
        const ctxD = await buildContext(dave);
        const n0 = await ctxD.provider.getTransactionCount(dave.evmAddress, 'latest');
        const balance = await ctxD.provider.getBalance(dave.evmAddress);

        // tx1 drains almost everything; tx2 (next nonce) is affordable against
        // the CURRENT balance but not against the post-tx1 balance.
        const drain = await signTransfer(dave, ctxD, {
            nonce: n0,
            to: admin.evmAddress,
            value: balance - ethers.parseEther('1'),
        });
        const doomed = await signTransfer(dave, ctxD, {
            nonce: n0 + 1,
            to: admin.evmAddress,
            value: ethers.parseEther('3'),
        });

        const drainSent = await sendRawTransaction(dave.evmRpcEndpoint, drain.signed);
        expect(drainSent.ok, drainSent.ok ? '' : (drainSent as { message: string }).message).to.equal(true);

        // Standard admission validates against COMMITTED state (the drain has
        // not mined yet), so the doomed tx must be admitted here; it becomes
        // unaffordable only once the drain lands, and must then be dropped.
        const doomedSent = await sendRawTransaction(dave.evmRpcEndpoint, doomed.signed);
        expect(
            doomedSent.ok,
            `doomed tx must be admitted against committed state: ${
                doomedSent.ok ? '' : (doomedSent as { message: string }).message
            }`,
        ).to.equal(true);

        await waitForMined(ctxD.provider, drain.hash, 60_000);
        const doomedMined = await tryWaitMined(doomed.hash, 30_000);
        if (doomedMined) {
            const receipt = await ctxD.provider.getTransactionReceipt(doomed.hash);
            expect.fail(
                `a tx whose sender can no longer afford it must not mine — but it was ` +
                    `included in block ${receipt?.blockNumber} with status=${receipt?.status} ` +
                    `gasUsed=${receipt?.gasUsed} (hash ${doomed.hash})`,
            );
        }

        // Strict purge contract: the dropped tx is fully forgotten, so a fresh
        // same-nonce tx at NORMAL fees must be accepted — no replacement bump.
        // A refusal here means the unaffordable tx still shadows its nonce.
        const occupy = await signTransfer(dave, ctxD, {
            nonce: n0 + 1,
            to: admin.evmAddress,
            value: ethers.parseEther('0.0001'),
        });
        const occupied = await sendRawTransaction(dave.evmRpcEndpoint, occupy.signed);
        expect(
            occupied.ok,
            `nonce ${n0 + 1} must accept a normal-fee tx after the doomed tx was dropped: ${
                occupied.ok ? '' : (occupied as { message: string }).message
            }`,
        ).to.equal(true);
        await waitForMined(ctxD.provider, occupy.hash, 60_000);

        // The doomed (unaffordable) tx must never have mined.
        expect(await ctxD.provider.getTransactionReceipt(doomed.hash)).to.equal(null);

        // Final coherence: exactly two nonces consumed, no residue.
        const finalLatest = await ctxD.provider.getTransactionCount(dave.evmAddress, 'latest');
        expect(finalLatest).to.equal(n0 + 2);
        expect(
            await ctxD.provider.getTransactionCount(dave.evmAddress, 'pending'),
        ).to.equal(finalLatest, 'nothing may remain in flight');
        const depth = await poolDepth(ctxD.provider, dave.evmAddress);
        expect(depth.pending + depth.queued).to.equal(0, 'no pool residue for the sender');
    });
});
