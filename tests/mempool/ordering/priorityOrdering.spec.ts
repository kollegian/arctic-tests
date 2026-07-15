import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer, suggestedTip } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';

/**
 * Sei uses a priority mempool: cross-sender ordering is by effective tip,
 * not by arrival order. This suite asserts that when two senders submit
 * within the same window, the higher-tip tx ends up at an earlier index
 * in its inclusion block.
 *
 * Caveat: on a shared testnet, other traffic interferes. We submit the
 * pair very close together and assert the relative ordering ONLY when
 * the two txs land in the same block. If they split blocks, the test is
 * inconclusive and we retry up to N times before failing.
 */
describe('Mempool / Ordering / Priority across senders', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let ctxA: BuildContext;
    let ctxB: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-prio');
        bob = await UserFactory.createSeiUser(admin, 'mempool-bob-prio');
        ctxA = await buildContext(alice);
        ctxB = await buildContext(bob);
        provider = ctxA.provider;
    });

    it('higher maxPriorityFeePerGas wins the within-block ordering when they land together', async () => {
        // Two txs submitted simultaneously on a sub-second chain co-locate in
        // one block almost always; require it within a few attempts and assert
        // the priority ordering in every co-located pair. No skip fallback:
        // if co-location never happens, that itself is a scheduling anomaly
        // worth failing on.
        const attempts = 4;
        let observed = false;

        for (let attempt = 0; attempt < attempts && !observed; attempt++) {
            const { maxFeePerGas, maxPriorityFeePerGas } = await suggestedTip(provider);

            const lowTip = maxPriorityFeePerGas;
            const highTip = maxPriorityFeePerGas * 10n + 1n;

            const { signed: signedLow, hash: hLow } = await signTransfer(alice, ctxA, {
                maxFeePerGas: maxFeePerGas * 12n,
                maxPriorityFeePerGas: lowTip,
            });
            const { signed: signedHigh, hash: hHigh } = await signTransfer(bob, ctxB, {
                maxFeePerGas: maxFeePerGas * 12n,
                maxPriorityFeePerGas: highTip,
            });

            // Submit as close together as possible.
            const [rLow, rHigh] = await Promise.all([
                sendRawTransaction(alice.evmRpcEndpoint, signedLow),
                sendRawTransaction(bob.evmRpcEndpoint, signedHigh),
            ]);
            expect(rLow.ok && rHigh.ok, 'both txs should admit').to.equal(true);

            const [receiptLow, receiptHigh] = await Promise.all([
                waitForMined(provider, hLow, 90_000),
                waitForMined(provider, hHigh, 90_000),
            ]);

            expect(receiptLow?.status).to.equal(1);
            expect(receiptHigh?.status).to.equal(1);

            if (Number(receiptLow!.blockNumber) === Number(receiptHigh!.blockNumber)) {
                // Same block: high-tip should be at a strictly lower index.
                expect(Number(receiptHigh!.index)).to.be.lessThan(
                    Number(receiptLow!.index),
                    'high-tip tx should appear earlier in block than low-tip tx',
                );
                observed = true;
            }
        }

        expect(observed).to.equal(
            true,
            `two simultaneously submitted txs never co-located in one block across ${attempts} attempts`,
        );
    });
});
