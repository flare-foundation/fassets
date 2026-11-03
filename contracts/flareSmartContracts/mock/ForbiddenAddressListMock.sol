// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IForbiddenAddressList} from "../interfaces/IForbiddenAddressList.sol";
import {ISourceConfig} from "../tee/ISourceConfig.sol";


/**
 * A test double for flare-smart-contracts-v2's `ForbiddenAddressList`, the contract the asset manager is pointed at
 * (`setForbiddenAddressList`). Only its interface is vendored
 * (`../interfaces/IForbiddenAddressList.sol`); the real contract is fsc-v2's, deployed by its owners, and FAsset reads
 * it only through that interface (`ForbiddenAddresses`: `isForbiddenHash` for underlying addresses,
 * `isForbiddenEvmAddress` for Flare addresses).
 *
 * MODELLED: the whole interface. A string list per source id, keyed by the standard address hash
 * `keccak256(bytes(address))`, and one EVM list of `address` values, each with its own version (raised once per call
 * that changes the list) and last-addition time (moved only by a call that added something); additions skip an entry
 * already listed, removals one not listed, and a removal moves the last entry into the removed one's place; paged
 * getters with the total and the version; the list events (not the maintainer ones); `EvmAddressZero`; the removal
 * functions with the signatures of upstream's governance interface `IIForbiddenAddressList`. Every per-source call -
 * the checks (`isForbiddenHash` included), the getters, additions and removals - reverts `UnsupportedSourceId` unless
 * the source id is `BTC`, `XRP` or `DOGE` and fits the network given to the constructor (`getNetwork`): the `test…`
 * id on Testnet, the plain one on Mainnet, either on Local. As on the real list, an asset manager whose chain the
 * list holds no string list under - an EVM chain, or a list of the other kind of network - stops at every
 * underlying-side check.
 *
 * NOT MODELLED:
 * - the canonical-form rule (the real list reverts `NonCanonicalAddress` on addition and on a check by string unless
 *   the address is valid on the deployment's network and in its chain's canonical form): a string is canonical
 *   unless a test marked it otherwise (`setNonCanonicalAddresses`); a marked one is refused as on the real list
 *   and `isCanonicalAddress` is false for it;
 * - Personal Account providers: `getPersonalAccountProvider` is zero for every supported source, so an addition never
 *   lists a Personal Account (the real list asks the source's provider and lists the answer on the EVM list);
 * - governance, its timelock and the maintainers: anyone may add or remove (removal is for tests; the real list's
 *   interface has no removal, only its governance removes), `isMaintainer` is false and `getMaintainers` empty;
 * - the proxy and upgrades.
 */
