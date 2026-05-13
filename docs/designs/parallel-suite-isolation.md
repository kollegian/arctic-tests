# Parallel suite isolation

**Status:** Draft — deferred until burndown lands at 0 failures.
**Date:** 2026-05-13

## Problem

The release-test suite runs sequentially in a single mocha process. Wall-clock today is ~50 min per nightly run (chain bootstrap ~7 min + suite ~45 min). Enabling `mocha --parallel` today would not work — multiple cross-suite state dependencies cause non-deterministic flakes:

- `bin/deploy-fixtures.ts` writes `tests/tokens/contractAddresses.json`, `tests/rpc_node_tests/contractAddresses.json`, and `config/mnemonics.json` once at process start. Spec files import these globally and share the same admin keyring, user pool, and contract addresses.
- Every fixture-mutating tx is `--from admin`. Two parallel workers signing as admin collide on cosmos sequence and EVM nonce.
- `users[0..9]` is a shared pool. Specs assume specific users are in specific states from prior tests.

## Direction

**Per-suite fixture isolation.** Each spec file owns its admin, users, and contracts. The global pre-suite fixture deploy is retired (or kept only for the `state-required` target).

Concretely:
- A `setupSuiteFixture(suiteId)` helper in `shared/` derives an admin sub-key from a master mnemonic (HD path keyed on `suiteId`), creates the users this suite needs, deploys the contracts this suite needs, and returns a `{admin, users, contracts}` bundle.
- Each spec's `before all` calls `setupSuiteFixture` and binds the returned bundle to its describe-block-scoped vars. No spec reads `contractAddresses.json` or `mnemonics.json` ever again.
- The orchestrator's `seictl nd apply --preset genesis-chain` extends `--genesis-account` to list either N per-suite admins (pre-derived) or one master admin who funds suite admins at runtime.
- `bin/release-test.ts` adds `parallel: true, jobs: N` once the substrate is safe.

## What changes

- New: `shared/SuiteFixture.ts` (or similar) with `setupSuiteFixture(suiteId)`.
- Modified: ~12–15 spec files (each one's `before all` hook). Mechanical.
- Modified: `bin/release-test.ts` to enable `--parallel` and pass `suiteId` to mocha workers.
- Modified: `bin/deploy-fixtures.ts` retired for `chain-agnostic` target.
- Modified: platform `orchestrate.sh` — `--genesis-account` list, no other shape change.

## What doesn't change

- No sei-chain primitive changes.
- No sei-k8s-controller / SeiNodeDeployment CRD changes.
- No new K8s parallelism patterns (Indexed Jobs, chain-per-shard) — single chain, single inner Job, mocha workers within one pod.
- `state-required` target (indexers, pectra_upgrade, disable_pointers) is untouched. Those tests intentionally read shared chain state.
- Intra-describe state accumulation (e.g., `solo.spec.ts` alice/bob CW20 choreography) stays — mocha's `--parallel` is file-level, so each describe is still serial within itself.

## Ceiling

Chain throughput caps practical parallelism at ~4–6 workers (mempool, 2-replica RPC fleet state-prop lag, validator block-size limits). Beyond that, RPC fleet `--replicas` would need to scale with worker count.

## Open questions

- **HD path scheme for per-suite admin derivation.** Pinning this is a one-way door if any future artifact references a suite admin address. Recommend deriving live each run; no pinning.
- **`config/mnemonics.json` retirement.** Suites manage their own user mnemonics in memory; the global file goes away. Any external tooling that reads it (PR debug helpers?) needs auditing.
- **RPC fleet horizontal scale > 4 replicas.** If we push to N > 4, confirm the SND RPC preset has no implicit single-instance assumptions.

## Trigger to start

- Burndown reaches 0 failures (clean baseline first; parallelism + active flakes are indistinguishable).
- A consumer requests faster cycle time (per-PR gate, release-blocker check) — currently the nightly cron is async, no user is waiting synchronously.

Until then, the current sequential shape is correct. Filed for pickup when the trigger fires.

## References

- Coral session 2026-05-13: `product-engineer`, `sei-network-specialist`, `kubernetes-specialist`, `product-manager` analysis.
- `bin/deploy-fixtures.ts`, `shared/User.ts`, `shared/Funder.ts`, `shared/Token.ts` (current fixture surface).
- `tests/precompiles/solo.spec.ts` (heavy intra-describe state consumer, fine as-is).
- platform PRs #500, #502, #504 (orchestrator wait + log streaming; prerequisites for any parallel rollout to be debuggable).
