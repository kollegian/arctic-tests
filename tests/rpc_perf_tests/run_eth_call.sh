#!/bin/bash

# Read transaction data and run eth_call test
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

echo "✅ Loaded transaction data for eth_call replay"
echo "📊 Transaction records: $(echo "$K6_TRANSACTION_DATA" | jq length)"

# Run the eth_call test
k6 run k6_eth_call_perf.js 