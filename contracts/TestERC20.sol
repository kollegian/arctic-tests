// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.0
pragma solidity ^0.8.22;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract TestERC20 is ERC20, ERC20Burnable, ERC20Pausable, Ownable, ERC20Permit {
    // Track all accounts that have ever held a balance
    address[] private _allAccounts;
    mapping(address => bool) private _accountExists;

    constructor(address initialOwner)
    ERC20("MyToken", "MTK")
    Ownable(initialOwner)
    ERC20Permit("MyToken")
    {}

    function pause() public onlyOwner {
        _pause();
    }

    function unpause() public onlyOwner {
        _unpause();
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    // Override _update to track accounts
    function _update(address from, address to, uint256 value)
    internal
    override(ERC20, ERC20Pausable)
    {
        super._update(from, to, value);

        // Track new accounts
        if (to != address(0) && !_accountExists[to]) {
            _allAccounts.push(to);
            _accountExists[to] = true;
        }
    }

    // Get the minter (owner)
    function minter() public view returns (address) {
        return owner();
    }

    // Get all accounts that have ever held a balance
    function allAccounts() public view returns (address[] memory) {
        return _allAccounts;
    }
}