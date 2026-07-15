import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { describeMultiNode, nodeProviders } from '../helpers/multiNode';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForTxpool } from '../helpers/txpoolView';
import { waitForMined } from '../helpers/waitFor';

/**
 * Multi-node propagation: submit to node A, observe in node B's txpool.
 * Skipped unless config.mempoolNodes has >= 2 entries.
 */
describeMultiNode('Mempool / Broadcast / Cross-node propagation', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-bcast');
        ctx = await buildContext(alice);
    });

    it('a tx submitted to node A appears in node B\'s txpool_content within 5s', async () => {
        const providers = nodeProviders();
        expect(providers.length).to.be.gte(2);
        const [nodeA, nodeB] = providers;

        const aProvider = new ethers.JsonRpcProvider(nodeA.node.evmRpcEndpoint);
        const nonce = await aProvider.getTransactionCount(alice.evmAddress, 'pending');
        const aliceA = { ...alice, evmRpcEndpoint: nodeA.node.evmRpcEndpoint } as SeiUser;
        const ctxA = await buildContext(aliceA);
        const { signed, hash } = await signTransfer(aliceA, ctxA, { nonce });

        const sent = await sendRawTransaction(nodeA.node.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);

        // Wait up to 5s for nodeB to see the tx in its pool.
        await waitForTxpool(
            nodeB.provider,
            (c) =>
                Object.keys(c.pending).some(
                    (s) =>
                        s.toLowerCase() === alice.evmAddress.toLowerCase() &&
                        Object.keys(c.pending[s]).some((n) => Number(n) === nonce),
                ),
            5_000,
        );

        await waitForMined(aProvider, hash, 60_000);
    });

    it('every node sees the tx mined in the same block', async () => {
        const providers = nodeProviders();
        const aliceA = { ...alice, evmRpcEndpoint: providers[0].node.evmRpcEndpoint } as SeiUser;
        const ctxA = await buildContext(aliceA);
        const { signed, hash } = await signTransfer(aliceA, ctxA);
        const sent = await sendRawTransaction(providers[0].node.evmRpcEndpoint, signed);
        expect(sent.ok).to.equal(true);

        // Mine on node A.
        const receipts = await Promise.all(
            providers.map(async ({ provider }) => {
                return waitForMined(provider, hash, 60_000);
            }),
        );

        const blockNums = receipts.map((r) => Number(r!.blockNumber));
        for (let i = 1; i < blockNums.length; i++) {
            expect(blockNums[i]).to.equal(
                blockNums[0],
                'all nodes must observe the tx in the same block number',
            );
        }
    });
});
