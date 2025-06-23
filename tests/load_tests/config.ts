export const CONFIG = {
  TOTAL_USERS : 1000,
  EVM_USERS   : 500,
  COSMOS_USERS: 500,

  TOTAL_TXS         : 5000,
  INTER_TX_DELAY_MS :   2,

  POLL_INTERVAL_MS  : 20,
  MAX_CONCURRENCY   : 400,

  GAS_LIMIT         : 900_000n,
} as const;
