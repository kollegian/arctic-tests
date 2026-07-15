/**
 * Raw tx submission that exposes the *synchronous* CheckTx result.
 *
 * On Sei, eth_sendRawTransaction returns the CheckTx error inline. Catching
 * it precisely is the whole game for admission tests, so we use raw fetch
 * rather than ethers' wrappers (which can flatten errors).
 */
export type SendRawResult =
    | { ok: true; hash: string }
    | { ok: false; code: number; message: string; data?: unknown };

export interface SendRawOptions {
    id?: number;
}

let idCounter = 1;

export async function sendRawTransaction(
    evmRpcEndpoint: string,
    signedTx: string,
    opts: SendRawOptions = {},
): Promise<SendRawResult> {
    const id = opts.id ?? idCounter++;
    const res = await fetch(evmRpcEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'eth_sendRawTransaction',
            params: [signedTx],
        }),
    });
    const body = (await res.json()) as {
        result?: string;
        error?: { code: number; message: string; data?: unknown };
    };
    if (body.result) return { ok: true, hash: body.result };
    if (body.error) {
        return {
            ok: false,
            code: body.error.code,
            message: body.error.message,
            data: body.error.data,
        };
    }
    throw new Error('eth_sendRawTransaction returned neither result nor error');
}

/** Submit N signed txs in parallel; preserve per-tx outcomes. */
export async function sendManyRaw(
    evmRpcEndpoint: string,
    signedTxs: string[],
): Promise<SendRawResult[]> {
    return Promise.all(signedTxs.map((tx) => sendRawTransaction(evmRpcEndpoint, tx)));
}
