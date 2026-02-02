// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC721} from  "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";
import {GovernedBase} from "../governance/implementation/GovernedBase.sol";
import {GovernedUUPSProxyImplementation} from "../governance/implementation/GovernedUUPSProxyImplementation.sol";
import {Transfers} from "../utils/library/Transfers.sol";
import {IMintingTagManager} from "../userInterfaces/IMintingTagManager.sol";
import {ReentrancyGuard} from "../openzeppelin/security/ReentrancyGuard.sol";


contract MintingTagManager is
    ERC721,
    GovernedUUPSProxyImplementation,
    IMintingTagManager,
    ReentrancyGuard
{
    error OnlyTagOwner();
    error AlreadyInitialized();
    error WrongReservationPaymentAmount();
    error ZeroAddress();

    string private _name;
    string private _symbol;

    uint256 public nextAvailableTag = 0;
    uint256 public reservationFeeNATWei;
    address payable public reservationFeeRecipient;
    mapping (uint256 mintingTag => address recipient) public mintingRecipient;

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
        uint256 _reservationFeeNATWei,
        address payable _reservationFeeRecipient
    ) external {
        require(nextAvailableTag == 0, AlreadyInitialized());
        GovernedBase.initialise(_governanceSettings, _initialGovernance);
        nextAvailableTag = 1;
        _name = name_;
        _symbol = symbol_;
        reservationFeeNATWei = _reservationFeeNATWei;
        reservationFeeRecipient = _reservationFeeRecipient;
    }

    function reserveForSystem(
        address _to,
        uint256 _numberOfTags
    )
        external
        onlyGovernance
    {
        require(_to != address(0), ZeroAddress());
        for (uint256 i = 0; i < _numberOfTags; i++) {
            _reserve(_to);
        }
    }

    function setReservationFee(
        uint256 _reservationFeeNATWei
    )
        external
        onlyGovernance
    {
        reservationFeeNATWei = _reservationFeeNATWei;
        emit ReservationFeeChanged(_reservationFeeNATWei, reservationFeeRecipient);
    }

    function setReservationFeeRecipient(
        address payable _reservationFeeRecipient
    )
        external
        onlyGovernance
    {
        reservationFeeRecipient = _reservationFeeRecipient;
        emit ReservationFeeChanged(reservationFeeNATWei, _reservationFeeRecipient);
    }

    function reserve()
        external payable
        nonReentrant
        returns (uint256)
    {
        require(msg.value == reservationFeeNATWei, WrongReservationPaymentAmount());
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

    function _afterTokenTransfer(address /* _from */, address _to, uint256 _firstTokenId, uint256 _batchSize)
        internal virtual override
    {
        // update the minting recipient to the new owner on transfer or reservation
        for (uint256 i = 0; i < _batchSize; i++) {
            _setRecipient(_firstTokenId + i, _to);
        }
    }

    function _reserve(address _to) internal returns (uint256) {
        uint256 mintingTag = nextAvailableTag;
        nextAvailableTag += 1;
        _mint(_to, mintingTag);
        emit MintingTagReserved(mintingTag, _to);
        return mintingTag;
    }

    function _setRecipient(uint256 _mintingTag, address _recipient) internal {
        mintingRecipient[_mintingTag] = _recipient;
        emit MintingTagRecipientChanged(_mintingTag, _recipient);
    }
}
