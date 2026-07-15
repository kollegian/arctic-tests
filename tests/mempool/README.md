# Sei mempool e2e tests

End-to-end tests for Sei's mempool semantics — admission rules (CheckTx), per-sender nonce ordering, cross-sender priority, RPC surface (`txpool_*`, `pending` blockTag, subscriptions), dual-pool coherency between the Tendermint mempool and the EVM `txpool` view, Sei-specific behaviors, capacity & TTL eviction, and cross-node propagation.

## Running

```bash
# All testnet-safe categories:
npm run test:mempool

# Multi-node broadcast tests run automatically when config has >= 2 nodes.
# See "Multi-node config" below.

# Local-node-only categories (capacity, TTL) require LOCAL_CHAIN=1.
# See "Local chain harness" below.
LOCAL_CHAIN=1 LOCAL_CHAIN_BOOTSTRAP=./scripts/local-chain-bootstrap.sh \
    npm run test:mempool
```

Report lands at `reports/mempool/mempool-report.{html,json}` and is folded into the combined report via `npm run test:reports:merge`.

## Categories

| Folder           | What it covers                                                                                            | Where it runs                                       |
| ---------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `admission/`     | CheckTx-time rejections: signature, fee, intrinsic gas, balance, nonce, chainId, size. Nonce queueing.    | Shared testnet (works against any live Sei chain).  |
| `ordering/`      | Cross-sender priority ordering, per-sender nonce monotonicity, replacement-by-fee.                        | Shared testnet (some tests self-skip on flakes).    |
| `parallel/`      | OCC parallel-execution observable invariants (co-located disjoint senders, RAW conflict determinism).      | Shared testnet.                                     |
| `rpc_surface/`   | `txpool_content` / `txpool_status` / `txpool_contentFrom` / `txpool_inspect`, `pending` blockTag, `eth_subscribe('newPendingTransactions')`. | Shared testnet.            |
| `coherency/`     | EVM-side `txpool_content` vs. Tendermint `/unconfirmed_txs` invariants.                                   | Shared testnet.                                     |
| `sei_specific/`  | `sei_getCosmosTx` for pending EVM hash, pending balance crossover, EIP-7702 admission.                    | Shared testnet (self-skips when feature absent).    |
| `broadcast/`     | Cross-node gossip: tx submitted to node A visible on node B; all nodes mine in same block.                | Multi-node only; otherwise skipped with reason.     |
| `capacity/`      | `mempool.size` cap, EVM `pending-size` pool fill, tip-based eviction.                                     | Local-only via `LOCAL_CHAIN=1`.                     |
| `ttl/`           | `ttl-num-blocks` eviction of queued (gap-blocked) txs, retry-after-TTL.                                   | Local-only via `LOCAL_CHAIN=1`.                     |
| `negative/`      | Malformed RLP, truncated payloads, CheckTx-passed-but-DeliverTx-reverts pool clearing.                    | Shared testnet.                                     |

## Multi-node config

The `broadcast/` suite needs at least two RPC endpoints pointing at distinct Sei nodes in the same network. Add an optional `mempoolNodes` field to `config/testConfig.json`:

```json
{
  "adminAddress": "...",
  "seiRpcEndpoint": "https://node-a/tm",
  "evmRpcEndpoint": "https://node-a/evm",
  "restEndpoint":   "https://node-a/cosmos",
  "adminMnemonic":  "...",
  "mempoolNodes": [
    { "evmRpcEndpoint": "https://node-a/evm", "seiRpcEndpoint": "https://node-a/tm" },
    { "evmRpcEndpoint": "https://node-b/evm", "seiRpcEndpoint": "https://node-b/tm" }
  ]
}
```

When `mempoolNodes` is missing or has fewer than 2 entries, the broadcast suite skips with a clear reason in the mochawesome report.

## Local chain harness

Categories `capacity/` and `ttl/` cannot be tested against a shared testnet — you don't control `mempool.size`, and other traffic drowns the eviction/TTL signals. The harness in `helpers/localChain.ts` spawns a local `seid` node with overridden mempool config.

Requirements:

1. `seid` binary on `PATH`.
2. A bootstrap script that prepares genesis for the tmp home directory (this is environment-specific — keys, genesis, gentx, collect-gentxs). The harness invokes it via `LOCAL_CHAIN_BOOTSTRAP=...` and passes `$SEID_HOME`, `$CHAIN_ID`, `$MONIKER`. The bootstrap **must not** start the node — only finalize genesis.

Then:

```bash
LOCAL_CHAIN=1 \
LOCAL_CHAIN_BOOTSTRAP=./scripts/local-chain-bootstrap.sh \
    npm run test:mempool
```

Without `LOCAL_CHAIN=1`, the local-only suites self-skip with a reason — the rest of `test:mempool` still runs normally against the configured testnet.

## Authoring notes for adding new mempool tests

- **Assert the blockchain-first expected behavior (geth reference semantics), not observed Sei behavior.** No `if (...) this.skip()` guards, no "accept either outcome" branches. If Sei deviates behaviorally, the test FAILS — that failure is a finding to report to the chain team, never something to silently absorb into the test. Flakiness is addressed by making the scenario deterministic (see below), not by skipping.
- **One sanctioned exception (team decision, 2026-07-10): UNIMPLEMENTED RPC methods.** When the node answers with its method-missing signature (JSON-RPC `-32601` / "not enabled on this node"), the test may skip via `isMethodUnavailable` from `helpers/rpcSupport.ts` — the suite tracks behavior divergences, not RPC surface inventory. Any other error still fails, and the skip auto-deactivates once the method ships.
- Use `sendRawTransaction` from `helpers/rawTxSender.ts` to capture the **synchronous** CheckTx error. Don't rely on ethers' send wrappers — they flatten error structure and we need the JSON-RPC error code/message verbatim.
- For "tx is in the pool right now" assertions, prefer a **gap-blocked tx** (it cannot mine, so pool reads are race-free); fill the gap afterwards so nothing lingers. For executable txs, use `waitForTxpool` / `waitUntil` polling rather than a single read.
- For invariants that require controlled mempool config, gate behind `LOCAL_CHAIN=1` via `describeLocalOnly`; for multi-node gossip, `describeMultiNode`. These environment gates are the only acceptable skips.
