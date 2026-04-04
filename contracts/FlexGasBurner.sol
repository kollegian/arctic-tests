// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract FlexGasBurner {
    mapping(uint256 => uint256) public store;

    event GasBurned(uint256 targetGas, uint256 actualGasUsed, uint256 gasLeft);

    function burnExactGas(uint256 targetGas, uint256 salt) external {
        uint256 startGas = gasleft();
        uint256 i = 0;
        
        while (startGas - gasleft() < targetGas && gasleft() > 50000) {
            store[uint256(keccak256(abi.encodePacked(block.number, msg.sender, i, salt)))] = i;
            i++;
        }
        
        emit GasBurned(targetGas, startGas - gasleft(), gasleft());
    }

    function burnIterations(uint256 iterations, uint256 salt) external {
        uint256 startGas = gasleft();
        
        for (uint256 i = 0; i < iterations; i++) {
            store[uint256(keccak256(abi.encodePacked(block.number, msg.sender, i, salt)))] = i;
        }
        
        emit GasBurned(iterations, startGas - gasleft(), gasleft());
    }

    function estimateGasPerIteration() external returns (uint256) {
        uint256 startGas = gasleft();
        store[uint256(keccak256(abi.encodePacked(block.number, msg.sender, uint256(0))))] = 0;
        return startGas - gasleft();
    }
}
