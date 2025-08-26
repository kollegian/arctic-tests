#!/bin/bash

# Read transaction data and run debug_traceTransaction test
set -e

# Check if transaction data file exists
if [ ! -f "transaction_data.json" ]; then
    echo "❌ transaction_data.json not found. Please run setupForPerfTests.ts first."
    exit 1
fi

# Export transaction data as environment variable
export K6_TRANSACTION_DATA=$(cat transaction_data.json)

# Source the k6 environment variables
set -a
source k6.env
set +a

echo "✅ Loaded transaction data for debug_traceTransaction"
echo "📊 Transaction records: $(echo "$K6_TRANSACTION_DATA" | jq length)"

# Run the debug_traceTransaction test
k6 run k6_debug_trace_transaction_perf.js 