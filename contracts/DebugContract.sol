// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract DebugContract {
    event Called(address indexed target, bytes data, bool success);

    receive() external payable {}
    // Makes a low-level call to a target contract with arbitrary data.
    function lowLevelCall(address target, bytes calldata data) external returns (bytes memory) {
        (bool success, bytes memory returnData) = target.call(data);
        emit Called(target, data, success);
        require(success, "Call failed");
        return returnData;
    }
}