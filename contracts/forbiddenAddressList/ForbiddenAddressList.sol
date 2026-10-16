// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";
import {GovernedUUPSProxyImplementation} from "../governance/implementation/GovernedUUPSProxyImplementation.sol";
import {IForbiddenAddressList} from "../userInterfaces/IForbiddenAddressList.sol";


contract ForbiddenAddressList is GovernedUUPSProxyImplementation, IERC165, IForbiddenAddressList {
    error EmptyAddress();
    error InvalidCursor();

    // Doubly linked list node. Zero hash marks the absence of previous/next node
    // (no real address can have zero hash).
    // Unlike AddressSet this ensures that elements keep order even after remove,
    // so reading list by pages in getList never misses an address.
    struct Record {
        string underlyingAddress;
        bytes32 prev;
        bytes32 next;
    }

    mapping(bytes32 addressHash => Record) private records;
    bytes32 private head;
    bytes32 private tail;
    uint256 private length;

    function initialize(IGovernanceSettings _governanceSettings, address _initialGovernance) external {
        initialise(_governanceSettings, _initialGovernance);    // also marks as initialized
    }

    function addForbiddenAddresses(string[] calldata _addresses)
        external
        onlyImmediateGovernance
    {
        for (uint256 i = 0; i < _addresses.length; i++) {
            _add(_addresses[i]);
        }
    }

    function removeForbiddenAddresses(string[] calldata _addresses)
        external
        onlyImmediateGovernance
    {
        for (uint256 i = 0; i < _addresses.length; i++) {
            _remove(_addresses[i]);
        }
    }

    function isForbidden(string calldata _address)
        external view
        returns (bool)
    {
        return _contains(keccak256(bytes(_address)));
    }

    function isForbiddenHash(bytes32 _addressHash)
        external view
        returns (bool)
    {
        return _contains(_addressHash);
    }

    function getLength()
        external view
        returns (uint256)
    {
        return length;
    }

    function getList(bytes32 _startCursor, uint256 _maxLength)
        external view
        returns (string[] memory _addresses)
    {
        bytes32 start;
        if (_startCursor == 0) {
            start = head;
        } else {
            require(_contains(_startCursor), InvalidCursor());
            start = records[_startCursor].next;
        }
        uint256 count = 0;
        for (bytes32 hash = start; hash != 0 && count < _maxLength; hash = records[hash].next) {
            count++;
        }
        _addresses = new string[](count);
        bytes32 current = start;
        for (uint256 i = 0; i < count; i++) {
            Record storage record = records[current];
            _addresses[i] = record.underlyingAddress;
            current = record.next;
        }
    }

    /**
     * Implementation of ERC-165 interface.
     */
    function supportsInterface(bytes4 _interfaceId)
        public pure override
        returns (bool)
    {
        return _interfaceId == type(IERC165).interfaceId
            || _interfaceId == type(IForbiddenAddressList).interfaceId;
    }

    function _add(string calldata _address) private {
        require(bytes(_address).length > 0, EmptyAddress());
        bytes32 hash = keccak256(bytes(_address));
        if (_contains(hash)) return;
        Record storage record = records[hash];
        record.underlyingAddress = _address;
        record.prev = tail;
        if (tail != 0) {
            records[tail].next = hash;
        } else {
            head = hash;
        }
        tail = hash;
        length += 1;
        emit ForbiddenAddressAdded(_address);
    }

    function _remove(string calldata _address) private {
        bytes32 hash = keccak256(bytes(_address));
        if (!_contains(hash)) return;
        Record storage record = records[hash];
        bytes32 prev = record.prev;
        bytes32 next = record.next;
        if (prev != 0) {
            records[prev].next = next;
        } else {
            head = next;
        }
        if (next != 0) {
            records[next].prev = prev;
        } else {
            tail = prev;
        }
        delete records[hash];
        length -= 1;
        emit ForbiddenAddressRemoved(_address);
    }

    function _contains(bytes32 _addressHash) private view returns (bool) {
        // empty addresses cannot be added, so empty string marks a missing record
        return bytes(records[_addressHash].underlyingAddress).length > 0;
    }
}
