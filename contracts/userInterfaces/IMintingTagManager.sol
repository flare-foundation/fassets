// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";


interface IMintingTagManager is IERC721 {
    event MintingTagReserved(uint256 tag, address owner);
    event MintingTagRecipientChanged(uint256 tag, address recipient);
    event ReservationFeeChanged(uint256 reservationFeeNATWei, address recipient);

    function reserve() external payable returns (uint256);
    function transfer(address _to, uint256 _mintingTag) external;
    function setMintingRecipient(uint256 _mintingTag, address _recipient) external;

    function nextAvailableTag() external view returns (uint256);
    function reservationFeeNATWei() external view returns (uint256);
    function mintingRecipient(uint256) external view returns (address);
}
