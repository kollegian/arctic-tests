import { ethers } from 'ethers';
import { expect } from 'chai';
import WebSocket from 'ws';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';
import { isMethodUnavailable } from '../helpers/rpcSupport';

/**
 * eth_subscribe("newPendingTransactions") — asserted against the standard
 * geth websocket surface: the subscription exists, emits the hash of a tx we
 * submit while it is pending, and eth_unsubscribe stops the stream.
 *
 * A node that does not expose the subscription FAILS these tests (observed on
 * arctic-1: 'no "newPendingTransactions" subscription in eth namespace') —
 * that is a finding to report, not a variation to skip.
 */
describe('Mempool / RPC surface / newPendingTransactions subscription', function () {
    this.timeout(120_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;
    let wsEndpoint: string;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-sub');
        ctx = await buildContext(alice);
        provider = ctx.provider;
        wsEndpoint = alice.evmRpcEndpoint.replace(/^http/i, 'ws');
    });

    interface SubscribedSocket {
        ws: WebSocket;
        seen: Set<string>;
        subscriptionId: string;
        unsubscribe: () => Promise<unknown>;
    }

    /** Open a websocket and subscribe to newPendingTransactions. Throws on any failure. */
    async function openSubscription(): Promise<SubscribedSocket> {
        const ws = new WebSocket(wsEndpoint);
        const seen = new Set<string>();
        let subscriptionId = '';
        let unsubscribeResult: ((v: unknown) => void) | null = null;

        await new Promise<void>((resolve, reject) => {
            ws.on('open', () => resolve());
            ws.on('error', (err) => reject(new Error(`websocket connect failed: ${err.message}`)));
        });

        const subscribed = new Promise<void>((resolve, reject) => {
            ws.on('message', (raw: Buffer) => {
                const msg = JSON.parse(raw.toString());
                if (msg.id === 1) {
                    if (msg.error) reject(new Error(`eth_subscribe failed: ${JSON.stringify(msg.error)}`));
                    else {
                        subscriptionId = msg.result;
                        resolve();
                    }
                } else if (msg.id === 2) {
                    unsubscribeResult?.(msg.error ?? msg.result);
                } else if (msg.params?.subscription === subscriptionId) {
                    const hash = msg.params.result as string;
                    if (typeof hash === 'string') seen.add(hash.toLowerCase());
                }
            });
        });
        ws.send(
            JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_subscribe',
                params: ['newPendingTransactions'],
            }),
        );
        await subscribed;

        const unsubscribe = (): Promise<unknown> =>
            new Promise((resolve) => {
                unsubscribeResult = resolve;
                ws.send(
                    JSON.stringify({
                        jsonrpc: '2.0',
                        id: 2,
                        method: 'eth_unsubscribe',
                        params: [subscriptionId],
                    }),
                );
            });

        return { ws, seen, subscriptionId, unsubscribe };
    }

    it('emits a newPendingTransactions notification for a tx we submit', async function () {
        let sub: SubscribedSocket;
        try {
            sub = await openSubscription();
        } catch (err: unknown) {
            if (isMethodUnavailable(err)) this.skip(); // sanctioned: subscription not implemented
            throw err;
        }
        try {
            const { signed, hash } = await signTransfer(alice, ctx);
            const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
            expect(sent.ok).to.equal(true);

            const start = Date.now();
            while (Date.now() - start < 20_000 && !sub.seen.has(hash.toLowerCase())) {
                await new Promise((r) => setTimeout(r, 250));
            }

            const receipt = await waitForMined(provider, hash, 60_000);
            expect(receipt?.status).to.equal(1);

            expect(sub.seen.has(hash.toLowerCase())).to.equal(
                true,
                'newPendingTransactions should have emitted our hash before inclusion',
            );
        } finally {
            sub.ws.close();
        }
    });

    it('eth_unsubscribe stops the notification stream', async function () {
        let sub: SubscribedSocket;
        try {
            sub = await openSubscription();
        } catch (err: unknown) {
            if (isMethodUnavailable(err)) this.skip(); // sanctioned: subscription not implemented
            throw err;
        }
        try {
            const ack = await sub.unsubscribe();
            expect(ack, 'eth_unsubscribe should acknowledge').to.equal(true);

            // Submit a tx AFTER unsubscribing; its hash must never arrive.
            const { signed, hash } = await signTransfer(alice, ctx);
            const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
            expect(sent.ok).to.equal(true);

            const receipt = await waitForMined(provider, hash, 60_000);
            expect(receipt?.status).to.equal(1);
            // Give any straggler notification a moment to arrive, then assert silence.
            await new Promise((r) => setTimeout(r, 2_000));
            expect(sub.seen.has(hash.toLowerCase())).to.equal(
                false,
                'no notification should arrive after eth_unsubscribe',
            );
        } finally {
            sub.ws.close();
        }
    });
});
