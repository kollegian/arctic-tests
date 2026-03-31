#!/bin/bash

# Default values
RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
PRIVATE_KEY="${PRIVATE_KEY:-0x2bd96f4b341d7e26afbfabafdaae89b6c67cdd8076517181d11b30faa2412f8e}"

# Get address from private key
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDRESS=$(cd "$SCRIPT_DIR/../../../.." && npx ts-node "$SCRIPT_DIR/get-address.ts" "$PRIVATE_KEY")

echo "═══════════════════════════════════════════════════════════════════════════════"
echo "RPC Load Test Configuration"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo "RPC URL:     $RPC_URL"
echo "Private Key: ${PRIVATE_KEY:0:14}...${PRIVATE_KEY: -6}"
echo "Address:     $ADDRESS"
echo "═══════════════════════════════════════════════════════════════════════════════"
echo ""

# Run k6 with the derived address
k6 run \
  -e RPC_URL="$RPC_URL" \
  -e PRIVATE_KEY="$PRIVATE_KEY" \
  -e TEST_ADDRESS="$ADDRESS" \
  "$SCRIPT_DIR/k6-getBalance.js"
