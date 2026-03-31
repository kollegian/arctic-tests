import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION - Modify these values
// ═══════════════════════════════════════════════════════════════════════════════

const RPC_URL = __ENV.RPC_URL || 'http://localhost:8545';
const TEST_ADDRESS = __ENV.TEST_ADDRESS || '0xF87A299e6bC7bEba58dbBe5a5Aa21d49bCD16D52';
const CONTRACT_ADDRESS = __ENV.CONTRACT_ADDRESS || '0x0000000000000000000000000000000000001005'; // staking precompile

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD PROFILE - Choose one by uncommenting
// ═══════════════════════════════════════════════════════════════════════════════

export const options = {
  // ─────────────────────────────────────────────────────────────────────────────
  // Option 1: Simple constant VUs
  // ─────────────────────────────────────────────────────────────────────────────
  // vus: 50,
  // duration: '1m',

  // ─────────────────────────────────────────────────────────────────────────────
  // Option 2: Ramp up test
  // ─────────────────────────────────────────────────────────────────────────────
  stages: [
    { duration: '10s', target: 10 },   // Warm up
    { duration: '20s', target: 50 },   // Ramp to 50
    { duration: '30s', target: 50 },   // Hold 50
    { duration: '20s', target: 100 },  // Ramp to 100
    { duration: '30s', target: 100 },  // Hold 100
    { duration: '20s', target: 200 },  // Ramp to 200
    { duration: '30s', target: 200 },  // Hold 200
    { duration: '20s', target: 0 },    // Ramp down
  ],

  // ─────────────────────────────────────────────────────────────────────────────
  // Option 3: Constant request rate (uncomment and comment out stages above)
  // ─────────────────────────────────────────────────────────────────────────────
  // scenarios: {
  //   constant_rate: {
  //     executor: 'constant-arrival-rate',
  //     rate: 500,              // 500 requests per second
  //     timeUnit: '1s',
  //     duration: '2m',
  //     preAllocatedVUs: 100,
  //     maxVUs: 500,
  //   },
  // },

  // ─────────────────────────────────────────────────────────────────────────────
  // Thresholds - test fails if these are not met
  // ─────────────────────────────────────────────────────────────────────────────
  thresholds: {
    http_req_failed: ['rate<0.05'],           // <5% errors
    http_req_duration: ['p(95)<1000'],        // 95% of requests < 1s
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════════════════════

const rpcErrors = new Counter('rpc_errors');
const rpcSuccess = new Rate('rpc_success');

const latencyBlockNumber = new Trend('latency_eth_blockNumber', true);
const latencyGetBalance = new Trend('latency_eth_getBalance', true);
const latencyCall = new Trend('latency_eth_call', true);
const latencyGetCode = new Trend('latency_eth_getCode', true);

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function rpcRequest(method, params = []) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: method,
    params: params,
    id: __ITER,
  });

  return http.post(RPC_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { rpc_method: method },
  });
}

function validateResponse(response, method) {
  let success = response.status === 200;
  
  if (success) {
    try {
      const body = JSON.parse(response.body);
      success = body.result !== undefined && !body.error;
    } catch {
      success = false;
    }
  }

  if (!success) {
    rpcErrors.add(1);
  }
  rpcSuccess.add(success);

  return success;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

export default function () {
  const method = __ITER % 4;

  let start, response;

  switch (method) {
    case 0:
      start = Date.now();
      response = rpcRequest('eth_blockNumber');
      latencyBlockNumber.add(Date.now() - start);
      validateResponse(response, 'eth_blockNumber');
      break;

    case 1:
      start = Date.now();
      response = rpcRequest('eth_getBalance', [TEST_ADDRESS, 'latest']);
      latencyGetBalance.add(Date.now() - start);
      validateResponse(response, 'eth_getBalance');
      break;

    case 2:
      start = Date.now();
      response = rpcRequest('eth_call', [
        { to: CONTRACT_ADDRESS, data: '0x' },
        'latest'
      ]);
      latencyCall.add(Date.now() - start);
      validateResponse(response, 'eth_call');
      break;

    case 3:
      start = Date.now();
      response = rpcRequest('eth_getCode', [CONTRACT_ADDRESS, 'latest']);
      latencyGetCode.add(Date.now() - start);
      validateResponse(response, 'eth_getCode');
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

export function setup() {
  console.log('\n' + '═'.repeat(70));
  console.log('K6 RPC LOAD TEST');
  console.log('═'.repeat(70));
  console.log(`RPC URL:          ${RPC_URL}`);
  console.log(`Test Address:     ${TEST_ADDRESS}`);
  console.log(`Contract Address: ${CONTRACT_ADDRESS}`);
  console.log('═'.repeat(70) + '\n');

  // Verify connectivity
  const res = rpcRequest('eth_blockNumber');
  check(res, { 'RPC reachable': (r) => r.status === 200 });
  
  if (res.status !== 200) {
    throw new Error('Cannot connect to RPC');
  }

  const block = JSON.parse(res.body).result;
  console.log(`Starting block: ${parseInt(block, 16)}\n`);

  return { startBlock: block };
}

export function teardown(data) {
  const res = rpcRequest('eth_blockNumber');
  const endBlock = JSON.parse(res.body).result;

  console.log('\n' + '═'.repeat(70));
  console.log('TEST COMPLETE');
  console.log('═'.repeat(70));
  console.log(`Start block: ${parseInt(data.startBlock, 16)}`);
  console.log(`End block:   ${parseInt(endBlock, 16)}`);
  console.log(`Blocks:      ${parseInt(endBlock, 16) - parseInt(data.startBlock, 16)}`);
  console.log('═'.repeat(70) + '\n');
}
