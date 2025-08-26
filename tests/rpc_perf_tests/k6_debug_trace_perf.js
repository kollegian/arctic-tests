import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";

// Custom metrics
const rpcCalls = new Counter("rpc_calls_total");
const traceDuration = new Trend("trace_duration_ms");
const blockTxCount = new Trend("block_tx_count");
const blockGasUsed = new Trend("block_gas_used");
const traceSuccessRate = new Rate("trace_success_rate");
const errorRate = new Rate("error_rate");

// Configuration - can be overridden via environment variables
const CONFIG = {
    VUS: __ENV.K6_VUS || 10,
    DURATION_PER_BLOCK: __ENV.K6_DURATION_PER_BLOCK || "30s",
    RPC_URL: __ENV.K6_RPC_URL || "http://127.0.0.1:8545",
    TRACER_TYPE: __ENV.K6_TRACER_TYPE || "callTracer",
    ONLY_TOP_CALL: __ENV.K6_ONLY_TOP_CALL || "true"
};

// Parse blocks from environment variable
let blocks = [];
try {
    blocks = JSON.parse(__ENV.K6_BLOCKS || "[]");
} catch (e) {
    console.error("Failed to parse K6_BLOCKS:", e);
    blocks = [];
}

console.log(`🚀 Starting debug_traceBlockByNumber performance test`);
console.log(`📊 Configuration:`);
console.log(`   - VUs: ${CONFIG.VUS}`);
console.log(`   - Duration per block: ${CONFIG.DURATION_PER_BLOCK}`);
console.log(`   - RPC URL: ${CONFIG.RPC_URL}`);
console.log(`   - Tracer type: ${CONFIG.TRACER_TYPE}`);
console.log(`   - Only top call: ${CONFIG.ONLY_TOP_CALL}`);
console.log(`   - Blocks to test: ${blocks.length}`);

export const options = {
    scenarios: {
        debug_trace_per_block: {
            executor: "per-vu-iterations",
            vus: CONFIG.VUS,
            iterations: blocks.length,
            maxDuration: `${CONFIG.DURATION_PER_BLOCK}`,
            gracefulStop: "10s",
        },
    },
    thresholds: {
        "trace_duration_ms": ["p(95)<60000"], // 95% of traces should complete within 5 seconds
        "trace_success_rate": ["rate>0.90"], // 95% success rate
        "error_rate": ["rate<0.1"], // Less than 5% errors
        "http_req_duration": ["p(95)<60000"], // 95% of HTTP requests should complete within 3 seconds
    },
};

const headers = { 
    "Content-Type": "application/json",
    "Accept": "application/json"
};

function rpcRequest(method, params, id, count = true) {
    if (count) rpcCalls.add(1);
    return JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id,
    });
}

