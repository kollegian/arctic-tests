# RPC Load Tests

## eth_getBalance Load Test

A dedicated load test for the `eth_getBalance` endpoint that derives the address from a private key.

### Quick Start

```bash
# Using the wrapper script (recommended)
./run-load-test.sh

# Or with custom settings
RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... ./run-load-test.sh

# Or directly with k6 (pass address manually)
k6 run -e TEST_ADDRESS=0x44E3ca00494F9F44d92F3612B153419e87b02A39 k6-getBalance.js
```

### Features

- Derives address from private key (supports known test keys)
- Tests `eth_getBalance` with different block tags: `latest`, `pending`, and specific block numbers
- Ramp-up load profile: 10 → 50 → 100 → 200 VUs
- Custom metrics per block tag type
- Validates response format and balance values

---

## k6 Load Tests

### Installation

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### Running Tests

**Simple test (ramp up):**
```bash
k6 run k6-simple.js
```

**With custom RPC URL:**
```bash
k6 run -e RPC_URL=http://localhost:8545 k6-simple.js
```

**With custom addresses:**
```bash
k6 run \
  -e RPC_URL=http://localhost:8545 \
  -e TEST_ADDRESS=0xYourAddress \
  -e CONTRACT_ADDRESS=0xYourContract \
  k6-simple.js
```

**Full test suite:**
```bash
k6 run k6-rpc-load.js
```

### Modifying Load Profiles

Edit `k6-simple.js` and modify the `options` object:

**Constant VUs:**
```javascript
export const options = {
  vus: 100,
  duration: '2m',
};
```

**Ramp up/down:**
```javascript
export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '1m', target: 100 },
    { duration: '30s', target: 0 },
  ],
};
```

**Constant request rate (RPS):**
```javascript
export const options = {
  scenarios: {
    constant_rate: {
      executor: 'constant-arrival-rate',
      rate: 1000,           // 1000 RPS
      timeUnit: '1s',
      duration: '2m',
      preAllocatedVUs: 200,
      maxVUs: 500,
    },
  },
};
```

**Ramping request rate:**
```javascript
export const options = {
  scenarios: {
    ramping_rate: {
      executor: 'ramping-arrival-rate',
      startRate: 100,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { duration: '1m', target: 500 },
        { duration: '1m', target: 1000 },
        { duration: '1m', target: 2000 },
      ],
    },
  },
};
```

### Output Options

**JSON output:**
```bash
k6 run --out json=results.json k6-simple.js
```

**InfluxDB (for Grafana):**
```bash
k6 run --out influxdb=http://localhost:8086/k6 k6-simple.js
```

**Cloud (k6 cloud):**
```bash
k6 cloud k6-simple.js
```

### Key Metrics

| Metric | Description |
|--------|-------------|
| `http_reqs` | Total requests |
| `http_req_duration` | Request latency |
| `http_req_failed` | Failed request rate |
| `vus` | Current virtual users |
| `iterations` | Completed iterations |
| `rpc_success` | Custom: RPC success rate |
| `latency_eth_*` | Custom: Per-method latency |

### Thresholds

Tests fail if thresholds are not met:

```javascript
thresholds: {
  http_req_failed: ['rate<0.05'],      // <5% errors
  http_req_duration: ['p(95)<1000'],   // 95th percentile < 1s
  http_req_duration: ['p(99)<2000'],   // 99th percentile < 2s
  rpc_success: ['rate>0.95'],          // >95% success
}
```

## Mocha Load Tests

For simpler tests without k6:

```bash
npx mocha tests/solo_evm/rpc_tests/load_tests/rpc_load.spec.ts
```
