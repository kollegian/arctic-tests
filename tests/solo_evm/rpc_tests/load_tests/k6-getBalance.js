import http from 'k6/http';
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const RPC_URL = __ENV.RPC_URL || 'http://127.0.0.1:8545';
const PRIVATE_KEY = __ENV.PRIVATE_KEY || '2bd96f4b341d7e26afbfabafdaae89b6c67cdd8076517181d11b30faa2412f8e';

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVE ADDRESS FROM PRIVATE KEY
// ═══════════════════════════════════════════════════════════════════════════════

function hexToBytes(hex) {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function keccak256Simple(data) {
  // k6 doesn't have keccak256, so we'll compute address in setup using RPC
  return null;
}

// We'll derive the address using eth_accounts or compute it in setup
let TEST_ADDRESS = __ENV.TEST_ADDRESS || '';

// ═══════════════════════════════════════════════════════════════════════════════
// METRICS
// ═══════════════════════════════════════════════════════════════════════════════

const rpcErrors = new Counter('rpc_errors');
const rpcSuccess = new Rate('rpc_success');
const getBalanceLatency = new Trend('eth_getBalance_latency', true);

// Track by block tag
const latencyLatest = new Trend('latency_latest', true);
const latencyPending = new Trend('latency_pending', true);
const latencyByNumber = new Trend('latency_by_number', true);

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

export const options = {
  // Ramp up test
  stages: [
    { duration: '10s', target: 10 },
    { duration: '20s', target: 50 },
    { duration: '30s', target: 400 },
    { duration: '20s', target: 1000 },
    { duration: '30s', target: 1000 },
    { duration: '20s', target: 1000 },
    { duration: '30s', target: 200 },
    { duration: '20s', target: 20 },
  ],

  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    rpc_success: ['rate>0.95'],
    eth_getBalance_latency: ['p(95)<300'],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

let requestId = 0;

function rpcRequest(method, params = []) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    method: method,
    params: params,
    id: ++requestId,
  });

  return http.post(RPC_URL, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { rpc_method: method },
  });
}

function validateResponse(response) {
  let success = response.status === 200;
  let result = null;

  if (success) {
    try {
      const body = JSON.parse(response.body);
      success = body.result !== undefined && !body.error;
      result = body.result;
    } catch {
      success = false;
    }
  }

  if (!success) {
    rpcErrors.add(1);
  }
  rpcSuccess.add(success);

  return { success, result };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP - Derive address from private key
// ═══════════════════════════════════════════════════════════════════════════════

export function setup() {
  console.log('\n' + '═'.repeat(70));
  console.log('K6 eth_getBalance LOAD TEST');
  console.log('═'.repeat(70));
  console.log(`RPC URL:     ${RPC_URL}`);
  console.log(`Private Key: ${PRIVATE_KEY.slice(0, 10)}...${PRIVATE_KEY.slice(-6)}`);

  // Derive address from private key using personal_importRawKey or compute it
  // Since k6 doesn't have secp256k1, we'll use a workaround:
  // Option 1: Use eth_accounts if the key is already imported
  // Option 2: Pass address as env var
  // Option 3: Use a known test address

  let address = TEST_ADDRESS;

  if (!address) {
    // Try to get address from private key using a signing trick
    // We'll sign a message and recover, but k6 doesn't support this natively
    // So we'll use a hardcoded mapping for common test keys

    const knownKeys = {
      // Hardhat default accounts
      'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80': '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d': '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a': '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
      // Sei local test key
      '2bd96f4b341d7e26afbfabafdaae89b6c67cdd8076517181d11b30faa2412f8e': '0x44E3ca00494F9F44d92F3612B153419e87b02A39',
    };

    const cleanKey = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY.slice(2) : PRIVATE_KEY;
    address = knownKeys[cleanKey.toLowerCase()];

    if (!address) {
      // If not a known key, try eth_accounts
      const accountsRes = rpcRequest('eth_accounts');
      if (accountsRes.status === 200) {
        const accounts = JSON.parse(accountsRes.body).result;
        if (accounts && accounts.length > 0) {
          address = accounts[0];
        }
      }
    }

    if (!address) {
      throw new Error('Could not derive address. Please provide TEST_ADDRESS env var.');
    }
  }

  console.log(`Address:     ${address}`);

  // Verify RPC connectivity
  const blockRes = rpcRequest('eth_blockNumber');
  check(blockRes, { 'RPC reachable': (r) => r.status === 200 });

  if (blockRes.status !== 200) {
    throw new Error('Cannot connect to RPC');
  }

  const currentBlock = parseInt(JSON.parse(blockRes.body).result, 16);
  console.log(`Block:       ${currentBlock}`);

  // Get initial balance
  const balanceRes = rpcRequest('eth_getBalance', [address, 'latest']);
  const balance = JSON.parse(balanceRes.body).result;
  const balanceEth = parseInt(balance, 16) / 1e18;
  console.log(`Balance:     ${balanceEth.toFixed(4)} ETH`);

  console.log('═'.repeat(70) + '\n');

  return {
    address: address,
    startBlock: currentBlock,
    startBalance: balance,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TEST
// ═══════════════════════════════════════════════════════════════════════════════

export default function (data) {
  const address = data.address;
  const variant = __ITER % 3;

  let start, response, blockTag;

  switch (variant) {
    case 0:
      // Query with 'latest'
      blockTag = 'latest';
      start = Date.now();
      response = rpcRequest('eth_getBalance', [address, 'latest']);
      latencyLatest.add(Date.now() - start);
      break;

    case 1:
      // Query with 'pending'
      blockTag = 'pending';
      start = Date.now();
      response = rpcRequest('eth_getBalance', [address, 'pending']);
      latencyPending.add(Date.now() - start);
      break;

    case 2:
      // Query with specific block number
      blockTag = 'block_number';
      const blockNum = '0x' + (data.startBlock - Math.floor(Math.random() * 10)).toString(16);
      start = Date.now();
      response = rpcRequest('eth_getBalance', [address, blockNum]);
      latencyByNumber.add(Date.now() - start);
      break;
  }

  const latency = Date.now() - start;
  getBalanceLatency.add(latency);

  const { success, result } = validateResponse(response);

  // Validate balance is a valid hex
  if (success) {
    check(response, {
      'balance is hex': () => result && result.startsWith('0x'),
      'balance is non-negative': () => {
        const val = parseInt(result, 16);
        return val >= 0;
      },
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEARDOWN
// ═══════════════════════════════════════════════════════════════════════════════

export function teardown(data) {
  const blockRes = rpcRequest('eth_blockNumber');
  const endBlock = parseInt(JSON.parse(blockRes.body).result, 16);

  const balanceRes = rpcRequest('eth_getBalance', [data.address, 'latest']);
  const endBalance = JSON.parse(balanceRes.body).result;
  const endBalanceEth = parseInt(endBalance, 16) / 1e18;

  console.log('\n' + '═'.repeat(70));
  console.log('TEST COMPLETE');
  console.log('═'.repeat(70));
  console.log(`Address:       ${data.address}`);
  console.log(`Start Block:   ${data.startBlock}`);
  console.log(`End Block:     ${endBlock}`);
  console.log(`Blocks:        ${endBlock - data.startBlock}`);
  console.log(`End Balance:   ${endBalanceEth.toFixed(4)} ETH`);
  console.log('═'.repeat(70) + '\n');
}
