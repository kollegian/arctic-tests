import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import {
    BuildContext,
    buildContext,
    computeOversizeGasLimit,
    signTransfer,
    suggestedTip,
} from '../helpers/txFactory';
import { blockMaxBytes, blockMaxGas } from '../helpers/tendermintMempool';
import {
    signType2Raw,
    signType2WithHighS,
    signType2WithSignatureOverride,
    Type2Fields,
} from '../helpers/rawSign';

describe('Mempool / Admission / CheckTx rejection paths', function () {
    this.timeout(120_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        await UserFactory.fundAdminOnSei();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    it('a mutated signature byte recovers to a different sender; tx cannot proceed', async () => {
        const { signed } = await signTransfer(alice, ctx);
        const tampered =
            signed.slice(0, -2) + (signed.slice(-2) === 'ff' ? 'fe' : 'ff');

        const parsedTampered = ethers.Transaction.from(tampered);
        const recoveredAddress = parsedTampered.from;

        expect(recoveredAddress).to.not.equal(null);
        expect(recoveredAddress!.toLowerCase()).to.not.equal(
            alice.evmAddress.toLowerCase(),
        );

        const aliceNonceBefore = await provider.getTransactionCount(
            alice.evmAddress,
            'latest',
        );
        const aliceBalBefore = await provider.getBalance(alice.evmAddress);
        const recoveredNonceBefore = await provider.getTransactionCount(
            recoveredAddress!,
            'latest',
        );
        const recoveredBalBefore = await provider.getBalance(recoveredAddress!);

        const result = await sendRawTransaction(alice.evmRpcEndpoint, tampered);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(
            ': insufficient funds',
        );

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(aliceNonceBefore);
        expect(await provider.getBalance(alice.evmAddress)).to.equal(
            aliceBalBefore,
        );
        expect(
            await provider.getTransactionCount(recoveredAddress!, 'latest'),
        ).to.equal(recoveredNonceBefore);
        expect(await provider.getBalance(recoveredAddress!)).to.equal(
            recoveredBalBefore,
        );
    });

    it('rejects a tx whose s value is above N/2 (EIP-2 high-s violation)', async () => {
        const nonce = await provider.getTransactionCount(
            alice.evmAddress,
            'pending',
        );
        const { maxFeePerGas, maxPriorityFeePerGas } = await suggestedTip(
            provider,
        );

        const tampered = signType2WithHighS(alice.evmWallet.wallet.privateKey, {
            chainId: BigInt(ctx.chainId),
            nonce: BigInt(nonce),
            maxPriorityFeePerGas,
            maxFeePerGas,
            gasLimit: 21000n,
            to: alice.evmAddress.toLowerCase(),
            value: ethers.parseEther('0.0001'),
            data: '0x',
        });

        const nonceBefore = await provider.getTransactionCount(
            alice.evmAddress,
            'latest',
        );
        const balBefore = await provider.getBalance(alice.evmAddress);

        const result = await sendRawTransaction(alice.evmRpcEndpoint, tampered);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(
            ': invalid chain-id',
        );

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
        expect(await provider.getBalance(alice.evmAddress)).to.equal(balBefore);
    });

    it('rejects gasPrice below baseFee', async () => {
        const nonceBefore = await provider.getTransactionCount(
            alice.evmAddress,
            'latest',
        );
        const { signed } = await signTransfer(alice, ctx, {
            type: 0,
            gasPrice: 1n,
        });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(
            ': insufficient fee',
        );

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    it('rejects when gasLimit is below intrinsic gas', async () => {
        const nonceBefore = await provider.getTransactionCount(
            alice.evmAddress,
            'latest',
        );
        const { signed } = await signTransfer(alice, ctx, { gasLimit: 100n });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(': unknown');

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    it('rejects when sender cannot afford upfront gasLimit * gasPrice', async () => {
        const balance = await provider.getBalance(alice.evmAddress);
        const gasLimit = 21000n;
        const gasPrice = balance / gasLimit + 1n;
        const { signed } = await signTransfer(alice, ctx, {
            type: 0,
            gasLimit,
            gasPrice,
            value: 0n,
        });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(
            ': insufficient funds',
        );
    });

    it('rejects when nonce is below the account nonce ("nonce too low")', async () => {
        const latest = await provider.getTransactionCount(
            alice.evmAddress,
            'latest',
        );
        if (latest === 0) {
            const { signed, hash } = await signTransfer(alice, ctx);
            const send = await sendRawTransaction(alice.evmRpcEndpoint, signed);
            expect(send.ok).to.equal(true);
            await provider.waitForTransaction(hash);
        }

        const stale =
            (await provider.getTransactionCount(alice.evmAddress, 'latest')) - 1;
        const { signed } = await signTransfer(alice, ctx, {
            nonce: stale,
            value: ethers.parseEther('0.0002'),
        });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(
            ': incorrect account sequence',
        );
    });

    it('rejects a tx signed with the wrong chainId', async () => {
        const nonceBefore = await provider.getTransactionCount(
            alice.evmAddress,
            'latest',
        );
        const wrong = ctx.chainId === 1 ? 2 : 1;
        const { signed } = await signTransfer(alice, ctx, { chainId: wrong });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(
            ': invalid chain-id',
        );

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    it('rejects a tx whose gasLimit exceeds consensus block.max_gas', async () => {
        const maxGas = await blockMaxGas(alice.seiRpcEndpoint);
        const gasLimit = maxGas + 1n;
        const { maxFeePerGas, maxPriorityFeePerGas } = await suggestedTip(provider);
        const { signed } = await signTransfer(alice, ctx, {
            gasLimit,
            maxFeePerGas,
            maxPriorityFeePerGas,
            value: 0n,
        });

        const nonceBefore = await provider.getTransactionCount(
            alice.evmAddress,
            'latest',
        );

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(': out of gas');

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    async function canonicalFields(): Promise<Type2Fields> {
        const nonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const { maxFeePerGas, maxPriorityFeePerGas } = await suggestedTip(provider);
        return {
            chainId: BigInt(ctx.chainId),
            nonce: BigInt(nonce),
            maxPriorityFeePerGas,
            maxFeePerGas,
            gasLimit: 21000n,
            to: alice.evmAddress.toLowerCase(),
            value: ethers.parseEther('0.0001'),
            data: '0x',
        };
    }

    it('rejects a tx with a zeroed signature (r = 0, s = 0) with no side effects', async () => {
        const nonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const balBefore = await provider.getBalance(alice.evmAddress);

        const zeroSig = signType2WithSignatureOverride(
            alice.evmWallet.wallet.privateKey,
            await canonicalFields(),
            { r: 0n, s: 0n },
        );

        const result = await sendRawTransaction(alice.evmRpcEndpoint, zeroSig);
        expect(result.ok).to.equal(false);
        expect((result as { message: string }).message.length).to.be.greaterThan(0);

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
        expect(await provider.getBalance(alice.evmAddress)).to.equal(balBefore);
    });

    it('rejects a tx with an out-of-range yParity (v = 2)', async () => {
        const nonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');

        const badParity = signType2WithSignatureOverride(
            alice.evmWallet.wallet.privateKey,
            await canonicalFields(),
            { yParity: 2 },
        );

        const result = await sendRawTransaction(alice.evmRpcEndpoint, badParity);
        expect(result.ok).to.equal(false);
        expect((result as { message: string }).message.length).to.be.greaterThan(0);

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    it('rejects maxPriorityFeePerGas greater than maxFeePerGas', async () => {
        // ethers refuses to sign this shape client-side, so assemble the raw
        // tx ourselves — the point is to verify the NODE's validation.
        const nonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const fields = await canonicalFields();
        const signed = signType2Raw(alice.evmWallet.wallet.privateKey, {
            ...fields,
            maxPriorityFeePerGas: fields.maxFeePerGas + 1n,
        });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    it('rejects when value consumes the whole balance leaving nothing for gas', async () => {
        const balance = await provider.getBalance(alice.evmAddress);
        const { signed } = await signTransfer(alice, ctx, {
            to: admin.evmAddress,
            value: balance,
        });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);
        expect((result as { message: string }).message).to.equal(
            ': insufficient funds',
        );
    });

    it('rejects when gasLimit covers the base 21000 but not the calldata intrinsic cost', async () => {
        const nonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');
        // 100 non-zero bytes cost 1600 gas on top of the 21000 base; a 21000
        // gasLimit is below the true intrinsic cost of this payload.
        const { signed } = await signTransfer(alice, ctx, {
            data: '0x' + 'ff'.repeat(100),
            gasLimit: 21000n,
        });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32000);

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore);
    });

    it('rejects a tx whose wire size exceeds consensus block.max_bytes', async () => {
        const maxBytes = await blockMaxBytes(alice.seiRpcEndpoint);
        const payloadBytes = maxBytes + 64 * 1024;
        const huge = '0x' + 'ab'.repeat(payloadBytes);
        const gasLimit = await computeOversizeGasLimit(payloadBytes);

        const { signed } = await signTransfer(alice, ctx, {
            data: huge,
            gasLimit,
        });

        const result = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(result.ok).to.equal(false);
        expect((result as { code: number }).code).to.equal(-32700);
        expect((result as { message: string }).message).to.equal('parse error');
    });
});
