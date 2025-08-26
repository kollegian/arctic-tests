// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract EtherDisperser {
    error MismatchedArrays();
    error TransferFailed(address to, uint256 amount);

    event Dispersed(address indexed sender, uint256 total, uint256 recipients);

    constructor() payable {}

    function disperseEther(address[] calldata recipients, uint256[] calldata amounts) external payable {
        if (recipients.length != amounts.length) {
            revert MismatchedArrays();
        }

        uint256 totalAmount = 0;
        for (uint i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }

        require(msg.value >= totalAmount, "Insufficient ETH sent");

        for (uint i = 0; i < recipients.length; i++) {
            (bool success, ) = recipients[i].call{value: amounts[i]}("");
            if (!success) {
                revert TransferFailed(recipients[i], amounts[i]);
            }
        }

        emit Dispersed(msg.sender, totalAmount, recipients.length);
    }

    // Withdraw any leftover ETH
    function withdraw() external {
        payable(msg.sender).transfer(address(this).balance);
    }

    // Accept direct ETH transfers
    receive() external payable {}
}
