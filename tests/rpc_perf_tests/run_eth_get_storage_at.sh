#!/bin/bash

# Read transaction data and run eth_getStorageAt test
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

echo "✅ Loaded transaction data for eth_getStorageAt"
echo "📊 Transaction records: $(echo "$K6_TRANSACTION_DATA" | jq length)"
echo "📊 Contract address: $K6_CONTRACT_ADDRESS"

# Run the eth_getStorageAt test
k6 run k6_eth_get_storage_at_perf.js 