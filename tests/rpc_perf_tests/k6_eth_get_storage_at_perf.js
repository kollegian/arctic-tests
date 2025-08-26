import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";

// Custom metrics for detailed tracking
const rpcCalls = new Counter("rpc_calls_total");
const storageDuration = new Trend("storage_duration_ms");
const httpRequestDuration = new Trend("http_request_duration_ms");
const httpResponseDuration = new Trend("http_response_duration_ms");
const storageSuccessRate = new Rate("storage_success_rate");
const errorRate = new Rate("error_rate");
const storageSlot = new Trend("storage_slot");
const contractAddress = new Trend("contract_address");

// Configuration - can be overridden via environment variables
const CONFIG = {
    VUS: __ENV.K6_VUS || 10,
    DURATION_PER_SLOT: __ENV.K6_DURATION_PER_SLOT || "30s",
    RPC_ENDPOINT: __ENV.K6_RPC_ENDPOINT || "http://localhost:8545",
    REQUEST_TIMEOUT: __ENV.K6_REQUEST_TIMEOUT || "30s",
    CONTRACT_ADDRESS: __ENV.K6_CONTRACT_ADDRESS || "0x0000000000000000000000000000000000000000",
};

// Load transaction data from environment
let transactionData = [];
try {
    transactionData = JSON.parse(__ENV.K6_TRANSACTION_DATA || "[]");
    console.log(`📊 Loaded ${transactionData.length} transaction records for storage testing`);
} catch (error) {
    console.error("❌ Failed to parse K6_TRANSACTION_DATA:", error);
    transactionData = [];
}

// Generate storage slots to test
// For the disperse contract, we'll test various storage slots including:
// - Slot 0: contract balance (if any)
// - Slots 1-10: potential state variables
// - Slots based on transaction hashes (modulo operation)
const generateStorageSlots = () => {
    const slots = [];
    
    // Basic storage slots
    for (let i = 0; i < 10; i++) {
        slots.push("0x" + i.toString(16).padStart(64, '0'));
    }
    
    // Slots based on transaction hashes (if we have transaction data)
    if (transactionData.length > 0) {
        transactionData.slice(0, 20).forEach((tx, index) => {
            // Use transaction hash to generate a storage slot
            const hash = tx.hash;
            if (hash && hash.startsWith('0x')) {
                // Take first 32 bytes of hash and use as storage slot
                const slotFromHash = "0x" + hash.slice(2, 34).padEnd(64, '0');
                slots.push(slotFromHash);
            }
        });
    }
    
    // Add some random slots for comprehensive testing
    for (let i = 0; i < 10; i++) {
        const randomSlot = "0x" + Math.floor(Math.random() * 1000000).toString(16).padStart(64, '0');
        slots.push(randomSlot);
    }
    
    return [...new Set(slots)]; // Remove duplicates
};

const storageSlots = generateStorageSlots();
console.log(`📊 Generated ${storageSlots.length} storage slots for testing`);

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
        eth_get_storage_at_per_slot: {
            executor: "shared-iterations",
            vus: CONFIG.VUS,
            iterations: Math.max(storageSlots.length, 1), // Use storage slots length, minimum 1
            maxDuration: `${CONFIG.DURATION_PER_SLOT}`,
            gracefulStop: "10s",
        },
    },
    thresholds: {
        storage_duration_ms: ["p(95)<5000", "p(99)<10000"],
        storage_success_rate: ["rate>0.95"],
        error_rate: ["rate<0.05"],
    },
};

