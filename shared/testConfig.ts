// Test configuration sourced from environment variables.
//
// The orchestrator (clusters/harbor/nightly/release/configmap.yaml) sets
// SEI_TENDERMINT_RPC / SEI_EVM_JSON_RPC / SEI_REST_ENDPOINT / SEI_ADMIN_ADDRESS
// / SEI_ADMIN_MNEMONIC on the inner Job's pod env. The wrapper used to overlay
// these onto a tracked testConfig.json on disk and let consumers `import` it
// at module-load — that turned out to be a recurring footgun: any in-process
// refactor that bypassed the spawn boundary silently re-introduced frozen
// defaults (PRs #70-#74 history; Surface A finding F1).
//
// This module replaces that pattern. Consumers call getTestConfig() at use
// time, reading process.env directly. Empty-string env values fail closed —
// orchestrate.sh's `seictl nd get ... -o jsonpath=...` returns "" when a
// field is missing, and silently falling back to a bundled testnet endpoint
// (Surface A finding F18) is worse than failing the run loudly.

export interface TestConfig {
    adminAddress: string;
    seiRpcEndpoint: string;
    evmRpcEndpoint: string;
    restEndpoint: string;
    adminMnemonic: string;
}

function requireEnv(name: string): string {
    const v = process.env[name];
    if (v === undefined || v === '') {
        throw new Error(
            `Required env var ${name} is missing or empty. ` +
            `Set it in the test pod env or the orchestrator's Job spec.`,
        );
    }
    return v;
}

export function getTestConfig(): TestConfig {
    return {
        adminAddress: requireEnv('SEI_ADMIN_ADDRESS'),
        seiRpcEndpoint: requireEnv('SEI_TENDERMINT_RPC'),
        evmRpcEndpoint: requireEnv('SEI_EVM_JSON_RPC'),
        restEndpoint: requireEnv('SEI_REST_ENDPOINT'),
        adminMnemonic: requireEnv('SEI_ADMIN_MNEMONIC'),
    };
}
