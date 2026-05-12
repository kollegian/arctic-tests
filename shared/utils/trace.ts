// Wraps an awaitable step with start/done/error logging and elapsed-ms
// timing. Use to surface which await is currently in flight when a long
// sequence (e.g. a mocha before-hook) is hung or slow.

export async function trace<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    console.log(`[trace] ${label}...`);
    try {
        const r = await fn();
        console.log(`[trace] ${label} ✓ ${Date.now() - t0}ms`);
        return r;
    } catch (err: any) {
        console.error(`[trace] ${label} ✗ ${Date.now() - t0}ms: ${err?.message ?? err}`);
        throw err;
    }
}
