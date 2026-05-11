// Per-chain operational parameters that the test suite needs in order to
// reproduce on-chain gas math, fee dynamics, and similar consensus-coupled
// behavior client-side.
//
// Values are sourced from each chain's current operational state (governance
// has typically tuned these away from sei-chain module defaults). When
// running against an ephemeral chain provisioned by seictl, the entry under
// SEI_CHAIN_ID is consulted; if the chain-id is unrecognized and matches
// the orchestrator's `rel-*` prefix, the suite falls back to the ephemeral
// harness values — which today match sei-tendermint's DefaultBlockParams
// (100M block gas limit) because the seictl preset / orchestrator pipeline
// does not yet write pacific-1-aligned consensus_params at chain init.
//
// The longer-term shape (embed canonical defaults in sei-config, overlay
// at sidecar `generate-identity`) is tracked separately. When that lands,
// the ephemeral entry should swing to pacific-1's operational values to
// match the new chain shape.
//
// When governance updates a parameter, update the corresponding entry here.

export type ChainParams = {
    // CometBFT consensus_params.block.max_gas — operational, governance-mutable.
    blockGasLimit: number;
    // EVM module x/evm/types/params.go — governance-mutable.
    targetGasUsed: number;
    maxUpwardAdjustment: number;
    maxDownwardAdjustment: number;
    minFeePerGas: number;
};

const PACIFIC_1: ChainParams = {
    blockGasLimit: 12_500_000,
    targetGasUsed: 250_000,
    maxUpwardAdjustment: 0.0189,
    maxDownwardAdjustment: 0.0039,
    minFeePerGas: 1_000_000_000,
};

const ATLANTIC_2: ChainParams = {
    blockGasLimit: 12_500_000,
    targetGasUsed: 250_000,
    maxUpwardAdjustment: 0.0189,
    maxDownwardAdjustment: 0.0039,
    minFeePerGas: 1_000_000_000,
};

const ARCTIC_1: ChainParams = {
    blockGasLimit: 35_000_000,
    targetGasUsed: 250_000,
    maxUpwardAdjustment: 0.0189,
    maxDownwardAdjustment: 0.0039,
    minFeePerGas: 1_000_000_000,
};

// Ephemeral chains provisioned by the release-test orchestrator inherit
// sei-tendermint's DefaultBlockParams (sei-chain/sei-tendermint/types/params.go,
// MaxGas: 100_000_000) because neither the seictl `genesis-chain` preset nor
// the orchestrator overrides consensus_params at chain init. When the chain-side
// emulation work lands (sei-config embedded defaults + sidecar overlay, tracked
// separately), this entry should swing to PACIFIC_1 to match the new
// pacific-1-aligned chain state.
const EPHEMERAL_HARNESS: ChainParams = {
    blockGasLimit: 100_000_000,
    targetGasUsed: 250_000,
    maxUpwardAdjustment: 0.0189,
    maxDownwardAdjustment: 0.0039,
    minFeePerGas: 1_000_000_000,
};

export const CHAIN_PARAMS: Record<string, ChainParams> = {
    "pacific-1": PACIFIC_1,
    "atlantic-2": ATLANTIC_2,
    "arctic-1": ARCTIC_1,
};

export function getChainParams(chainId?: string): ChainParams {
    const id = chainId ?? process.env.SEI_CHAIN_ID ?? "";
    if (CHAIN_PARAMS[id]) return CHAIN_PARAMS[id];
    if (id.startsWith("rel-")) return EPHEMERAL_HARNESS;
    throw new Error(
        `No chainParams entry for chain-id "${id}". ` +
        `Add it to shared/chainParams.ts (or set SEI_CHAIN_ID).`,
    );
}
