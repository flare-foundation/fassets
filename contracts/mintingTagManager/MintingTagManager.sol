// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ERC721} from  "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from  "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";
import {GovernedBase} from "../governance/implementation/GovernedBase.sol";
import {GovernedUUPSProxyImplementation} from "../governance/implementation/GovernedUUPSProxyImplementation.sol";
import {Transfers} from "../utils/library/Transfers.sol";
import {IMintingTagManager} from "../userInterfaces/IMintingTagManager.sol";
import {ReentrancyGuard} from "../openzeppelin/security/ReentrancyGuard.sol";


contract MintingTagManager is
    ERC721Enumerable,
    GovernedUUPSProxyImplementation,
    IMintingTagManager,
    ReentrancyGuard
{
    using SafeCast for uint256;

    error OnlyTagOwner();
    error AlreadyInitialized();
    error WrongReservationPaymentAmount();
    error ZeroAddress();

    struct TagData {
        address recipient;
        // When allowedExecutor field is not address(0), only this address can execute direct mintings with this tag.
        // Changing allowedExecutor requires a cooldown period, so that a minter cannot change
        // it in the process of minting, when the executor has already paid for FDC request.
        address allowedExecutor;
        uint64 allowedExecutorActiveAfterTs;
        address oldAllowedExecutor;
    }

    // must be longer than the time to wait for FDC proof
    uint256 internal constant EXECUTOR_CHANGE_ACTIVE_AFTER_SECONDS = 10 minutes;

    string private _name;
    string private _symbol;

    uint256 public nextAvailableTag = 0;
    uint256 public reservationFee;
    address payable public reservationFeeRecipient;
    mapping (uint256 mintingTag => TagData) private tagData;

    modifier onlyTagOwner(uint256 _mintingTag) {
        require(ownerOf(_mintingTag) == msg.sender, OnlyTagOwner());
        _;
    }

    constructor()
        ERC721("", "")
    {
    }

    function initialize(
        IGovernanceSettings _governanceSettings,
        address _initialGovernance,
        string memory name_,
        string memory symbol_,
        uint256 _reservationFee,
        address payable _reservationFeeRecipient,
        uint256 _reservedTagsCount
    ) external {
        require(nextAvailableTag == 0, AlreadyInitialized());
        GovernedBase.initialise(_governanceSettings, _initialGovernance);
        nextAvailableTag = _reservedTagsCount;
        _name = name_;
        _symbol = symbol_;
        reservationFee = _reservationFee;
        reservationFeeRecipient = _reservationFeeRecipient;
    }

    function setReservationFee(
        uint256 _reservationFee
    )
        external
        onlyGovernance
    {
        reservationFee = _reservationFee;
        emit ReservationFeeChanged(_reservationFee, reservationFeeRecipient);
    }

    function setReservationFeeRecipient(
        address payable _reservationFeeRecipient
    )
        external
        onlyGovernance
    {
        reservationFeeRecipient = _reservationFeeRecipient;
        emit ReservationFeeChanged(reservationFee, _reservationFeeRecipient);
    }

    function reserve()
        external payable
        nonReentrant
        returns (uint256)
    {
        require(msg.value == reservationFee, WrongReservationPaymentAmount());
        uint256 mintingTag = _reserve(msg.sender);
        Transfers.transferNAT(reservationFeeRecipient, msg.value);
        return mintingTag;
    }

    function setMintingRecipient(uint256 _mintingTag, address _recipient)
        external
        onlyTagOwner(_mintingTag)
    {
        require(_recipient != address(0), ZeroAddress());
        _setRecipient(_mintingTag, _recipient);
    }

    function setAllowedExecutor(uint256 _mintingTag, address _executor)
        external
        onlyTagOwner(_mintingTag)
    {
        _setExecutor(_mintingTag, _executor);
    }

    function transfer(address _to, uint256 _mintingTag) external {
        _transfer(msg.sender, _to, _mintingTag);
    }

    /**
     * @dev See {IERC721Metadata-name}.
     */
    function name() public view virtual override returns (string memory) {
        return _name;
    }

    /**
     * @dev See {IERC721Metadata-symbol}.
     */
    function symbol() public view virtual override returns (string memory) {
        return _symbol;
    }

    function reservedTagsForOwner(address _owner)
        external view
        returns (uint256[] memory)
    {
        uint256 count = balanceOf(_owner);
        uint256[] memory result = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = tokenOfOwnerByIndex(_owner, i);
        }
        return result;
    }

    function mintingRecipient(uint256 _mintingTag)
        external view virtual override
        returns (address)
    {
        return tagData[_mintingTag].recipient;
    }

    function allowedExecutor(uint256 _mintingTag)
        external view virtual override
        returns (address)
    {
        return _allowedExecutor(tagData[_mintingTag]);
    }

    function pendingAllowedExecutorChange(uint256 _mintingTag)
        external view virtual override
        returns (bool _pending, address _newExecutor, uint256 _activeAfterTs)
    {
        TagData storage tag = tagData[_mintingTag];
        if (block.timestamp < tag.allowedExecutorActiveAfterTs) {
            return (true, tag.allowedExecutor, tag.allowedExecutorActiveAfterTs);
        } else {
            return (false, address(0), 0);
        }
    }

    function _afterTokenTransfer(address /* _from */, address _to, uint256 _firstTokenId, uint256 _batchSize)
        internal virtual override
    {
        // update the minting recipient to the new owner on transfer or reservation
        for (uint256 i = 0; i < _batchSize; i++) {
            _setRecipient(_firstTokenId + i, _to);
            _setExecutor(_firstTokenId + i, address(0));
        }
    }

    function _reserve(address _to) internal returns (uint256) {
        uint256 mintingTag = nextAvailableTag;
        nextAvailableTag += 1;
        _safeMint(_to, mintingTag);
        emit MintingTagReserved(mintingTag, _to);
        return mintingTag;
    }

    function _setRecipient(uint256 _mintingTag, address _recipient) internal {
        TagData storage tag = tagData[_mintingTag];
        if (tag.recipient != _recipient) {
            tag.recipient = _recipient;
            emit RecipientChanged(_mintingTag, _recipient);
        }
    }

    function _setExecutor(uint256 _mintingTag, address _executor) internal {
        TagData storage tag = tagData[_mintingTag];
        address currentAllowedExecutor = _allowedExecutor(tag);
        if (currentAllowedExecutor != _executor) {
            uint256 allowedExecutorActiveAfterTs = block.timestamp + EXECUTOR_CHANGE_ACTIVE_AFTER_SECONDS;
            tag.oldAllowedExecutor = currentAllowedExecutor;
            tag.allowedExecutor = _executor;
            tag.allowedExecutorActiveAfterTs = allowedExecutorActiveAfterTs.toUint64();
            emit AllowedExecutorChangePending(_mintingTag, _executor, allowedExecutorActiveAfterTs);
        }
    }

    function _allowedExecutor(TagData storage _tag) internal view returns (address) {
        return block.timestamp >= _tag.allowedExecutorActiveAfterTs ? _tag.allowedExecutor : _tag.oldAllowedExecutor;
    }
}
