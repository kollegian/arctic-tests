import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { describeLocalOnly, startLocalChain, LocalChainHandle } from '../helpers/localChain';
import { sendManyRaw } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer, suggestedTip } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';

describeLocalOnly('Mempool / Capacity / Pending pool fill + tip-based eviction', function () {
    this.timeout(10 * 60 * 1000);

    let chain: LocalChainHandle;
    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let ctxA: BuildContext;
    let ctxB: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        chain = await startLocalChain({
            mempoolSize: 200,
            pendingPoolSize: 30,  // small EVM pending pool to force eviction
            ttlNumBlocks: 100,
            ttlDurationSeconds: 0,
        });

        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-evict');
        bob = await UserFactory.createSeiUser(admin, 'mempool-bob-evict');
        ctxA = await buildContext(alice);
        ctxB = await buildContext(bob);
        provider = ctxA.provider;
    });

    after(async () => {
        await chain?.stop();
    });

    it('fills the pending pool with low-tip txs and confirms high-tip arrivals still get included', async () => {
        const { maxFeePerGas, maxPriorityFeePerGas } = await suggestedTip(provider);

        // Flood alice's pool with 40 low-tip txs (pending-size = 30, so >= 10
        // should be rejected or fall to queued/dropped).
        const aliceStart = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const lowTips = await Promise.all(
            Array.from({ length: 40 }, (_, i) =>
                signTransfer(alice, ctxA, {
                    nonce: aliceStart + i,
                    maxFeePerGas,
                    maxPriorityFeePerGas,
                }),
            ),
        );
        await sendManyRaw(chain.evmRpcEndpoint, lowTips.map((s) => s.signed));

        // Now submit a single very-high-tip tx from bob.
        const { signed: hot, hash: hotHash } = await signTransfer(bob, ctxB, {
            maxFeePerGas: maxFeePerGas * 20n,
            maxPriorityFeePerGas: maxPriorityFeePerGas * 50n,
        });
        const sent = await fetch(chain.evmRpcEndpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_sendRawTransaction',
                params: [hot],
            }),
        });
        const body = (await sent.json()) as {
            result?: string;
            error?: { code: number; message: string };
        };
        expect(body.result, body.error?.message ?? '').to.be.a('string');

        // Bob's high-tip tx should mine within ~3 blocks even though alice
        // flooded the pool.
        const receipt = await waitForMined(provider, hotHash, 60_000);
        expect(receipt?.status).to.equal(1);
    });
});
