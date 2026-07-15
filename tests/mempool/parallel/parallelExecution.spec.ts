import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { waitForMined } from '../helpers/waitFor';
import ERC20_ARTIFACT from '../../../artifacts/contracts/TestERC20.sol/TestERC20.json';

/**
 * Sei executes non-conflicting txs in parallel (OCC). From outside the chain
 * we can only assert this indirectly:
 *
 *   1. Two senders whose state writes don't overlap can both be included in
 *      the same block when the mempool serves them together.
 *   2. The block's `gasUsed` is consistent (sum of per-tx gasUsed) even if the
 *      txs were executed concurrently.
 *
 * We don't try to assert *true* parallelism (that requires node metrics); we
 * just assert that batched execution doesn't violate any externally observable
 * invariants and that two-sender blocks are achievable.
 */
describe('Mempool / Parallel / Disjoint senders co-located in same block', function () {
    this.timeout(180_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let bob: SeiUser;
    let provider: ethers.JsonRpcProvider;
    let ctxA: BuildContext;
    let ctxB: BuildContext;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-par');
        bob = await UserFactory.createSeiUser(admin, 'mempool-bob-par');
        ctxA = await buildContext(alice);
        ctxB = await buildContext(bob);
        provider = ctxA.provider;
    });

    it('two senders writing to disjoint accounts can land in the same block', async () => {
        // No skip fallback: two simultaneous submissions on a sub-second chain
        // must co-locate within a few attempts, or scheduling is broken.
        const attempts = 4;
        let coLocated = false;

        for (let attempt = 0; attempt < attempts && !coLocated; attempt++) {
            const { signed: sA, hash: hA } = await signTransfer(alice, ctxA, {
                to: ethers.Wallet.createRandom().address,
            });
            const { signed: sB, hash: hB } = await signTransfer(bob, ctxB, {
                to: ethers.Wallet.createRandom().address,
            });

            const [rA, rB] = await Promise.all([
                sendRawTransaction(alice.evmRpcEndpoint, sA),
                sendRawTransaction(bob.evmRpcEndpoint, sB),
            ]);
            expect(rA.ok && rB.ok).to.equal(true);

            const [recA, recB] = await Promise.all([
                waitForMined(provider, hA, 60_000),
                waitForMined(provider, hB, 60_000),
            ]);
            expect(recA?.status).to.equal(1);
            expect(recB?.status).to.equal(1);

            if (Number(recA!.blockNumber) === Number(recB!.blockNumber)) {
                const block = await provider.getBlock(recA!.blockNumber, true);
                expect(block).to.not.equal(null);
                const sumGas = Number(recA!.gasUsed) + Number(recB!.gasUsed);
                // Block gasUsed must be AT LEAST the sum of these two txs.
                expect(Number(block!.gasUsed)).to.be.gte(sumGas);
                coLocated = true;
            }
        }

        expect(coLocated).to.equal(
            true,
            `two simultaneously submitted disjoint txs never co-located in one block across ${attempts} attempts`,
        );
    });

    it('two senders writing to the SAME storage slot (one recipient balance) both succeed with a consistent result', async () => {
        // A real write-write conflict for OCC: both senders transfer the same
        // ERC20 to the SAME recipient, so both txs write the recipient's
        // balance slot. We don't predict which executes first, but we assert:
        //   - Both receipts succeed (the conflict is re-executed, not dropped)
        //   - The final recipient balance equals the sum of both transfers
        //   - If co-located in one block, their indices are distinct
        const erc20 = await (async () => {
            const factory = new ethers.ContractFactory(
                ERC20_ARTIFACT.abi,
                ERC20_ARTIFACT.bytecode,
                alice.evmWallet.wallet,
            );
            const contract = await factory.deploy(alice.evmAddress);
            await contract.waitForDeployment();
            return new ethers.Contract(
                await contract.getAddress(),
                ERC20_ARTIFACT.abi,
                alice.evmWallet.wallet,
            );
        })();

        const amount = ethers.parseEther('1');
        await (await erc20.mint(alice.evmAddress, amount)).wait();
        await (await erc20.mint(bob.evmAddress, amount)).wait();

        const recipient = ethers.Wallet.createRandom().address;
        const data = erc20.interface.encodeFunctionData('transfer', [recipient, amount]);
        const erc20Addr = await erc20.getAddress();

        // Generous gas limit: TestERC20's _update override tracks first-time
        // holders (array push + mapping write) on top of pausable/permit
        // overhead, so a fresh-recipient transfer costs well above a vanilla
        // ERC20 transfer.
        const { signed: sA, hash: hA } = await signTransfer(alice, ctxA, {
            to: erc20Addr,
            data,
            value: 0n,
            gasLimit: 400_000n,
        });
        const { signed: sB, hash: hB } = await signTransfer(bob, ctxB, {
            to: erc20Addr,
            data,
            value: 0n,
            gasLimit: 400_000n,
        });

        const [rA, rB] = await Promise.all([
            sendRawTransaction(alice.evmRpcEndpoint, sA),
            sendRawTransaction(bob.evmRpcEndpoint, sB),
        ]);
        expect(rA.ok && rB.ok).to.equal(true);

        const [recA, recB] = await Promise.all([
            waitForMined(provider, hA, 90_000),
            waitForMined(provider, hB, 90_000),
        ]);
        expect(recA?.status).to.equal(1, 'conflicting write A must still succeed');
        expect(recB?.status).to.equal(1, 'conflicting write B must still succeed');

        if (Number(recA!.blockNumber) === Number(recB!.blockNumber)) {
            expect(Number(recA!.index)).to.not.equal(Number(recB!.index));
        }

        // Neither write may be lost: the recipient holds the sum.
        const finalBalance = (await erc20.balanceOf(recipient)) as bigint;
        expect(finalBalance).to.equal(amount * 2n);
    });
});