contract ForbiddenAddressListMock is IForbiddenAddressList {
    struct SourceList {
        bytes32[] hashes;
        string[] addresses;
        mapping(bytes32 addressHash => uint256 indexPlusOne) indexOf;
        uint64 version;
        uint64 lastAddedAt;
    }

    ISourceConfig.Network private immutable network;

    mapping(bytes32 sourceId => SourceList) private lists;
    mapping(bytes32 sourceId => mapping(bytes32 addressHash => bool)) private nonCanonical;

    address[] private evmAddresses;
    mapping(address => uint256 indexPlusOne) private evmIndexOf;
    uint64 private evmVersion;
    uint64 private evmLastAddedAt;

    modifier onlySupportedSource(bytes32 _sourceId) {
        require(_isSupported(_sourceId), UnsupportedSourceId(_sourceId));
        _;
    }

    constructor(ISourceConfig.Network _network) {
        network = _network;
    }

    function addForbiddenAddresses(bytes32 _sourceId, string[] calldata _addresses)
        external
        onlySupportedSource(_sourceId)
    {
        SourceList storage list = lists[_sourceId];
        bool added;
        for (uint256 i = 0; i < _addresses.length; i++) {
            bytes32 addressHash = keccak256(bytes(_addresses[i]));
            require(!nonCanonical[_sourceId][addressHash], NonCanonicalAddress(_sourceId, _addresses[i]));
            if (list.indexOf[addressHash] != 0) continue;
            list.hashes.push(addressHash);
            list.addresses.push(_addresses[i]);
            list.indexOf[addressHash] = list.hashes.length;
            added = true;
            emit ForbiddenAddressAdded(_sourceId, _addresses[i]);
        }
        if (added) {
            list.version += 1;
            list.lastAddedAt = uint64(block.timestamp);
            emit ListVersionChanged(_sourceId, list.version);
        }
    }

    /**
     * Test helper (on the real list, a rule of the source's chain): marks addresses as not canonical under a source,
     * or clears the mark.
     */
    function setNonCanonicalAddresses(bytes32 _sourceId, string[] calldata _addresses, bool _nonCanonical)
        external
        onlySupportedSource(_sourceId)
    {
        for (uint256 i = 0; i < _addresses.length; i++) {
            nonCanonical[_sourceId][keccak256(bytes(_addresses[i]))] = _nonCanonical;
        }
    }

    /**
     * Test helper (on the real list, governance's with timelock): removes addresses from a source's list.
     */
    function removeForbiddenAddresses(bytes32 _sourceId, string[] calldata _addresses)
        external
        onlySupportedSource(_sourceId)
    {
        SourceList storage list = lists[_sourceId];
        bool removed;
        for (uint256 i = 0; i < _addresses.length; i++) {
            bytes32 addressHash = keccak256(bytes(_addresses[i]));
            uint256 indexPlusOne = list.indexOf[addressHash];
            if (indexPlusOne == 0) continue;
            uint256 last = list.hashes.length - 1;
            if (indexPlusOne - 1 != last) {
                bytes32 movedHash = list.hashes[last];
                list.hashes[indexPlusOne - 1] = movedHash;
                list.addresses[indexPlusOne - 1] = list.addresses[last];
                list.indexOf[movedHash] = indexPlusOne;
            }
            list.hashes.pop();
            list.addresses.pop();
            delete list.indexOf[addressHash];
            removed = true;
            emit ForbiddenAddressRemoved(_sourceId, _addresses[i]);
        }
        if (removed) {
            list.version += 1;
            emit ListVersionChanged(_sourceId, list.version);
        }
    }

    function addForbiddenEvmAddresses(address[] calldata _addresses)
        external
    {
        bool added;
        for (uint256 i = 0; i < _addresses.length; i++) {
            address evmAddress = _addresses[i];
            require(evmAddress != address(0), EvmAddressZero());
            if (evmIndexOf[evmAddress] != 0) continue;
            evmAddresses.push(evmAddress);
            evmIndexOf[evmAddress] = evmAddresses.length;
            added = true;
            emit ForbiddenEvmAddressAdded(evmAddress);
        }
        if (added) {
            evmVersion += 1;
            evmLastAddedAt = uint64(block.timestamp);
            emit EvmListVersionChanged(evmVersion);
        }
    }

    /**
     * Test helper (on the real list, governance's with timelock): removes addresses from the EVM list.
     */
    function removeForbiddenEvmAddresses(address[] calldata _addresses)
        external
    {
        bool removed;
        for (uint256 i = 0; i < _addresses.length; i++) {
            address evmAddress = _addresses[i];
            uint256 indexPlusOne = evmIndexOf[evmAddress];
            if (indexPlusOne == 0) continue;
            uint256 last = evmAddresses.length - 1;
            if (indexPlusOne - 1 != last) {
                address moved = evmAddresses[last];
                evmAddresses[indexPlusOne - 1] = moved;
                evmIndexOf[moved] = indexPlusOne;
            }
            evmAddresses.pop();
            delete evmIndexOf[evmAddress];
            removed = true;
            emit ForbiddenEvmAddressRemoved(evmAddress);
        }
        if (removed) {
            evmVersion += 1;
            emit EvmListVersionChanged(evmVersion);
        }
    }

    function isForbiddenHash(bytes32 _sourceId, bytes32 _addressHash)
        external view
        onlySupportedSource(_sourceId)
        returns (bool)
    {
        return lists[_sourceId].indexOf[_addressHash] != 0;
    }

    function isForbidden(bytes32 _sourceId, string calldata _address)
        external view
        onlySupportedSource(_sourceId)
        returns (bool)
    {
        bytes32 addressHash = keccak256(bytes(_address));
        require(!nonCanonical[_sourceId][addressHash], NonCanonicalAddress(_sourceId, _address));
        return lists[_sourceId].indexOf[addressHash] != 0;
    }

    function isForbiddenEvmAddress(address _address)
        external view
        returns (bool)
    {
        return evmIndexOf[_address] != 0;
    }

    function isCanonicalAddress(bytes32 _sourceId, string calldata _address)
        external view
        onlySupportedSource(_sourceId)
        returns (bool)
    {
        return !nonCanonical[_sourceId][keccak256(bytes(_address))];
    }

    function getForbiddenAddressHashes(bytes32 _sourceId, uint256 _start, uint256 _count)
        external view
        onlySupportedSource(_sourceId)
        returns (bytes32[] memory _hashes, uint256 _totalCount, uint64 _version)
    {
        SourceList storage list = lists[_sourceId];
        _totalCount = list.hashes.length;
        _version = list.version;
        uint256 end = _pageEnd(_start, _count, _totalCount);
        _hashes = new bytes32[](end - _start);
        for (uint256 i = _start; i < end; i++) {
            _hashes[i - _start] = list.hashes[i];
        }
    }

    function getForbiddenAddresses(bytes32 _sourceId, uint256 _start, uint256 _count)
        external view
        onlySupportedSource(_sourceId)
        returns (string[] memory _addresses, uint256 _totalCount, uint64 _version)
    {
        SourceList storage list = lists[_sourceId];
        _totalCount = list.addresses.length;
        _version = list.version;
        uint256 end = _pageEnd(_start, _count, _totalCount);
        _addresses = new string[](end - _start);
        for (uint256 i = _start; i < end; i++) {
            _addresses[i - _start] = list.addresses[i];
        }
    }

    function getForbiddenEvmAddresses(uint256 _start, uint256 _count)
        external view
        returns (address[] memory _addresses, uint256 _totalCount, uint64 _version)
    {
        _totalCount = evmAddresses.length;
        _version = evmVersion;
        uint256 end = _pageEnd(_start, _count, _totalCount);
        _addresses = new address[](end - _start);
        for (uint256 i = _start; i < end; i++) {
            _addresses[i - _start] = evmAddresses[i];
        }
    }

    function getVersion(bytes32 _sourceId)
        external view
        onlySupportedSource(_sourceId)
        returns (uint64 _version)
    {
        return lists[_sourceId].version;
    }

    function lastAdditionTimestamp(bytes32 _sourceId)
        external view
        onlySupportedSource(_sourceId)
        returns (uint64)
    {
        return lists[_sourceId].lastAddedAt;
    }

    function getEvmVersion()
        external view
        returns (uint64 _version)
    {
        return evmVersion;
    }

    function lastEvmAdditionTimestamp()
        external view
        returns (uint64)
    {
        return evmLastAddedAt;
    }

    /// No source has a Personal Account provider here: an addition lists nothing on the EVM list but itself.
    function getPersonalAccountProvider(bytes32 _sourceId)
        external view
        onlySupportedSource(_sourceId)
        returns (address)
    {
        return address(0);
    }

    function getNetwork()
        external view
        returns (ISourceConfig.Network)
    {
        return network;
    }

    function isMaintainer(address /* _address */)
        external pure
        returns (bool)
    {
        return false;
    }

    function getMaintainers()
        external pure
        returns (address[] memory _maintainers)
    {
        return new address[](0);
    }

    /**
     * A source the list holds a string list under: `BTC`, `XRP` or `DOGE`, with the `test` prefix exactly on a Testnet
     * list, without it on a Mainnet list, either way on a Local one (upstream's `SourceIds.fitsNetwork`).
     */
    function _isSupported(bytes32 _sourceId)
        private view
        returns (bool)
    {
        bool isTestId = bytes4(_sourceId) == "test";
        bytes32 chain = isTestId ? _sourceId << 32 : _sourceId;
        bool fitsNetwork = network == ISourceConfig.Network.Local
            || isTestId == (network == ISourceConfig.Network.Testnet);
        return (chain == "BTC" || chain == "XRP" || chain == "DOGE") && fitsNetwork;
    }

    function _pageEnd(uint256 _start, uint256 _count, uint256 _totalCount)
        private pure
        returns (uint256)
    {
        if (_start >= _totalCount) return _start;
        return _totalCount - _start < _count ? _totalCount : _start + _count;
    }
}
