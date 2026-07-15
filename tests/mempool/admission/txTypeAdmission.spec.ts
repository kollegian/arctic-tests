import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';

/**
 * Admission matrix across transaction envelope types. The mempool must:
 *   - admit every type the chain supports (legacy 0, access-list 1, dynamic-fee 2),
 *   - admit contract creations (to = null),
 *   - refuse unknown/unsupported envelope types at the door with no side effects.
 *
 * Where a type's support genuinely varies by node version, a rejection with a
 * clear type-related error is accepted and the test self-skips per README.
 */
describe('Mempool / Admission / Transaction type acceptance matrix', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-types');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    it('admits a legacy (type-0) transfer and mines it with receipt.type = 0', async () => {
        const { signed, hash } = await signTransfer(alice, ctx, { type: 0 });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);

        const receipt = await waitForMined(provider, hash, 60_000);
        expect(receipt?.status).to.equal(1);
        expect(receipt?.type).to.equal(0);
    });

    it('admits an EIP-2930 (type-1) access-list transfer and mines it with receipt.type = 1', async () => {
        // NOTE: the access list raises the intrinsic gas (2400 per address +
        // 1900 per storage key on top of the 21000 base), so the default
        // transfer gasLimit of 21000 would be rejected for intrinsic gas —
        // with the same generic ": unknown" error a genuine type rejection
        // would produce. Budget for the list explicitly.
        const { signed, hash } = await signTransfer(alice, ctx, {
            type: 1,
            gasLimit: 40_000n,
            accessList: [
                {
                    address: ethers.Wallet.createRandom().address,
                    storageKeys: [ethers.ZeroHash],
                },
            ],
        });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);

        const receipt = await waitForMined(provider, hash, 60_000);
        expect(receipt?.status).to.equal(1);
        expect(receipt?.type).to.equal(1);
    });

    it('admits an EIP-1559 (type-2) transfer and mines it with receipt.type = 2', async () => {
        const { signed, hash } = await signTransfer(alice, ctx, { type: 2 });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);

        const receipt = await waitForMined(provider, hash, 60_000);
        expect(receipt?.status).to.equal(1);
        expect(receipt?.type).to.equal(2);
    });

    it('admits a contract-creation tx (to = null) and the receipt carries contractAddress', async () => {
        const feeData = await provider.getFeeData();
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        // Init code that returns a 1-byte runtime (0xFE = INVALID). Smallest
        // possible deployable contract; deployment itself succeeds.
        const initCode = '0x60fe60005360016000f3';
        const signed = await alice.evmWallet.wallet.signTransaction({
            type: 2,
            chainId: ctx.chainId,
            nonce,
            to: null,
            value: 0n,
            data: initCode,
            gasLimit: 100_000n,
            maxFeePerGas: (feeData.maxFeePerGas ?? 1_000_000_000n) * 2n,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100_000_000n,
        });
        const hash = ethers.Transaction.from(signed).hash!;

        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);

        const receipt = await waitForMined(provider, hash, 60_000);
        expect(receipt?.status).to.equal(1);
        expect(receipt?.contractAddress).to.not.equal(null);
        const code = await provider.getCode(receipt!.contractAddress!);
        expect(code).to.equal('0xfe');
    });

    it('rejects an unknown typed envelope (0x05) with no nonce burn', async () => {
        const nonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');
        // 0x05 is not a defined tx envelope type; 0xc0 is a well-formed empty RLP list.
        const result = await sendRawTransaction(alice.evmRpcEndpoint, '0x05c0');
        expect(result.ok).to.equal(false);
        expect((result as { message: string }).message.length).to.be.greaterThan(0);

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    it('rejects a blob (type-3) envelope outright', async () => {
        const result = await sendRawTransaction(alice.evmRpcEndpoint, '0x03c0');
        expect(result.ok).to.equal(false);
        expect((result as { message: string }).message.length).to.be.greaterThan(0);
    });
});
