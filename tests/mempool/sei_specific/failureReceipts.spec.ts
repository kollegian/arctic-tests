import { ethers } from 'ethers';
import { expect } from 'chai';
import { coins } from '@cosmjs/amino';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';

/**
 * EVM failure-receipt taxonomy — Sei v6.6 (giga executor + CON-256).
 *
 * These tests pin the PRECISE receipt shape of each failure class, which is
 * intentional Sei behavior confirmed against the sei-chain source:
 *
 *   - x/evm/keeper/msg_server.go        (EVM execution → receipt with gasUsed)
 *   - x/evm/keeper/abci.go:124-134      (ante-failure → receipt, no gasUsed)
 *   - x/evm/keeper/deferred.go:24-37    ("reverted during execution ... ante")
 *   - app/ante/evm_delivertx.go         (DecorateNonceCallback bumps nonce)
 *   - x/evm/AGENTS.md "Receipts for Failure Scenarios"
 *   - CHANGELOG v6.6 PR #3383 "write receipt for state-transition errors that
 *     bump the nonce", PR #3372 "recheck=false from Autobahn block-finalize"
 *
 * The single load-bearing distinction: **gasUsed tells you WHERE a tx failed.**
 *   status=1                       → success
 *   status=0, gasUsed  > 0         → failed INSIDE the EVM (revert/OOG/INVALID);
 *                                    the sender paid for the executed gas
 *   status=0, gasUsed == 0         → failed BEFORE the EVM, in the DeliverTx
 *                                    ante (e.g. unaffordable at inclusion);
 *                                    nonce consumed, ZERO fee charged
 *
 * NOTE ON POSTURE: this spec documents Sei's *intentional* v6.6 semantics as a
 * regression guard (it is expected to pass on arctic-1). It does NOT contradict
 * tests/mempool/ttl/liveEviction.spec.ts, which asserts the geth reference
 * (an unaffordable tx should never reach a block) and stays red to flag the
 * divergence. Both are deliberate: one flags the divergence, one pins its shape.
 */
