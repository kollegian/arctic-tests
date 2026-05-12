// Per-chain operational parameters for gas math, fee dynamics, and
// other consensus-coupled behavior the suite reproduces client-side.
// Public chains (CHAIN_PARAMS) carry governance-tuned values; any
// other non-empty chain-id resolves to EPHEMERAL_HARNESS — the values
// fresh chains actually run because seictl's `genesis-chain` preset
// doesn't override consensus_params yet. Empty chain-id throws.
//
// The public-vs-ephemeral split also gates bootstrap behavior — see
// shared/warmup.ts.

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

// Matches sei-tendermint's DefaultBlockParams (MaxGas 100M). Swing to
// PACIFIC_1 once the chain-side emulation work (sei-config embedded
// defaults + sidecar overlay) lands.
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

export function isPublicChain(chainId: string): boolean {
    return chainId in CHAIN_PARAMS;
}

export function getChainParams(chainId?: string): ChainParams {
    const id = chainId ?? process.env.SEI_CHAIN_ID ?? "";
    if (isPublicChain(id)) return CHAIN_PARAMS[id];
    if (id === "") {
        throw new Error(
            "No chainParams entry: SEI_CHAIN_ID is missing or empty. " +
            "Set it to one of: " + Object.keys(CHAIN_PARAMS).join(", ") +
            ", or an ephemeral chain-id.",
        );
    }
    return EPHEMERAL_HARNESS;
}
