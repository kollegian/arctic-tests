/**
 * Raw EVM (EIP-1559 / type-2) transaction signer that bypasses ethers'
 * high-level Wallet / Transaction / Signature classes.
 *
 * Why this exists: ethers' Signature.from() enforces EIP-2 low-s and
 * Transaction.serialized re-validates on the way out, which makes it
 * impossible to deliver a deliberately-non-canonical or otherwise
 * malformed signature to the chain. For wire-level negative tests we
 * want to construct exactly what we send and let Sei's CheckTx decide.
 *
 * We still use ethers' `encodeRlp` because it's a pure, audited
 * encoder with no validation surface — the part of ethers that gets
 * in the way is only the high-level Wallet/Transaction/Signature
 * classes, not the byte-level RLP helper.
 *
 * Signing is done with @noble/curves' raw secp256k1 and hashing with
 * @noble/hashes' keccak_256, so the cryptography path is fully
 * library-independent from ethers.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { encodeRlp, toBeHex } from 'ethers';

/** Curve order N. EIP-2 requires s <= N/2 ("low-s"). */
export const SECP256K1_N = secp256k1.CURVE.n;

export interface Type2Fields {
    chainId: bigint;
    nonce: bigint;
    maxPriorityFeePerGas: bigint;
    maxFeePerGas: bigint;
    gasLimit: bigint;
    /** 0x-prefixed 20-byte address, or '0x' for contract creation. */
    to: string;
    value: bigint;
    /** 0x-prefixed calldata. */
    data: string;
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (clean.length % 2 !== 0) {
        throw new Error(`odd-length hex: ${hex}`);
    }
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/** Encode an unsigned bigint as RLP's minimal big-endian form (0 -> empty). */
function rlpInt(v: bigint): string {
    return v === 0n ? '0x' : toBeHex(v);
}

function unsignedType2(fields: Type2Fields): string {
    const rlp = encodeRlp([
        rlpInt(fields.chainId),
        rlpInt(fields.nonce),
        rlpInt(fields.maxPriorityFeePerGas),
        rlpInt(fields.maxFeePerGas),
        rlpInt(fields.gasLimit),
        fields.to,
        rlpInt(fields.value),
        fields.data,
        [],
    ]);
    return '0x02' + rlp.slice(2);
}

function signedType2(
    fields: Type2Fields,
    r: bigint,
    s: bigint,
    yParity: number,
): string {
    const rlp = encodeRlp([
        rlpInt(fields.chainId),
        rlpInt(fields.nonce),
        rlpInt(fields.maxPriorityFeePerGas),
        rlpInt(fields.maxFeePerGas),
        rlpInt(fields.gasLimit),
        fields.to,
        rlpInt(fields.value),
        fields.data,
        [],
        rlpInt(BigInt(yParity)),
        rlpInt(r),
        rlpInt(s),
    ]);
    return '0x02' + rlp.slice(2);
}

/** Sign the type-2 sighash with a raw private key. Returns (r, s, recovery). */
function rawSign(
    privateKeyHex: string,
    fields: Type2Fields,
): { r: bigint; s: bigint; recovery: 0 | 1 } {
    const unsigned = unsignedType2(fields);
    const sighash = keccak_256(hexToBytes(unsigned));
    const pk = hexToBytes(privateKeyHex);
    const sig = secp256k1.sign(sighash, pk);
    return {
        r: sig.r,
        s: sig.s,
        recovery: sig.recovery as 0 | 1,
    };
}

/**
 * Standard low-s signed type-2 tx, hex-encoded for eth_sendRawTransaction.
 * Equivalent in outcome to ethers' Wallet.signTransaction, but assembled
 * by hand so we can swap out individual signature components.
 */
export function signType2Raw(
    privateKeyHex: string,
    fields: Type2Fields,
): string {
    const { r, s, recovery } = rawSign(privateKeyHex, fields);
    return signedType2(fields, r, s, recovery);
}

/**
 * Type-2 tx signed with a non-canonical high-s value (s' = N - s).
 *
 * Negating s mod N inverts the recovered point's y coordinate, so the
 * recovery bit is flipped to preserve which key recovers. The resulting
 * tx is parseable by any RLP-aware client but violates EIP-2; strict
 * chains must reject it.
 */
export function signType2WithHighS(
    privateKeyHex: string,
    fields: Type2Fields,
): string {
    const { r, s, recovery } = rawSign(privateKeyHex, fields);
    const highS = SECP256K1_N - s;
    const flipped = (recovery === 0 ? 1 : 0) as 0 | 1;
    return signedType2(fields, r, highS, flipped);
}

/**
 * Sign correctly, then splice arbitrary signature components into the wire
 * encoding. Lets negative tests deliver e.g. r=0/s=0 or an out-of-range
 * yParity while everything else about the tx stays canonical.
 */
export interface SignatureOverride {
    r?: bigint;
    s?: bigint;
    yParity?: number;
}

export function signType2WithSignatureOverride(
    privateKeyHex: string,
    fields: Type2Fields,
    override: SignatureOverride,
): string {
    const { r, s, recovery } = rawSign(privateKeyHex, fields);
    return signedType2(
        fields,
        override.r ?? r,
        override.s ?? s,
        override.yParity ?? recovery,
    );
}
