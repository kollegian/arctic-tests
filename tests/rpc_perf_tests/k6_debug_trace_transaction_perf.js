import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

// Custom metrics for detailed tracking
const rpcCalls = new Counter("rpc_calls_total");
const traceDuration = new Trend("trace_duration_ms");
const httpRequestDuration = new Trend("http_request_duration_ms");
const httpResponseDuration = new Trend("http_response_duration_ms");
const traceSuccessRate = new Rate("trace_success_rate");
const errorRate = new Rate("error_rate");
const gasUsed = new Trend("gas_used");
const transactionHash = new Trend("transaction_hash");

// Configuration - can be overridden via environment variables
const CONFIG = {
    VUS: __ENV.K6_VUS || 20,
    DURATION_PER_BLOCK: __ENV.K6_DURATION_PER_BLOCK || "30s",
    RPC_URL: __ENV.K6_RPC_URL || "http://127.0.0.1:8545",
    CONTRACT_ADDRESS: __ENV.K6_CONTRACT_ADDRESS || "0x8f8Dc7A9C7182abf1067085bA6FB70612AC77204",
    ADMIN_ADDRESS: __ENV.K6_ADMIN_ADDRESS || "0x44E3ca00494F9F44d92F3612B153419e87b02A39",
    BLOCK_TAG: __ENV.K6_BLOCK_TAG || (__ENV.K6_FIRST_BLOCK ? (parseInt(__ENV.K6_FIRST_BLOCK) - 1).toString() : "18112")
};

// Load transaction data from environment variable for trace
let transactionData = [];
try {
    transactionData = JSON.parse(__ENV.K6_TRANSACTION_DATA || "[]");
    console.log(`📊 Loaded ${transactionData.length} transaction records for tracing`);
} catch (e) {
    console.error("Failed to parse K6_TRANSACTION_DATA:", e);
    transactionData = [];
}

console.log(`🚀 Starting debug_traceTransaction performance test`);
console.log(`📊 Configuration:`);
console.log(`   - VUs: ${CONFIG.VUS}`);
console.log(`   - Duration per block: ${CONFIG.DURATION_PER_BLOCK}`);
console.log(`   - RPC URL: ${CONFIG.RPC_URL}`);
console.log(`   - Contract Address: ${CONFIG.CONTRACT_ADDRESS}`);
console.log(`   - Admin Address: ${CONFIG.ADMIN_ADDRESS}`);
console.log(`   - Block Tag: ${CONFIG.BLOCK_TAG}`);
console.log(`   - Transaction records for tracing: ${transactionData.length}`);

