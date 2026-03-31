import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const rpcErrors = new Counter('rpc_errors');
const rpcSuccessRate = new Rate('rpc_success_rate');
const blockNumberLatency = new Trend('eth_blockNumber_latency', true);
const getBalanceLatency = new Trend('eth_getBalance_latency', true);
const callLatency = new Trend('eth_call_latency', true);
const getCodeLatency = new Trend('eth_getCode_latency', true);

// Configuration - modify these as needed
const RPC_URL = __ENV.RPC_URL || 'http://localhost:8545';
const TEST_ADDRESS = __ENV.TEST_ADDRESS || '0x0000000000000000000000000000000000000000';
const CONTRACT_ADDRESS = __ENV.CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000';

// ERC20 balanceOf selector
const BALANCE_OF_DATA = '0x70a08231000000000000000000000000' + TEST_ADDRESS.slice(2).toLowerCase();

export const options = {
  scenarios: {
    // Scenario 1: Constant load
    constant_load: {
      executor: 'constant-vus',
      vus: 10,
      duration: '30s',
      startTime: '0s',
      tags: { scenario: 'constant' },
    },
    
    // Scenario 2: Ramp up/down
    ramp_up_down: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },   // Ramp up to 50 VUs
        { duration: '1m', target: 50 },    // Stay at 50 VUs
        { duration: '30s', target: 100 },  // Ramp up to 100 VUs
        { duration: '1m', target: 100 },   // Stay at 100 VUs
        { duration: '30s', target: 0 },    // Ramp down to 0
      ],
      startTime: '35s',
      tags: { scenario: 'ramp' },
    },

    // Scenario 3: Spike test
    spike_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 10 },   // Warm up
        { duration: '5s', target: 200 },   // Spike!
        { duration: '30s', target: 200 },  // Hold spike
        { duration: '10s', target: 10 },   // Recover
        { duration: '10s', target: 0 },    // Cool down
      ],
      startTime: '5m',
      tags: { scenario: 'spike' },
    },

    // Scenario 4: Stress test - find breaking point
    stress_test: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '30s', target: 100 },
        { duration: '30s', target: 200 },
        { duration: '30s', target: 300 },
        { duration: '30s', target: 400 },
        { duration: '30s', target: 500 },
        { duration: '1m', target: 0 },
      ],
      startTime: '6m30s',
      tags: { scenario: 'stress' },
    },

    // Scenario 5: Constant arrival rate
    constant_rate: {
      executor: 'constant-arrival-rate',
      rate: 100,              // 100 requests per second
      timeUnit: '1s',
      duration: '1m',
      preAllocatedVUs: 50,
      maxVUs: 200,
      startTime: '10m',
      tags: { scenario: 'constant_rate' },
    },

    // Scenario 6: Ramping arrival rate
    ramping_rate: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 500,
      stages: [
        { duration: '30s', target: 50 },   // 50 RPS
        { duration: '30s', target: 100 },  // 100 RPS
        { duration: '30s', target: 200 },  // 200 RPS
        { duration: '30s', target: 500 },  // 500 RPS
        { duration: '30s', target: 1000 }, // 1000 RPS
        { duration: '30s', target: 0 },
      ],
      startTime: '11m30s',
      tags: { scenario: 'ramping_rate' },
    },
  },

  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    rpc_success_rate: ['rate>0.95'],
    eth_blockNumber_latency: ['p(95)<200'],
    eth_getBalance_latency: ['p(95)<300'],
    eth_call_latency: ['p(95)<500'],
  },
};

// JSON-RPC request helper
function rpcCall(method, params = []) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: method,
    params: params,
    id: Date.now(),
  });

  const response = http.post(RPC_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  return response;
}

// Check if RPC response is valid
function checkRpcResponse(response, methodName) {
  const isSuccess = check(response, {
    [`${methodName} status is 200`]: (r) => r.status === 200,
    [`${methodName} has result`]: (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.result !== undefined && body.error === undefined;
      } catch {
        return false;
      }
    },
  });

  if (!isSuccess) {
    rpcErrors.add(1);
  }
  rpcSuccessRate.add(isSuccess);

  return isSuccess;
}

export default function () {
  // Rotate through different RPC methods
  const iteration = __ITER % 4;

  switch (iteration) {
    case 0: {
      // eth_blockNumber
      const start = Date.now();
      const response = rpcCall('eth_blockNumber');
      blockNumberLatency.add(Date.now() - start);
      checkRpcResponse(response, 'eth_blockNumber');
      break;
    }
    case 1: {
      // eth_getBalance
      const start = Date.now();
      const response = rpcCall('eth_getBalance', [TEST_ADDRESS, 'latest']);
      getBalanceLatency.add(Date.now() - start);
      checkRpcResponse(response, 'eth_getBalance');
      break;
    }
    case 2: {
      // eth_call (balanceOf)
      const start = Date.now();
      const response = rpcCall('eth_call', [
        { to: CONTRACT_ADDRESS, data: BALANCE_OF_DATA },
        'latest'
      ]);
      callLatency.add(Date.now() - start);
      checkRpcResponse(response, 'eth_call');
      break;
    }
    case 3: {
      // eth_getCode
      const start = Date.now();
      const response = rpcCall('eth_getCode', [CONTRACT_ADDRESS, 'latest']);
      getCodeLatency.add(Date.now() - start);
      checkRpcResponse(response, 'eth_getCode');
      break;
    }
  }

  // Small sleep to prevent overwhelming
  sleep(0.01);
}

// Lifecycle hooks
export function setup() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('K6 RPC LOAD TEST');
  console.log('═'.repeat(60));
  console.log(`RPC URL: ${RPC_URL}`);
  console.log(`Test Address: ${TEST_ADDRESS}`);
  console.log(`Contract Address: ${CONTRACT_ADDRESS}`);
  console.log('═'.repeat(60) + '\n');

  // Verify RPC is reachable
  const response = rpcCall('eth_blockNumber');
  if (response.status !== 200) {
    throw new Error(`RPC not reachable: ${response.status}`);
  }
  
  const body = JSON.parse(response.body);
  console.log(`Current block: ${parseInt(body.result, 16)}`);
  
  return { startBlock: body.result };
}

export function teardown(data) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log('LOAD TEST COMPLETE');
  console.log('═'.repeat(60));
  
  const response = rpcCall('eth_blockNumber');
  const body = JSON.parse(response.body);
  const startBlock = parseInt(data.startBlock, 16);
  const endBlock = parseInt(body.result, 16);
  
  console.log(`Blocks processed during test: ${endBlock - startBlock}`);
  console.log('═'.repeat(60) + '\n');
}
