import {
  QueryClient,
  setupAuthExtension,
  setupAuthzExtension,
  setupBankExtension,
  setupDistributionExtension,
  setupFeegrantExtension,
  setupGovExtension,
  setupMintExtension,
  setupSlashingExtension,
  setupStakingExtension,
} from '@cosmjs/stargate';
import { Tendermint34Client } from '@cosmjs/tendermint-rpc';
import * as seiProto from '@sei-js/proto';
import testConfig from '../../../config/testConfig.json';
import { normalizeRestEndpoint } from '../moduleTestUtils';

// Shape returned by the sei-evm Tendermint-RPC extension. We expose this as a
// proper named extension so consumers can keep using `client.evm.*` the same
// way they use `client.authz.*` etc.
type SeiEvmQuerier = ReturnType<
  typeof seiProto.seiprotocol.seichain.evm.createRpcQueryExtension
>;
export interface SeiEvmExtension {
  readonly evm: SeiEvmQuerier;
}

function setupSeiEvmExtension(base: QueryClient): SeiEvmExtension {
  // @sei-js/proto pins its own copy of @cosmjs/stargate, which means the
  // QueryClient signature there is structurally different (lacks
  // queryStoreVerified, queryRawProof, getNextHeader on the type alias even
  // though they exist at runtime). Cast through `unknown` so this stays a
  // single source of truth without leaking the duplication into call sites.
  return {
    evm: seiProto.seiprotocol.seichain.evm.createRpcQueryExtension(base as unknown as never),
  };
}

// Derive the per-module extension shape from the runtime factory's return
// type — cosmjs exports the factory functions but not the matching interface
// names, so this avoids depending on symbols that aren't always exposed.
type AuthExt = ReturnType<typeof setupAuthExtension>;
type AuthzExt = ReturnType<typeof setupAuthzExtension>;
type BankExt = ReturnType<typeof setupBankExtension>;
type DistributionExt = ReturnType<typeof setupDistributionExtension>;
type FeegrantExt = ReturnType<typeof setupFeegrantExtension>;
type GovExt = ReturnType<typeof setupGovExtension>;
type MintExt = ReturnType<typeof setupMintExtension>;
type SlashingExt = ReturnType<typeof setupSlashingExtension>;
type StakingExt = ReturnType<typeof setupStakingExtension>;

export type ModuleQueryClient = QueryClient &
  AuthExt &
  AuthzExt &
  BankExt &
  DistributionExt &
  FeegrantExt &
  GovExt &
  MintExt &
  SlashingExt &
  StakingExt &
  SeiEvmExtension;

let clientPromise: Promise<ModuleQueryClient> | undefined;

export async function getRpcQueryClient(): Promise<ModuleQueryClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const tm = await Tendermint34Client.connect(testConfig.seiRpcEndpoint);
      return QueryClient.withExtensions(
        tm,
        setupAuthExtension,
        setupAuthzExtension,
        setupBankExtension,
        setupDistributionExtension,
        setupFeegrantExtension,
        setupGovExtension,
        setupMintExtension,
        setupSlashingExtension,
        setupStakingExtension,
        setupSeiEvmExtension,
      ) as ModuleQueryClient;
    })();
  }
  return clientPromise;
}

export const moduleRestEndpoint = normalizeRestEndpoint(testConfig.restEndpoint);

export function warnFallback(label: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.warn(
    `[rpc-fallback] ${label} via Tendermint RPC failed (${reason}); falling back to REST Querier at ${moduleRestEndpoint}`,
  );
}

/**
 * Run an RPC-backed query first; if it throws, log a console.warn and fall
 * back to the equivalent REST Querier call. Both functions must return the
 * same shape (callers are responsible for normalizing inside the rpcFn).
 */
export async function withRestFallback<T>(
  label: string,
  rpcFn: () => Promise<T>,
  restFn: () => Promise<T>,
): Promise<T> {
  try {
    return await rpcFn();
  } catch (err) {
    warnFallback(label, err);
    return await restFn();
  }
}

/**
 * Snake_case keys (after conversion) whose values are Cosmos `Dec` scalars
 * encoded as `bytes` by cosmjs-types. The bytes are the ASCII representation
 * of the Dec value, so decoding them as UTF-8 yields the same kind of string
 * REST returns ("0.500000000000000000", "100000000000000000", etc.).
 */
const COSMOS_DEC_KEYS = new Set<string>([
  'min_signed_per_window',
  'slash_fraction_double_sign',
  'slash_fraction_downtime',
  'min_commission_rate',
  'community_tax',
  'base_proposer_reward',
  'bonus_proposer_reward',
  'rate',
  'max_rate',
  'max_change_rate',
  'inflation_rate_change',
  'inflation_max',
  'inflation_min',
  'goal_bonded',
  'quorum',
  'threshold',
  'veto_threshold',
]);

/**
 * Snake_case keys (after conversion) whose values are protobuf Timestamps
 * `{ seconds, nanos }` which need to surface to the test as RFC3339 strings
 * (matching what the REST gateway emits). Listed explicitly so we don't
 * accidentally convert google.protobuf.Duration objects, which share the
 * same `{ seconds, nanos }` shape.
 */
const TIMESTAMP_KEYS = new Set<string>([
  'jailed_until',
  'unbonding_time',
  'completion_time',
  'update_time',
  'last_total_power_update_time',
  'time',
]);

const utf8Decoder = new TextDecoder();

function decodeDecBytes(bytes: Uint8Array): string {
  return utf8Decoder.decode(bytes);
}

function isTimestampObject(v: any): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 2) return false;
  return keys.includes('seconds') && keys.includes('nanos');
}

function timestampToIso(ts: { seconds: any; nanos: any }): string {
  const secondsNum = typeof ts.seconds === 'bigint' ? Number(ts.seconds) : Number(ts.seconds ?? 0);
  const nanosNum = Number(ts.nanos ?? 0);
  return new Date(secondsNum * 1000 + Math.floor(nanosNum / 1e6)).toISOString();
}

/**
 * Recursively converts an object's keys from camelCase to snake_case so that
 * cosmjs (RPC) responses can be compared against REST-shape assertions that
 * already exist throughout the test suite. Handles arrays, plain objects,
 * Uint8Array (kept as-is unless the field is a known Cosmos Dec, in which
 * case the bytes are decoded to UTF-8), Timestamp objects (converted to
 * RFC3339 strings for known timestamp fields), bigint (stringified the same
 * way REST does), and primitives.
 *
 * `parentKey` lets us key-aware-normalize Dec/Timestamp fields without
 * mis-converting unrelated `Uint8Array`s (e.g. consensus pubkeys) or
 * `Duration` objects that share Timestamp's structural shape.
 */
export function toSnakeCase<T = any>(value: any, parentKey?: string): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => toSnakeCase(v, parentKey)) as any;
  if (value instanceof Uint8Array) {
    if (parentKey && COSMOS_DEC_KEYS.has(parentKey)) {
      return decodeDecBytes(value) as any;
    }
    return value as any;
  }
  if (typeof value === 'bigint') return value.toString() as any;
  if (typeof value !== 'object') return value;

  if (parentKey && TIMESTAMP_KEYS.has(parentKey) && isTimestampObject(value)) {
    return timestampToIso(value as any) as any;
  }

  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(value)) {
    const snakeKey = key.replace(/([A-Z])/g, (m) => `_${m.toLowerCase()}`);
    out[snakeKey] = toSnakeCase(val, snakeKey);
  }
  return out as T;
}
