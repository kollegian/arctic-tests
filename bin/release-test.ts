import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'testConfig.json');
const REPORT_DIR = path.join(REPO_ROOT, 'release-test-report');
const REPORT_PATH = path.join(REPORT_DIR, 'mochawesome.json');

// Test targets partition the suite by what the chain must provide.
// chain-agnostic: tests that set up their own state; safe on any chain.
// state-required: tests that read pre-existing chain state (mainnet/atlantic-2
//   indexer data, hardcoded contract addresses on a specific chain).
// The harness defaults to chain-agnostic. state-required is invoked manually
// against pacific-1 / atlantic-2 by the QA team.
const STATE_REQUIRED_GLOBS = [
  'tests/indexers/**/*.spec.ts',
  'tests/rpc_node_tests/eth_subscribe.spec.ts',
  'tests/chain_tests/pectra_upgrade/**/*.spec.ts',
  'tests/tokens/disable_pointers.spec.ts',
];

const TARGETS = {
  'chain-agnostic': {
    spec: 'tests/**/*.spec.ts',
    ignore: ['tests/confidential_transfers/**', ...STATE_REQUIRED_GLOBS],
  },
  'state-required': {
    spec: `{${STATE_REQUIRED_GLOBS.join(',')}}`,
    ignore: [],
  },
} as const;
type TargetName = keyof typeof TARGETS;

const INFRA_SIGNALS = ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'];

function resolveTarget(): { name: TargetName; spec: string; ignore: readonly string[] } {
  const raw = process.env.TEST_TARGET ?? 'chain-agnostic';
  if (!(raw in TARGETS)) {
    const valid = Object.keys(TARGETS).join(', ');
    throw new Error(`unknown TEST_TARGET ${JSON.stringify(raw)}; expected one of: ${valid}`);
  }
  const name = raw as TargetName;
  return { name, ...TARGETS[name] };
}

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
  target: TargetName;
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

function runDeployFixtures(): Promise<{ exitCode: number; spawnError: Error | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['tsx', 'bin/deploy-fixtures.ts'],
      { cwd: REPO_ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: process.env },
    );
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, spawnError: null }));
    child.on('error', (err) => resolve({ exitCode: 2, spawnError: err }));
  });
}

function runMocha(spec: string, ignore: readonly string[]): Promise<{ exitCode: number; spawnError: Error | null }> {
  return new Promise((resolve) => {
    const ignoreArgs = ignore.flatMap((g) => ['--ignore', g]);
    // requires live in .mocharc.cjs
    const child = spawn(
      'npx',
      [
        'mocha',
        '--reporter', 'mochawesome',
        '--reporter-options', `reportDir=${REPORT_DIR},reportFilename=mochawesome,quiet=true,html=false,json=true`,
        ...ignoreArgs,
        spec,
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
  const target = resolveTarget();
  const { merged, originalRaw } = loadAndOverlayEnv();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + '\n');

  let mochaExit = 1;
  let spawnError: Error | null = null;
  let deployError: Error | null = null;
  try {
    if (target.name === 'state-required') {
      console.log('[release-test] skipped fixture deploy: TEST_TARGET=state-required');
    } else {
      // Spawned: shared/User.ts caches testConfig at module load; the child
      // loads it after the parent overlays env values.
      const dep = await runDeployFixtures();
      if (dep.exitCode !== 0) {
        deployError = dep.spawnError ?? new Error(`deploy-fixtures exited ${dep.exitCode}`);
      }
    }
    if (!deployError) {
      ({ exitCode: mochaExit, spawnError } = await runMocha(target.spec, target.ignore));
    }
  } finally {
    fs.writeFileSync(CONFIG_PATH, originalRaw);
  }

  const report = readReport();
  const verdict: Verdict = deployError
    ? { exitCode: 2, reason: `fixture deploy failed: ${deployError.message ?? deployError}` }
    : classify(mochaExit, spawnError, report);

  const summary: Summary = {
    passed: report?.stats?.passes ?? 0,
    failed: report?.stats?.failures ?? 0,
    pending: report?.stats?.pending ?? 0,
    exitCode: verdict.exitCode,
    reportPath: REPORT_PATH,
    target: target.name,
    ...(verdict.reason ? { error: verdict.reason } : {}),
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exit(verdict.exitCode);
}

main().catch((err) => {
  const target = (process.env.TEST_TARGET ?? 'chain-agnostic') as TargetName;
  const summary: Summary = {
    passed: 0,
    failed: 0,
    pending: 0,
    exitCode: 2,
    reportPath: REPORT_PATH,
    target,
    error: `wrapper crash: ${err}`,
  };
  process.stdout.write(JSON.stringify(summary) + '\n');
  process.exit(2);
});
