import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

// Custom metrics for detailed tracking
const rpcCalls = new Counter("rpc_calls_total");
const logsDuration = new Trend("logs_duration_ms");
const httpRequestDuration = new Trend("http_request_duration_ms");
const httpResponseDuration = new Trend("http_response_duration_ms");
const logsSuccessRate = new Rate("logs_success_rate");
const errorRate = new Rate("error_rate");
const logsCount = new Trend("logs_count");
const blockNumber = new Trend("block_number");

// Configuration - can be overridden via environment variables
const CONFIG = {
    VUS: __ENV.K6_VUS || 6,
    DURATION_PER_BLOCK: __ENV.K6_DURATION_PER_BLOCK || "30s",
    RPC_ENDPOINT: __ENV.K6_RPC_ENDPOINT || "http://localhost:8545",
    REQUEST_TIMEOUT: __ENV.K6_REQUEST_TIMEOUT || "30s",
};

// Load transaction data from environment
let transactionData = [];
try {
    transactionData = JSON.parse(__ENV.K6_TRANSACTION_DATA || "[]");
    console.log(`📊 Loaded ${transactionData.length} transaction records for logs testing`);
} catch (error) {
    console.error("❌ Failed to parse K6_TRANSACTION_DATA:", error);
    transactionData = [];
}

// Get unique block numbers from transaction data
const uniqueBlocks = [...new Set(transactionData.map(tx => tx.blockNumber))].sort((a, b) => a - b);
console.log(`📊 Found ${uniqueBlocks.length} unique blocks for logs testing`);

// RPC request helper function
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

// Test configuration
export const options = {
    scenarios: {
        eth_get_logs_per_block: {
            executor: "shared-iterations",
            vus: CONFIG.VUS,
            iterations: Math.max(uniqueBlocks.length, 1), // Use unique blocks length, minimum 1
            maxDuration: `${CONFIG.DURATION_PER_BLOCK}`,
            gracefulStop: "10s",
        },
    },
    thresholds: {
        logs_duration_ms: ["p(95)<35000", "p(99)<100000"],
        logs_success_rate: ["rate>0.9"],
        error_rate: ["rate<0.15"],
    },
};

