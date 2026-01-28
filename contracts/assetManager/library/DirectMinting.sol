// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IFAssetMintingTag} from "../../userInterfaces/IFAssetMintingTag.sol";
import {ISmartAccountManagerMock} from "../mock/ISmartAccountManagerMock.sol";


library DirectMinting {
    struct State {
        IFAssetMintingTag mintingTags;
        uint32 coreVaultDonationTag;
        ISmartAccountManagerMock smartAccountManager;
        address mintingFeeReceiver;
        uint64 minimumMintingFeeAmg;
        uint16 mintingFeeBIPS;
        uint16 executorFeeBIPS; // relative to minting fee
    }

    function mintingRecipientForTag(uint256 _mintingTag)
        internal view
        returns (address)
    {
        State storage state = getState();
        return state.mintingTags.mintingRecipient(_mintingTag);
    }

    bytes32 internal constant STATE_POSITION = keccak256("fasset.DirectMinting.State");

    function getState()
        internal pure
        returns (State storage _state)
    {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
