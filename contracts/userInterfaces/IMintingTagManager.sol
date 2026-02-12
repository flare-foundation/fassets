// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";


interface IMintingTagManager is IERC721 {
    event MintingTagReserved(uint256 tag, address owner);
    event RecipientChanged(uint256 tag, address recipient);
    event AllowedExecutorChangePending(uint256 mintingTag, address executor, uint256 activeAfterTs);
    event ReservationFeeChanged(uint256 reservationFeeNATWei, address recipient);

    function reserve() external payable returns (uint256);

    function transfer(address _to, uint256 _mintingTag) external;

    function setMintingRecipient(uint256 _mintingTag, address _recipient) external;

    function nextAvailableTag() external view returns (uint256);

    function reservationFeeNATWei() external view returns (uint256);

    function mintingRecipient(uint256 _mintingTag) external view returns (address);

    function allowedExecutor(uint256 _mintingTag) external view returns (address);

    function pendingAllowedExecutorChange(uint256  _mintingTag)
        external view
        returns (bool _pending, address _newExecutor, uint256 _activeAfterTs);
}
