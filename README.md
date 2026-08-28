# arctic_tests

Sei integration test suite — TS/mocha specs across nine categories under `tests/`.

## Running locally against testnet (existing flow)

```sh
yarn install
npx mocha --require ts-node/register 'tests/<category>/*.spec.ts'
```

Endpoints come from `config/testConfig.json` (testnet defaults).

## Running against an ephemeral chain via `seictl`

The `release-test` wrapper consumes seictl-emitted endpoints via env vars, runs the suite, and surfaces a typed exit code (0/1/2 per [sei-protocol/platform#235](https://github.com/sei-protocol/platform/issues/235)) plus a one-line stdout JSON summary.

```sh
seictl bench up --image $IMAGE --apply -o json > endpoints.json

SEI_EVM_JSON_RPC=$(jq -r '.data.endpoints.evmJsonRpc[0]' endpoints.json) \
SEI_TENDERMINT_RPC=$(jq -r '.data.endpoints.tendermintRpc[0]' endpoints.json) \
SEI_CHAIN_ID=$(jq -r '.data.chainId' endpoints.json) \
SEI_ADMIN_MNEMONIC=$ADMIN_MNEMONIC \
  yarn release-test
exit_code=$?

seictl bench down --name $NAME
exit $exit_code
```

### Env-var contract

| Env var | Overrides | Required when |
|---|---|---|
| `SEI_EVM_JSON_RPC` | `testConfig.evmRpcEndpoint` | running against ephemeral chain |
| `SEI_TENDERMINT_RPC` | `testConfig.seiRpcEndpoint` | running against ephemeral chain |
| `SEI_REST_ENDPOINT` | `testConfig.restEndpoint` | optional |
| `SEI_ADMIN_MNEMONIC` | `testConfig.adminMnemonic` | running against ephemeral chain |

When no env is set, the wrapper falls back to `config/testConfig.json` defaults — `yarn release-test` against testnet works without any env.

### Test targets

The suite partitions into two targets selected via `TEST_TARGET`:

- `chain-agnostic` (default) — tests that set up their own state. Safe on any chain. The harness target.
- `state-required` — tests that read pre-existing chain state (mainnet/atlantic-2 indexer data, hardcoded contracts, testnet WSS). For manual pacific-1 / atlantic-2 runs.

```sh
TEST_TARGET=state-required yarn release-test  # only state-required tests
yarn release-test                              # chain-agnostic (default)
```

Each suite's bucket is declared in the test file itself: state-required suites have `@state-required` in their top-level `describe` name. Chain-agnostic is the default — no tag.

```ts
describe('@state-required Indexer Tests', function () { ... });   // state-required
describe('TokenFactory Tests', function () { ... });              // chain-agnostic
```

`bin/release-test.ts` filters at the file-glob level via `STATE_REQUIRED_GLOBS` (mochawesome's grep filter has a known bug that inflates pending counts — file globs sidestep it). The tag is the in-test source of truth; the glob list mirrors it. Adding a new state-required test means: add the tag to its top-level `describe`, then add its file path to `STATE_REQUIRED_GLOBS`.

### Stdout summary

```json
{"passed": 47, "failed": 0, "pending": 2, "exitCode": 0, "reportPath": "./release-test-report/mochawesome.json", "target": "chain-agnostic"}
```

Mocha's live output goes to stderr; the summary lands on stdout as a single line for `jq` consumption.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | All tests passed |
| 1 | ≥1 test assertion failed; infra was fine |
| 2 | Infra failure (RPC dial, missing config, mocha crash) |

See [`docs/design/seictl-harness.md`](docs/design/seictl-harness.md) for the full design.

## Ethereum execution-spec tests

The EEST runner uses the `ethereum-execution-testing` package and Python tests
from the same pinned `ethereum/execution-specs` Amsterdam checkout. The package
cannot be installed from PyPI by itself: its `ethereum-execution` dependency is
developed in lockstep, and the upstream test files are not included as package
data.

Install the pinned checkout and apply the Sei compatibility patch:

```sh
npm run eest:install
```

Run the complete EIP-7702 source suite against a local chain:

```sh
npm run test:eest:eip7702
```

Run all remote-compatible tests applicable to a Prague Sei chain:

```sh
SEI_EVM_JSON_RPC=http://127.0.0.1:8545 \
SEI_ADMIN_MNEMONIC="<funded genesis mnemonic>" \
  npm run test:eest:nightly
```

The nightly command covers every fork suite from Frontier through Prague plus
the canonical `ported_static` tests. EEST automatically removes transition
formats that remote execution cannot run and skips tests requiring mutable
pre-allocation. At the pinned revision this collects 13,567 tests after the
configured exclusions; two system-contract cases are marked skipped, leaving
13,565 runnable tests.

Suites that require unsupported payload fields, transaction types, or
per-block Ethereum system processing are listed in
`tests/eest/prague-nightly-ignores.txt`. Individual remote-runner
incompatibilities are listed in `tests/eest/remote-exclusions.txt`. The
installed compatibility patch marks two EIP-7702 tests skipped because they
delegate to Ethereum system-contract bytecode absent from Sei. Known Sei
execution failures and persistent-state incompatibilities are skipped by the
compatibility patch while adjacent passing vectors remain enabled. Set
`EEST_INCLUDE_NON_APPLICABLE=1` or
`EEST_INCLUDE_REMOTE_EXCLUSIONS=1` to include the excluded groups for diagnostic
runs. The nightly command writes JUnit XML to `eest-report/junit.xml`.

The runner is sequential by default to minimize shared-chain interference.
Set `EEST_PARALLELISM` above `1` to use EEST's isolated worker accounts after
validating the target chain's capacity. The all-spec run sweeps 100,000 SEI
into its worker account by default; override `EEST_SWEEP_AMOUNT` if the nightly
genesis uses a different allocation.

For parallel chains, launch one fresh chain and one EEST Job per shard. Every
Job uses the same shard count and a unique zero-based index:

```sh
EEST_SHARD_COUNT=8 EEST_SHARD_INDEX=0 npm run test:eest:nightly
EEST_SHARD_COUNT=8 EEST_SHARD_INDEX=1 npm run test:eest:nightly
# Continue through EEST_SHARD_INDEX=7 on separate chains.
```

Test node IDs are deterministically hashed across shards, so their union is the
complete selection with no overlap. Sharded reports default to
`eest-report/junit-shard-<index>.xml`. Start with
`EEST_PARALLELISM=1` per chain; raising both chain count and per-chain workers
multiplies RPC and mempool pressure.

For an end-to-end GitHub-hosted run, dispatch the `EEST eight-shard run`
workflow. It builds the selected `sei-chain` revision once, then starts eight
matrix runners. Each runner owns a fresh four-node devnet and one shard. The
default `ubuntu-latest` label can be overridden when dispatching, and each shard
uploads its JUnit report as a workflow artifact.

Transaction inclusion is polled every 0.2 seconds by default. Override
`EEST_POLL_INTERVAL` with another positive number if RPC load or block time
makes a slower interval preferable.

The checkout comes from the Amsterdam development branch, but `--fork=Prague`
is intentional because the flag must name the fork active on the target Sei
chain. The supplied mnemonic must control a sufficiently funded EVM account.

The release-test image contains the patched EEST checkout. A Kubernetes job can
override the image entrypoint with `/app/scripts/runEestNightly.sh` and provide
`SEI_EVM_JSON_RPC` plus either `SEI_ADMIN_MNEMONIC`,
`SEI_ADMIN_PRIVATE_KEY`, or `EEST_SEED_KEY`.
