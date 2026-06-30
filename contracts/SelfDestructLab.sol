// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * Contracts for exercising SELFDESTRUCT under EIP-6780 (Cancun) semantics.
 *
 * EIP-6780 changed SELFDESTRUCT so it only deletes the account (code + storage)
 * when the contract was *created in the same transaction* as the SELFDESTRUCT.
 * Otherwise it just transfers the contract's balance to the recipient and leaves
 * code and storage intact.
 *
 * Sei previously had an app-hash incident around SELFDESTRUCT, so these contracts
 * let the spec assert the post-state precisely on both the pre-existing-contract
 * path and the create-and-destruct-in-one-tx path.
 */

/// A destructible contract that holds balance + storage so the spec can verify
/// exactly what survives a SELFDESTRUCT.
contract Destructible {
    uint256 public storedValue;
    address public immutable deployer;

    constructor() payable {
        deployer = msg.sender;
        storedValue = 0xABCDEF;
    }

    function setValue(uint256 v) external {
        storedValue = v;
    }

    /// SELFDESTRUCT, sending the remaining balance to `recipient`.
    function destroy(address payable recipient) external {
        selfdestruct(recipient);
    }

    /// SELFDESTRUCT sending balance to self (recipient == address(this)). Under
    /// EIP-6780, for a non-same-tx contract this should burn nothing and keep the
    /// balance, since the account is not deleted.
    function destroyToSelf() external {
        selfdestruct(payable(address(this)));
    }

    receive() external payable {}
}

/**
 * Factory that can create a Destructible and (optionally) destroy it within the
 * same transaction, exercising the EIP-6780 "created in same tx" deletion path.
 */
contract DestructFactory {
    event Deployed(address addr);

    /// Deploy a Destructible and keep it (separate-tx destruction will be a no-delete).
    function deploy() external payable returns (address) {
        Destructible d = (new Destructible){value: msg.value}();
        emit Deployed(address(d));
        return address(d);
    }

    /// Deploy a Destructible at a CREATE2 address (deterministic) and keep it.
    function deploy2(bytes32 salt) external payable returns (address) {
        Destructible d = (new Destructible){value: msg.value, salt: salt}();
        emit Deployed(address(d));
        return address(d);
    }

    /// Deploy AND destroy a Destructible in this single transaction. Under EIP-6780
    /// this is the only path that still wipes code + storage. Returns the address
    /// that was used (so the caller can inspect its code afterwards — expected 0x).
    function deployAndDestroyInSameTx(address payable recipient)
        external
        payable
        returns (address)
    {
        Destructible d = (new Destructible){value: msg.value}();
        address addr = address(d);
        d.destroy(recipient);
        return addr;
    }

    /// Compute the CREATE2 address deploy2() would use, so the spec can assert the
    /// derivation matches keccak256(0xff ++ factory ++ salt ++ keccak(initcode)).
    function computeAddress(bytes32 salt) external view returns (address) {
        bytes32 initCodeHash = keccak256(type(Destructible).creationCode);
        bytes32 h = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
        );
        return address(uint160(uint256(h)));
    }

    /// Expose the init code hash so the spec can derive CREATE2 addresses off-chain too.
    function initCodeHash() external pure returns (bytes32) {
        return keccak256(type(Destructible).creationCode);
    }
}
