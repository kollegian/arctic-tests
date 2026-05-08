// Standard --node / --chain-id flags appended to every seid CLI shell-out.
// Without these, seid defaults to tcp://localhost:26657 which has nothing
// running inside the harness pod. Functions throw at call time rather than
// returning empty so a missing env var fails loud instead of silently
// falling back to localhost.

export function seidNodeFlag(): string {
    const node = process.env.SEI_TENDERMINT_RPC;
    if (!node) throw new Error('SEI_TENDERMINT_RPC must be set for seid CLI calls');
    return `--node ${node}`;
}

export function seidTxFlags(): string {
    const chainId = process.env.SEI_CHAIN_ID;
    if (!chainId) throw new Error('SEI_CHAIN_ID must be set for seid CLI broadcast calls');
    return `${seidNodeFlag()} --chain-id ${chainId}`;
}