export default function () {
    const iteration = __ITER;
    const currentBlock = uniqueBlocks[iteration];
    
    if (!currentBlock) {
        console.log(`⚠️ No block data for iteration ${iteration}`);
        return;
    }

    const blockHex = "0x" + currentBlock.toString(16);
    
    // Create eth_getLogs parameters for the current block
    const logsParams = [{
        fromBlock: blockHex,
        toBlock: blockHex,
        // No specific topics to get all logs from the block
        // You can add specific topics if needed for filtering
    }];

    const logsPayload = rpcRequest("eth_getLogs", logsParams, iteration + 1);
    
    // Debug: Print the first few calls to see what we're sending
    if (iteration < 2 && __VU <= 2) {
        console.log(`🔍 Debug Logs ${iteration} (VU ${__VU}):`);
        console.log(`   Block: ${blockHex} (${currentBlock})`);
        console.log(`   Payload: ${logsPayload.slice(0, 200)}...`);
    }

    // Make the RPC call
    const requestStartTime = Date.now();
    const logsRes = http.post(CONFIG.RPC_ENDPOINT, logsPayload, {
        headers: {
            "Content-Type": "application/json",
        },
        timeout: CONFIG.REQUEST_TIMEOUT,
    });
    const requestEndTime = Date.now();

    // Calculate timing metrics
    const totalDuration = requestEndTime - requestStartTime;
    logsDuration.add(totalDuration);
    httpRequestDuration.add(totalDuration);

    // Check if the request was successful
    const success = check(logsRes, {
        "logs status is 200": (r) => r.status === 200,
        "logs has valid json": (r) => {
            try {
                JSON.parse(r.body);
                return true;
            } catch {
                return false;
            }
        },
    });

    if (success) {
        logsSuccessRate.add(1);
        errorRate.add(0);
        
        const response = JSON.parse(logsRes.body);
        const result = response.result;
        
        // Count the number of logs returned
        if (Array.isArray(result)) {
            logsCount.add(result.length);
        }
        
        blockNumber.add(currentBlock);
        
        // Debug: Show log count for first few calls
        if (iteration < 3) {
            console.log(`✅ Block ${currentBlock}: ${result?.length || 0} logs found`);
        }
    } else {
        logsSuccessRate.add(0);
        errorRate.add(1);
        
        // Debug: Show response details for failed calls
        if (iteration < 3) {
            console.log(`❌ Failed logs call for block ${currentBlock}:`);
            console.log(`   Status: ${logsRes.status}`);
            console.log(`   Response: ${logsRes.body.slice(0, 200)}...`);
        }
    }

    // Small delay between requests
    sleep(0.1);
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString();
    const testName = "eth_get_logs_performance_test";
    
    // Calculate key metrics with fallbacks to built-in metrics
    const totalRequests = data.metrics.rpc_calls_total?.values?.count || data.metrics.http_reqs?.count || 0;
    const avgResponseTime = data.metrics.logs_duration_ms?.values?.avg || data.metrics.http_req_duration?.avg || 0;
    const p95ResponseTime = data.metrics.logs_duration_ms?.values?.["p(95)"] || data.metrics.http_req_duration?.["p(95)"] || 0;
    const p99ResponseTime = data.metrics.logs_duration_ms?.values?.["p(99)"] || data.metrics.http_req_duration?.["p(99)"] || 0;
    const minResponseTime = data.metrics.logs_duration_ms?.values?.min || data.metrics.http_req_duration?.min || 0;
    const maxResponseTime = data.metrics.logs_duration_ms?.values?.max || data.metrics.http_req_duration?.max || 0;
    const successRate = (data.metrics.logs_success_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const errorRate = (data.metrics.error_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const blocksQueried = data.metrics.block_number?.values?.count || 0;
    const avgLogsPerBlock = data.metrics.logs_count?.values?.avg || 0;
    const totalLogs = data.metrics.logs_count?.values?.count || 0;

    // Debug: Log all available metrics (only if needed)
    if (__ENV.K6_DEBUG_METRICS) {
        console.log("\n🔍 Available metrics:");
        console.log("data.metrics keys:", Object.keys(data.metrics));
        console.log("rpc_calls_total:", data.metrics.rpc_calls_total);
        console.log("logs_duration_ms:", data.metrics.logs_duration_ms);
        console.log("logs_success_rate:", data.metrics.logs_success_rate);
        console.log("error_rate:", data.metrics.error_rate);
        console.log("block_number:", data.metrics.block_number);
        console.log("logs_count:", data.metrics.logs_count);
    }

    // Create structured artifact
    const artifact = {
        test_name: testName,
        timestamp: timestamp,
        total_requests: totalRequests,
        blocks_queried: blocksQueried,
        response_time_metrics: {
            average_ms: Math.round(avgResponseTime * 100) / 100,
            p95_ms: Math.round(p95ResponseTime * 100) / 100,
            p99_ms: Math.round(p99ResponseTime * 100) / 100,
            min_ms: Math.round(minResponseTime * 100) / 100,
            max_ms: Math.round(maxResponseTime * 100) / 100,
        },
        success_metrics: {
            success_rate_percent: Math.round(successRate * 100) / 100,
            error_rate_percent: Math.round(errorRate * 100) / 100,
        },
        logs_metrics: {
            total_logs_retrieved: totalLogs,
            average_logs_per_block: Math.round(avgLogsPerBlock * 100) / 100,
        },
        configuration: {
            virtual_users: CONFIG.VUS,
            duration_per_block: CONFIG.DURATION_PER_BLOCK,
            rpc_endpoint: CONFIG.RPC_ENDPOINT,
            request_timeout: CONFIG.REQUEST_TIMEOUT,
            unique_blocks_available: uniqueBlocks.length,
        },
    };

    // Generate filename with timestamp
    const filename = `${testName}_${timestamp.replace(/[:.]/g, '-')}.json`;
    
    console.log(`\n📊 ${testName} Results:`);
    console.log(`   Total Requests: ${totalRequests}`);
    console.log(`   Blocks Queried: ${blocksQueried}`);
    console.log(`   Average Response Time: ${artifact.response_time_metrics.average_ms}ms`);
    console.log(`   P95 Response Time: ${artifact.response_time_metrics.p95_ms}ms`);
    console.log(`   Success Rate: ${artifact.success_metrics.success_rate_percent}%`);
    console.log(`   Total Logs Retrieved: ${totalLogs}`);
    console.log(`   Average Logs per Block: ${artifact.logs_metrics.average_logs_per_block}`);
    console.log(`   Artifact saved: ${filename}`);

    return {
        [filename]: JSON.stringify(artifact, null, 2),
    };
} 