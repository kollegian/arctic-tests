import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';

/**
 * Sei-specific: an EVM tx from an unassociated EOA implicitly triggers
 * address association on first inclusion. The mempool admits the wrapper
 * even though the cosmos-side account doesn't yet exist.
 *
 * Invariants we lock down here:
 *   1. eth_sendRawTransaction accepts the first tx from an unassociated EOA.
 *   2. After the first tx mines, the EVM<->Sei address mapping is established.
 *   3. Subsequent txs from the same EOA still admit normally (no double-association).
 */
describe('Mempool / Admission / Unassociated EOA first-tx behavior', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let unassociated: SeiUser;
    let funded: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        
        unassociated = await UserFactory.createUnassociatedUsers(admin, 'mempool-unassoc');
        funded = await UserFactory.createSeiUser(admin, 'mempool-unassoc-funder');
        ctx = await buildContext(funded);
        provider = ctx.provider;

        // Fund the EVM-side address of the unassociated account from a funded
        // associated user so it has enough balance to pay gas.
        const fundTx = await funded.evmWallet.wallet.sendTransaction({
            to: unassociated.evmAddress,
            value: ethers.parseEther('0.5'),
        });
        await fundTx.wait();

        // Sanity: confirm balance arrived. (Compare bigints directly — chai's
        // gt/lt matchers only accept numbers.)
        const bal = await provider.getBalance(unassociated.evmAddress);
        expect(bal > 0n).to.equal(true);
    });

    it('admits the very first EVM tx from an unassociated EOA', async () => {
        // Receiving funds must NOT associate an account; only the account's
        // own first tx does. This is the documented Sei association contract.
        const wasAssociated = await unassociated.evmWallet.isAssociated();
        expect(wasAssociated).to.equal(
            false,
            'receiving a transfer must not associate the EOA',
        );
        const senderCtx = await buildContext(unassociated);

        const { signed, hash } = await signTransfer(unassociated, senderCtx, {
            to: admin.evmAddress,
            value: ethers.parseEther('0.001'),
        });
        const sent = await sendRawTransaction(unassociated.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(
            true,
            'first tx from unassociated EOA should be admitted',
        );

        const receipt = await waitForMined(provider, hash, 90_000);
        expect(receipt?.status).to.equal(1);

        // After first inclusion the EOA must be associated.
        const nowAssociated = await unassociated.evmWallet.isAssociated();
        expect(nowAssociated).to.equal(true, 'EOA should be associated after first inclusion');
    });

    it('subsequent txs from the now-associated EOA admit without re-association cost', async () => {
        const senderCtx = await buildContext(unassociated);
        const { signed, hash } = await signTransfer(unassociated, senderCtx, {
            to: admin.evmAddress,
            value: ethers.parseEther('0.001'),
        });
        const sent = await sendRawTransaction(unassociated.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);

        const receipt = await waitForMined(provider, hash, 60_000);
        expect(receipt?.status).to.equal(1);
        // Gas usage should be close to 21000 for a plain transfer (no extra
        // association overhead this time).
        expect(Number(receipt!.gasUsed)).to.be.lessThan(60_000);
    });
});
