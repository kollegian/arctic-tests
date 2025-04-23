// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IPicasso {
    function submitPrediction(
        uint32 date,
        uint256[] calldata predictions
    ) external payable;
}