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

### Stdout summary

```json
{"passed": 47, "failed": 0, "pending": 2, "exitCode": 0, "reportPath": "./release-test-report/mochawesome.json"}
```

Mocha's live output goes to stderr; the summary lands on stdout as a single line for `jq` consumption.

### Exit codes

| Exit | Meaning |
|---|---|
| 0 | All tests passed |
| 1 | ≥1 test assertion failed; infra was fine |
| 2 | Infra failure (RPC dial, missing config, mocha crash) |

See [`docs/design/seictl-harness.md`](docs/design/seictl-harness.md) for the full design.
