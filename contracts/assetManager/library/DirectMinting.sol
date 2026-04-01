// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IInstructionsFacet} from "@flarenetwork/flare-periphery-contracts/flare/IInstructionsFacet.sol";
import {IMintingTagManager} from "../../userInterfaces/IMintingTagManager.sol";
import {MintingRateLimiter} from "./data/MintingRateLimiter.sol";


library DirectMinting {
    struct DelayedMinting {
        uint64 startedAt;
        uint64 allowedAt;
    }

    struct State {
        uint8 version;
        IMintingTagManager mintingTagManager;
        IInstructionsFacet smartAccountManager;
        address mintingFeeReceiver;
        uint64 minimumMintingFeeAmg;
        uint16 mintingFeeBIPS;
        uint64 executorFeeAmg;
        uint64 othersCanExecuteAfterSeconds;
        MintingRateLimiter.State hourlyLimiter;
        MintingRateLimiter.State dailyLimiter;
        uint64 largeMintingThresholdAmg;
        uint64 largeMintingDelaySeconds;
        uint64 unblockMintingsUntilTimestamp;
        uint64 mintingsUnblockedAt;
        mapping (bytes32 transactionId => DelayedMinting) delayedMintings;
    }

    function mintingRecipientForTag(uint256 _mintingTag)
        internal view
        returns (address)
    {
        State storage state = getState();
        return state.mintingTagManager.mintingRecipient(_mintingTag);
    }

    function allowedExecutorForTag(uint256 _mintingTag)
        internal view
        returns (address)
    {
        State storage state = getState();
        return state.mintingTagManager.allowedExecutor(_mintingTag);
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
