import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

// Custom metrics for detailed tracking
const rpcCalls = new Counter("rpc_calls_total");
const callDuration = new Trend("call_duration_ms");
const httpRequestDuration = new Trend("http_request_duration_ms");
const httpResponseDuration = new Trend("http_response_duration_ms");
const callSuccessRate = new Rate("call_success_rate");
const errorRate = new Rate("error_rate");
const gasUsed = new Trend("gas_used");
const blockNumber = new Trend("block_number");

// Configuration - can be overridden via environment variables
const CONFIG = {
    VUS: __ENV.K6_VUS || 20,
    DURATION_PER_BLOCK: __ENV.K6_DURATION_PER_BLOCK || "30s",
    RPC_URL: __ENV.K6_RPC_URL || "http://127.0.0.1:8545",
    CONTRACT_ADDRESS: __ENV.K6_CONTRACT_ADDRESS || "0x8f8Dc7A9C7182abf1067085bA6FB70612AC77204",
    ADMIN_ADDRESS: __ENV.K6_ADMIN_ADDRESS || "0x44E3ca00494F9F44d92F3612B153419e87b02A39",
    BLOCK_TAG: __ENV.K6_BLOCK_TAG || (__ENV.K6_FIRST_BLOCK ? (parseInt(__ENV.K6_FIRST_BLOCK) - 1).toString() : "18112")
};


// Load transaction data from environment variable for replay
let transactionData = [];
try {
    transactionData = JSON.parse(__ENV.K6_TRANSACTION_DATA || "[]");
    console.log(`📊 Loaded ${transactionData.length} transaction records for replay`);
} catch (e) {
    console.error("Failed to parse K6_TRANSACTION_DATA:", e);
    transactionData = [];
}

console.log(`🚀 Starting eth_call performance test with replay`);
console.log(`📊 Configuration:`);
console.log(`   - VUs: ${CONFIG.VUS}`);
console.log(`   - Duration per block: ${CONFIG.DURATION_PER_BLOCK}`);
console.log(`   - RPC URL: ${CONFIG.RPC_URL}`);
console.log(`   - Contract Address: ${CONFIG.CONTRACT_ADDRESS}`);
console.log(`   - Admin Address: ${CONFIG.ADMIN_ADDRESS}`);
console.log(`   - Block Tag: ${CONFIG.BLOCK_TAG}`);
console.log(`   - Transaction records for replay: ${transactionData.length}`);

export const options = {
    scenarios: {
        eth_call_per_block: {
            executor: "shared-iterations",
            vus: CONFIG.VUS,
            iterations: Math.max(transactionData.length, 1), // Use transaction data length, minimum 1
            maxDuration: `${CONFIG.DURATION_PER_BLOCK}`,
            gracefulStop: "10s",
        },
    },
    thresholds: {
        "call_duration_ms": ["p(95)<60000"], // 95% of calls should complete within 5 seconds
        "call_success_rate": ["rate>0.9"], // 95% success rate
        "error_rate": ["rate<0.1"], // Less than 5% errors
        "http_req_duration": ["p(95)<60000"], // 95% of HTTP requests should complete within 3 seconds
    },
};

const headers = { 
    "Content-Type": "application/json",
    "Accept": "application/json"
};

