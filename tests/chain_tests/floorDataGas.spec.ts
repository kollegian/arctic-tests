import {ethers} from "ethers";
import {SeiUser, UserFactory} from "../../shared/User";
import {EvmRpcClient} from "../../shared/RpcClient";
import {expect} from "chai";
import {waitFor} from "../../shared/utils/helpers";

// EIP-7623 (Pectra) charges calldata a floor price of 10 gas per token
// (zero byte = 1 token), enforced inside go-ethereum's Execute() — after
// Sei's ante checks, which validate only the EIP-2028 intrinsic cost
// (4 gas per zero byte). A tx whose gas limit sits between the two passes
// CheckTx, enters a block, then fails as a state-transition error before
// any opcode runs.
//
// This is the only known failure class that reaches that branch, and it is
// exactly where the giga executor historically diverged from v2:
//   - an early giga build dropped the receipt entirely, so
//     eth_getTransactionReceipt returned null forever;
//   - pre-fix giga stamped a full receipt (gasUsed=gasLimit, type=2,
//     populated effectiveGasPrice) while v2 writes its EndBlock synthetic
//     receipt with zeroed gas fields — an RPC-level divergence on mixed
//     fleets, fixed by routing these failures to the v2 fallback
//     (sei-chain#3768).
//
// This spec locks the canonical (v2) behavior at the RPC surface, so it
// fails against any executor that drifts from it regardless of which
// executor the serving node runs.
describe('EIP-7623 floor-data-gas failure semantics', function () {
    this.timeout(10 * 60 * 1000);

    // 1000 zero bytes: intrinsic (EIP-2028) = 21000 + 4*1000 = 25000,
    // floor (EIP-7623) = 21000 + 10*1000 = 31000. A 27500 gas limit clears
    // the ante's intrinsic check but fails the floor check inside Execute().
    const DATA = '0x' + '00'.repeat(1000);
    const GAS_LIMIT = 27_500n;

    let sender: SeiUser;
    let provider: ethers.JsonRpcProvider;
    let rpcClient: EvmRpcClient;
    let feePerGas: bigint;
    let txHash: string;
    let receipt: any;
    let nonceBefore: number;
    let balanceBefore: bigint;

    before('Initializes a dedicated funded user', async () => {
        const admin = await UserFactory.createAdminUser();
        // Fresh non-recorded user: the balance-delta assertion below must
        // see no transactions other than this spec's.
        [sender] = await UserFactory.createSeiUsers(admin, 1, false);
        provider = sender.evmWallet.signingClient;
        rpcClient = new EvmRpcClient(sender.evmRpcEndpoint, provider);
    });

    it('passes CheckTx and lands on-chain with a failed receipt', async () => {
        const feeData = await provider.getFeeData();
        // tip == feeCap pins the effective gas price to exactly feePerGas
        // (min(baseFee + tip, feeCap) == feeCap when tip == feeCap), making
        // the fee-charge assertion deterministic. Doubled for base-fee headroom.
        feePerGas = (feeData.maxFeePerGas ?? feeData.gasPrice!) * 2n;
        nonceBefore = await provider.getTransactionCount(sender.evmAddress);
        balanceBefore = await provider.getBalance(sender.evmAddress);

        const signedTx = await sender.evmWallet.wallet.signTransaction({
            to: ethers.getAddress('0x' + '12'.repeat(20)),
            value: 0,
            data: DATA,
            gasLimit: GAS_LIMIT,
            maxFeePerGas: feePerGas,
            maxPriorityFeePerGas: feePerGas,
            nonce: nonceBefore,
            chainId: (await provider.getNetwork()).chainId,
            type: 2,
        });
        // Must be accepted by the mempool: the ante validates intrinsic gas
        // only, so the floor deficit is invisible until DeliverTx.
        txHash = await rpcClient.sendRawTransaction(signedTx);
        expect(txHash).to.match(/^0x[0-9a-f]{64}$/i);

        // Regression guard: giga once wrote no receipt at all for this
        // class, hanging any client that polls for it.
        const deadlineMs = Date.now() + 30_000;
        while (Date.now() < deadlineMs) {
            try {
                receipt = await rpcClient.getTransactionReceipt(txHash);
                if (receipt) break;
            } catch (e: any) {
                // A transient HTTP/JSON-RPC fault must not abort the poll —
                // the tx may already be mined; retry until the deadline.
                console.warn(`receipt poll error (retrying): ${e?.message ?? e}`);
            }
            await waitFor(0.5);
        }
        expect(receipt, `receipt not produced within 30s for txHash=${txHash}`).to.not.be.null;
        expect(Number(receipt.status),
            'expected floor-data-gas failure (status=0) — is EIP-7623 (Pectra) active on this chain?'
        ).to.equal(0);
    });

    it('returns the canonical v2 failure receipt (executor parity, sei-chain#3768)', async () => {
        // v2 records this failure via its EndBlock synthetic receipt, which
        // zeroes the gas fields. Pre-#3768 giga returned gasUsed=gasLimit,
        // type=2, and a populated effectiveGasPrice for the same tx — the
        // mixed-fleet RPC divergence #3768 fixed. A mismatch here means the
        // serving node's executor drifted from canonical v2 behavior.
        expect(BigInt(receipt.gasUsed), 'gasUsed').to.equal(0n);
        expect(Number(receipt.type), 'type').to.equal(0);
        expect(BigInt(receipt.effectiveGasPrice), 'effectiveGasPrice').to.equal(0n);
        expect(receipt.logs ?? [], 'logs').to.have.length(0);
    });

    it('bumps the sender nonce exactly once', async () => {
        const nonceAfter = await provider.getTransactionCount(sender.evmAddress);
        expect(nonceAfter).to.equal(nonceBefore + 1);
    });

    it('charges the full gas-limit fee with no refund', async () => {
        // The ante charges gasLimit * effectiveGasPrice up front and the
        // failed message never refunds, on both executors (value untouched).
        const balanceAfter = await provider.getBalance(sender.evmAddress);
        expect(balanceBefore - balanceAfter).to.equal(GAS_LIMIT * feePerGas);
    });
});
