// SPDX-License-Identifier: MIT
pragma solidity ^0.8.12;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";

contract TestReceiver is IERC1155Receiver {
    // Mapping to track received token amounts by token ID
    mapping(uint256 => uint256) public receivedTokens;

    // Event for successful reception of tokens
    event Received(address operator, address from, uint256 id, uint256 value, bytes data);

    /**
     * @notice Handles the receipt of a single ERC1155 token type.
     * Reverts if data indicates so; otherwise, logs the receipt.
     */
    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external override returns (bytes4) {
        // Check if data instructs to revert
        if (data.length > 0 && keccak256(data) == keccak256("REVERT")) {
            revert("TestReceiver: Reverting as instructed by data");
        }
        // Update state to reflect receipt
        receivedTokens[id] += value;
        emit Received(operator, from, id, value, data);
        return this.onERC1155Received.selector;
    }

    /**
     * @notice Handles the receipt of multiple ERC1155 token types.
     * Reverts if data indicates so; otherwise, logs the receipt.
     */
    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external override returns (bytes4) {
        if (data.length > 0 && keccak256(data) == keccak256("REVERT")) {
            revert("TestReceiver: Reverting as instructed by data");
        }
        for (uint256 i = 0; i < ids.length; i++) {
            receivedTokens[ids[i]] += values[i];
        }
        return this.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC1155Receiver).interfaceId;
    }
}