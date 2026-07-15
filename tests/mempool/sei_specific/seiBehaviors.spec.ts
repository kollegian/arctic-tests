import { ethers } from 'ethers';
import { expect } from 'chai';

import { coins } from '@cosmjs/amino';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined, waitUntil } from '../helpers/waitFor';
import { isCosmosTxHash } from '../helpers/hex';
import { isMethodUnavailable } from '../helpers/rpcSupport';

/**
 * Sei-specific mempool behaviors that aren't covered by the standard
 * categories.
 */
describe('Mempool / Sei-specific / pending semantics with native cross-paths', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-sei');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    it('sei_getCosmosTx resolves the wrapper hash for a pending EVM tx', async function () {
        const { signed, hash } = await signTransfer(alice, ctx);
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok).to.equal(true);

        // Sei wraps every EVM tx as MsgEVMTransaction; the mapping RPC must
        // resolve for a tx the node has already accepted.
        let cosmosHash: string;
        try {
            cosmosHash = (await provider.send('sei_getCosmosTx', [hash])) as string;
        } catch (err: unknown) {
            await waitForMined(provider, hash, 60_000);
            // sanctioned: sei_* legacy surface is deprecated/disabled on this node
            if (isMethodUnavailable(err)) this.skip();
            throw err;
        }
        expect(isCosmosTxHash(cosmosHash)).to.equal(
            true,
            `sei_getCosmosTx returned an invalid hash: ${cosmosHash}`,
        );

        await waitForMined(provider, hash, 60_000);
    });

    it('eth_getBalance(recipient, "pending") reflects an in-flight EVM-mediated native credit', async () => {
        const recipient = ethers.Wallet.createRandom().address;
        const value = ethers.parseEther('0.005');

        const beforeRecipient = await provider.getBalance(recipient);
        const { signed, hash } = await signTransfer(alice, ctx, { to: recipient, value });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok).to.equal(true);

        // Standard pending-state contract: the recipient's pending balance is
        // credited as soon as the tx is in the pool, and stays credited after
        // inclusion — so this read is deterministic either way.
        const pendingRecipient = await provider.getBalance(recipient, 'pending');
        expect(pendingRecipient).to.equal(
            beforeRecipient + value,
            'pending balance must reflect the in-flight credit',
        );

        await waitForMined(provider, hash, 60_000);
        expect(await provider.getBalance(recipient)).to.equal(beforeRecipient + value);
    });

    it('EIP-7702 authorization-list tx is admitted by the mempool', async () => {
        const feeData = await provider.getFeeData();
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');

        const authorization = await alice.evmWallet.wallet.authorize({
            address: ethers.Wallet.createRandom().address,
            nonce: nonce + 1,
            chainId: ctx.chainId,
        });
        const signed = await alice.evmWallet.wallet.signTransaction({
            type: 4,
            chainId: ctx.chainId,
            nonce,
            to: alice.evmAddress,
            value: 0n,
            data: '0x',
            gasLimit: 100_000n,
            maxFeePerGas: (feeData.maxFeePerGas ?? 1_000_000_000n) * 2n,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100_000_000n,
            authorizationList: [authorization],
        } as unknown as ethers.TransactionRequest);

        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(
            true,
            'a type-4 (EIP-7702) tx must be admitted',
        );

        const receipt = await waitForMined(
            provider,
            (sent as { ok: true; hash: string }).hash,
            90_000,
        );
        expect(receipt?.status).to.equal(1);
    });

    it('an EVM tx and a Cosmos bank send from the SAME account can be in flight together; both succeed', async () => {
        // Sei tracks the EVM nonce and the Cosmos sequence separately, so the
        // two paths must not trip over each other when used concurrently from
        // one associated account.
        const evmNonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const accountBefore = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
        const seqBefore = accountBefore!.sequence;

        const { signed, hash } = await signTransfer(alice, ctx);
        const bankMsg = {
            typeUrl: '/cosmos.bank.v1beta1.MsgSend',
            value: {
                fromAddress: alice.seiAddress,
                toAddress: admin.seiAddress,
                amount: coins(1, 'usei'),
            },
        };

        const [evmResult, cosmosResult] = await Promise.all([
            sendRawTransaction(alice.evmRpcEndpoint, signed),
            alice.seiWallet.signAndSend([bankMsg], 'mempool-concurrent-paths'),
        ]);
        expect(evmResult.ok, evmResult.ok ? '' : (evmResult as { message: string }).message).to.equal(
            true,
            'EVM tx must admit alongside the in-flight Cosmos tx',
        );
        expect(cosmosResult.code).to.equal(
            0,
            `Cosmos send must succeed alongside the in-flight EVM tx: ${cosmosResult.rawLog}`,
        );

        const receipt = await waitForMined(provider, hash, 60_000);
        expect(receipt?.status).to.equal(1);

        // Each path advances only its own counter.
        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(evmNonceBefore + 1, 'exactly one EVM nonce consumed');
        await waitUntil(
            async () => {
                const account = await alice.seiWallet.signingClient.getAccount(alice.seiAddress);
                return account!.sequence === seqBefore + 1;
            },
            30_000,
            500,
            'cosmos sequence to advance by exactly the bank send',
        );
    });
});
