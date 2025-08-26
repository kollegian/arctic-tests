// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RealGasBurner {
    mapping(uint256 => uint256) public store;

    event Burned(uint256 count, uint256 gasLeft);

    function burnGas(uint256 salt) external {
        for (uint256 i = 0; i < 5000; i++) {
            store[uint256(keccak256(abi.encodePacked(block.number, msg.sender, i, salt)))] = i;
        }
        emit Burned(50, gasleft());
    }

    function burnGasOverMaxLimit(uint256 salt) external {
        for (uint256 i = 0; i < 301; i++) {
            store[uint256(keccak256(abi.encodePacked(block.number, msg.sender, i, salt)))] = i;
        }
        emit Burned(50, gasleft());
    }
}
