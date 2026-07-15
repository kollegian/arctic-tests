import { expect } from 'chai';
import { DeliverTxResponse } from '@cosmjs/stargate';
import { ExecuteResult } from '@cosmjs/cosmwasm-stargate';

export function expectTxSuccess(tx: DeliverTxResponse | ExecuteResult | { code?: number; transactionHash?: string }, label = 'transaction') {
  if ('code' in tx) {
    expect(tx.code, `${label} should succeed`).to.eq(0);
    return;
  }

  expect(tx.transactionHash, `${label} transaction hash`).to.match(/^[A-F0-9]{64}$/i);
}

export function expectTxFailure(tx: DeliverTxResponse | { code?: number; rawLog?: string; raw_log?: string }, expectedMessage?: string) {
  expect(tx.code, 'transaction should fail').to.not.eq(0);
  if (expectedMessage) {
    const failed = tx as MaybeTxResult;
    const rawLog = failed.rawLog ?? failed.raw_log ?? '';
    expect(rawLog, 'failure log').to.contain(expectedMessage);
  }
}

type MaybeTxResult = { code?: number; rawLog?: string; raw_log?: string };

/**
 * Awaits an operation that is expected to fail and fails the test if it
 * succeeds. Handles both failure modes of cosmjs/CLI flows: a rejected
 * promise (CheckTx errors, exec failures) and a resolved DeliverTxResponse
 * carrying a non-zero code. Never use `expect.fail` inside a `try` whose own
 * `catch` asserts on the error — the AssertionError gets swallowed and the
 * test passes vacuously; use this helper instead.
 *
 * Returns the failure message (error message or raw log) for further
 * assertions at the call site.
 */
export async function expectFailure(
  operation: Promise<unknown>,
  expectedMessage?: string,
  label = 'operation'
): Promise<string> {
  let result: unknown;
  try {
    result = await operation;
  } catch (e: any) {
    const message: string = e?.message ?? String(e);
    if (expectedMessage) {
      expect(message, `${label} failure message`).to.contain(expectedMessage);
    }
    return message;
  }

  const tx = result as MaybeTxResult | null | undefined;
  if (tx && typeof tx.code === 'number' && tx.code !== 0) {
    const rawLog = tx.rawLog ?? tx.raw_log ?? '';
    if (expectedMessage) {
      expect(rawLog, `${label} failure log`).to.contain(expectedMessage);
    }
    return rawLog;
  }

  return expect.fail(`${label} should have failed but succeeded`);
}

export function expectUseiCoin(coin: { denom?: string; amount?: string }, expectedAmount?: string | number | bigint) {
  expect(coin.denom, 'coin denom').to.eq('usei');
  expect(coin.amount, 'coin amount').to.match(/^[0-9]+$/);
  if (expectedAmount !== undefined) {
    expect(BigInt(coin.amount!), 'coin amount').to.eq(BigInt(expectedAmount));
  }
}

export function expectUseiBalanceDelta(
  before: { amount?: string },
  after: { amount?: string },
  expectedDelta: string | number | bigint,
  label = 'usei balance delta'
) {
  expect(before.amount, `${label} before amount`).to.match(/^[0-9]+$/);
  expect(after.amount, `${label} after amount`).to.match(/^[0-9]+$/);
  expect(BigInt(after.amount!) - BigInt(before.amount!), label).to.eq(BigInt(expectedDelta));
}

export function expectSeiAddress(address: string, label = 'sei address') {
  expect(address, label).to.match(/^sei1[0-9a-z]+$/);
}

export function expectValoperAddress(address: string, label = 'validator address') {
  expect(address, label).to.match(/^seivaloper1[0-9a-z]+$/);
}

export function expectNonEmptyArray<T>(value: T[], label: string) {
  expect(value, label).to.be.an('array');
  expect(value.length, `${label} length`).to.be.greaterThan(0);
}

export function normalizeRestEndpoint(endpoint: string) {
  const trimmed = endpoint.replace(/\/$/, '');
  if (trimmed.endsWith('/tm')) {
    return trimmed.slice(0, -3) + '/rest';
  }
  return trimmed;
}
