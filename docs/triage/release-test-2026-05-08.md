# Release-Test Failure Triage — chain-agnostic target

**Run:** `release-test-partition-verify-20260508-155218`
**Inner test job:** `release-test-20260508-225223`
**Image:** `416ff79daf862df83a89db3fc4bf9f094673289d`
**Target:** `chain-agnostic` (state-required tests filtered per #49 + #50)
**Final tally:** `passed: 420 / failed: 231 / pending: 21`
**Date:** 2026-05-08

## Methodology

Four specialists reviewed the failure list independently — solidity-developer, product-engineer, sei-network-specialist, platform-engineer. Each had the same input (failure list, run log, source tree) and produced an independent categorization. State-required candidates were flagged-for-cross-review rather than auto-confirmed. This document is the synthesis: only entries with reviewer consensus land as concrete decisions.

The headline finding is that **the 231 failures collapse to ~10 root causes**. Most aren't independent bugs — they're cascades from a small set of harness-wiring and test-architecture issues.

## Bucket counts (synthesized)

| Bucket | Count | Notes |
|---|---|---|
| **harness-wiring** | ~150 | Setup specs don't run, env vars not set, broadcast-mode regression. Fix at orchestrator/runner layer. |
| **test-bug** | ~50 | Logic errors, undefined identifiers, hardcoded magic numbers, brittle error-string matches. |
| **flake** | ~10 | Parallel-worker race on shared chain state, indexer lag, EIP-1559 base-fee math under load. |
| **state-coupled** (genuine, missed in initial Bucket 3) | 0 | All four reviewers converged: no test in this run's failures genuinely requires pre-existing chain state once the harness wiring is fixed. |
| **ambiguous** | ~6 | Need stack traces from end-of-run mochawesome JSON to resolve. |

The harness-wiring bucket dominates. **The chain-agnostic suite is much closer to a green build than the raw 231 fail count suggests.**

## Root-cause clusters

Listed by leverage. Each cluster has reviewer-agreement signal: ✅ = all four reviewers; 3/4 = three reviewers caught it independently.

### 1. Setup specs never run — `startTests.ts` filename mismatch ✅

Mocha's spec glob is `tests/**/*.spec.ts`. The setup files that deploy ERC20/CW20/CW721/Debug contracts and rewrite `contractAddresses.json` are named `startTests.ts` — **they don't match the glob**. Mocha silently skips them. Every consumer reads the stale repo-committed JSON (with mainnet/testnet contract addresses) and dials non-existent contracts on the fresh ephemeral chain.

`eth_call` to a non-existent contract returns `0x` (no revert), so "should reject invalid call data" tests see success and fail their negative assertion. `balanceOf` returns `0n` on every address, breaking balance comparisons. The cascade is uniform across these files:

- `tests/rpc_node_tests/debug.spec.ts` (35 tests)
- `tests/rpc_node_tests/eth_call.spec.ts` (16 tests)
- `tests/rpc_node_tests/eth_getBlockByNumber.spec.ts` (23 tests)
- `tests/rpc_node_tests/eth_getLogs.spec.ts` (33 tests)
- `tests/rpc_node_tests/sei_getLogs.spec.ts` (7 tests)
- `tests/rpc_node_tests/eth_getTransactionReceipt.spec.ts` (cascade)
- `tests/tokens/erc20_refactored.spec.ts` (23 tests)
- `tests/tokens/cw20_refactored.spec.ts` (20 tests)
- `tests/tokens/cw721_refactored.spec.ts` (20 tests)

**Total: ~140-180 failures.** Single root cause.

A subtler aggravator product-engineer caught: consumer specs `import` the JSON at parse-time. Even if `startTests.ts` rewrote it mid-run, mocha's module cache would hold the stale snapshot. So the fix has to land before any consumer spec is parsed.

**Fix shape (recommended):**
- Rename `startTests.ts` → `startTests.spec.ts` so it joins the glob, OR
- Add `--file tests/tokens/startTests.ts --file tests/rpc_node_tests/startTests.ts` to the mocha invocation (mocha runs `--file` args before regular specs), OR
- Move setup into the orchestrator: deploy contracts in a Job before the test pod starts, write addresses into a ConfigMap mounted into the test pod (most robust; survives test-repo refactors).

Issue to file: see Action Items below.

### 2. `SEI_REST_ENDPOINT` is read but never set ✅ (platform-engineer's find)

`bin/release-test.ts` reads `process.env.SEI_REST_ENDPOINT` and overlays `config.restEndpoint`, but the orchestrator (`clusters/harbor/nightly/release/configmap.yaml`) only sets `SEI_TENDERMINT_RPC` and `SEI_EVM_JSON_RPC`. Static fallback in `config/testConfig.json` is `https://testnet-1.release-6-4.dev.platform.sei.io/tm` — **an external testnet**.

Every test calling `User.associate()`, `Querier.evm.EVMAddressBySeiAddress`, or any cosmjs LCD/REST query is dialing the wrong chain. If that endpoint is up, tests read state from a different chain ID. If it's down, the call fails with an HTTP 5xx — which doesn't match the harness's narrow infra-signal filter (`ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN`), so the failure leaks through as a test failure.

Affected: `addr` precompile tests (~6), `sei_getSeiAddress`/`sei_getEVMAddress` (2), and the broader `User.associate()` flow underlying many other tests.

**Fix:**
- Orchestrator queries `seictl nd get $RPC_NAME -o jsonpath='{.status.endpoints.lcd[0]}'` (or whatever the SND status field is for LCD/REST) and adds `SEI_REST_ENDPOINT` env var to the inner test pod.
- If the SND status doesn't expose an LCD endpoint, that's a separate issue worth filing on the controller.

### 3. `--broadcast-mode block` removed in cosmos-sdk 0.50+ (3/4 reviewers)

Used in `shared/utils/cliUtils.ts:19`, `tests/precompiles/tokenfactory.spec.ts` (multiple sites), `tests/precompiles/bank_precompile.spec.ts`. The harness's seid binary is post-0.50; `--broadcast-mode block` either errors or silently downgrades to `sync`, returning before tx commits. Subsequent balance reads find no minted tokens.

Affected: ~14 TokenFactory tests, Bank Precompile `before all` (cascade), Pointer/PointerView setup hooks.

**Fix:** sed replace `--broadcast-mode block` → `--broadcast-mode sync` and add a deterministic poll for tx inclusion. Could be wrapped in `seidExec` (already the chokepoint per qa-testing#46/#48).

### 4. `gov.spec.ts` is dead code (solidity-developer + sei-network-specialist)

The file references undefined identifiers — `owner`, `voter3`, `nonVoter` are never declared (lines 294, 330, 406, 475). It does not compile in TS strict mode and has never run end-to-end. It also defines a duplicate `describe('Gov Precompile Tests')` that races with `gov_refactored.spec.ts` for proposal IDs under `--parallel`.

The `Voting Tests` inner `before` calls `govContract.getProposal(proposalId)` but `proposalId` is declared `let proposalId: bigint` and never assigned — every dependent test cascades.

Affected: ~11 fails (`should fail depositing zero tokens`, `should cast a YES vote`, all weighted-vote / quorum tests, `Gov Precompile Tests` before-all hook).

**Fix:** delete `gov.spec.ts` outright. `gov_refactored.spec.ts` is the working replacement.

### 5. Users not auto-associated (solidity-developer)

`UserFactory.createSeiUsers` funds users but doesn't send an `associate()` call. The `addr` precompile and `sei_getSeiAddress`/`sei_getEVMAddress` tests rely on association having occurred.

Affected: 6 `addr` precompile tests + 2 sei_get* tests.

**Fix:** add `associate()` to `UserFactory.createSeiUsers` after funding (preferred — ephemeral-friendly and matches what the tests already assume), OR add `associate()` in the addr-precompile suite's `before` hook.

### 6. Mnemonic users have non-zero genesis balance (solidity-developer)

`tests/solo_evm/rpc_tests/state_endpoints/eth_getBalance.spec.ts` asserts `balance at block 0 === 0n` and `balance at "earliest" === 0n` for users created from `config/mnemonics.json`. Those mnemonics may be pre-allocated funds in the harness genesis config.

Affected: ~3 fails (`returns zero balance at genesis`, `returns zero balance with "earliest" tag`, `queries balance with "earliest" tag returns zero`).

**Fix:** harness genesis should not pre-allocate to test mnemonics — users get funded from `admin` post-chain-start. Alternative: tests could create fresh `ethers.Wallet.createRandom()` users instead of reading mnemonics.

### 7. Newly-created users have no usei for CLI fees (solidity-developer + platform-engineer)

`UserFactory.createSeiUsers` funds via EVM (gives users wei) but doesn't send usei. Tests that `seid tx tokenfactory create-denom --from alice --fees 24200usei` fail at fee deduction. Cascades through tokenfactory + bank_precompile + pointer setups.

Affected: ~17 fails.

**Fix:** in `UserFactory.createSeiUsers`, send a small usei top-up via `admin` so newly-created users can pay seid CLI fees. Or (cleaner) the Funder helper handles both EVM and cosmos funding.

### 8. RPC error-string brittleness in solo_evm (product-engineer)

`expect(e.message).to.include('invalid')` / `'not found'` / `'execution reverted'` is fragile to any RPC server-side wording change. Tests should match on `e.code === 'CALL_EXCEPTION'` or `code === 'INVALID_ARGUMENT'`.

Affected: ~20 fails in `tests/solo_evm/rpc_tests/state_endpoints/`.

**Fix:** loosen string-match assertions to code-based assertions. Per-test edits, mostly mechanical.

### 9. EIP-1559 base-fee math hardcoded to Ethereum (sei-network-specialist + solidity-developer)

`tests/chain_tests/gasTests.spec.ts:275-296` uses Geth's denominator (8) and assumes elasticity = 2 / target = parent.gasLimit/2. Sei has its own `BaseFeeChangeDenominator` and gas-target params.

Affected: 2 fails (`Users can send type 2 txs with high gas limit and base gas fee matches expectation`, sibling).

**Fix:** read `gasUsed`/`gasLimit`/`elasticity`/`baseFeeChangeDenominator` from chain genesis params; compute target dynamically. This is also a parallel-worker race amplifier — other workers' txs perturb the next block's gas usage.

### 10. `debug_traceCall` state-override + `pending` block tag — Sei capability (solidity-developer)

Tests in `tests/solo_evm/rpc_tests/debug_endpoints/debug_traceCall.spec.ts` pass a 4th `stateOverrides` arg or use `pending` block tag. Sei's debug API may not implement these geth extensions.

Affected: 4 fails.

**Fix:** verify Sei capability; if unimplemented, mark the tests `it.skip` with a tracking comment or move to `state-required` since they need a chain that supports state-override.

## Sei-specific signals worth investigating (sei-network-specialist)

These appeared as flake-shaped but are worth a Sei-side review rather than ignoring:

- **`finalized`/`safe`/`pending` block-tag semantics** on a chain with <2000 blocks finalized. Sei aliases `safe = finalized = latestCommit`; `pending` in dual-runtime is weakly defined. Tests that iterate `['latest','finalized','safe','pending']` need to either skip the underdefined tags or wait for chain to mature.
- **`sei_get*` indexer lag** — `waitFor(1)` (1 second wall-clock) is insufficient on slow block times. Several `sei_get*` tests fail because the cosmos-side indexer hasn't yet caught up to an EVM tx.
- **Distribution rewards lifecycle** — depends on validator block-production tempo. On a fresh chain with small staked supply, rewards accrue more slowly than the test's hardcoded timeout.

## Cross-review divergence resolution

The four reviewers had **one substantive disagreement on action**:

- **solidity-developer + product-engineer + platform-engineer:** *fix the harness wiring* (don't tag tests as state-required).
- **sei-network-specialist:** *tag the contractAddresses.json-cascading suites as `@state-required`* (operational quarantine).

**Resolution:** the consensus position holds. The reason these tests look state-coupled is that mocha skips the deploy step (`startTests.ts` filename mismatch) — so the harness silently provides *stale* state. Once the deploy step actually runs, the tests are chain-agnostic by design. Tagging them `@state-required` would mask a fixable wiring bug. **No new `@state-required` tags should be added from this run's failures.**

The genuine `@state-required` tags landed in qa-testing#50 (`tests/indexers/`, `tests/rpc_node_tests/eth_subscribe.spec.ts`, `tests/chain_tests/pectra_upgrade/EOA.spec.ts`, `tests/tokens/disable_pointers.spec.ts`).

## Action items (issues to file)

In leverage order. Cluster numbers map to the root-cause sections above.

| # | Issue | Cluster | Estimated test recovery |
|---|---|---|---|
| 1 | `startTests.ts` not picked up by mocha glob | 1 | ~140-180 |
| 2 | `SEI_REST_ENDPOINT` env var not set in orchestrator | 2 | ~10-15 |
| 3 | `--broadcast-mode block` removed in cosmos-sdk 0.50+ | 3 | ~14 |
| 4 | Delete `gov.spec.ts` (dead code, undefined identifiers) | 4 | ~11 |
| 5 | Users not auto-associated by `UserFactory.createSeiUsers` | 5 | ~8 |
| 6 | Mnemonic users get genesis-allocated funds | 6 | ~3 |
| 7 | Newly-created users have no usei for CLI fees | 7 | ~17 |
| 8 | RPC error-string brittleness in solo_evm tests | 8 | ~20 |
| 9 | EIP-1559 base-fee math hardcoded to Ethereum params | 9 | ~2-4 |
| 10 | `debug_traceCall` state-override / `pending` capability | 10 | ~4 |

**Top three fixes (1-3) recover an estimated 165-210 of 231 failures.** That's the realistic short-term burndown.

## Ambiguous (needs more data)

| Test name | File | What additional data would resolve |
|---|---|---|
| 5 distribution log-query tests | `tests/precompiles/distribution.spec.ts:369-432` | Stack trace from end-of-run JSON. Whether `getLogs` errors or `parseLog` throws inside the loop. |
| `Eth get block by number matches with sei getBlock by Number` | `tests/rpc_node_tests/eth_getBlockByNumber.spec.ts` | Likely cluster-1 cascade; possibly Sei RPC parity issue. |
| `Sei get logs supports finalized, safe, latest, pending tags` | `tests/rpc_node_tests/sei_getLogs.spec.ts` | Likely cluster-1 cascade; possibly block-tag finalization on young chain. |
| `Eth get logs tx indexes alongside with log indexes return correct data` | `tests/rpc_node_tests/eth_getLogs.spec.ts:367` | Same. |
| `Can return txs successfully for a span of 100 blocks` | `tests/rpc_node_tests/eth_getLogs.spec.ts` | Chain may not have 100 blocks at this point. Flake-on-young-chain. |
| `should execute via precompile and verify via cosmos query client` | `tests/precompiles/wasm.spec.ts:587` | Likely cascade from prior `it`; could be precompile execute bug. |

## Source-of-truth references

- PR sei-protocol/qa-testing#49 — file-glob `STATE_REQUIRED_GLOBS` in `bin/release-test.ts`.
- PR sei-protocol/qa-testing#50 — `@state-required` tag convention.
- PR sei-protocol/platform#460 — explicit `TEST_TARGET=chain-agnostic` env on the inner test pod.
- PR sei-protocol/platform#462 — image pin bump to `416ff79`.
- Run logs: `kubectl --context harbor -n nightly logs job/release-test-20260508-225223` (until pod GC).

## Reviewer outputs

Per-reviewer triage views retained at:
- `/tmp/triage-audit.md` (solidity-developer)
- `/tmp/triage-product-engineer.md` (product-engineer)
- `/tmp/triage-sei-network.md` (sei-network-specialist)
- `/tmp/triage-platform-engineer.md` (platform-engineer)

These are not committed; they're scratch files from the synthesis pass. The synthesized doc is the source of truth.
