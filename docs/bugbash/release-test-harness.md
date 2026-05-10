# Bugbash: release-test harness machinery

**Target:** the full bootstrap chain from harbor cronjob → orchestrator script → keygen init container → seictl SND apply → `release-test.ts` wrapper → `deploy-fixtures.ts` child process → mocha child process → inner spec hooks → Token/Deployer machinery in `shared/`.

**Started:** 2026-05-09  
**Pass 1 closed:** 2026-05-10

**Expert slate:** product-engineer, solidity-developer, kubernetes-specialist, platform-engineer, sre-engineer

**Motivation.** Five PRs in flight (#70 → #74) trying to stabilize bootstrap; each fixed one bug and surfaced another (module-not-found → frozen testConfig → keep-alive hang → nonce collision → eth_estimateGas wrong-low). Brandon called for a holistic hardening review focused on enumerating problem surfaces concretely, separating concerns, and recommending idiomatic control-flow shapes that make each piece resilient on its own.

**Pass 1 outcome:** 25 candidate findings, merged to 22 after dedup. All 22 confirmed by challengers (no refutes). Distribution: **1 Critical, 11 High, 6 Medium, 4 Low.**

---

## Severity tally

| Severity | Count | IDs |
|---|---|---|
| Critical | 1 | F2 |
| High | 11 | F1, F4, F5, F6, F7, F9, F12, F13, F14, F18, F20 |
| Medium | 6 | F3, F8, F15, F16, F19, F21 |
| Low | 4 | F10, F11, F17, F22 |

---

## Findings

### F1 — testConfig.json round-trip is the IPC ABI between two processes that both treat it as static
**Severity:** High  
**File:** `bin/release-test.ts:75-83,150-171`; `bin/deploy-fixtures.ts:7,36,46`; `shared/User.ts:16,223`  
**Finders:** product-engineer, platform-engineer · **Challenger:** kubernetes-specialist (confirm)

**Path to failure.** Wrapper writes env-overlaid `testConfig.json` to disk, spawns deploy-fixtures + mocha (both `import testConfig from '...json'` at module load), restores original in `finally`. The spawn boundary is the only thing keeping in-process consumers from seeing frozen-default values. `UserFactory.testConfig = testConfig` at User.ts:223 captures the snapshot; `returnUsersFromMnemonics` at :328 reads `this.testConfig.seiRpcEndpoint` from that snapshot. PR #72 was the proof — any code path that imports `testConfig` before `loadAndOverlayEnv()` runs silently uses defaults.

**Idiomatic fix shape.** Stop using JSON-on-disk as IPC. Two clean alternatives: (a) read `process.env.SEI_*` at function-call sites, no `testConfig.json` smuggling; (b) write the runtime config to a fresh path the children read explicitly via fs.readFileSync, never via `import`. Either kills the frozen-import contract.

---

### F2 — Hardcoded 2024-testnet admin address+mnemonic as runtime fallback in shared/User.ts
**Severity:** Critical  
**File:** `shared/User.ts:178-179`  
**Finders:** product-engineer, solidity-developer · **Challenger:** platform-engineer (confirm)

**Path to failure.** `Cli.adminAddress` and `Cli.adminMnemonic` default to literal funded testnet credentials if env unset. Class-field initializers latch the literal at construction; every `SeiUser` builds a `Cli`. Reached when the env is missing, partially propagated, or a future caller forgets the contract. No fail-closed mode — absence of `SEI_ADMIN_*` is treated as "use the bundled credentials."

**Idiomatic fix shape.** `assert(process.env.SEI_ADMIN_MNEMONIC, '...')` at process start; throw on absence. Move the literal mnemonic to a developer fixture file consumed only when a `--dev` flag is passed, not as a silent runtime default. Never a credential as a fallback.

---

### F3 — EvmWallet.createUser constructs two separate JsonRpcProvider instances per user; 10 users → 20 keep-alive socket pools
**Severity:** Medium *(downgraded from High)*  
**File:** `shared/User.ts:140-146`  
**Finders:** solidity-developer · **Challenger:** kubernetes-specialist (downgrade — already partially mitigated by the per-tx timeout shipped in #74; workaround is straightforward provider-sharing)

**Path to failure.** `createUser` does `this.wallet = createHdNodeWallet(...).connect(new JsonRpcProvider(rpcEndpoint))` AND `this.signingClient = new JsonRpcProvider(rpcEndpoint)` — two independent providers per wallet, each with its own keep-alive socket pool. With `USER_POOL_SIZE = 10` plus admin, ~22 independent provider instances per fixture deploy. Each pool is independently susceptible to the keep-alive idle-wedge that hung sequential safeMint.

**Idiomatic fix shape.** One `JsonRpcProvider` per RPC URL (typically two URLs total — admin RPC + same), reused across all wallets via `wallet.connect(sharedProvider)`. Eliminates the N×2 socket pool fan-out.

---

### F4 — Three-phase orchestration straddles two repos with no schema for the env-var contract
**Severity:** High  
**File:** `clusters/harbor/nightly/release/configmap.yaml:99-147`; `bin/release-test.ts:78-81`  
**Finders:** product-engineer · **Challenger:** platform-engineer (confirm)

**Path to failure.** Platform-side orchestrate.sh injects 7 env vars; harness consumes from 4 sites (release-test.ts overlays 4; User.ts:178-179 reads admin pair; SEI_CHAIN_ID is unread). No shared contract — adding/renaming a key fails silently as fallback to JSON or hardcoded mnemonic. Test pass/fail does not detect; it tests the wrong chain.

**Idiomatic fix shape.** A typed config schema validated at harness startup (e.g., zod or a hand-written assertion module), throwing on missing/empty/malformed env. Schema lives in qa-testing as the canonical contract; orchestrate.sh sources from the same schema for variable names. F2 is the acute symptom; F4 is the systemic enabler.

---

### F5 — createSeiUsers has duplicated branches and a self-recursive pool-grow path that silently ignores caller's count
**Severity:** High  
**File:** `shared/User.ts:260-312`  
**Finders:** product-engineer · **Challenger:** solidity-developer (confirm)

**Path to failure.** Two near-identical fund/wait/associate sequences (lines 265-283 and 292-311). `recordMnemonics=true` calls `returnUsersFromMnemonics()` to merge prior-run users (line 277), writes merged list back. On re-run with N existing recorded users, pool grows to `count + N`, not `count`. When `recordedUsers >= count`, returns whatever's on disk regardless of caller intent. deploy-fixtures iterates `users.map((_, i) => i.toString())` for cw721 ids and erc721 safeMint — stale-pool re-run collides token ids with already-minted tokens. Hidden today only because deploy-fixtures resets `MNEMONICS_JSON` at line 22; any direct `UserFactory` consumer that skips the reset gets the bug.

**Idiomatic fix shape.** Collapse the two branches into one. Pick a single semantic — "exactly count" or "top up to count" — and document it on the function. Honor the contract regardless of `recordMnemonics`.

---

### F6 — deploy-fixtures interleaves parallel ethers, parallel cosmjs, and serial seid-CLI shell-outs against one admin account with three independent nonce sources
**Severity:** High  
**File:** `bin/deploy-fixtures.ts:32-83`; `shared/Token.ts:75-89,222-231`; `shared/Deployer.ts:115-131`  
**Finders:** product-engineer · **Challenger:** solidity-developer (confirm)

**Path to failure.** Pipeline against single admin: ethers `factory.deploy` (sequential), `mintToUsers` (Promise.all), `seid tx evm register-cw-pointer` shell-out (serial), cosmwasm `instantiate` (serial), two more sequential admin mints, parallel `mintMultiple` cosmwasm, `Promise.allSettled` parallel safeMint. Three nonce sources (ethers in-memory, cosmjs sequence, seid keyring) all writing to the same account. Only `waitFor(2)` literals between phases as synchronization. Each PR fix targeted one symptom — the shape is the hazard.

**Idiomatic fix shape.** Single-writer admin queue: serialize all admin-signed txs through one async iterator that owns the chain-side sequence. Replace `waitFor(2)` between phases with a `seid q account` sync barrier (or equivalent ethers nonce sync). User-signed txs (mintToUsers, safeMint) belong to their own per-user signers — don't muddle them with admin queue.

---

### F7 — mintToUsers fires 10 parallel ERC20 mints with no gasLimit override; ethers trusts a Sei eth_estimateGas that races early-chain state
**Severity:** High  
**File:** `shared/Token.ts:75-82`; `bin/deploy-fixtures.ts:33`  
**Finders:** solidity-developer · **Challenger:** platform-engineer (confirm)

**Path to failure.** `mintToUsers` builds 10 promises via `this.contract.connect(user.evmWallet.wallet).mint(...)` (`mint()` is unguarded). Each user signer concurrently calls `eth_getTransactionCount("pending")` + `eth_estimateGas` against Sei within a few-block window after token deployment. Sei's estimate-race returned 22,946 wei at block 130 (just over 21000-wei intrinsic); same call returns 105,046 wei now. ethers used the bad estimate as gasLimit, every tx OOG'd, mintFailures threw.

**Idiomatic fix shape.** Pass an explicit `{ gasLimit: 500_000 }` override (well above any reasonable mint cost). Bypasses `eth_estimateGas` entirely — never trust it for fixture deploy. Either modify `Token.ts:mintToUsers` to accept overrides, or move the parallel pattern + override into deploy-fixtures.ts and call `contract.mint(..., { gasLimit })` directly.

---

### F8 — Parallel safeMint block lacks gas hardening AND leaks 30s setTimeout timers on success path
**Severity:** Medium  
**File:** `bin/deploy-fixtures.ts:62-83`  
**Finders:** solidity-developer · **Challenger:** platform-engineer (confirm)

**Path to failure.** Each safeMint signed by 10 distinct users (independent nonces). But ethers v6 contract method path still calls eth_estimateGas with no override — same Sei early-block OOG window as F7. The 30s `Promise.race` only catches socket-wedge symptoms, not OOG. Race timer leaks: setTimeout id never cleared on winning branch (Cursor-flagged on PR #74).

**Idiomatic fix shape.** Same `gasLimit` override as F7. `withTimeout` helper that tracks the timer ID and calls `clearTimeout` in `.finally(...)`. Replaces the inline `Promise.race` so the leak footgun is structurally avoided.

---

### F9 — TestERC20._update unbounded _allAccounts.push SSTORE — built-in eth_estimateGas-vs-execution skew
**Severity:** High  
**File:** `contracts/TestERC20.sol:35-46`  
**Finders:** solidity-developer · **Challenger:** platform-engineer (confirm)

**Path to failure.** `_update` does `super._update` then conditional `_allAccounts.push(to)` (cold SSTORE on `_accountExists[to]` flip + dynamic-array length SSTORE + slot SSTORE for the new element) on every first-time recipient. Cost depends on whether `to` was ever a recipient. eth_estimateGas snapshot at block 130 under-counts what tx pays once 9 sibling parallel mints have already extended the array. ERC20Pausable adds `paused()` SLOAD per call. Estimator-vs-execution skew is a built-in property of this contract under parallel first-time recipients — F7 is the symptom, F9 is the mechanism.

**Idiomatic fix shape.** F7's gasLimit override masks this for the harness. Cleaner long-term: the account-tracking should be moved out of `_update` (push it into a separate bookkeeping function called explicitly when needed) — but that's out of scope for harness-level work. Pin the gasLimit and file a tracked issue against TestERC20 for the structural fix.

---

### F10 — Deployer.deployErc20 / deployErc721 pass the HDNodeWallet object as the constructor `address` argument
**Severity:** Low  
**File:** `shared/Deployer.ts:31, 48`  
**Finders:** solidity-developer · **Challenger:** kubernetes-specialist (confirm — but cosmetic, ethers v6 resolves via Addressable)

**Path to failure.** `factory.deploy(this.user.evmWallet.wallet)` passes `HDNodeWallet` where `address initialOwner` is expected. ethers v6 resolves via the `Addressable` interface (Wallet exposes `getAddress()`) — currently equal to cached `evmAddress`. They cannot diverge unless someone mutates `evmAddress` after construction (no current call does).

**Idiomatic fix shape.** `factory.deploy(this.user.evmAddress)`. Removes the implicit Addressable dependency and matches `deployErc1155`'s pattern.

---

### F11 — Init container's /tmp/keyring (admin private key, plaintext) lives on orchestrator's emptyDir, persists for the run
**Severity:** Low *(downgraded from High)*  
**File:** `clusters/harbor/nightly/release/cronjob.yaml:46-58`  
**Finders:** kubernetes-specialist · **Challenger:** product-engineer (downgrade — same mnemonic is also in `/shared/admin.json` and the K8s Secret; not new exposure, just duplicate)

**Path to failure.** Keygen writes keyring to `/tmp/keyring` on the shared `tmp` emptyDir mounted by both init and orchestrator. Orchestrator's `HOME=/tmp` overlaps. Plaintext keyring (`test` backend) persists in orchestrator's working dir for the run.

**Idiomatic fix shape.** `--keyring-dir /tmp/kg-$$` in the init (process-scoped), or `rm -rf /tmp/keyring` after `> /shared/admin.json`. Hygiene — not a launch blocker.

---

### F12 — Three+ pinned versions of "the seid binary" coupled only by a YAML comment; seictl tarball is a fourth runtime download with no checksum
**Severity:** High  
**File:** `clusters/harbor/nightly/release/cronjob.yaml:32-36, 87-88`; `configmap.yaml:38-55`  
**Finders:** kubernetes-specialist, platform-engineer · **Challenger:** sre-engineer (confirm)

**Path to failure.** initContainer image and orchestrator `SEID_IMAGE` env coupled by a YAML comment ("bump together"). Validator + RPC SNDs use `${SEID_IMAGE}` from env — third reference. seictl is fetched at runtime from a public GitHub release URL with no checksum. Keyring formats / address derivations are versioned; mismatch surfaces as 'admin address has no balance' deep in deploy-fixtures, not at apply.

**Idiomatic fix shape.** Single source of truth via Kustomize var or a values file referenced once. seictl: pin to a digest in an internal artifact registry, or `sha256sum -c` on the tarball before unpacking.

---

### F13 — Cleanup trap is racy with seictl-managed child resources under SIGKILL — foreground cascade on two SNDs cannot finish in 60s grace
**Severity:** High  
**File:** `clusters/harbor/nightly/release/configmap.yaml:29-35`  
**Finders:** kubernetes-specialist · **Challenger:** product-engineer (confirm)

**Path to failure.** `trap cleanup EXIT` runs on pod termination including from `activeDeadlineSeconds: 3600` SIGTERM with 60s grace. Cleanup does `seictl nd delete --cascade=foreground` for two SNDs (4+2 replicas) plus Secret. Foreground cascade waits for dependent StatefulSets, Pods (with own grace), PVCs to drain — a 4-node validator with seid shutdown won't finish in 60s. Pod SIGKILLed mid-finalization → SNDs with deletionTimestamp set, finalizers pending, PVCs orphaned. Drift accumulates over runs.

**Idiomatic fix shape.** Background cascade (`--cascade=background`) so the trap completes fast. Add a separate janitor CronJob that GCs zombie SNDs and PVCs nightly. Or: ditch the trap, rely on `ttlSecondsAfterFinished` + a cluster-side reaper.

---

### F14 — Inner Job mnemonic Secret reachable by every pod with workload-service-account in the nightly namespace
**Severity:** High  
**File:** `clusters/harbor/nightly/release/configmap.yaml:94-97,139-143`; `rbac.yaml:16-18`  
**Finders:** kubernetes-specialist · **Challenger:** sre-engineer (confirm)

**Path to failure.** Orchestrator Role grants `secrets: get/create/delete/patch` namespace-wide (no resourceNames restriction). `workload-service-account` is the SA for both orchestrator and inner test Job (and SeiNodeDeployment-managed pods, which share the namespace). Any pod under that SA can `kubectl get secret release-test-mnemonic-${RUN_ID}`. Auto-promotes to Critical if `nightly` ever hosts a workload reaching a real-funded chain.

**Idiomatic fix shape.** Per-Job ServiceAccount (test Job runs as `release-test-runner`, not `workload-service-account`); orchestrator Role uses `resourceNames: [release-test-mnemonic-${RUN_ID}]` for the get path. NetworkPolicy denying egress to the kube-API for non-orchestrator pods.

---

### F15 — First-block poll uses ${SECONDS} after two preceding seictl nd watch --timeout=20m
**Severity:** Medium  
**File:** `clusters/harbor/nightly/release/configmap.yaml:58-92`  
**Finders:** kubernetes-specialist · **Challenger:** sre-engineer (confirm)

**Path to failure.** `deadline=$((SECONDS + 300))` measures shell uptime since interpreter start, accumulating the seictl tarball download + two `nd apply` + two `nd watch --timeout=20m` calls before the poll begins. The 5-minute budget is independent (arithmetic is correct) — but the *outer* CronJob `activeDeadlineSeconds: 3600` is mostly consumed by the time block-poll starts, so the 5min budget overlaps pod-termination grace, not acting as a true independent budget.

**Idiomatic fix shape.** `start=$SECONDS; deadline=$((start + 300))` for the inner poll — or use `date +%s` snapshots so it reads as wall-clock-since-poll-start. Raise outer `activeDeadlineSeconds` to ~5400s to credibly cover all documented inner waits (20+20+5+45=90min > 60min current limit).

---

### F16 — classify() conflates infrastructure-during-setup with infrastructure-during-tests AND collapses pre-mocha failures to one string
**Severity:** Medium  
**File:** `bin/release-test.ts:117-145, 178-188`  
**Finders:** platform-engineer, sre-engineer · **Challenger:** product-engineer (confirm)

**Path to failure.** `hasInfraSignal` walks every test's `err.message`/`err.code` for `ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN` with no scoping to bootstrap/before-hooks; a single mid-suite test with transient `ETIMEDOUT` flips entire run to exit 2 reason `'rpc dial failure during test setup'` — the reason is a literal lie. Separately, classify() distinguishes only 4 states; module-not-found, mocharc parse error, malformed glob, missing fixture all produce identical `Summary.error`. Real stack lands in pod logs (stdio inherit) but never enters Summary.

**Idiomatic fix shape.** Scope infra check to before-hook errors only (mochawesome's `err.context.beforeAll === true`). Capture mocha's stderr tail into `Summary.errorDetail`. Add discrete failure categories: `parse-error | mocharc-error | spec-load-error | infra-during-setup | test-failure | wrapper-crash`.

---

### F17 — release-test.ts spawns children via `npx` (re-resolves binaries) instead of node_modules/.bin direct paths
**Severity:** Low *(downgraded — npx 9+ short-circuits to local binary, no current failure mode; trivial fix)*  
**File:** `bin/release-test.ts:87-95,101-115`; `Dockerfile:33-35`  
**Finders:** platform-engineer · **Challenger:** kubernetes-specialist (downgrade)

**Path to failure.** Children are `spawn('npx', ['tsx', ...])` and `spawn('npx', ['mocha', ...])`. Entrypoint already does `node node_modules/.bin/tsx`; spawns inconsistently reach for npx. ~200-500ms resolution overhead per spawn; if `node_modules/.bin/tsx` ever disappears, npx silently tries to fetch.

**Idiomatic fix shape.** `spawn('node_modules/.bin/tsx', ['bin/deploy-fixtures.ts'])` and `spawn('node_modules/.bin/mocha', [...])`. Match the entrypoint pattern.

---

### F18 — loadAndOverlayEnv's `if (process.env.X)` guards short-circuit on empty string — empty TM_RPC silently falls back to bundled testnet
**Severity:** High  
**File:** `bin/release-test.ts:77-84`; `clusters/harbor/nightly/release/configmap.yaml:99-147`  
**Finders:** platform-engineer · **Challenger:** solidity-developer (confirm)

**Path to failure.** orchestrate.sh sets test pod env from `seictl nd get ... -o jsonpath=...`; jsonpath returns `""` on missing field silently. Empty env in test pod → `if (process.env.SEI_TENDERMINT_RPC)` is falsy in JS → loadAndOverlayEnv keeps committed `testConfig.json`'s `3.133.59.72` testnet endpoints. Test pod silently runs against testnet, not the freshly-provisioned chain. Green tests for the wrong chain.

**Idiomatic fix shape.** Replace truthy guard with `if (process.env.X !== undefined && process.env.X !== '')`. Better: fail-closed — throw on empty-string env (almost always a templating error, never an intentional unset). Same schema validation that addresses F4 fixes this.

---

### F19 — deploy-fixtures' rejection stack is discarded by release-test.ts's structured Summary
**Severity:** Medium  
**File:** `bin/deploy-fixtures.ts:110-113`; `bin/release-test.ts:161-176`  
**Finders:** sre-engineer · **Challenger:** product-engineer (confirm)

**Path to failure.** When deployFixtures rejects, child writes `[deploy-fixtures] FAILED: <stack>` to stderr (inherited → pod logs) and exits 1. Parent synthesizes `error: 'fixture deploy failed: deploy-fixtures exited 1'` — discarding stack and granular cause. Every distinct deploy failure (legacy mnemonic, safeMint timeout, wasm missing, RPC unreachable) collapses to the same one-liner. Distinguishing requires fetching pod logs and grepping.

**Idiomatic fix shape.** deploy-fixtures emits a JSON line on exit (`{stage: "mintToUsers", error: "..."}`); parent merges into Summary. Alternatively: pipe child stderr to a buffer, attach last N lines as `deployErrorDetail`. Same pattern as F16.

---

### F20 — orchestrate.sh's ::: release-test FAILED branch truncates `kubectl describe` to head -80 and emits no inner-pod logs / mochawesome.json / structured failure category
**Severity:** High  
**File:** `clusters/harbor/nightly/release/configmap.yaml:149-160`  
**Finders:** sre-engineer · **Challenger:** kubernetes-specialist (confirm)

**Path to failure.** On Job failure: `kubectl describe job/<name> | head -80` and exit 1. No `kubectl logs job/<name>`, no fetch of `/dev/termination-log`, no echo of inner pod's structured Summary JSON, no copy of `mochawesome.json`. With `ttlSecondsAfterFinished: 86400` the data is salvageable for 24h, but on-call must manually re-fetch — defeating the structured Summary's point.

**Idiomatic fix shape.** On FAILED branch: (1) `kubectl logs job/${JOB_NAME} --tail=-1` (full inner pod stdout/stderr), (2) `kubectl cp release-test-pod:/app/release-test-report/mochawesome.json /tmp/run-${RUN_ID}.json && upload to S3 (or echo base64)`, (3) echo the last stdout line of the inner pod (the JSON Summary) as a banner. So one CronJob run carries the failure evidence in its own logs.

---

### F21 — No liveness/heartbeat signal during deploy-fixtures stages; keep-alive socket hangs invisible until activeDeadlineSeconds 45min later
**Severity:** Medium  
**File:** `bin/deploy-fixtures.ts:65-83`; `configmap.yaml:112,151`  
**Finders:** sre-engineer · **Challenger:** platform-engineer (confirm)

**Path to failure.** Inner Job has `activeDeadlineSeconds: 2700` (45m); outer wait `--timeout=45m`. No per-stage heartbeat log, no progress metric, no liveness probe, no checkpoint. Between `[deploy-fixtures] funded N users` and the next stage line, pod sits silent for 30+ min on a wedged socket. SIGKILL reason is `DeadlineExceeded` + last stdout — doesn't tell which stage hung.

**Idiomatic fix shape.** Per-stage `[deploy-fixtures] enter <stage>` / `[deploy-fixtures] exit <stage>` log lines so an operator can pin "hung in <X>" by reading the log tail. Consider a sidecar liveness ping (`/dev/termination-log` write per stage).

---

### F22 — No runbook for release-test failure modes
**Severity:** Low *(downgraded — runbook is useful, not launch-blocking; team has triaged 5 incidents this week from logs alone)*  
**File:** missing — should be `docs/runbook/release-test.md`  
**Finders:** sre-engineer · **Challenger:** product-engineer (downgrade)

**Path to failure.** No runbook documenting the 5 distinct failure modes seen this week ('key not found', 'Cannot find module', safeMint timeout, OOG, 'nonce too low'). No `INFRA_SIGNALS` taxonomy doc explaining exitCode 2 vs 1 for cronjob alerting routes. Platform overlay carries a runbook for the chaos test but nothing for nightly release-test.

**Idiomatic fix shape.** Single runbook with: failure-mode → which logs to fetch → which env to verify → retry vs. file-issue. INFRA_SIGNALS taxonomy doc as a paragraph alongside `bin/release-test.ts`'s classify() function — the alerting contract.

---

## Surface map (concern separation)

Brandon's framing: *"focus on each separately and address them concretely."* Findings group into **8 independent surfaces** that can be fixed in isolation:

| Surface | Findings | Owner | Idiomatic shape |
|---|---|---|---|
| **A. Config-as-IPC** | F1, F18 | release-test.ts wrapper | Stop using JSON-on-disk as IPC; read env at call sites OR write to a fresh path read via `fs.readFileSync` (never `import`). Validate at startup (rejects empty strings). |
| **B. Credential fail-closed** | F2, F4 | shared/User.ts + cross-repo schema | Throw on missing/empty `SEI_ADMIN_*`; remove the testnet mnemonic literal entirely (move to a `--dev` fixture file). Schema validated at process start ties to the platform-side env contract. |
| **C. Tx-submission machinery** | F3, F6, F7, F8, F9 | shared/ + deploy-fixtures.ts | Single-writer admin queue + per-user signers separated; explicit `gasLimit` override on every tx (never trust eth_estimateGas in fresh-chain state); shared JsonRpcProvider per RPC URL; `withTimeout` helper that clears the timer in finally. |
| **D. UserFactory contract** | F5 | shared/User.ts | Collapse `createSeiUsers` into one branch with one documented semantic. |
| **E. Deployer hygiene** | F10 | shared/Deployer.ts | Pass `evmAddress`, not the wallet object. |
| **F. K8s orchestration** | F11, F12, F13, F14, F15 | platform repo (cronjob + configmap + rbac) | Single image source-of-truth; per-Job ServiceAccount; background cascade in cleanup + janitor for drift; resourceNames-scoped Secret access; corrected $SECONDS poll budget + outer activeDeadlineSeconds raised. |
| **G. Failure surface (operability)** | F16, F19, F20, F21 | bin/release-test.ts + configmap.yaml | Structured failure categories in Summary JSON; deploy-fixtures emits JSON exit line; orchestrate.sh's FAILED branch fetches inner-pod logs + mochawesome + echoes Summary banner; per-stage heartbeat logs. |
| **H. Run discipline** | F17, F22 | bin/release-test.ts + docs/ | Direct `node_modules/.bin/<tool>` spawn; runbook + INFRA_SIGNALS taxonomy. |

**Independence claim.** A through H can each ship as a separate PR without touching the others. Surfaces couple only via shared file edits in 2 cases:

- A (F1) and B (F2, F4) both touch `shared/User.ts`. Coordinate the edits or land sequentially — A first (frees the testConfig pattern), then B (rewrites Cli admin handling on top of the new pattern).
- G (F16, F19) both touch `release-test.ts`. Fold into one PR.

All 8 surfaces are mechanically isolated otherwise.

---


## Pass 2 — what P1 missed

**Discovery.** 14 net candidates after dedup. **Verdicts:** 7 confirmed, 5 downgraded, 2 refuted.

### Confirmed / downgraded (added to surface map)

| ID | Title | Severity | Surface | Notes |
|---|---|---|---|---|
| F23 | testConfig.json restore window leaks past wrapper crash path | Medium | A | `main().catch` doesn't restore `originalRaw`; `finally`'s own write can fail. Dev-machine impact only — CI pod ephemeral. |
| F26 | `Erc721Token.transfer` aliases `transferFrom`, swallows safe-receiver semantic | Medium | C | One-line fix; no current spec relies on safe semantics. Pre-launch correctness trap for future tests. |
| F27 | `Cw20Token.deployPointer` returns void; siblings parse-and-return | Low | C | Hygiene; runtime path works today via re-query. |
| F28 | `executeMultipleInTheSameBlock` offline-sign race | Low | C | **Dead code** — no callers in repo. Real on activation; zero blast radius today. Delete or guard. |
| F29 | Inner test Job has no `securityContext`; PSS divergence | Medium | F | Re-rate to High the day Pod Security Standards `restricted` lands on `nightly` namespace. |
| F30 | RBAC has dead `delete` verb on configmaps | Low | F | Least-privilege hygiene. |
| F31 | Manual `kubectl create job --from=cronjob` bypasses concurrencyPolicy | Medium | F | Workaround: suspend CronJob before manual run. Real fix: random RUN_ID suffix + existence precondition. |
| F32 | Outer `activeDeadlineSeconds: 3600` < sum of inner timeouts (90m); orphans inner Job under SIGTERM | High | F | Raise outer to ≥5400s, OR run validator+rpc watches in parallel. |
| F35 | release-test failures emit no alert; on-call learns by accident | High | G | One PrometheusRule on `kube_job_status_failed{job_name=~"release-test.*"}`. |
| F36 | mochawesome.json dies with pod after 24h TTL; no S3 archive | Medium | G | Loki picks up pod logs (catch-all selector); the structured JSON artifact is the real loss. |

### Refuted (kept in `.bugbash` state for record)

- **F24 (keyring-isolation namespace split)** — refuted. Specs' `before()` hooks call `cli.createUser` which re-recovers admin into the worker's isolated keyring at startup. The cross-phase channel is `mnemonics.json`, not the keyring. Hygiene concern only.
- **F25 (`extension: ['ts']` + auxiliary modules transitively load)** — refuted. Grep verified no non-indexer spec imports from `tests/indexers/`. Constants are literals, not env reads. Real mocha gotcha pattern, not present in this repo today. Worth a `no-restricted-imports` lint rule as a cheap guardrail.

### Outstanding (challenger phase incomplete; defer to `/issue` triage)

- **F33 — stdout summary not flushed before `process.exit`; verdict can be lost on a piped stream.** `bin/release-test.ts:187-188, 202-203`. Fix: replace `process.exit(code)` with `process.exitCode = code` + return; or `process.stdout.once('drain', ...)`.
- **F34 — `wget -qO- ... | tar -xz` cannot fail the pipeline on transient github.com 5xx.** `cronjob.yaml:78-79`. Silent seictl absence → `command not found` → exit 127, no indication download was the root cause. Fix: `wget --spider` precheck + `[ -x /tmp/seictl ]` guard + checksum.

---

## Surface map (consolidated, post-P2)

| Surface | Findings | Owner |
|---|---|---|
| **A. Config-as-IPC** | F1, F18, F23 | release-test.ts wrapper |
| **B. Credential fail-closed** | F2, F4 | shared/User.ts + cross-repo schema |
| **C. Tx-submission machinery** | F3, F6, F7, F8, F9, F26, F27, F28 | shared/ + deploy-fixtures.ts |
| **D. UserFactory contract** | F5 | shared/User.ts |
| **E. Deployer hygiene** | F10 | shared/Deployer.ts |
| **F. K8s orchestration** | F11, F12, F13, F14, F15, F29, F30, F31, F32 | platform repo |
| **G. Failure surface (operability)** | F16, F19, F20, F21, F33, F35, F36 | release-test.ts + configmap.yaml + monitoring |
| **H. Run discipline** | F17, F22, F34 | release-test.ts + docs/ + cronjob.yaml |

**Convergence note.** P2 added 4 ≥Medium findings (F23, F32, F35, F36); convergence counter remains 0. Bugbash terminated early at user request — surface map is the deliverable, not exhaustive convergence. Outstanding stragglers (F33, F34) tracked as `/issue` items rather than challenged.

## Hand-off

Each surface ships as a separate `/issue` umbrella. Critical (F2) and the immediate-blocker subset of Surface C (F7, F9 — gas-estimation OOG that broke nightly) are the first work items.
