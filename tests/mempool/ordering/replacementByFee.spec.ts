import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';
import { flushOnFailure } from '../helpers/cleanup';

/**
 * Replacement-by-fee semantics on Sei. Geth requires a minimum 10% bump.
 * Sei may follow the same rule or define its own; this suite documents the
 * observed behavior on the chain under test:
 *
 *   1. Same nonce, equal-or-lower tip => rejected as duplicate / underpriced.
 *   2. Same nonce, sufficient (>= +10%) tip bump => REPLACES the prior tx;
 *      first tx hash never appears in a block, second does.
 *   3. Tip bump of < 10% (e.g. +1%) => rejected as "replacement transaction underpriced".
 */
describe('Mempool / Ordering / Replacement-by-fee', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-rbf');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    afterEach(flushOnFailure(() => alice, () => ctx));

    it('a same-nonce resend with insufficient tip bump never produces two mined txs at that nonce', async () => {
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const feeData = await provider.getFeeData();
        const baseTip = feeData.maxPriorityFeePerGas ?? 100_000_000n;
        const maxFeePerGas = (feeData.maxFeePerGas ?? 1_000_000_000n) * 4n;

        const { signed: signed1, hash: h1 } = await signTransfer(alice, ctx, {
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas: baseTip * 5n,
        });
        const { signed: signed2, hash: h2 } = await signTransfer(alice, ctx, {
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas: (baseTip * 5n * 101n) / 100n,
        });

        const r1 = await sendRawTransaction(alice.evmRpcEndpoint, signed1);
        expect(r1.ok, r1.ok ? '' : (r1 as { message: string }).message).to.equal(true);

        // Standard RBF rule: a bump below the ~10% threshold is rejected as
        // an underpriced replacement.
        const r2 = await sendRawTransaction(alice.evmRpcEndpoint, signed2);
        expect(r2.ok).to.equal(false, 'a +1% bump must be refused as underpriced replacement');
        expect((r2 as { code: number }).code).to.equal(-32000);

        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            const [rc1, rc2] = await Promise.all([
                provider.getTransactionReceipt(h1),
                provider.getTransactionReceipt(h2),
            ]);
            if (rc1 !== null || rc2 !== null) break;
            await new Promise((r) => setTimeout(r, 500));
        }

        const [rc1, rc2] = await Promise.all([
            provider.getTransactionReceipt(h1),
            provider.getTransactionReceipt(h2),
        ]);
        const mined = [rc1, rc2].filter((r) => r !== null).length;
        expect(mined).to.equal(1);

        const finalNonce = await provider.getTransactionCount(alice.evmAddress, 'latest');
        expect(finalNonce).to.equal(nonce + 1);
    });

    it('replaces the in-flight tx when the resend has a sufficient (~10%+) tip bump', async () => {
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const feeData = await provider.getFeeData();
        const baseTip = (feeData.maxPriorityFeePerGas ?? 100_000_000n) * 5n;
        const maxFeePerGas = (feeData.maxFeePerGas ?? 1_000_000_000n) * 4n;

        const { signed: signed1, hash: h1 } = await signTransfer(alice, ctx, {
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas: baseTip,
            // Pick a distinguishable `to` so we can later assert which tx mined.
            to: ethers.Wallet.createRandom().address,
        });
        const { signed: signed2, hash: h2 } = await signTransfer(alice, ctx, {
            nonce,
            maxFeePerGas,
            // +25% tip bump, comfortably above any 10% threshold.
            maxPriorityFeePerGas: (baseTip * 125n) / 100n,
            to: ethers.Wallet.createRandom().address,
        });

        const r1 = await sendRawTransaction(alice.evmRpcEndpoint, signed1);
        expect(r1.ok, r1.ok ? '' : (r1 as { message: string }).message).to.equal(true);

        // Standard RBF rule: a >=10% bump replaces the in-flight tx.
        const r2 = await sendRawTransaction(alice.evmRpcEndpoint, signed2);
        expect(r2.ok, r2.ok ? '' : (r2 as { message: string }).message).to.equal(
            true,
            'a +25% tip bump must be accepted as a replacement',
        );

        const receipt2 = await waitForMined(provider, h2, 60_000);
        expect(receipt2?.status).to.equal(1);

        // The original tx hash MUST NOT appear (it was replaced).
        const receipt1 = await provider.getTransactionReceipt(h1);
        expect(receipt1).to.equal(null);
    });

    it('a same-nonce resend with IDENTICAL fees but different payload never yields two mined txs', async () => {
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const feeData = await provider.getFeeData();
        const tip = (feeData.maxPriorityFeePerGas ?? 100_000_000n) * 5n;
        const maxFeePerGas = (feeData.maxFeePerGas ?? 1_000_000_000n) * 4n;

        const { signed: signed1, hash: h1 } = await signTransfer(alice, ctx, {
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas: tip,
            to: ethers.Wallet.createRandom().address,
        });
        const { signed: signed2, hash: h2 } = await signTransfer(alice, ctx, {
            nonce,
            maxFeePerGas,
            maxPriorityFeePerGas: tip,
            to: ethers.Wallet.createRandom().address,
        });
        expect(h1).to.not.equal(h2, 'different recipients must produce different hashes');

        const r1 = await sendRawTransaction(alice.evmRpcEndpoint, signed1);
        expect(r1.ok, r1.ok ? '' : (r1 as { message: string }).message).to.equal(true);

        // Identical fees offer no bump, so the resend must be refused (it is a
        // DIFFERENT tx, so the idempotent-duplicate path doesn't apply either).
        const r2 = await sendRawTransaction(alice.evmRpcEndpoint, signed2);
        expect(r2.ok).to.equal(false);
        expect((r2 as { code: number }).code).to.equal(-32000);

        // Exactly one tx mines at this nonce: the original.
        const receipt1 = await waitForMined(provider, h1, 60_000);
        expect(receipt1?.status).to.equal(1);
        expect(await provider.getTransactionReceipt(h2)).to.equal(null);

        const finalNonce = await provider.getTransactionCount(alice.evmAddress, 'latest');
        expect(finalNonce).to.equal(nonce + 1);
    });

    it('a QUEUED (gap-blocked) tx can be replaced before the gap fills; only the replacement mines', async function () {
        const n0 = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const future = n0 + 1; // leaves nonce n0 as the gap
        const feeData = await provider.getFeeData();
        const baseTip = (feeData.maxPriorityFeePerGas ?? 100_000_000n) * 5n;
        const maxFeePerGas = (feeData.maxFeePerGas ?? 1_000_000_000n) * 4n;

        const { signed: original, hash: hOriginal } = await signTransfer(alice, ctx, {
            nonce: future,
            maxFeePerGas,
            maxPriorityFeePerGas: baseTip,
            to: ethers.Wallet.createRandom().address,
        });
        const { signed: replacement, hash: hReplacement } = await signTransfer(alice, ctx, {
            nonce: future,
            maxFeePerGas,
            maxPriorityFeePerGas: (baseTip * 150n) / 100n, // +50% bump
            to: ethers.Wallet.createRandom().address,
        });

        const r1 = await sendRawTransaction(alice.evmRpcEndpoint, original);
        expect(r1.ok, r1.ok ? '' : (r1 as { message: string }).message).to.equal(true);

        // Standard behavior: queued (non-executable) txs are replaceable by
        // the same fee-bump rule as pending ones.
        const r2 = await sendRawTransaction(alice.evmRpcEndpoint, replacement);
        expect(r2.ok, r2.ok ? '' : (r2 as { message: string }).message).to.equal(
            true,
            'a +50% bump must replace a queued (gap-blocked) tx',
        );

        // Fill the gap; the replacement (not the original) must mine.
        const { signed: gapSigned, hash: gapHash } = await signTransfer(alice, ctx, { nonce: n0 });
        const rGap = await sendRawTransaction(alice.evmRpcEndpoint, gapSigned);
        expect(rGap.ok, rGap.ok ? '' : (rGap as { message: string }).message).to.equal(true);

        await waitForMined(provider, gapHash, 60_000);
        const receiptReplacement = await waitForMined(provider, hReplacement, 60_000);
        expect(receiptReplacement?.status).to.equal(1);
        expect(await provider.getTransactionReceipt(hOriginal)).to.equal(null);

        const finalNonce = await provider.getTransactionCount(alice.evmAddress, 'latest');
        expect(finalNonce).to.equal(future + 1);
    });
});
