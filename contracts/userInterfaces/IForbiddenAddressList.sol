// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


/**
 * @title IForbiddenAddressList
 *
 * @notice A governance-managed list of forbidden underlying chain addresses.
 *  Direct mintings from a forbidden source address are rejected.
 *  Addresses are identified by their standard address hash, i.e. `keccak256(bytes(address))`,
 *  so they must be added in the same (standard) form that the FDC uses when computing the address hash.
 *  The list keeps the insertion order, which is preserved on removals.
 */
interface IForbiddenAddressList {
    /// Emitted when an address is added to the forbidden list.
    event ForbiddenAddressAdded(string underlyingAddress);

    /// Emitted when an address is removed from the forbidden list.
    event ForbiddenAddressRemoved(string underlyingAddress);

    /**
     * Add addresses to the end of the forbidden list. Addresses that are already forbidden are skipped.
     * NOTE: only governance can call this method (without timelock).
     * @param _addresses the underlying addresses to forbid (must be non-empty)
     */
    function addForbiddenAddresses(string[] calldata _addresses)
        external;

    /**
     * Remove addresses from the forbidden list. Addresses that are not forbidden are skipped.
     * NOTE: only governance can call this method (without timelock).
     * @param _addresses the underlying addresses to remove from the list
     */
    function removeForbiddenAddresses(string[] calldata _addresses)
        external;

    /**
     * Check if the underlying address is forbidden.
     * @param _address the underlying address
     */
    function isForbidden(string calldata _address)
        external view
        returns (bool);

    /**
     * Check if the underlying address with the given standard address hash is forbidden.
     * @param _addressHash the address hash, i.e. `keccak256(bytes(address))`
     */
    function isForbiddenHash(bytes32 _addressHash)
        external view
        returns (bool);

    /**
     * The number of forbidden addresses.
     */
    function getLength()
        external view
        returns (uint256);

    /**
     * Return a page of forbidden addresses in insertion order.
     * @param _startCursor zero to start at the beginning of the list, otherwise the hash of the last address
     *  returned by the previous call (the listing continues after that address); reverts if the cursor
     *  address is not in the list (e.g. it was removed in the meantime)
     * @param _maxLength the maximum number of addresses returned
     * @return _addresses the forbidden addresses; fewer than `_maxLength` means the end of the list was reached
     */
    function getList(bytes32 _startCursor, uint256 _maxLength)
        external view
        returns (string[] memory _addresses);
}