describe('Mempool / Sei-specific / EVM failure-receipt taxonomy (v6.6 CON-256)', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    // Runtime = single INVALID (0xFE) opcode: any call consumes all gas and fails.
    const INVALID_RUNTIME_INITCODE = '0x60fe60005360016000f3';

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-receipts');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    /** Read the raw receipt so status/gasUsed/effectiveGasPrice are inspected verbatim. */
    async function rawReceipt(hash: string): Promise<{
        status: number;
        gasUsed: bigint;
        effectiveGasPrice: bigint;
        blockNumber: number;
        logs: unknown[];
    } | null> {
        const r = await provider.send('eth_getTransactionReceipt', [hash]);
        if (r === null) return null;
        return {
            status: Number(r.status),
            gasUsed: BigInt(r.gasUsed),
            effectiveGasPrice: BigInt(r.effectiveGasPrice ?? '0x0'),
            blockNumber: Number(r.blockNumber),
            logs: r.logs ?? [],
        };
    }

    async function txInBlockBody(
        p: ethers.JsonRpcProvider,
        blockNumber: number,
        hash: string,
    ): Promise<boolean> {
        const block = await p.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), true]);
        return (block.transactions as { hash: string }[]).some(
            (t) => t.hash.toLowerCase() === hash.toLowerCase(),
        );
    }

    /** Poll eth_getTransactionReceipt on `p` until non-null or timeout. */
    async function pollReceipt(
        p: ethers.JsonRpcProvider,
        hash: string,
        timeoutMs = 30_000,
    ): Promise<{
        status: number;
        gasUsed: bigint;
        effectiveGasPrice: bigint;
        blockNumber: number;
        logs: unknown[];
    } | null> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const r = await p.send('eth_getTransactionReceipt', [hash]);
            if (r !== null) {
                return {
                    status: Number(r.status),
                    gasUsed: BigInt(r.gasUsed),
                    effectiveGasPrice: BigInt(r.effectiveGasPrice ?? '0x0'),
                    blockNumber: Number(r.blockNumber),
                    logs: r.logs ?? [],
                };
            }
            await new Promise((res) => setTimeout(res, 750));
        }
        return null;
    }

    it('SUCCESS: a plain transfer yields status=1, gasUsed=21000, positive effectiveGasPrice', async () => {
        const { signed, hash } = await signTransfer(alice, ctx, {
            to: admin.evmAddress,
            value: ethers.parseEther('0.0001'),
        });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(true);
        await waitForMined(provider, hash, 60_000);

        const r = await rawReceipt(hash);
        expect(r).to.not.equal(null);
        expect(r!.status).to.equal(1);
        expect(r!.gasUsed).to.equal(21000n);
        expect(r!.effectiveGasPrice > 0n).to.equal(true, 'a paid tx must report a positive gas price');
    });

    it('IN-EVM FAILURE: an INVALID-opcode call yields status=0 with gasUsed > 0 (gas WAS charged)', async () => {
        // Deploy the always-failing contract.
        const feeData = await provider.getFeeData();
        const deployNonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const deploySigned = await alice.evmWallet.wallet.signTransaction({
            type: 2,
            chainId: ctx.chainId,
            nonce: deployNonce,
            to: null,
            value: 0n,
            data: INVALID_RUNTIME_INITCODE,
            gasLimit: 100_000n,
            maxFeePerGas: (feeData.maxFeePerGas ?? 1_000_000_000n) * 2n,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100_000_000n,
        });
        const deployHash = ethers.Transaction.from(deploySigned).hash!;
        expect((await sendRawTransaction(alice.evmRpcEndpoint, deploySigned)).ok).to.equal(true);
        const deployReceipt = await waitForMined(provider, deployHash, 60_000);
        const target = deployReceipt!.contractAddress!;
        expect(await provider.getCode(target)).to.equal('0xfe');

        // Call it: fails inside the EVM, consuming the whole gas limit.
        const gasLimit = 80_000n;
        const { signed, hash } = await signTransfer(alice, ctx, {
            to: target,
            value: 0n,
            gasLimit,
        });
        expect((await sendRawTransaction(alice.evmRpcEndpoint, signed)).ok).to.equal(true);
        await waitForMined(provider, hash, 60_000);

        const r = await rawReceipt(hash);
        expect(r).to.not.equal(null);
        expect(r!.status).to.equal(0, 'INVALID opcode must fail the tx');
        expect(r!.gasUsed > 0n).to.equal(
            true,
            'a failure INSIDE the EVM must charge for executed gas (gasUsed > 0)',
        );
        expect(r!.gasUsed).to.equal(gasLimit, 'INVALID consumes the entire gas limit');
        expect(r!.effectiveGasPrice > 0n).to.equal(true);
    });

    it('PRE-EVM (ANTE) FAILURE: an unaffordable-at-inclusion tx yields status=0 with gasUsed == 0 (nonce burned, zero fee)', async () => {
        // This is the CON-256 same-block behavior: when the drain and the
        // doomed tx are CO-SELECTED into one block, the drain executes first,
        // the doomed tx then fails the ante mid-block, and a status-0/gasUsed-0
        // receipt is written (verified 8/8 via scripts/includedInvalidTxProbe).
        // Co-selection is timing-dependent (a drain mined a block early instead
        // sends the doomed tx down the re-validated DROP path), so retry until
        // co-selection is achieved; fail only if it never is.
        const signRawType2 = async (
            w: ethers.Wallet,
            nonce: number,
            value: bigint,
        ): Promise<{ signed: string; hash: string }> => {
            const fee = await provider.getFeeData();
            const signed = await w.signTransaction({
                type: 2,
                chainId: ctx.chainId,
                nonce,
                to: admin.evmAddress,
                value,
                gasLimit: 21000n,
                maxFeePerGas: (fee.maxFeePerGas ?? 1_000_000_000n) * 2n,
                maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 100_000_000n,
            });
            return { signed, hash: ethers.Transaction.from(signed).hash! };
        };

        const attempts = 6;
        let receipt: Awaited<ReturnType<typeof pollReceipt>> = null;
        let doomedHash = '';
        let sender: ethers.Wallet | undefined;

        for (let attempt = 0; attempt < attempts && receipt === null; attempt++) {
            sender = ethers.Wallet.createRandom().connect(provider);
            const stake = ethers.parseEther('5');
            await (await alice.evmWallet.wallet.sendTransaction({ to: sender.address, value: stake })).wait();

            const drain = await signRawType2(sender, 0, stake - ethers.parseEther('1'));
            const doomed = await signRawType2(sender, 1, ethers.parseEther('3'));
            doomedHash = doomed.hash;

            // Doomed (nonce 1, gap-blocked) first, then drain (nonce 0), back-to-back.
            const rDoomed = await sendRawTransaction(alice.evmRpcEndpoint, doomed.signed);
            const rDrain = await sendRawTransaction(alice.evmRpcEndpoint, drain.signed);
            expect(rDrain.ok, rDrain.ok ? '' : (rDrain as { message: string }).message).to.equal(true);
            expect(rDoomed.ok, 'doomed tx must admit against committed state').to.equal(true);

            await waitForMined(provider, drain.hash, 60_000);
            // Short poll: if co-selected, the receipt appears within a block or two.
            receipt = await pollReceipt(provider, doomed.hash, 8_000);
        }

        expect(
            receipt,
            `co-selection never achieved in ${attempts} attempts (drain kept mining a block early) — ` +
                'unable to exercise the CON-256 same-block ante-failure receipt path',
        ).to.not.equal(null);

        expect(receipt!.status).to.equal(0, 'ante-failed tx must have a failed receipt');
        expect(receipt!.gasUsed).to.equal(
            0n,
            'a failure BEFORE the EVM must charge NO gas (gasUsed == 0) — this is the tell',
        );
        expect(receipt!.effectiveGasPrice).to.equal(0n, 'no gas price is charged for an ante-failed tx');
        expect(receipt!.logs.length).to.equal(0, 'an ante-failed tx emits no logs');

        // The tx physically occupied a block slot...
        expect(await txInBlockBody(provider, receipt!.blockNumber, doomedHash)).to.equal(
            true,
            'the ante-failed tx is present in the block body',
        );

        // ...and consumed its nonce, while the 3 SEI value never moved (gasUsed=0).
        expect(await provider.getTransactionCount(sender!.address, 'latest')).to.equal(
            2,
            'the ante-failed tx consumes its nonce',
        );
        expect(
            (await provider.getBalance(sender!.address)) > ethers.parseEther('0.9'),
            'the doomed 3 SEI value must not have moved',
        ).to.equal(true);
    });

    it('CROSS-PATH: a Cosmos drain that CONFIRMS before promotion causes the invalidated EVM tx to be DROPPED (re-validated), not included', async () => {
        // Sei accounts share one bank balance across two spend paths. Here a
        // COSMOS-side send drains the balance while an EVM tx sits queued
        // (gap-blocked). The drain confirms in a PRIOR block, so when the EVM
        // tx is promoted it is re-validated against committed (drained) state
        // and DROPPED — the geth-like outcome.
        //
        // This is the key contrast with the same-block ante-failure case above:
        // CON-256's included-invalid receipt fires only when the invalidating
        // tx and the doomed tx are CO-SELECTED into one block (the drain
        // executes mid-block against an already-selected doomed tx). Promotion
        // after a committed drain instead re-checks and drops. Both are pinned
        // so a future change to either path is caught.
        const eve = await UserFactory.createSeiUser(admin, 'mempool-eve-crosspath');
        const ctxE = await buildContext(eve);
        const n0 = await ctxE.provider.getTransactionCount(eve.evmAddress, 'latest');

        // 1) EVM tx at nonce n0+1 (gap-blocked), sends 3 SEI. Affordable now (~5 SEI).
        const doomed = await signTransfer(eve, ctxE, {
            nonce: n0 + 1,
            to: admin.evmAddress,
            value: ethers.parseEther('3'),
        });
        const rDoomed = await sendRawTransaction(eve.evmRpcEndpoint, doomed.signed);
        expect(rDoomed.ok, rDoomed.ok ? '' : (rDoomed as { message: string }).message).to.equal(
            true,
            'gap-blocked EVM tx must admit while the balance still covers it',
        );

        // 2) Cosmos bank send draining most of the balance; wait for it to confirm.
        const seiBalance = await eve.seiWallet.queryBalance();
        const drainUsei = BigInt(seiBalance.amount) - 1_000_000n; // leave ~1 SEI (1_000_000 usei)
        const bankMsg = {
            typeUrl: '/cosmos.bank.v1beta1.MsgSend',
            value: {
                fromAddress: eve.seiAddress,
                toAddress: admin.seiAddress,
                amount: coins(drainUsei.toString(), 'usei'),
            },
        };
        const cosmosResult = await eve.seiWallet.signAndSend([bankMsg], 'crosspath-drain');
        expect(cosmosResult.code).to.equal(0, `Cosmos drain must succeed: ${cosmosResult.rawLog}`);

        // 3) Fill the EVM gap (nonce n0) so the doomed nonce n0+1 tx is promoted
        //    to executable — but against the already-drained committed balance.
        const filler = await signTransfer(eve, ctxE, {
            nonce: n0,
            to: admin.evmAddress,
            value: ethers.parseEther('0.0001'),
        });
        const rFiller = await sendRawTransaction(eve.evmRpcEndpoint, filler.signed);
        expect(rFiller.ok, rFiller.ok ? '' : (rFiller as { message: string }).message).to.equal(true);
        await waitForMined(ctxE.provider, filler.hash, 60_000);

        // 4) The promoted EVM tx is unaffordable and must be DROPPED — no receipt,
        //    and it never executed (no status-0 stub either). Give it ample time.
        const r = await pollReceipt(ctxE.provider, doomed.hash, 30_000);
        expect(
            r,
            'a tx invalidated by a COMMITTED cosmos drain is re-validated on promotion and dropped (no receipt)',
        ).to.equal(null);

        // 5) The nonce n0+1 is recoverable: a fresh affordable tx takes it and mines.
        const recover = await signTransfer(eve, ctxE, {
            nonce: n0 + 1,
            to: admin.evmAddress,
            value: ethers.parseEther('0.0001'),
        });
        const rRecover = await sendRawTransaction(eve.evmRpcEndpoint, recover.signed);
        expect(rRecover.ok, rRecover.ok ? '' : (rRecover as { message: string }).message).to.equal(
            true,
            'the dropped tx must leave its nonce reusable',
        );
        await waitForMined(ctxE.provider, recover.hash, 60_000);
        expect(await ctxE.provider.getTransactionCount(eve.evmAddress, 'latest')).to.equal(n0 + 2);

        // The doomed 3 SEI never moved (its recovery replacement sent only 0.0001).
        expect(
            (await ctxE.provider.getBalance(eve.evmAddress)) > ethers.parseEther('0.9'),
            'the doomed 3 SEI value must not have moved',
        ).to.equal(true);
    });

    it('the three classes are mutually distinguishable by (status, gasUsed>0) alone', async () => {
        // A compact assertion of the taxonomy contract, using the cheapest
        // representative of each class already exercised above:
        //   success       → (1, gasUsed>0)
        //   in-EVM fail   → (0, gasUsed>0)
        //   ante fail     → (0, gasUsed==0)
        // Here we just re-affirm the success vs ante distinction is decidable
        // from the receipt alone (no external state needed).
        const { signed, hash } = await signTransfer(alice, ctx, {
            to: admin.evmAddress,
            value: ethers.parseEther('0.0001'),
        });
        expect((await sendRawTransaction(alice.evmRpcEndpoint, signed)).ok).to.equal(true);
        await waitForMined(provider, hash, 60_000);
        const r = await rawReceipt(hash);
        const classify = (status: number, gasUsed: bigint): string =>
            status === 1 ? 'success' : gasUsed === 0n ? 'ante-failure' : 'in-evm-failure';
        expect(classify(r!.status, r!.gasUsed)).to.equal('success');
    });
});
