// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Minimal contract used as a CREATE2 deployment target and as a known-code address
 * for EXTCODEHASH/EXTCODESIZE assertions. The constructor takes no args so its
 * creation code (and therefore its keccak hash) is fixed and easy to derive
 * off-chain for the CREATE2 address check.
 */
contract Create2Target {
    uint256 public magic = 42;

    function ping() external pure returns (uint256) {
        return 0xCAFE;
    }
}

/**
 * Factory exposing raw CREATE2 so the spec can deploy Create2Target deterministically
 * and confirm the resulting address equals keccak256(0xff ++ factory ++ salt ++
 * keccak(initcode))[12:].
 */
contract Create2Factory {
    event Deployed(address addr, bytes32 salt);

    function deploy(bytes32 salt) external returns (address addr) {
        bytes memory bytecode = type(Create2Target).creationCode;
        assembly {
            addr := create2(0, add(bytecode, 32), mload(bytecode), salt)
            if iszero(extcodesize(addr)) {
                revert(0, 0)
            }
        }
        emit Deployed(addr, salt);
    }

    function initCodeHash() external pure returns (bytes32) {
        return keccak256(type(Create2Target).creationCode);
    }

    function predict(bytes32 salt) external view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(type(Create2Target).creationCode)
            )
        );
        return address(uint160(uint256(h)));
    }
}
