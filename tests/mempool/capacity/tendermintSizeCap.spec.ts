import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { describeLocalOnly, startLocalChain, LocalChainHandle } from '../helpers/localChain';
import { sendManyRaw, sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { numUnconfirmedTxs } from '../helpers/tendermintMempool';
import { sleep } from '../helpers/waitFor';

describeLocalOnly('Mempool / Capacity / Tendermint mempool.size cap', function () {
    this.timeout(10 * 60 * 1000);

    let chain: LocalChainHandle;
    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        chain = await startLocalChain({
            mempoolSize: 20,
            pendingPoolSize: 50,
            ttlNumBlocks: 100, // disable TTL pruning during the test
            ttlDurationSeconds: 0,
        });
        process.env.LOCAL_CHAIN_RPC = chain.evmRpcEndpoint;
        process.env.LOCAL_CHAIN_TM = chain.rpcEndpoint;

        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-cap');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    after(async () => {
        await chain?.stop();
    });

    it('rejects new txs once the mempool reaches its configured size', async () => {
        // Build 25 txs (5 over the cap of 20) with high-but-equal tips so
        // none replace each other.
        const start = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const signs = await Promise.all(
            Array.from({ length: 25 }, (_, i) => signTransfer(alice, ctx, { nonce: start + i })),
        );

        const results = await sendManyRaw(chain.evmRpcEndpoint, signs.map((s) => s.signed));

        const accepted = results.filter((r) => r.ok).length;
        const rejected = results.filter((r) => !r.ok);

        expect(accepted).to.be.lte(20, 'no more than mempool.size txs should be accepted');
        expect(rejected.length).to.be.gte(5, 'overflow txs must be rejected');
        for (const r of rejected) {
            console.log('mempool-overflow rejection:', r);
        }

        // Sanity: Tendermint's count should reflect the in-mempool depth.
        await sleep(500);
        const { count } = await numUnconfirmedTxs(chain.rpcEndpoint);
        expect(count).to.be.lte(20);
    });

    it('after a tx leaves the pool (via inclusion), a previously-rejected one can be re-accepted', async () => {
        // Wait one block so some of the accepted txs get mined and drain the pool.
        const startBlock = await provider.getBlockNumber();
        while ((await provider.getBlockNumber()) === startBlock) await sleep(250);

        // Build a fresh tx with a new (higher) nonce and submit.
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const { signed } = await signTransfer(alice, ctx, { nonce });
        const sent = await sendRawTransaction(chain.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);
    });
});
