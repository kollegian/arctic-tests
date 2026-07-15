import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';

/**
 * Per-sender nonce monotonicity: even if N+1 arrives at the node before N,
 * the priority mempool must serialize them and confirm in nonce order.
 */
describe('Mempool / Ordering / Per-sender nonce monotonicity', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-mono');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    it('three sequential nonces submitted in reverse order still confirm in nonce order', async () => {
        const n0 = await provider.getTransactionCount(alice.evmAddress, 'latest');

        const signs = await Promise.all([
            signTransfer(alice, ctx, { nonce: n0 }),
            signTransfer(alice, ctx, { nonce: n0 + 1 }),
            signTransfer(alice, ctx, { nonce: n0 + 2 }),
        ]);

        // Send in REVERSE order to stress the queue->promotion path.
        const reverseOrder = [...signs].reverse();
        for (const { signed } of reverseOrder) {
            const r = await sendRawTransaction(alice.evmRpcEndpoint, signed);
            expect(r.ok, r.ok ? '' : (r as { message: string }).message).to.equal(true);
        }

        const receipts = await Promise.all(
            signs.map((s) => waitForMined(provider, s.hash, 120_000)),
        );

        for (const r of receipts) {
            expect(r?.status).to.equal(1);
        }
        const blocks = receipts.map((r) => Number(r!.blockNumber));
        // Strictly non-decreasing in nonce order.
        for (let i = 1; i < blocks.length; i++) {
            expect(blocks[i]).to.be.gte(
                blocks[i - 1],
                `tx with nonce ${n0 + i} must confirm in a block >= the previous`,
            );
        }
        // Within the same block, the index must also be monotonically increasing in nonce order.
        for (let i = 1; i < receipts.length; i++) {
            if (blocks[i] === blocks[i - 1]) {
                expect(Number(receipts[i]!.index)).to.be.greaterThan(
                    Number(receipts[i - 1]!.index),
                );
            }
        }
    });
});
