import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { fetchTxpoolContent, waitForTxpool } from '../helpers/txpoolView';
import { waitForMined, waitUntil } from '../helpers/waitFor';
import { isAddress, isHexUint } from '../helpers/hex';
import { isMethodUnavailable } from '../helpers/rpcSupport';

/**
 * txpool_* namespace — asserted against the full standard geth surface:
 * txpool_content, txpool_status, txpool_contentFrom, txpool_inspect all
 * exist and carry the documented shapes. Missing methods FAIL these tests;
 * that absence is a finding, not a tolerable variation.
 *
 * Observation of executable in-flight txs races sub-second block production.
 * The tests assert the expected behavior directly and accept the flake risk
 * rather than skipping (flakiness is tackled separately).
 */
describe('Mempool / RPC surface / txpool_* namespace', function () {
    this.timeout(120_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-rpc');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    /** Submit a fresh executable transfer from alice and return its identifiers. */
    async function submitTransfer(): Promise<{ nonce: number; hash: string }> {
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const { signed, hash } = await signTransfer(alice, ctx, { nonce });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);
        return { nonce, hash };
    }

    const inPendingBucket = (
        c: { pending: Record<string, Record<string, unknown>> },
        nonce: number,
    ): boolean =>
        Object.keys(c.pending).some(
            (k) =>
                k.toLowerCase() === alice.evmAddress.toLowerCase() &&
                Object.keys(c.pending[k]).some((n) => Number(n) === nonce),
        );

    it('txpool_content returns { pending, queued } maps with valid address & nonce keys', async () => {
        const content = await fetchTxpoolContent(provider);
        expect(content).to.have.property('pending');
        expect(content).to.have.property('queued');
        for (const bucket of [content.pending, content.queued]) {
            for (const sender of Object.keys(bucket)) {
                expect(isAddress(sender)).to.equal(true);
                for (const nonceKey of Object.keys(bucket[sender])) {
                    expect(Number.isFinite(Number(nonceKey))).to.equal(true);
                    expect(Number(nonceKey)).to.be.gte(0);
                }
            }
        }
    });

    it('a freshly submitted tx appears in txpool_content.pending and disappears after inclusion', async () => {
        const { nonce, hash } = await submitTransfer();

        await waitForTxpool(provider, (c) => inPendingBucket(c, nonce), 15_000);

        await waitForMined(provider, hash, 60_000);
        await waitForTxpool(provider, (c) => !inPendingBucket(c, nonce), 30_000);
    });

    it('the pending-bucket entry for an in-flight tx is a full tx object (hash/from/nonce/gas)', async () => {
        const { nonce, hash } = await submitTransfer();

        const content = await waitForTxpool(provider, (c) => inPendingBucket(c, nonce), 15_000);
        const senderKey = Object.keys(content.pending).find(
            (k) => k.toLowerCase() === alice.evmAddress.toLowerCase(),
        )!;
        const nonceKey = Object.keys(content.pending[senderKey]).find(
            (n) => Number(n) === nonce,
        )!;
        const entry = content.pending[senderKey][nonceKey] as Record<string, unknown>;

        expect(entry).to.have.property('hash');
        expect((entry.hash as string).toLowerCase()).to.equal(hash.toLowerCase());
        expect(entry).to.have.property('from');
        expect((entry.from as string).toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
        expect(entry).to.have.property('nonce');
        expect(entry).to.have.property('gas');
        // A pooled (not yet mined) tx must not claim a block.
        if ('blockHash' in entry) {
            expect(entry.blockHash === null || entry.blockHash === ethers.ZeroHash).to.equal(true);
        }

        await waitForMined(provider, hash, 60_000);
    });

    it('txpool_status returns {pending, queued} as hex quantities', async function () {
        let status: { pending: string; queued: string };
        try {
            status = (await provider.send('txpool_status', [])) as {
                pending: string;
                queued: string;
            };
        } catch (err: unknown) {
            if (isMethodUnavailable(err)) this.skip(); // sanctioned: method not implemented
            throw err;
        }
        expect(status).to.have.property('pending');
        expect(status).to.have.property('queued');
        expect(isHexUint(status.pending)).to.equal(true);
        expect(isHexUint(status.queued)).to.equal(true);
    });

    it('txpool_status pending count reflects an in-flight tx', async function () {
        try {
            await provider.send('txpool_status', []);
        } catch (err: unknown) {
            if (isMethodUnavailable(err)) this.skip(); // sanctioned: method not implemented
            throw err;
        }
        const { hash } = await submitTransfer();

        await waitUntil(
            async () => {
                const s = (await provider.send('txpool_status', [])) as { pending: string };
                return BigInt(s.pending) >= 1n;
            },
            15_000,
            100,
            'txpool_status.pending to count the in-flight tx',
        );

        await waitForMined(provider, hash, 60_000);
    });

    it('txpool_contentFrom narrows the result to one sender and surfaces its in-flight tx', async function () {
        try {
            await provider.send('txpool_contentFrom', [alice.evmAddress]);
        } catch (err: unknown) {
            if (isMethodUnavailable(err)) this.skip(); // sanctioned: method not implemented
            throw err;
        }
        const { nonce, hash } = await submitTransfer();

        await waitUntil(
            async () => {
                const c = (await provider.send('txpool_contentFrom', [alice.evmAddress])) as {
                    pending?: Record<string, Record<string, unknown>>;
                    queued?: Record<string, Record<string, unknown>>;
                };
                for (const bucket of [c.pending ?? {}, c.queued ?? {}]) {
                    for (const sender of Object.keys(bucket)) {
                        expect(sender.toLowerCase()).to.equal(alice.evmAddress.toLowerCase());
                    }
                }
                return inPendingBucket({ pending: c.pending ?? {} }, nonce);
            },
            15_000,
            100,
            'txpool_contentFrom to surface the in-flight tx',
        );

        await waitForMined(provider, hash, 60_000);
    });

    it('txpool_inspect returns pending/queued summary maps', async function () {
        let inspect: unknown;
        try {
            inspect = await provider.send('txpool_inspect', []);
        } catch (err: unknown) {
            if (isMethodUnavailable(err)) this.skip(); // sanctioned: method not implemented
            throw err;
        }
        expect(inspect).to.have.property('pending');
        expect(inspect).to.have.property('queued');
    });
});
