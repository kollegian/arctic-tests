// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title SimpleAccount7702
 * @notice Minimal smart account for EIP-7702 SetCode transactions
 * @dev This contract is used as the delegation target for EOAs using EIP-7702
 */
contract SimpleAccount7702 {
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /**
     * @notice Execute a batch of calls
     * @param calls Array of calls to execute
     */
    function executeBatch(Call[] calldata calls) external {
        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, bytes memory result) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!success) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
        }
    }

    /**
     * @notice Execute a single call
     * @param target Target address
     * @param value ETH value to send
     * @param data Calldata
     */
    function execute(address target, uint256 value, bytes calldata data) external {
        (bool success, bytes memory result) = target.call{value: value}(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {}
}
