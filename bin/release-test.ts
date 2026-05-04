import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'testConfig.json');
const REPORT_DIR = path.join(REPO_ROOT, 'release-test-report');
const REPORT_PATH = path.join(REPORT_DIR, 'mochawesome.json');
const SPEC_GLOB = 'tests/**/*.spec.ts';

const INFRA_SIGNALS = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'];

interface TestConfig {
  adminAddress: string;
  seiRpcEndpoint: string;
  evmRpcEndpoint: string;
  restEndpoint: string;
  adminMnemonic: string;
}

interface MochawesomeReport {
  stats?: { passes?: number; failures?: number; pending?: number };
  results?: Array<{ suites?: Array<{ tests?: Array<{ err?: { message?: string; code?: string } }> }> }>;
}

interface Verdict {
  exitCode: 0 | 1 | 2;
  reason?: string;
}

interface Summary {
  passed: number;
  failed: number;
  pending: number;
  exitCode: number;
  reportPath: string;
  error?: string;
}

function loadAndOverlayEnv(): { merged: TestConfig; originalRaw: string } {
  const originalRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const config: TestConfig = JSON.parse(originalRaw);
  if (process.env.SEI_TENDERMINT_RPC) config.seiRpcEndpoint = process.env.SEI_TENDERMINT_RPC;
  if (process.env.SEI_EVM_JSON_RPC) config.evmRpcEndpoint = process.env.SEI_EVM_JSON_RPC;
  if (process.env.SEI_REST_ENDPOINT) config.restEndpoint = process.env.SEI_REST_ENDPOINT;
  if (process.env.SEI_ADMIN_MNEMONIC) config.adminMnemonic = process.env.SEI_ADMIN_MNEMONIC;
  return { merged: config, originalRaw };
}

function runMocha(): Promise<{ exitCode: number; spawnError: Error | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      [
        'mocha',
        '--require', 'ts-node/register',
        '--reporter', 'mochawesome',
        '--reporter-options', `reportDir=${REPORT_DIR},reportFilename=mochawesome,quiet=true,html=false,json=true`,
        SPEC_GLOB,
      ],
      { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
    );
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, spawnError: null }));
    child.on('error', (err) => resolve({ exitCode: 2, spawnError: err }));
  });
}

function readReport(): MochawesomeReport | null {
  try {
    return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function classify(mochaExit: number, spawnError: Error | null, report: MochawesomeReport | null): Verdict {
  if (spawnError) return { exitCode: 2, reason: `mocha spawn failed: ${spawnError.message}` };
  if (report === null) return { exitCode: 2, reason: 'mocha did not produce a report' };
  if (hasInfraSignal(report)) return { exitCode: 2, reason: 'rpc dial failure during test setup' };
  if ((report.stats?.failures ?? 0) > 0) return { exitCode: 1 };
  if (mochaExit !== 0) return { exitCode: 2, reason: `mocha exited ${mochaExit} with no parsed failures` };
  return { exitCode: 0 };
}

function hasInfraSignal(report: MochawesomeReport): boolean {
  for (const r of report.results ?? []) {
    for (const s of r.suites ?? []) {
      for (const t of s.tests ?? []) {
        const msg = t.err?.message ?? '';
        const code = t.err?.code ?? '';
        if (INFRA_SIGNALS.some((p) => msg.includes(p) || code === p)) return true;
      }
    }
  }
  return false;
}

async function main() {
  const { merged, originalRaw } = loadAndOverlayEnv();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');

  let mochaExit = 1;
  let spawnError: Error | null = null;
  try {
    ({ exitCode: mochaExit, spawnError } = await runMocha());
  } finally {
    fs.writeFileSync(CONFIG_PATH, originalRaw);
  }

  const report = readReport();
  const verdict = classify(mochaExit, spawnError, report);

  const summary: Summary = {
    passed: report?.stats?.passes ?? 0,
    failed: report?.stats?.failures ?? 0,
    pending: report?.stats?.pending ?? 0,
    exitCode: verdict.exitCode,
    reportPath: REPORT_PATH,
    ...(verdict.reason ? { error: verdict.reason } : {}),
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exit(verdict.exitCode);
}

main().catch((err) => {
  const summary: Summary = {
    passed: 0,
    failed: 0,
    pending: 0,
    exitCode: 2,
    reportPath: REPORT_PATH,
    error: `wrapper crash: ${err}`,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exit(2);
});