export const options = {
    scenarios: {
        debug_trace_transaction: {
            executor: "per-vu-iterations",
            vus: CONFIG.VUS,
            iterations: Math.max(transactionData.length, 1), // Use transaction data length, minimum 1
            maxDuration: `${CONFIG.DURATION_PER_BLOCK}`,
            gracefulStop: "10s",
        },
    },
    thresholds: {
        "trace_duration_ms": ["p(95)<60000"], // 95% of traces should complete within 60 seconds
        "trace_success_rate": ["rate>0.9"], // 90% success rate
        "error_rate": ["rate<0.1"], // Less than 10% errors
        "http_req_duration": ["p(95)<60000"], // 95% of HTTP requests should complete within 60 seconds
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
    const currentTransaction = transactionData[iteration];
    
    if (!currentTransaction) {
        console.log(`⚠️ No transaction data for iteration ${iteration}`);
        return;
    }

    const txHash = currentTransaction.hash;
    
    // Debug: Print the first few calls to see what we're sending
    if (iteration < 2 && __VU <= 2) {
        console.log(`🔍 Debug Trace ${iteration} (VU ${__VU}):`);
        console.log(`   Transaction Hash: ${txHash}`);
        console.log(`   Block Number: ${currentTransaction.blockNumber}`);
    }

    // Record detailed timing for HTTP request/response
    const requestStartTime = Date.now();
    
    // Prepare the debug_traceTransaction RPC call
    const traceParams = [txHash, {
        tracer: "callTracer",
        tracerConfig: {
            onlyTopCall: false,
            withLog: false
        }
    }];
    
    const tracePayload = rpcRequest("debug_traceTransaction", traceParams, iteration + 1);
    const traceRes = http.post(CONFIG.RPC_URL, tracePayload, { headers });
    
    const requestEndTime = Date.now();
    
    const totalDuration = requestEndTime - requestStartTime;
    traceDuration.add(totalDuration);
    httpRequestDuration.add(totalDuration);

    const success = check(traceRes, {
        [`debug_trace_transaction_${txHash.slice(0, 10)}`]: (r) => r.status === 200,
        [`debug_trace_response_valid_${txHash.slice(0, 10)}`]: (r) => {
            try {
                const response = JSON.parse(r.body);
                return response.result && (response.result.calls || response.result.gas || response.result.failed);
            } catch (e) {
                return false;
            }
        }
    });

    if (success) {
        traceSuccessRate.add(1);
        errorRate.add(0);
        
        const response = JSON.parse(traceRes.body);
        const result = response.result;
        
        // Extract gas used from trace result
        if (result && result.gas) {
            const gas = parseInt(result.gas, 16);
            gasUsed.add(gas);
        }
        
        transactionHash.add(1); // Count successful traces
        
        // Log trace summary
        const callCount = result?.calls ? result.calls.length : 0;
        const failed = result?.failed || false;
        
        console.log(
            `✅ Trace ${txHash.slice(0, 10)}... | ` +
            `Block: ${currentTransaction.blockNumber} | ` +
            `Calls: ${callCount} | ` +
            `Failed: ${failed} | ` +
            `Duration: ${totalDuration}ms | ` +
            `VU: ${__VU}`
        );
    } else {
        traceSuccessRate.add(0);
        errorRate.add(1);
        
        // Debug: Show response details for failed traces
        let errorDetails = "";
        try {
            const response = JSON.parse(traceRes.body);
            if (response.error) {
                errorDetails = ` | Error: ${response.error.message || response.error}`;
            }
        } catch (e) {
            errorDetails = ` | Response: ${traceRes.body?.slice(0, 100)}...`;
        }
        
        console.log(
            `❌ Trace ${txHash.slice(0, 10)}... | ` +
            `Block: ${currentTransaction.blockNumber} | ` +
            `Failed trace | ` +
            `Duration: ${totalDuration}ms | ` +
            `Status: ${traceRes.status}${errorDetails} | ` +
            `VU: ${__VU}`
        );
    }

    // Add some delay between requests to avoid overwhelming the RPC
    sleep(0.1);
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString();
    const testName = "debug_trace_transaction_performance_test";
    
    // Debug: Log all available metrics (only if needed)
    if (__ENV.K6_DEBUG_METRICS) {
        console.log("\n🔍 Available metrics:");
        console.log("data.metrics keys:", Object.keys(data.metrics));
        console.log("rpc_calls_total:", data.metrics.rpc_calls_total);
        console.log("trace_duration_ms:", data.metrics.trace_duration_ms);
        console.log("trace_success_rate:", data.metrics.trace_success_rate);
        console.log("error_rate:", data.metrics.error_rate);
        console.log("transaction_hash:", data.metrics.transaction_hash);
    }
    
    // Calculate key metrics with fallbacks to built-in metrics
    const totalRequests = data.metrics.rpc_calls_total?.values?.count || data.metrics.http_reqs?.count || 0;
    const avgResponseTime = data.metrics.trace_duration_ms?.values?.avg || data.metrics.http_req_duration?.avg || 0;
    const p95ResponseTime = data.metrics.trace_duration_ms?.values?.["p(95)"] || data.metrics.http_req_duration?.["p(95)"] || 0;
    const p99ResponseTime = data.metrics.trace_duration_ms?.values?.["p(99)"] || data.metrics.http_req_duration?.["p(99)"] || 0;
    const minResponseTime = data.metrics.trace_duration_ms?.values?.min || data.metrics.http_req_duration?.min || 0;
    const maxResponseTime = data.metrics.trace_duration_ms?.values?.max || data.metrics.http_req_duration?.max || 0;
    const successRate = (data.metrics.trace_success_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const errorRate = (data.metrics.error_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const transactionsTraced = data.metrics.transaction_hash?.values?.count || transactionData.length;
    
    // Create artifact object
    const artifact = {
        test_name: testName,
        timestamp: timestamp,
        total_requests: totalRequests,
        transactions_traced: transactionsTraced,
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
        configuration: {
            rpc_url: CONFIG.RPC_URL,
            virtual_users: CONFIG.VUS,
            contract_address: CONFIG.CONTRACT_ADDRESS
        }
    };
    
    // Generate filename with timestamp
    const filename = `${testName}_${timestamp.replace(/[:.]/g, '-')}.json`;
    
    console.log(`\n📊 Test Summary:`);
    console.log(`   - Total Requests: ${totalRequests}`);
    console.log(`   - Transactions Traced: ${transactionsTraced}`);
    console.log(`   - Average Response Time: ${avgResponseTime.toFixed(2)}ms`);
    console.log(`   - P95 Response Time: ${p95ResponseTime.toFixed(2)}ms`);
    console.log(`   - Success Rate: ${successRate.toFixed(2)}%`);
    console.log(`   - Error Rate: ${errorRate.toFixed(2)}%`);
    console.log(`   - Artifact saved to: ${filename}`);
    
    return {
        [filename]: JSON.stringify(artifact, null, 2)
    };
} 