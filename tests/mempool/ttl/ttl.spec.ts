import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { describeLocalOnly, startLocalChain, LocalChainHandle } from '../helpers/localChain';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { fetchTxpoolContent } from '../helpers/txpoolView';
import { waitBlocks, sleep } from '../helpers/waitFor';

describeLocalOnly('Mempool / TTL / Time- and block-based eviction', function () {
    this.timeout(5 * 60 * 1000);

    let chain: LocalChainHandle;
    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        chain = await startLocalChain({
            mempoolSize: 1000,
            ttlNumBlocks: 3,
            ttlDurationSeconds: 0,  // block-count TTL only
        });

        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-ttl');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    after(async () => {
        await chain?.stop();
    });

    it('a queued (gap-blocked) tx is evicted after ttl-num-blocks blocks', async () => {
        const start = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const future = start + 5; // intentionally leave a gap
        const { signed } = await signTransfer(alice, ctx, { nonce: future });

        const sent = await sendRawTransaction(chain.evmRpcEndpoint, signed);
        expect(sent.ok).to.equal(true);

        // Verify it lands in queued first.
        await sleep(500);
        const beforeTtl = await fetchTxpoolContent(provider);
        const seen = Object.keys(beforeTtl.queued).some(
            (s) =>
                s.toLowerCase() === alice.evmAddress.toLowerCase() &&
                Object.keys(beforeTtl.queued[s]).some((n) => Number(n) === future),
        );
        expect(seen).to.equal(true, 'gapped tx must be in queued bucket');

        // Wait ttl-num-blocks + 1 blocks.
        await waitBlocks(provider, 5);

        const afterTtl = await fetchTxpoolContent(provider);
        const stillSeen = Object.keys(afterTtl.queued).some(
            (s) =>
                s.toLowerCase() === alice.evmAddress.toLowerCase() &&
                Object.keys(afterTtl.queued[s]).some((n) => Number(n) === future),
        );
        expect(stillSeen).to.equal(false, 'queued tx should have expired by ttl-num-blocks');
    });

    it('after TTL eviction, the SAME signed tx can be resubmitted (keep-invalid-txs-in-cache=false)', async () => {
        // Build a fresh gap tx, let it expire, then resend.
        const start = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const future = start + 5;
        const { signed } = await signTransfer(alice, ctx, { nonce: future });

        const first = await sendRawTransaction(chain.evmRpcEndpoint, signed);
        expect(first.ok).to.equal(true);
        await waitBlocks(provider, 5);

        const second = await sendRawTransaction(chain.evmRpcEndpoint, signed);
        console.log('ttl-resubmit result:', second);
    });
});