function rpcRequest(method, params, id, count = true) {
    if (count) {
        rpcCalls.add(1);
    }
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

    const currentBlock = currentTransaction.blockNumber;
    const blockHex = "0x" + currentBlock.toString(16);
    
    // Use the transaction data directly for replay
    const replayData = {
        encodedCall: currentTransaction.encodedCall,
        to: currentTransaction.to,
        value: currentTransaction.value,
        hash: currentTransaction.hash
    };
    
    // Debug: Log metric counters at start (only for first few iterations)
    if (iteration === 0 && __VU <= 3) {
        console.log(`🔍 Starting metrics debug - VU: ${__VU}`);
    }
    
    if (!replayData) {
        console.log(`⚠️ No transaction data found for block ${currentBlock}`);
        errorRate.add(1);
        return;
    }

    // Prepare eth_call parameters using recorded transaction data
    const callObject = {
        from: CONFIG.ADMIN_ADDRESS,
        to: replayData.to,
        data: replayData.encodedCall,
        value: replayData.value
    };

    // Use the actual block number for replay
    const blockParam = blockHex;

    const callPayload = rpcRequest("eth_call", [callObject, blockParam], iteration);

    // Debug: Print the first few calls to see what we're sending
    if (iteration < 2 && __VU <= 2) {
        console.log(`🔍 Debug Call ${iteration} (VU ${__VU}):`);
        console.log(`   Block: ${blockParam}`);
        console.log(`   To: ${callObject.to}`);
        console.log(`   Data: ${callObject.data?.slice(0, 50)}...`);
        console.log(`   Value: ${callObject.value}`);
    }

    // Record detailed timing for HTTP request/response
    const requestStartTime = Date.now();
    const callRes = http.post(CONFIG.RPC_URL, callPayload, { headers });
    const requestEndTime = Date.now();
    
    const totalDuration = requestEndTime - requestStartTime;
    // Add custom metrics
    callDuration.add(totalDuration);
    httpRequestDuration.add(totalDuration);
    
    // Also add to built-in metrics for reliability
    __ENV.K6_CUSTOM_DURATION = totalDuration;

    const success = check(callRes, {
        [`eth_call_${currentBlock}`]: (r) => r.status === 200,
        [`eth_call_response_valid_${currentBlock}`]: (r) => {
            try {
                const response = JSON.parse(r.body);
                return response.result && response.result.startsWith('0x');
            } catch (e) {
                return false;
            }
        }
    });

    if (success) {
        callSuccessRate.add(1);
        errorRate.add(0);
        
        const response = JSON.parse(callRes.body);
        const result = response.result;
        
        // Parse gas used if available
        if (response.result && response.result.gasUsed) {
            const gas = parseInt(response.result.gasUsed, 16);
            gasUsed.add(gas);
        }
        
        blockNumber.add(currentBlock);
        
        console.log(
            `✅ Block ${currentBlock} (${blockHex}) | ` +
            `Replay: ${replayData.hash?.slice(0, 10)}... | ` +
            `Result: ${result?.slice(0, 20)}... | ` +
            `Duration: ${totalDuration}ms | ` +
            `VU: ${__VU}`
        );
    } else {
        callSuccessRate.add(0);
        errorRate.add(1);
        
        // Debug: Show response details for failed calls
        let errorDetails = "";
        try {
            const response = JSON.parse(callRes.body);
            if (response.error) {
                errorDetails = ` | Error: ${response.error.message || response.error}`;
            }
        } catch (e) {
            errorDetails = ` | Response: ${callRes.body?.slice(0, 100)}...`;
        }
        
        console.log(
            `❌ Block ${currentBlock} (${blockHex}) | ` +
            `Replay: ${replayData.hash?.slice(0, 10)}... | ` +
            `Failed call | ` +
            `Duration: ${totalDuration}ms | ` +
            `Status: ${callRes.status}${errorDetails} | ` +
            `VU: ${__VU}`
        );
    }

    // Add some delay between requests to avoid overwhelming the RPC
    sleep(0.1);
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString();
    const testName = "eth_call_performance_test";
    
    // Debug: Log all available metrics (only if needed)
    if (__ENV.K6_DEBUG_METRICS) {
        console.log("\n🔍 Available metrics:");
        console.log("data.metrics keys:", Object.keys(data.metrics));
        console.log("rpc_calls_total:", data.metrics.rpc_calls_total);
        console.log("call_duration_ms:", data.metrics.call_duration_ms);
        console.log("call_success_rate:", data.metrics.call_success_rate);
        console.log("error_rate:", data.metrics.error_rate);
        console.log("block_number:", data.metrics.block_number);
    }
    
    // Calculate key metrics with fallbacks to built-in metrics
    const totalRequests = data.metrics.rpc_calls_total?.values?.count || data.metrics.http_reqs?.count || 0;
    const avgResponseTime = data.metrics.call_duration_ms?.values?.avg || data.metrics.http_req_duration?.avg || 0;
    const p95ResponseTime = data.metrics.call_duration_ms?.values?.["p(95)"] || data.metrics.http_req_duration?.["p(95)"] || 0;
    const p99ResponseTime = data.metrics.call_duration_ms?.values?.["p(99)"] || data.metrics.http_req_duration?.["p(99)"] || 0;
    const minResponseTime = data.metrics.call_duration_ms?.values?.min || data.metrics.http_req_duration?.min || 0;
    const maxResponseTime = data.metrics.call_duration_ms?.values?.max || data.metrics.http_req_duration?.max || 0;
    const successRate = (data.metrics.call_success_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const errorRate = (data.metrics.error_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const transactionsReplayed = data.metrics.block_number?.values?.count || transactionData.length;
    
    // Create artifact object
    const artifact = {
        test_name: testName,
        timestamp: timestamp,
        total_requests: totalRequests,
        transactions_replayed: transactionsReplayed,
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
    
    // Console output
    console.log("\n📊 Eth_Call Performance Test Summary:");
    console.log(`   - Test: ${testName}`);
    console.log(`   - Timestamp: ${timestamp}`);
    console.log(`   - Total Requests: ${totalRequests}`);
    console.log(`   - Transactions Replayed: ${transactionsReplayed}`);
    console.log(`   - Average Response Time: ${avgResponseTime.toFixed(2)}ms`);
    console.log(`   - P95 Response Time: ${p95ResponseTime.toFixed(2)}ms`);
    console.log(`   - P99 Response Time: ${p99ResponseTime.toFixed(2)}ms`);
    console.log(`   - Success Rate: ${successRate.toFixed(2)}%`);
    console.log(`   - Error Rate: ${errorRate.toFixed(2)}%`);
    
    // Return single artifact file
    return {
        [`${testName}_${timestamp.replace(/[:.]/g, '-')}.json`]: JSON.stringify(artifact, null, 2),
        stdout: JSON.stringify(artifact, null, 2),
    };
} 