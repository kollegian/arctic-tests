// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract StorageTest {
    // Slot 0
    uint256 public value;

    // Slot 1 (a mapping lives at slot 1)
    mapping(address => uint256) public balances;

    // helpers to change storage
    function setValue(uint256 _value) external {
        value = _value;
    }

    function setBalance(address user, uint256 balance) external {
        balances[user] = balance;
    }
}
