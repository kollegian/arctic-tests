import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { fetchTxpoolContent } from '../helpers/txpoolView';
import { sleep, waitForMined, waitUntil } from '../helpers/waitFor';
import { isHash } from '../helpers/hex';
import { flushOnFailure } from '../helpers/cleanup';

/**
 * Nonce-gap ("queued") semantics — asserted against standard Ethereum node
 * behavior (the blockchain-first contract), NOT against observed Sei quirks:
 *
 *   - a gap-blocked tx is accepted, surfaces under txpool_content.QUEUED
 *     (and never under `pending`), cannot mine, and does not advance the
 *     pending nonce;
 *   - filling the gap promotes and mines it;
 *   - an exact duplicate resubmission is refused as already-known.
 *
 * Where Sei diverges (e.g. gapped txs surfacing under `pending` or in
 * neither bucket — seen on arctic-1 and atlantic-2), these tests FAIL by
 * design: that is a finding to report, not a behavior to tolerate.
 *
 * NOTE: gapped txs are TTL-evicted after a number of blocks, and Sei blocks
 * are sub-second — every test fills its gap promptly rather than letting
 * queued txs linger.
 */
describe('Mempool / Admission / Nonce queueing semantics', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;
    // Highest nonce this suite has confirmed mined; used to skip stale reads
    // from lagging backends behind the load balancer.
    let settledNonce = 0;

    async function settledLatestNonce(): Promise<number> {
        await waitUntil(
            async () =>
                (await provider.getTransactionCount(alice.evmAddress, 'latest')) >=
                settledNonce,
            30_000,
            250,
            'latest nonce to catch up with previously mined txs',
        );
        return provider.getTransactionCount(alice.evmAddress, 'latest');
    }

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-queue');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    // If a test aborts before filling its gap, flush the residue so the next
    // test doesn't collide on the same nonce.
    afterEach(flushOnFailure(() => alice, () => ctx));

    it('a gap-blocked tx is accepted but cannot mine until its gap fills', async () => {
        const n0 = await settledLatestNonce();
        const future = n0 + 1;
        const { signed, hash } = await signTransfer(alice, ctx, {
            nonce: future,
            value: ethers.parseEther('0.00011'),
        });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);
        expect(isHash(hash)).to.equal(true);

        // Gap-blocked means unmineable: this read is race-free.
        await sleep(1_500);
        expect(await provider.getTransactionReceipt(hash)).to.equal(
            null,
            'a gap-blocked tx must not mine',
        );

        // Standard bucket contract: a non-executable tx belongs to `queued`,
        // never to `pending`.
        const content = await fetchTxpoolContent(provider);
        expect(isInBucket(content.queued, alice.evmAddress, future)).to.equal(
            true,
            'a gap-blocked tx must surface under txpool_content.queued',
        );
        expect(isInBucket(content.pending, alice.evmAddress, future)).to.equal(
            false,
            'a gap-blocked tx must never surface under txpool_content.pending',
        );

        // The pending nonce tag must not count a non-executable tx.
        expect(
            await provider.getTransactionCount(alice.evmAddress, 'pending'),
        ).to.equal(n0, 'gap-blocked txs must not advance the pending nonce');

        // Cleanup within the TTL window: fill the gap so both mine.
        const { signed: gapSigned, hash: gapHash } = await signTransfer(alice, ctx, {
            nonce: n0,
            value: ethers.parseEther('0.00012'),
        });
        const rGap = await sendRawTransaction(alice.evmRpcEndpoint, gapSigned);
        expect(rGap.ok).to.equal(true);
        await waitForMined(provider, gapHash, 60_000);
        const receiptFuture = await waitForMined(provider, hash, 60_000);
        expect(receiptFuture?.status).to.equal(1);
        settledNonce = future + 1;
    });

    it('filling the nonce gap promotes the blocked tx and both confirm in nonce order', async () => {
        const start = await settledLatestNonce();
        const gap = start;
        const future = start + 1;

        const { signed: signedFuture, hash: hFuture } = await signTransfer(alice, ctx, {
            nonce: future,
            value: ethers.parseEther('0.00013'),
        });
        const r1 = await sendRawTransaction(alice.evmRpcEndpoint, signedFuture);
        expect(r1.ok, r1.ok ? '' : (r1 as { message: string }).message).to.equal(true);

        // Still unmineable while the gap exists.
        await sleep(1_000);
        expect(await provider.getTransactionReceipt(hFuture)).to.equal(null);

        // Now fill the gap.
        const { signed: signedGap, hash: hGap } = await signTransfer(alice, ctx, {
            nonce: gap,
            value: ethers.parseEther('0.00014'),
        });
        const r2 = await sendRawTransaction(alice.evmRpcEndpoint, signedGap);
        expect(r2.ok, r2.ok ? '' : (r2 as { message: string }).message).to.equal(true);

        // Once the gap tx confirms, the previously-blocked tx promotes and mines.
        const receiptGap = await waitForMined(provider, hGap, 60_000);
        const receiptFuture = await waitForMined(provider, hFuture, 60_000);
        expect(receiptGap?.status).to.equal(1);
        expect(receiptFuture?.status).to.equal(1);
        expect(Number(receiptFuture!.blockNumber)).to.be.gte(Number(receiptGap!.blockNumber));
        settledNonce = future + 1;
    });

    it('exact duplicate submission of an in-flight tx is refused as already-known', async () => {
        await settledLatestNonce();
        const { signed, hash } = await signTransfer(alice, ctx, {
            value: ethers.parseEther('0.00015'),
        });
        const first = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(first.ok, first.ok ? '' : (first as { message: string }).message).to.equal(true);

        // Standard node behavior: an exact duplicate is rejected as already
        // known — it must never be double-admitted.
        const second = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(second.ok).to.equal(false, 'duplicate submission must be refused');
        expect((second as { code: number }).code).to.equal(-32000);
        expect((second as { message: string }).message).to.equal(
            'tx already exists in cache',
        );

        await waitForMined(provider, hash, 60_000);
    });

    describe('cascade promotion through a single gap', function () {
        // Dedicated user so the scenario fully controls the nonce sequence.
        let carol: SeiUser;
        let ctxC: BuildContext;
        let n0: number;
        let queuedSigns: { signed: string; hash: string; nonce: number }[];

        before(async () => {
            carol = await UserFactory.createSeiUser(admin, 'mempool-carol-cascade');
            ctxC = await buildContext(carol);
            n0 = await ctxC.provider.getTransactionCount(carol.evmAddress, 'latest');
        });

        // NOTE: no flushOnFailure here — these two tests are intentionally
        // coupled (the first submits the gapped chain, the second fills the gap
        // to promote it). Flushing between them would destroy that setup.

        it('multiple gapped txs are all accepted, all unmineable, and leave the pending nonce unmoved', async () => {
            queuedSigns = await Promise.all(
                [n0 + 1, n0 + 2, n0 + 3].map((nonce) =>
                    signTransfer(carol, ctxC, { nonce }),
                ),
            );
            for (const { signed } of queuedSigns) {
                const r = await sendRawTransaction(carol.evmRpcEndpoint, signed);
                expect(r.ok, r.ok ? '' : (r as { message: string }).message).to.equal(true);
            }

            await sleep(1_500);
            for (const q of queuedSigns) {
                expect(await ctxC.provider.getTransactionReceipt(q.hash)).to.equal(
                    null,
                    `gap-blocked tx at nonce ${q.nonce} must not mine before the gap fills`,
                );
            }

            // All three must sit in the queued bucket, none in pending.
            const content = await fetchTxpoolContent(ctxC.provider);
            for (const q of queuedSigns) {
                expect(isInBucket(content.queued, carol.evmAddress, q.nonce)).to.equal(
                    true,
                    `gap-blocked tx at nonce ${q.nonce} must surface under queued`,
                );
                expect(isInBucket(content.pending, carol.evmAddress, q.nonce)).to.equal(
                    false,
                    `gap-blocked tx at nonce ${q.nonce} must not surface under pending`,
                );
            }

            const pendingNonce = await ctxC.provider.getTransactionCount(
                carol.evmAddress,
                'pending',
            );
            expect(pendingNonce).to.equal(
                n0,
                'gap-blocked txs must not advance the pending nonce',
            );
        });

        it('filling the single gap promotes the whole chain; all four mine in nonce order', async () => {
            const { signed: gapSigned, hash: gapHash } = await signTransfer(carol, ctxC, {
                nonce: n0,
            });
            const r = await sendRawTransaction(carol.evmRpcEndpoint, gapSigned);
            expect(r.ok, r.ok ? '' : (r as { message: string }).message).to.equal(true);

            const receipts = [await waitForMined(ctxC.provider, gapHash, 60_000)];
            for (const q of queuedSigns) {
                receipts.push(await waitForMined(ctxC.provider, q.hash, 90_000));
            }
            for (const rec of receipts) {
                expect(rec?.status).to.equal(1);
            }
            const blocks = receipts.map((rec) => Number(rec!.blockNumber));
            for (let i = 1; i < blocks.length; i++) {
                expect(blocks[i]).to.be.gte(blocks[i - 1], 'nonce order violated across blocks');
                if (blocks[i] === blocks[i - 1]) {
                    expect(Number(receipts[i]!.index)).to.be.greaterThan(
                        Number(receipts[i - 1]!.index),
                        'nonce order violated within a block',
                    );
                }
            }

            const finalNonce = await ctxC.provider.getTransactionCount(
                carol.evmAddress,
                'latest',
            );
            expect(finalNonce).to.equal(n0 + 4);
        });
    });
});

function isInBucket(
    bucket: { [k: string]: { [k: string]: unknown } },
    addr: string,
    nonce: number,
): boolean {
    const key = Object.keys(bucket).find((k) => k.toLowerCase() === addr.toLowerCase());
    if (!key) return false;
    return Object.keys(bucket[key]).some((n) => Number(n) === nonce);
}