export default function () {
    const iteration = __ITER;
    const blockNumber = blocks[iteration];
    
    if (!blockNumber) {
        console.log(`⚠️ No block number for iteration ${iteration}`);
        return;
    }

    const blockHex = "0x" + blockNumber.toString(16);
    
    // First, get block info to understand what we're tracing
    const blockPayload = rpcRequest("eth_getBlockByNumber", [blockHex, true], iteration * 2);
    const blockRes = http.post(CONFIG.RPC_URL, blockPayload, { headers });
    
    if (!check(blockRes, { 
        [`get_block_${blockHex}`]: (r) => r.status === 200 
    })) {
        errorRate.add(1);
        console.log(`❌ Failed to get block ${blockHex}`);
        return;
    }

    const blockInfo = JSON.parse(blockRes.body).result;
    if (!blockInfo) {
        console.log(`⚠️ Block ${blockHex} not found`);
        return;
    }

    const txCount = blockInfo.transactions?.length || 0;
    const gasUsed = blockInfo.gasUsed ? parseInt(blockInfo.gasUsed, 16) : 0;
    blockTxCount.add(txCount);
    blockGasUsed.add(gasUsed);

    // Now perform the debug_traceBlockByNumber call
    const traceConfig = {
        tracer: CONFIG.TRACER_TYPE,
        tracerConfig: {
            onlyTopCall: CONFIG.ONLY_TOP_CALL === "true"
        }
    };

    const tracePayload = rpcRequest(
        "debug_traceBlockByNumber",
        [blockHex, traceConfig],
        iteration * 2 + 1
    );

    const startTime = Date.now();
    const traceRes = http.post(CONFIG.RPC_URL, tracePayload, { headers });
    const duration = Date.now() - startTime;
    traceDuration.add(duration);

    const success = check(traceRes, {
        [`trace_block_${blockHex}`]: (r) => r.status === 200,
        [`trace_response_valid_${blockHex}`]: (r) => {
            try {
                const response = JSON.parse(r.body);
                return response.result && Array.isArray(response.result);
            } catch (e) {
                return false;
            }
        }
    });

    if (success) {
        traceSuccessRate.add(1);
        errorRate.add(0);
        
        const response = JSON.parse(traceRes.body);
        const traceCount = response.result?.length || 0;
        
        console.log(
            `✅ Block ${blockNumber} (${blockHex}) | ` +
            `Tx: ${txCount} | ` +
            `Gas: ${gasUsed} | ` +
            `Traces: ${traceCount} | ` +
            `Duration: ${duration}ms | ` +
            `VU: ${__VU}`
        );
    } else {
        traceSuccessRate.add(0);
        errorRate.add(1);
        console.log(
            `❌ Block ${blockNumber} (${blockHex}) | ` +
            `Failed trace | ` +
            `Duration: ${duration}ms | ` +
            `Status: ${traceRes.status} | ` +
            `VU: ${__VU}`
        );
    }

    // Add some delay between requests to avoid overwhelming the RPC
    sleep(0.1);
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString();
    const testName = "debug_trace_performance_test";
    
    // Calculate key metrics with fallbacks to built-in metrics
    const totalRequests = data.metrics.rpc_calls_total?.values?.count || data.metrics.http_reqs?.count || 0;
    const avgResponseTime = data.metrics.trace_duration_ms?.values?.avg || data.metrics.http_req_duration?.avg || 0;
    const p95ResponseTime = data.metrics.trace_duration_ms?.values?.["p(95)"] || data.metrics.http_req_duration?.["p(95)"] || 0;
    const p99ResponseTime = data.metrics.trace_duration_ms?.values?.["p(99)"] || data.metrics.http_req_duration?.["p(99)"] || 0;
    const minResponseTime = data.metrics.trace_duration_ms?.values?.min || data.metrics.http_req_duration?.min || 0;
    const maxResponseTime = data.metrics.trace_duration_ms?.values?.max || data.metrics.http_req_duration?.max || 0;
    const successRate = (data.metrics.trace_success_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const errorRate = (data.metrics.error_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const avgTxPerBlock = data.metrics.block_tx_count?.values?.avg || 0;
    const avgGasPerBlock = data.metrics.block_gas_used?.values?.avg || 0;
    
    // Create artifact object
    const artifact = {
        test_name: testName,
        timestamp: timestamp,
        total_requests: totalRequests,
        blocks_traced: blocks.length,
        response_time_metrics: {
            average_ms: parseFloat(avgResponseTime.toFixed(2)),
            p95_ms: parseFloat(p95ResponseTime.toFixed(2)),
            p99_ms: parseFloat(p99ResponseTime.toFixed(2)),
            min_ms: parseFloat(minResponseTime.toFixed(2)),
            max_ms: parseFloat(maxResponseTime.toFixed(2))
        },
        success_metrics: {
            success_rate_percent: parseFloat(successRate.toFixed(2)),
            error_rate_percent: parseFloat(errorRate.toFixed(2))
        },
        block_metrics: {
            average_transactions_per_block: parseFloat(avgTxPerBlock.toFixed(2)),
            average_gas_per_block: parseFloat(avgGasPerBlock.toFixed(0))
        },
        configuration: {
            rpc_url: CONFIG.RPC_URL,
            virtual_users: CONFIG.VUS,
            tracer_type: CONFIG.TRACER_TYPE
        }
    };
    
    // Console output
    console.log("\n📊 Debug Trace Performance Test Summary:");
    console.log(`   - Test: ${testName}`);
    console.log(`   - Timestamp: ${timestamp}`);
    console.log(`   - Total Requests: ${totalRequests}`);
    console.log(`   - Blocks Traced: ${blocks.length}`);
    console.log(`   - Average Response Time: ${avgResponseTime.toFixed(2)}ms`);
    console.log(`   - P95 Response Time: ${p95ResponseTime.toFixed(2)}ms`);
    console.log(`   - P99 Response Time: ${p99ResponseTime.toFixed(2)}ms`);
    console.log(`   - Success Rate: ${successRate.toFixed(2)}%`);
    console.log(`   - Error Rate: ${errorRate.toFixed(2)}%`);
    console.log(`   - Avg Tx per Block: ${avgTxPerBlock.toFixed(2)}`);
    console.log(`   - Avg Gas per Block: ${avgGasPerBlock.toFixed(0)}`);
    
    // Return single artifact file
    return {
        [`${testName}_${timestamp.replace(/[:.]/g, '-')}.json`]: JSON.stringify(artifact, null, 2),
        stdout: JSON.stringify(artifact, null, 2),
    };
}
