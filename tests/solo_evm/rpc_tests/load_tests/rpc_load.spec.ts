import { expect } from 'chai';
import { ethers } from 'ethers';
import { User } from '../../shared/User';
import { TxBuilder } from '../../shared';
import { UserFactory as SeiUserFactory } from '../../../../shared/User';
import { getNetwork } from '../../config';

const network = getNetwork('local');
const RPC_URL = network.url;

interface LoadTestResult {
  totalRequests: number;
  successCount: number;
  failCount: number;
  totalDurationMs: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  requestsPerSecond: number;
  errors: Map<string, number>;
}

interface RequestResult {
  success: boolean;
  latencyMs: number;
  error?: string;
}

async function measureRequest(fn: () => Promise<any>): Promise<RequestResult> {
  const start = Date.now();
  try {
    await fn();
    return { success: true, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { success: false, latencyMs: Date.now() - start, error: e.message?.slice(0, 100) || 'Unknown error' };
  }
}

function calculatePercentile(sortedLatencies: number[], percentile: number): number {
  const index = Math.ceil((percentile / 100) * sortedLatencies.length) - 1;
  return sortedLatencies[Math.max(0, index)];
}

function analyzeResults(results: RequestResult[]): LoadTestResult {
  const successResults = results.filter(r => r.success);
  const failResults = results.filter(r => !r.success);
  
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const totalDuration = Math.max(...results.map(r => r.latencyMs));
  
  const errors = new Map<string, number>();
  for (const r of failResults) {
    const key = r.error || 'Unknown';
    errors.set(key, (errors.get(key) || 0) + 1);
  }

  return {
    totalRequests: results.length,
    successCount: successResults.length,
    failCount: failResults.length,
    totalDurationMs: totalDuration,
    avgLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    minLatencyMs: latencies[0],
    maxLatencyMs: latencies[latencies.length - 1],
    p50LatencyMs: calculatePercentile(latencies, 50),
    p95LatencyMs: calculatePercentile(latencies, 95),
    p99LatencyMs: calculatePercentile(latencies, 99),
    requestsPerSecond: (results.length / totalDuration) * 1000,
    errors,
  };
}

function printResults(name: string, result: LoadTestResult): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`LOAD TEST: ${name}`);
  console.log('═'.repeat(60));
  console.log(`Total Requests:    ${result.totalRequests}`);
  console.log(`Success:           ${result.successCount} (${((result.successCount / result.totalRequests) * 100).toFixed(2)}%)`);
  console.log(`Failed:            ${result.failCount} (${((result.failCount / result.totalRequests) * 100).toFixed(2)}%)`);
  console.log(`─`.repeat(60));
  console.log(`Total Duration:    ${result.totalDurationMs.toFixed(0)} ms`);
  console.log(`Requests/sec:      ${result.requestsPerSecond.toFixed(2)}`);
  console.log(`─`.repeat(60));
  console.log(`Latency (ms):`);
  console.log(`  Min:             ${result.minLatencyMs.toFixed(0)}`);
  console.log(`  Avg:             ${result.avgLatencyMs.toFixed(0)}`);
  console.log(`  P50:             ${result.p50LatencyMs.toFixed(0)}`);
  console.log(`  P95:             ${result.p95LatencyMs.toFixed(0)}`);
  console.log(`  P99:             ${result.p99LatencyMs.toFixed(0)}`);
  console.log(`  Max:             ${result.maxLatencyMs.toFixed(0)}`);
  
  if (result.errors.size > 0) {
    console.log(`─`.repeat(60));
    console.log(`Errors:`);
    for (const [error, count] of result.errors) {
      console.log(`  ${count}x: ${error.slice(0, 50)}`);
    }
  }
  console.log('═'.repeat(60));
}

