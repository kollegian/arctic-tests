import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { sleep, waitForMined } from '../helpers/waitFor';
import { isHash } from '../helpers/hex';
import { flushOnFailure } from '../helpers/cleanup';

/**
 * "pending" blockTag visibility — asserted against the standard Ethereum
 * pending-state contract:
 *
 *   - eth_getTransactionByHash(poolTxHash)  returns the tx with blockHash=null
 *   - eth_getTransactionReceipt(poolTxHash) returns null until inclusion
 *   - eth_getTransactionCount(addr, "pending") = latest + executable pool txs
 *   - eth_getBalance(addr, "pending")       reflects in-flight debits
 *
 * No divergence tolerances: where the node deviates, these tests fail and the
 * failure is the finding. Race-sensitive assertions use gap-blocked txs
 * (which cannot mine) so the reads are deterministic.
 */
describe('Mempool / RPC surface / "pending" blockTag visibility', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-pending');
        bob = await UserFactory.createSeiUser(admin, 'mempool-bob-pending');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    afterEach(flushOnFailure(() => alice, () => ctx));

    it('a pooled (gap-blocked) tx is visible by hash with null blockHash and a null receipt', async () => {
        const n0 = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const future = n0 + 1; // leaves nonce n0 as the gap — cannot mine, so reads are race-free

        const { signed, hash } = await signTransfer(alice, ctx, { nonce: future });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);
        await sleep(1_500);

        const tx = await provider.send('eth_getTransactionByHash', [hash]);
        expect(tx, 'a pooled tx must be visible via eth_getTransactionByHash').to.not.equal(null);
        expect(tx.hash.toLowerCase()).to.equal(hash.toLowerCase());
        expect(tx.blockHash).to.equal(null, 'a pooled tx must not claim a block');
        expect(tx.blockNumber).to.equal(null);

        const receipt = await provider.send('eth_getTransactionReceipt', [hash]);
        expect(receipt).to.equal(null, 'a pooled tx must not have a receipt');

        // Fill the gap; both mine; the receipt materializes with a real block.
        const { signed: gapSigned, hash: gapHash } = await signTransfer(alice, ctx, { nonce: n0 });
        const rGap = await sendRawTransaction(alice.evmRpcEndpoint, gapSigned);
        expect(rGap.ok).to.equal(true);
        await waitForMined(provider, gapHash, 60_000);
        const receiptFuture = await waitForMined(provider, hash, 60_000);
        expect(receiptFuture?.status).to.equal(1);
        expect(isHash(receiptFuture!.blockHash)).to.equal(true);
    });

    it('getTransactionCount(addr, "pending") counts the executable in-flight tx', async () => {
        const before = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const { signed, hash } = await signTransfer(alice, ctx);
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok).to.equal(true);

        // Standard pending-state contract: as soon as the node has accepted
        // the tx, the pending nonce reflects it. Whether the read lands
        // pre- or post-inclusion, the answer is before + 1.
        const pending = await provider.getTransactionCount(alice.evmAddress, 'pending');
        expect(pending).to.equal(before + 1, 'pending nonce must count the in-flight tx');

        await waitForMined(provider, hash, 60_000);
        const after = await provider.getTransactionCount(alice.evmAddress, 'latest');
        expect(after).to.equal(before + 1);
        expect(
            await provider.getTransactionCount(alice.evmAddress, 'pending'),
        ).to.equal(before + 1, 'pending must converge with latest after inclusion');
    });

    it('getBalance(addr, "pending") reflects the in-flight debit', async () => {
        const latestBefore = await provider.getBalance(alice.evmAddress);
        const value = ethers.parseEther('0.01');
        const { signed, hash } = await signTransfer(alice, ctx, {
            to: bob.evmAddress,
            value,
        });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok).to.equal(true);

        // Standard pending-state contract: the pending balance is debited by
        // value + gas as soon as the tx is in the pool (and stays debited
        // after inclusion), so this holds regardless of inclusion timing.
        const pendingBal = await provider.getBalance(alice.evmAddress, 'pending');
        expect(pendingBal <= latestBefore - value).to.equal(
            true,
            `pending balance must reflect the in-flight debit ` +
                `(before=${latestBefore}, pending=${pendingBal}, value=${value})`,
        );

        await waitForMined(provider, hash, 60_000);
        const latestAfter = await provider.getBalance(alice.evmAddress);
        expect(latestAfter <= latestBefore - value).to.equal(
            true,
            'post-inclusion balance must reflect value + gas debit',
        );
    });

    it('the pending nonce falls back in line with latest once the pool drains', async () => {
        // Quiescence invariant: with nothing in flight for alice, the two tags
        // must agree. All earlier tests await their mines, so this holds here.
        const latest = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const pending = await provider.getTransactionCount(alice.evmAddress, 'pending');
        expect(pending).to.equal(latest);
    });
});