export default function () {
    const iteration = __ITER;
    const currentSlot = storageSlots[iteration];
    
    if (!currentSlot) {
        console.log(`⚠️ No storage slot data for iteration ${iteration}`);
        return;
    }

    // Create eth_getStorageAt parameters
    const storageParams = [
        CONFIG.CONTRACT_ADDRESS, // contract address
        currentSlot,             // storage slot
        "latest"                 // block number (latest)
    ];

    const storagePayload = rpcRequest("eth_getStorageAt", storageParams, iteration + 1);
    
    // Debug: Print the first few calls to see what we're sending
    if (iteration < 2 && __VU <= 2) {
        console.log(`🔍 Debug Storage ${iteration} (VU ${__VU}):`);
        console.log(`   Contract: ${CONFIG.CONTRACT_ADDRESS}`);
        console.log(`   Slot: ${currentSlot}`);
        console.log(`   Payload: ${storagePayload.slice(0, 200)}...`);
    }

    // Make the RPC call
    const requestStartTime = Date.now();
    const storageRes = http.post(CONFIG.RPC_ENDPOINT, storagePayload, {
        headers: {
            "Content-Type": "application/json",
        },
        timeout: CONFIG.REQUEST_TIMEOUT,
    });
    const requestEndTime = Date.now();

    // Calculate timing metrics
    const totalDuration = requestEndTime - requestStartTime;
    storageDuration.add(totalDuration);
    httpRequestDuration.add(totalDuration);

    // Check if the request was successful
    const success = check(storageRes, {
        "storage status is 200": (r) => r.status === 200,
        "storage has valid json": (r) => {
            try {
                JSON.parse(r.body);
                return true;
            } catch {
                return false;
            }
        },
    });

    if (success) {
        storageSuccessRate.add(1);
        errorRate.add(0);
        
        const response = JSON.parse(storageRes.body);
        const result = response.result;
        
        // Track storage slot and contract address
        storageSlot.add(parseInt(currentSlot.slice(2, 10), 16)); // Use first 8 chars as number
        contractAddress.add(parseInt(CONFIG.CONTRACT_ADDRESS.slice(2, 10), 16)); // Use first 8 chars as number
        
        // Debug: Show storage value for first few calls
        if (iteration < 3) {
            console.log(`✅ Slot ${currentSlot}: ${result || '0x0'}`);
        }
    } else {
        storageSuccessRate.add(0);
        errorRate.add(1);
        
        // Debug: Show response details for failed calls
        if (iteration < 3) {
            console.log(`❌ Failed storage call for slot ${currentSlot}:`);
            console.log(`   Status: ${storageRes.status}`);
            console.log(`   Response: ${storageRes.body.slice(0, 200)}...`);
        }
    }

    // Small delay between requests
    sleep(0.1);
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString();
    const testName = "eth_get_storage_at_performance_test";
    
    // Calculate key metrics with fallbacks to built-in metrics
    const totalRequests = data.metrics.rpc_calls_total?.values?.count || data.metrics.http_reqs?.count || 0;
    const avgResponseTime = data.metrics.storage_duration_ms?.values?.avg || data.metrics.http_req_duration?.avg || 0;
    const p95ResponseTime = data.metrics.storage_duration_ms?.values?.["p(95)"] || data.metrics.http_req_duration?.["p(95)"] || 0;
    const p99ResponseTime = data.metrics.storage_duration_ms?.values?.["p(99)"] || data.metrics.http_req_duration?.["p(99)"] || 0;
    const minResponseTime = data.metrics.storage_duration_ms?.values?.min || data.metrics.http_req_duration?.min || 0;
    const maxResponseTime = data.metrics.storage_duration_ms?.values?.max || data.metrics.http_req_duration?.max || 0;
    const successRate = (data.metrics.storage_success_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const errorRate = (data.metrics.error_rate?.values?.rate || data.metrics.http_req_failed?.rate || 0) * 100;
    const slotsQueried = data.metrics.storage_slot?.values?.count || 0;

    // Debug: Log all available metrics (only if needed)
    if (__ENV.K6_DEBUG_METRICS) {
        console.log("\n🔍 Available metrics:");
        console.log("data.metrics keys:", Object.keys(data.metrics));
        console.log("rpc_calls_total:", data.metrics.rpc_calls_total);
        console.log("storage_duration_ms:", data.metrics.storage_duration_ms);
        console.log("storage_success_rate:", data.metrics.storage_success_rate);
        console.log("error_rate:", data.metrics.error_rate);
        console.log("storage_slot:", data.metrics.storage_slot);
        console.log("contract_address:", data.metrics.contract_address);
    }

    // Create structured artifact
    const artifact = {
        test_name: testName,
        timestamp: timestamp,
        total_requests: totalRequests,
        slots_queried: slotsQueried,
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
        storage_metrics: {
            contract_address: CONFIG.CONTRACT_ADDRESS,
            storage_slots_generated: storageSlots.length,
            unique_slots_tested: slotsQueried,
        },
        configuration: {
            virtual_users: CONFIG.VUS,
            duration_per_slot: CONFIG.DURATION_PER_SLOT,
            rpc_endpoint: CONFIG.RPC_ENDPOINT,
            request_timeout: CONFIG.REQUEST_TIMEOUT,
            storage_slots_available: storageSlots.length,
        },
    };

    // Generate filename with timestamp
    const filename = `${testName}_${timestamp.replace(/[:.]/g, '-')}.json`;
    
    console.log(`\n📊 ${testName} Results:`);
    console.log(`   Total Requests: ${totalRequests}`);
    console.log(`   Slots Queried: ${slotsQueried}`);
    console.log(`   Average Response Time: ${artifact.response_time_metrics.average_ms}ms`);
    console.log(`   P95 Response Time: ${artifact.response_time_metrics.p95_ms}ms`);
    console.log(`   Success Rate: ${artifact.success_metrics.success_rate_percent}%`);
    console.log(`   Contract Address: ${CONFIG.CONTRACT_ADDRESS}`);
    console.log(`   Storage Slots Generated: ${storageSlots.length}`);
    console.log(`   Artifact saved: ${filename}`);

    return {
        [filename]: JSON.stringify(artifact, null, 2),
    };
} 