describe('RPC Load Tests', function () {
  this.timeout(5 * 60 * 1000);

  let provider: ethers.JsonRpcProvider;
  let funder: User;
  let alice: User;
  let txBuilder: TxBuilder;
  let erc20Address: string;

  before(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);

    const admin = await SeiUserFactory.createAdminUser();
    const seiUsers = await SeiUserFactory.createSeiUsers(admin, 1);

    funder = await User.fromPrivateKey(admin.evmWallet.wallet.privateKey, RPC_URL);
    alice = await User.fromPrivateKey(seiUsers[0].evmWallet.wallet.privateKey, RPC_URL);

    txBuilder = new TxBuilder([alice]);
    const erc20 = await txBuilder.deployErc20(funder);
    erc20Address = await erc20.getAddress();
  });

  describe('eth_blockNumber load test', function () {

    it('handles 100 concurrent requests', async () => {
      const requests = Array(100).fill(null).map(() => 
        measureRequest(() => provider.getBlockNumber())
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_blockNumber (100 concurrent)', analysis);
      expect(analysis.successCount).to.equal(100);
    });

    it('handles 500 concurrent requests', async () => {
      const requests = Array(500).fill(null).map(() => 
        measureRequest(() => provider.getBlockNumber())
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_blockNumber (500 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.95);
    });

    it('handles 1000 concurrent requests', async () => {
      const requests = Array(1000).fill(null).map(() => 
        measureRequest(() => provider.getBlockNumber())
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_blockNumber (1000 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.90);
    });

  });

  describe('eth_getBalance load test', function () {

    it('handles 100 concurrent requests', async () => {
      const requests = Array(100).fill(null).map(() => 
        measureRequest(() => provider.getBalance(alice.address))
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_getBalance (100 concurrent)', analysis);
      expect(analysis.successCount).to.equal(100);
    });

    it('handles 500 concurrent requests', async () => {
      const requests = Array(500).fill(null).map(() => 
        measureRequest(() => provider.getBalance(alice.address))
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_getBalance (500 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.95);
    });

    it('handles 1000 concurrent requests', async () => {
      const requests = Array(1000).fill(null).map(() => 
        measureRequest(() => provider.getBalance(alice.address))
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_getBalance (1000 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.90);
    });

  });

  describe('eth_call load test', function () {

    it('handles 100 concurrent requests', async () => {
      const iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const data = iface.encodeFunctionData('balanceOf', [alice.address]);

      const requests = Array(100).fill(null).map(() => 
        measureRequest(() => provider.call({ to: erc20Address, data }))
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_call balanceOf (100 concurrent)', analysis);
      expect(analysis.successCount).to.equal(100);
    });

    it('handles 500 concurrent requests', async () => {
      const iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const data = iface.encodeFunctionData('balanceOf', [alice.address]);

      const requests = Array(500).fill(null).map(() => 
        measureRequest(() => provider.call({ to: erc20Address, data }))
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_call balanceOf (500 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.95);
    });

    it('handles 1000 concurrent requests', async () => {
      const iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const data = iface.encodeFunctionData('balanceOf', [alice.address]);

      const requests = Array(1000).fill(null).map(() => 
        measureRequest(() => provider.call({ to: erc20Address, data }))
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_call balanceOf (1000 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.90);
    });

  });

  describe('eth_getCode load test', function () {

    it('handles 1000 concurrent requests', async () => {
      const requests = Array(1000).fill(null).map(() => 
        measureRequest(() => provider.getCode(erc20Address))
      );
      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('eth_getCode (1000 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.90);
    });

  });

  describe('Mixed RPC load test', function () {

    it('handles 1000 mixed concurrent requests', async () => {
      const iface = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const data = iface.encodeFunctionData('balanceOf', [alice.address]);

      const requests: Promise<RequestResult>[] = [];
      
      for (let i = 0; i < 1000; i++) {
        const requestType = i % 4;
        switch (requestType) {
          case 0:
            requests.push(measureRequest(() => provider.getBlockNumber()));
            break;
          case 1:
            requests.push(measureRequest(() => provider.getBalance(alice.address)));
            break;
          case 2:
            requests.push(measureRequest(() => provider.call({ to: erc20Address, data })));
            break;
          case 3:
            requests.push(measureRequest(() => provider.getCode(erc20Address)));
            break;
        }
      }

      const results = await Promise.all(requests);
      const analysis = analyzeResults(results);
      
      printResults('Mixed RPCs (1000 concurrent)', analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.90);
    });

  });

  describe('Sustained load test', function () {

    it('handles sustained load of 100 requests/batch for 10 batches', async () => {
      const batchSize = 100;
      const batchCount = 10;
      const allResults: RequestResult[] = [];

      for (let batch = 0; batch < batchCount; batch++) {
        const requests = Array(batchSize).fill(null).map(() => 
          measureRequest(() => provider.getBlockNumber())
        );
        const results = await Promise.all(requests);
        allResults.push(...results);
        
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const analysis = analyzeResults(allResults);
      printResults(`Sustained load (${batchCount} batches x ${batchSize})`, analysis);
      expect(analysis.successCount / analysis.totalRequests).to.be.gte(0.95);
    });

  });

  describe('Ramp-up load test', function () {

    it('ramps up from 10 to 500 concurrent requests', async () => {
      const levels = [10, 50, 100, 200, 300, 400, 500];
      const results: { level: number; analysis: LoadTestResult }[] = [];

      for (const level of levels) {
        const requests = Array(level).fill(null).map(() => 
          measureRequest(() => provider.getBlockNumber())
        );
        const levelResults = await Promise.all(requests);
        const analysis = analyzeResults(levelResults);
        results.push({ level, analysis });
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      console.log('\n' + '═'.repeat(80));
      console.log('RAMP-UP LOAD TEST SUMMARY');
      console.log('═'.repeat(80));
      console.log(`${'Level'.padEnd(10)} ${'Success%'.padEnd(12)} ${'Avg(ms)'.padEnd(12)} ${'P95(ms)'.padEnd(12)} ${'RPS'.padEnd(12)}`);
      console.log('─'.repeat(80));
      
      for (const { level, analysis } of results) {
        const successRate = ((analysis.successCount / analysis.totalRequests) * 100).toFixed(1);
        console.log(
          `${level.toString().padEnd(10)} ` +
          `${(successRate + '%').padEnd(12)} ` +
          `${analysis.avgLatencyMs.toFixed(0).padEnd(12)} ` +
          `${analysis.p95LatencyMs.toFixed(0).padEnd(12)} ` +
          `${analysis.requestsPerSecond.toFixed(1).padEnd(12)}`
        );
      }
      console.log('═'.repeat(80));

      const lastResult = results[results.length - 1];
      expect(lastResult.analysis.successCount / lastResult.analysis.totalRequests).to.be.gte(0.80);
    });

  });

  describe('Find breaking point', function () {

    it('finds the concurrency level where failures start', async () => {
      const levels = [100, 200, 500, 1000, 2000, 3000, 5000];
      let breakingPoint: number | null = null;

      console.log('\n' + '═'.repeat(80));
      console.log('BREAKING POINT TEST');
      console.log('═'.repeat(80));

      for (const level of levels) {
        const requests = Array(level).fill(null).map(() => 
          measureRequest(() => provider.getBlockNumber())
        );
        const results = await Promise.all(requests);
        const analysis = analyzeResults(results);
        
        const successRate = analysis.successCount / analysis.totalRequests;
        const status = successRate >= 0.99 ? '✓' : successRate >= 0.90 ? '⚠' : '✗';
        
        console.log(
          `${status} ${level.toString().padEnd(6)} requests: ` +
          `${(successRate * 100).toFixed(1)}% success, ` +
          `${analysis.avgLatencyMs.toFixed(0)}ms avg, ` +
          `${analysis.p99LatencyMs.toFixed(0)}ms p99`
        );

        if (successRate < 0.95 && breakingPoint === null) {
          breakingPoint = level;
        }

        if (analysis.failCount > 0) {
          console.log(`  Errors: ${[...analysis.errors.entries()].map(([e, c]) => `${c}x ${e.slice(0, 40)}`).join(', ')}`);
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      console.log('─'.repeat(80));
      if (breakingPoint) {
        console.log(`Breaking point detected around ${breakingPoint} concurrent requests`);
      } else {
        console.log('No breaking point detected up to 5000 concurrent requests');
      }
      console.log('═'.repeat(80));
    });

  });

});
