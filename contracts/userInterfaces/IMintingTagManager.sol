// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {IERC721EnumerableUpgradeable}
    from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/IERC721EnumerableUpgradeable.sol";


/**
 * @title IMintingTagManager
 *
 * @notice Manages minting tags for direct minting in the FAsset system.
 *  Each minting tag is an ERC721 token that authorizes its owner to perform direct mintings.
 *  Tags are reserved by paying a fee and can be transferred. Each tag has a configurable
 *  minting recipient (the address that receives minted f-assets) and an optional allowed
 *  executor (the only address permitted to execute direct mintings with that tag).
 */
interface IMintingTagManager is IERC721EnumerableUpgradeable {
    /// Emitted when a new minting tag is reserved.
    event MintingTagReserved(uint256 tag, address owner);

    /// Emitted when the minting recipient for a tag is changed.
    event RecipientChanged(uint256 tag, address recipient);

    /// Emitted when an allowed executor change is initiated (subject to cooldown delay).
    event AllowedExecutorChangePending(uint256 tag, address executor, uint256 activeAfterTs);

    /// Emitted when the reservation fee or its recipient is changed by governance.
    event ReservationFeeChanged(uint256 reservationFee, address recipient);

    /**
     * Reserve a new minting tag by paying the reservation fee.
     * The caller becomes the owner of the tag and the initial minting recipient.
     * @return The newly reserved minting tag id.
     */
    function reserve() external payable returns (uint256);

    /**
     * Transfer a minting tag to a new owner. Also updates the minting recipient
     * to the new owner and resets the allowed executor.
     * @param _to The address to transfer the tag to.
     * @param _mintingTag The minting tag id to transfer.
     */
    function transfer(address _to, uint256 _mintingTag) external;

    /**
     * Set the minting recipient for a tag. Only callable by the tag owner.
     * The minting recipient is the address that receives minted f-assets when this tag is used.
     * @param _mintingTag The minting tag id.
     * @param _recipient The new minting recipient address (must not be zero address).
     */
    function setMintingRecipient(uint256 _mintingTag, address _recipient) external;

    /**
     * The next tag id that will be assigned on the next reservation.
     */
    function nextAvailableTag() external view returns (uint256);

    /**
     * The fee (in native currency) required to reserve a new minting tag.
     */
    function reservationFee() external view returns (uint256);

    /**
     * Return all minting tag ids owned by the given address.
     * @param _owner The address to query.
     * @return An array of minting tag ids owned by `_owner`.
     */
    function reservedTagsForOwner(address _owner) external view returns (uint256[] memory);

    /**
     * Return the minting recipient for a given tag.
     * @param _mintingTag The minting tag id.
     * @return The address that receives minted f-assets when this tag is used.
     */
    function mintingRecipient(uint256 _mintingTag) external view returns (address);

    /**
     * Return the currently active allowed executor for a given tag.
     * If no executor is set or the pending change hasn't activated yet, returns the previous executor.
     * @param _mintingTag The minting tag id.
     * @return The address of the allowed executor, or address(0) if none is set.
     */
    function allowedExecutor(uint256 _mintingTag) external view returns (address);

    /**
     * Return information about a pending allowed executor change for a given tag.
     * Executor changes are subject to a cooldown delay to allow executor to avoid making FDC request when
     * they won't be allowed to execute minting anymore.
     * @param _mintingTag The minting tag id.
     * @return _pending True if there is a pending executor change that hasn't activated yet.
     * @return _newExecutor The address of the pending new executor (address(0) if no pending change).
     * @return _activeAfterTs The timestamp after which the new executor becomes active (0 if no pending change).
     */
    function pendingAllowedExecutorChange(uint256  _mintingTag)
        external view
        returns (bool _pending, address _newExecutor, uint256 _activeAfterTs);
}
