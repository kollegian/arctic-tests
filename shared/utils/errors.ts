// Unwraps nested error messages from ethers v6, cosmjs, and JSON-RPC envelopes
// into a " | "-joined string for substring matching in tests.
export function unwrapErrorMessage(e: unknown): string {
    const raw = String((e as any)?.message ?? e);
    const parts: string[] = [raw];

    const ethersV6WrapMatch = raw.match(/error=({[\s\S]*?})\s*(?:,\s*payload=|\))/);
    if (ethersV6WrapMatch) {
        try {
            const inner = JSON.parse(ethersV6WrapMatch[1]);
            if (typeof inner?.message === 'string') parts.push(inner.message);
            if (typeof inner?.data === 'string') parts.push(inner.data);
        } catch {}
    }

    const jsonRpcDataMatch = raw.match(/^\s*{[\s\S]*?"data"\s*:\s*"([^"]*)"/);
    if (jsonRpcDataMatch) parts.push(jsonRpcDataMatch[1]);

    return parts.join(' | ');
}
