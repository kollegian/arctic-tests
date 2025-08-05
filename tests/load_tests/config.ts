export const CONFIG = {
  TOTAL_USERS : 750,
  EVM_USERS   : 1000,
  COSMOS_USERS: 100,

  TOTAL_TXS         : 1500,
  INTER_TX_DELAY_MS :   1,

  POLL_INTERVAL_MS  : 2,
  MAX_CONCURRENCY   : 750,

  GAS_LIMIT         : 990_000n,
} as const;
