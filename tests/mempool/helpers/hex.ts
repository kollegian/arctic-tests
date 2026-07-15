type PrefixMode = 'required' | 'optional' | 'forbidden';

function isHexString(
    value: unknown,
    opts: { length?: number; prefix?: PrefixMode } = {},
): boolean {
    if (typeof value !== 'string') return false;
    const prefix = opts.prefix ?? 'required';
    let body: string;
    if (value.startsWith('0x')) {
        if (prefix === 'forbidden') return false;
        body = value.slice(2);
    } else {
        if (prefix === 'required') return false;
        body = value;
    }
    if (body.length === 0) return false;
    if (opts.length !== undefined && body.length !== opts.length) return false;
    return /^[0-9a-fA-F]+$/.test(body);
}

/** 32-byte EVM tx hash or block hash: 0x + 64 hex chars (any case). */
export function isHash(value: unknown): boolean {
    return isHexString(value, { length: 64, prefix: 'required' });
}

/** 20-byte EVM address: 0x + 40 hex chars (any case). */
export function isAddress(value: unknown): boolean {
    return isHexString(value, { length: 40, prefix: 'required' });
}

/**
 * Cosmos tx hash: 32 bytes, conventionally without the 0x prefix but
 * sometimes shown with one. Accepts both shapes.
 */
export function isCosmosTxHash(value: unknown): boolean {
    return isHexString(value, { length: 64, prefix: 'optional' });
}

/** Any non-empty 0x-prefixed hex string (e.g. RPC-encoded nonce keys). */
export function isHexUint(value: unknown): boolean {
    return isHexString(value, { prefix: 'required' });
}
