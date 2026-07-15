// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Probe contract for post-London/Cancun EVM behaviours where Sei may deviate from
 * upstream go-ethereum. Each function isolates one opcode/feature so the spec can
 * assert the exact value the EVM exposes on-chain, and cross-check it against the
 * JSON-RPC view (eth_chainId, block header baseFeePerGas, real block hashes, etc.).
 *
 * Compiled with solc 0.8.28 (default evmVersion = cancun), so PUSH0, MCOPY and
 * BLOBHASH are emitted by the compiler / available via inline assembly.
 */
contract EipProbe {
    // ---- persistent storage for SSTORE-gas (EIP-2200/2929) measurements ----
    uint256 public slotA; // starts at 0 (zero -> nonzero path)
    uint256 public slotB = 7; // starts nonzero (nonzero -> nonzero / -> zero paths)

    function setSlotA(uint256 v) external {
        slotA = v;
    }

    function setSlotB(uint256 v) external {
        slotB = v;
    }

    event Context(
        uint256 blockNumber,
        uint256 baseFee,
        uint256 prevRandao,
        address coinbase,
        bytes32 parentHash
    );

    /**
     * Emit the live block context from inside a real transaction. eth_call uses a
     * synthetic context where BASEFEE/PREVRANDAO read as 0 (true on geth too), so a
     * mined tx that emits the values is the reliable way to observe them. Using an
     * event (not SSTORE) keeps the measurement independent of storage-gas behaviour.
     */
    function emitContext() external {
        emit Context(
            block.number,
            block.basefee,
            block.prevrandao,
            block.coinbase,
            blockhash(block.number - 1)
        );
    }

    // ---- EIP-3198: BASEFEE opcode ----
    function baseFee() external view returns (uint256) {
        return block.basefee;
    }

    // ---- EIP-1344: CHAINID opcode ----
    function chainId() external view returns (uint256) {
        return block.chainid;
    }

    // ---- BLOCKHASH ----
    function blockHashOf(uint256 n) external view returns (bytes32) {
        return blockhash(n);
    }

    function currentBlockHash() external view returns (bytes32) {
        return blockhash(block.number);
    }

    // ---- PREVRANDAO (post-merge difficulty) ----
    function prevRandao() external view returns (uint256) {
        return block.prevrandao;
    }

    // ---- block.coinbase (per-block proposer, distinct from eth_coinbase) ----
    function coinbase() external view returns (address) {
        return block.coinbase;
    }

    /**
     * EIP-3651: the COINBASE address is pre-warmed at the start of a transaction,
     * so the first BALANCE(block.coinbase) should cost the warm price (100) rather
     * than the cold price (2600). We measure the gas delta of BALANCE(coinbase)
     * against a known-cold address read, then BALANCE(coinbase) again (warm).
     *
     * Returns (coldOtherCost, firstCoinbaseCost, secondCoinbaseCost). If COINBASE
     * is pre-warmed, firstCoinbaseCost ~= secondCoinbaseCost ~= warm, while
     * coldOtherCost is markedly higher on its first access.
     */
    function coinbaseWarmthGas(address coldProbe)
        external
        view
        returns (
            uint256 coldOtherCost,
            uint256 firstCoinbaseCost,
            uint256 secondCoinbaseCost,
            uint256 sink
        )
    {
        address cb = block.coinbase;

        // Read a cold, arbitrary address first (full cold cost, 2600). `sink`
        // accumulates each balance and is returned, so the optimizer cannot drop the
        // BALANCE opcodes (which would flatten the gas deltas to 0).
        uint256 g0 = gasleft();
        assembly {
            sink := add(sink, balance(coldProbe))
        }
        uint256 g1 = gasleft();
        // First BALANCE(coinbase): warm under EIP-3651 (~100), cold (~2600) without it.
        assembly {
            sink := add(sink, balance(cb))
        }
        uint256 g2 = gasleft();
        // Second BALANCE(coinbase): unambiguously warm (~100).
        assembly {
            sink := add(sink, balance(cb))
        }
        uint256 g3 = gasleft();

        coldOtherCost = g0 - g1;
        firstCoinbaseCost = g1 - g2;
        secondCoinbaseCost = g2 - g3;
    }

    // ---- EIP-3855: PUSH0 ----
    // The compiler emits PUSH0 for pushing zero at evmVersion >= shanghai. Just
    // having this contract deploy and run proves PUSH0 is accepted by the chain.
    function pushZero() external pure returns (uint256) {
        uint256 z;
        assembly {
            z := 0
        }
        return z;
    }

    // ---- EIP-5656: MCOPY ----
    // Copy `data` within memory using MCOPY (emitted by solc >= cancun for this
    // pattern) and return it, so the spec confirms MCOPY produces correct output.
    function mcopy(bytes calldata data) external pure returns (bytes memory out) {
        out = new bytes(data.length);
        // memory-to-memory copy; solc 0.8.28 lowers this to MCOPY under cancun.
        bytes memory src = data;
        assembly {
            let len := mload(src)
            mcopy(add(out, 32), add(src, 32), len)
        }
    }

    // ---- EIP-1153: transient storage (TSTORE/TLOAD) ----
    // Within a single call, a value written with TSTORE reads back via TLOAD, then
    // is cleared at the end of the transaction. Returns the in-call read-back.
    function transientRoundTrip(uint256 v) external returns (uint256 readBack) {
        assembly {
            tstore(0, v)
            readBack := tload(0)
        }
    }

    // ---- EIP-4844: BLOBHASH opcode ----
    // For non-blob (type < 3) transactions there are no blob hashes, so BLOBHASH(i)
    // must return 0x0 for any index.
    function blobHashAt(uint256 index) external view returns (bytes32 h) {
        assembly {
            h := blobhash(index)
        }
    }

    function blobBaseFee() external view returns (uint256 f) {
        assembly {
            f := blobbasefee()
        }
    }

    // ---- EXTCODEHASH / EXTCODESIZE ----
    function extCodeHash(address a) external view returns (bytes32 h) {
        assembly {
            h := extcodehash(a)
        }
    }

    function extCodeSize(address a) external view returns (uint256 s) {
        assembly {
            s := extcodesize(a)
        }
    }

    // ---- CREATE2 derivation cross-check helper ----
    function create2Address(bytes32 salt, bytes32 initCodeHash)
        external
        view
        returns (address)
    {
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
        );
        return address(uint160(uint256(h)));
    }
}
