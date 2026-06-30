# arctic-tests

End-to-end test suite for a Sei chain (Cosmos modules, EVM RPC, precompiles, tokens, RPC node behavior, and chain-level tx tests).

Every suite runs through Mocha + [`mochawesome`](https://www.npmjs.com/package/mochawesome) and writes a self-contained HTML + JSON report to `reports/<suite>/`. A combined report can be assembled across all suites.

---

## 1. Setup

```bash
npm install
```

The tests target whatever endpoints are listed in `config/testConfig.json`:

```json
{
  "adminAddress": "...",
  "seiRpcEndpoint": "https://.../tm",
  "evmRpcEndpoint": "https://.../evm",
  "restEndpoint":   "https://.../cosmos",
  "adminMnemonic":  "..."
}
```

Update those four fields to point at the chain you want to exercise. The admin account must be funded — it is the source of funds for every test user that gets created during a run.

---

## 2. Test suites

Each suite has its own `.mocharc.json` so it can be run in isolation. The table below maps the npm scripts to what they exercise and where reports are written.

| Script                       | Mocha config                              | What it covers                                                                                                                                               | Report location                                |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `npm run test:modules`       | `tests/modules/.mocharc.json`             | Cosmos SDK modules: `authz`, `bank`, `distribution`, `evm`, `feegrant`, `mint`, `slashing`, `staking`, `wasm` (RPC-first via `rpcQueryClient` with REST fallback) | `reports/modules/modules-report.{html,json}`   |
| `npm run test:precompiles`   | `tests/precompiles/.mocharc.json`         | EVM precompiles: addr, staking, tokenfactory, etc. (`gov` is excluded by default)                                                                            | `reports/precompiles/precompiles-report.{html,json}` |
| `npm run test:precompiles:gov` | same config, `gov.spec.ts` only         | Governance precompile in isolation (writes a separate `precompiles-gov-report` so it doesn't overwrite the main precompiles report)                          | `reports/precompiles/precompiles-gov-report.{html,json}` |
| `npm run test:tokens`        | `tests/tokens/.mocharc.json`              | ERC20 / ERC721 / CW20 / CW721 token flows (deploy, mint, transfer, approvals, etc.)                                                                          | `reports/tokens/tokens-report.{html,json}`     |
| `npm run test:rpc-node`      | `tests/rpc_node_tests/.mocharc.json`      | `solo_evm` RPC suites (state endpoints `eth_getBalance` / `eth_getCode` / `eth_getStorageAt` / `eth_getTransactionCount` / `eth_call` / `eth_estimateGas`, and debug endpoints `debug_traceCall` / `debug_traceTransaction` / `debug_traceBlockByNumber`). Load tests are intentionally skipped. | `reports/rpc_node/rpc-node-report.{html,json}` |
| `npm run test:evm-rpc`       | `tests/evm_rpc/.mocharc.json`             | `tests/evm_rpc/**/*.spec.ts` — additional EVM JSON-RPC coverage                                                                                              | `reports/evm_rpc/evm-rpc-report.{html,json}`   |
| `npm run test:chain`         | `tests/chain_tests/.mocharc.json`         | Chain-level tx behavior: gas, EIP-1559, tx types, nonce management, tx execution, Pectra (EIP-7702) EOA upgrades                                             | `reports/chain/chain-report.{html,json}`       |
| `npm run test:mempool`       | `tests/mempool/.mocharc.json`             | Sei mempool semantics: admission (CheckTx), nonce queueing, priority ordering, RPC surface (`txpool_*`, `pending` blockTag, subscriptions), Tendermint↔EVM dual-pool coherency, capacity/TTL (local-only), broadcast (multi-node). See `tests/mempool/README.md`. | `reports/mempool/mempool-report.{html,json}`   |

All configs share the same shape:

- `require: ["tsx"]` — TypeScript specs run directly, no build step.
- `timeout: 600000` — each test gets up to 10 minutes (these are real on-chain flows).
- `exit: true` — Mocha exits after the run so dangling sockets don't keep the process alive.
- `reporter: "mochawesome"` with `html: true, json: true, overwrite: true`.

---

## 3. Running a subset of tests

Anything you can do with raw `mocha` works because every script just delegates to it.

```bash
# A specific spec file (the suite's mocharc still applies — reporter, timeout, etc.):
npx mocha --config tests/modules/.mocharc.json tests/modules/staking/staking.spec.ts

# A single describe / it via --grep:
npx mocha --config tests/modules/.mocharc.json --grep "Slashing Module Tests"

# Just the gov precompile (already wired as an npm script):
npm run test:precompiles:gov
```

Reports from one-off runs land in the same `reports/<suite>/` directory and overwrite the previous file there (because `overwrite=true`). Pass `--reporter-option reportFilename=<name>` if you want to keep a separate report for a one-off run, e.g.:

```bash
npx mocha --config tests/modules/.mocharc.json \
  --reporter-option reportFilename=staking-only-report \
  tests/modules/staking/staking.spec.ts
# → reports/modules/staking-only-report.{html,json}
```

---

## 4. Run everything + merge reports

```bash
npm run test:reported
```

This runs every suite sequentially (precompiles → tokens → rpc-node → evm-rpc → modules → chain) and then runs `test:reports:merge`, which:

1. Globs every per-suite JSON report at `reports/*/*.json`.
2. Calls [`mochawesome-merge`](https://www.npmjs.com/package/mochawesome-merge) to fold them into one combined JSON.
3. Calls `marge` (the mochawesome report generator) to render it as HTML.

Output:

```
reports/combined/combined-report.json
reports/combined/combined-report.html  ← single dashboard for the whole run
```

The `(... ; ... ; ...)` grouping in the script means the merge step runs even if individual suites fail, so a partial run still produces a combined report covering whichever suites finished.

You can also run the merge step on its own at any time after individual suite runs:

```bash
npm run test:reports:merge
```

---

## 5. Where to look after a run

```
reports/
├── chain/        chain-report.{html,json}
├── combined/     combined-report.{html,json}        ← cross-suite dashboard
├── evm_rpc/      evm-rpc-report.{html,json}
├── modules/      modules-report.{html,json}
├── precompiles/  precompiles-report.{html,json}
│                 precompiles-gov-report.{html,json} (only after test:precompiles:gov)
├── rpc_node/     rpc-node-report.{html,json}
└── tokens/       tokens-report.{html,json}
```

Open any `*.html` file directly in a browser. The HTML report is fully self-contained (no need to serve it).

The `reports/` directory is gitignored — every run starts fresh from your local state.

---

## 6. Troubleshooting

- **A suite fails on the first test with `Not Implemented`.** The Cosmos REST gateway pruned the data. The shared `tests/modules/utils/rpcQueryClient.ts` now goes RPC-first and falls back to REST automatically; if you still see this, point `seiRpcEndpoint` in `config/testConfig.json` at a less-pruned RPC.
- **Tests time out.** Default per-test timeout is 10 minutes. If a suite legitimately needs more, raise `timeout` in that suite's `.mocharc.json` or pass `--timeout <ms>` on the CLI.
- **You only want the JSON report (e.g. for CI artifacting).** Set `--reporter-option html=false` on the CLI; the JSON file at the same path still gets written and is what `test:reports:merge` consumes.
