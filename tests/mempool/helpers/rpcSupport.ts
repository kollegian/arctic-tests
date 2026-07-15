/**
 * Sanctioned-skip predicate for UNIMPLEMENTED RPC methods (team decision,
 * 2026-07-10): tests for a method the node does not expose at all skip
 * instead of failing, so the suite tracks behavior divergences rather than
 * surface inventory. The predicate matches ONLY the node's method-missing /
 * method-disabled signature (JSON-RPC -32601 and its known message shapes) —
 * any other error still fails the test. The day the node ships the method,
 * the skip stops matching and the full assertions activate automatically.
 */
export function isMethodUnavailable(err: unknown): boolean {
    const e = err as {
        error?: { code?: number };
        info?: { error?: { code?: number } };
        message?: string;
    };
    const code = e?.error?.code ?? e?.info?.error?.code;
    if (code === -32601) return true;
    const msg = e?.message ?? String(err);
    return /-32601|does not exist\/is not available|not enabled on this node|no ".*" subscription/i.test(
        msg,
    );
}
