export type UndecryptedBalance = {
    "public_key": Uint8Array,
    "pending_balance_lo": {
        "c": Uint8Array,
        "d": Uint8Array,
    },
    "pending_balance_hi": {
        "c": Uint8Array,
        "d": Uint8Array,
    },
    "pending_balance_credit_counter": number,
    "available_balance": {
        "c": Uint8Array,
        "d": Uint8Array,
    }
    "decryptable_available_balance": string
}

export type DecryptedBalance = {
    publicKey: string,
    pendingBalanceLo: bigint,
    pendingBalanceHi: bigint,
    totalPendingBalance: bigint,
    pendingBalanceCreditCounter: number,
    availableBalance: string,
    decryptableAvailableBalance: bigint
}
