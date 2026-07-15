import { ethers } from 'ethers';
import { expect } from 'chai';

import { SeiUser, UserFactory } from '../../../shared/User';
import { sendRawTransaction } from '../helpers/rawTxSender';
import { BuildContext, buildContext, signTransfer } from '../helpers/txFactory';
import { fetchTxpoolContent } from '../helpers/txpoolView';
import { waitForMined } from '../helpers/waitFor';

/**
 * Pure error-path and reverted-but-included behavior.
 */
describe('Mempool / Negative / Malformed payloads + DeliverTx reverts', function () {
    this.timeout(120_000);

    let admin: SeiUser;
    let alice: SeiUser;
    let ctx: BuildContext;
    let provider: ethers.JsonRpcProvider;

    before(async () => {
        admin = await UserFactory.createAdminUser();
        alice = await UserFactory.createSeiUser(admin, 'mempool-alice-neg');
        ctx = await buildContext(alice);
        provider = ctx.provider;
    });

    it('garbage hex is rejected with a JSON-RPC error (no crash)', async () => {
        const result = await sendRawTransaction(alice.evmRpcEndpoint, '0xdeadbeef');
        expect(result.ok).to.equal(false);
    });

    it('empty payload is rejected', async () => {
        const result = await sendRawTransaction(alice.evmRpcEndpoint, '0x');
        expect(result.ok).to.equal(false);
    });

    it('a truncated signed tx (missing last 4 bytes) is rejected', async () => {
        const { signed } = await signTransfer(alice, ctx);
        const truncated = signed.slice(0, -8);

        const result = await sendRawTransaction(alice.evmRpcEndpoint, truncated);
        expect(result.ok).to.equal(false);
    });

    it('a valid signed tx with trailing garbage bytes is rejected (strict RLP framing)', async () => {
        const nonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const { signed } = await signTransfer(alice, ctx);
        const padded = signed + 'deadbeef';

        const result = await sendRawTransaction(alice.evmRpcEndpoint, padded);
        expect(result.ok).to.equal(false);

        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore, 'the embedded valid tx must not be salvaged and executed');
    });

    it('a non-hex params payload is rejected with a JSON-RPC error', async () => {
        const result = await sendRawTransaction(
            alice.evmRpcEndpoint,
            'this-is-not-hex-at-all',
        );
        expect(result.ok).to.equal(false);
        expect((result as { message: string }).message.length).to.be.greaterThan(0);
    });

    it('a reserved envelope byte (0x7f) followed by well-formed RLP is rejected', async () => {
        const result = await sendRawTransaction(alice.evmRpcEndpoint, '0x7fc0');
        expect(result.ok).to.equal(false);
    });

    it('a DeliverTx failure (INVALID opcode) still burns the nonce and charges gas up to the limit', async () => {
        // Deploy the smallest possible always-failing contract: runtime code is
        // the single INVALID (0xFE) opcode, so any call consumes ALL gas.
        const feeData = await provider.getFeeData();
        const deployNonce = await provider.getTransactionCount(alice.evmAddress, 'pending');
        const deploySigned = await alice.evmWallet.wallet.signTransaction({
            type: 2,
            chainId: ctx.chainId,
            nonce: deployNonce,
            to: null,
            value: 0n,
            data: '0x60fe60005360016000f3', // returns runtime 0xFE
            gasLimit: 100_000n,
            maxFeePerGas: (feeData.maxFeePerGas ?? 1_000_000_000n) * 2n,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 100_000_000n,
        });
        const deployHash = ethers.Transaction.from(deploySigned).hash!;
        const deploySent = await sendRawTransaction(alice.evmRpcEndpoint, deploySigned);
        expect(deploySent.ok).to.equal(true);
        const deployReceipt = await waitForMined(provider, deployHash, 60_000);
        expect(deployReceipt?.status).to.equal(1);
        const target = deployReceipt!.contractAddress!;
        expect(await provider.getCode(target)).to.equal('0xfe');

        const nonceBefore = await provider.getTransactionCount(alice.evmAddress, 'latest');
        const balBefore = await provider.getBalance(alice.evmAddress);
        const gasLimit = 100_000n;

        const { signed, hash } = await signTransfer(alice, ctx, {
            to: target,
            value: 0n,
            gasLimit,
        });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, 'the failing call must still pass CheckTx').to.equal(true);

        const receipt = await waitForMined(provider, hash, 60_000);
        expect(receipt?.status).to.equal(0, 'INVALID opcode must revert the call');
        expect(receipt?.gasUsed).to.equal(gasLimit, 'INVALID consumes the whole gas limit');

        // The failure happened in DeliverTx, not CheckTx: nonce and fee are spent.
        expect(
            await provider.getTransactionCount(alice.evmAddress, 'latest'),
        ).to.equal(nonceBefore + 1, 'a reverted-but-included tx must burn its nonce');
        const balAfter = await provider.getBalance(alice.evmAddress);
        expect(balBefore - balAfter).to.equal(
            receipt!.gasUsed * receipt!.gasPrice,
            'the sender pays exactly gasUsed * effectiveGasPrice, nothing else',
        );
    });

    it('a tx that passes CheckTx but reverts in DeliverTx clears from the mempool with status=0', async () => {
        // Build a tx that calls a non-existent address with `data` that will
        // be interpreted as a function call. Calling code that doesn't exist
        // returns no data and status=1 actually. Use a different revert path:
        // call a contract whose fallback reverts. Deploy a small revert-on-call
        // contract from alice.
        const ReverterAbi = ['function go() public'];
        const ReverterBytecode =
            '0x6080604052348015600f57600080fd5b50609a8061001e6000396000f3fe6080604052348015600f57600080fd5b5060003610603657604051630e1c1ad760e21b815260040160405180910390fd5b005b' +
            '6000fd';
        const factory = new ethers.ContractFactory(
            ReverterAbi,
            ReverterBytecode,
            alice.evmWallet.wallet,
        );
        const contract = await factory.deploy();
        await contract.waitForDeployment();
        const addr = await contract.getAddress();

        const iface = new ethers.Interface(ReverterAbi);
        const data = iface.encodeFunctionData('go', []);

        const { signed, hash } = await signTransfer(alice, ctx, {
            to: addr,
            data,
            gasLimit: 200_000n,
        });
        const sent = await sendRawTransaction(alice.evmRpcEndpoint, signed);
        expect(sent.ok, sent.ok ? '' : (sent as { message: string }).message).to.equal(
            true,
            'tx should pass CheckTx even though it will revert in DeliverTx',
        );

        const receipt = await waitForMined(provider, hash, 90_000);
        expect(receipt?.status).to.equal(0, 'expected DeliverTx revert');

        // After inclusion, the tx must not be in the mempool anymore.
        const content = await fetchTxpoolContent(provider);
        const present = Object.keys(content.pending).some((s) =>
            Object.values(content.pending[s]).some(
                (tx) => (tx as { hash?: string }).hash?.toLowerCase() === hash.toLowerCase(),
            ),
        );
        expect(present).to.equal(false);
    });
});
