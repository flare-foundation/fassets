// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IMemoInstructionsFacet} from "@flarenetwork/flare-periphery-contracts/flare/IMemoInstructionsFacet.sol";
import {IMintingTagManager} from "../../userInterfaces/IMintingTagManager.sol";
import {MintingRateLimiter} from "./data/MintingRateLimiter.sol";


library DirectMinting {
    struct MintingTarget {
        bool mintToSmartAccount;
        address recipient;
        address allowedExecutor;
    }

    struct DelayedMinting {
        uint64 startedAt;
        uint64 allowedAt;
        // The minting capacity is always checked/reserved before limit checks that can create delay, so this flag
        // will always be true for new mintings. However, if delay happens just before the upgrade that introduced
        // the minting cap check/reservation, it will be false (otherwise, the system would try to release unreserved
        // capacity, leading to underflow).
        bool mintingCapacityReserved;
        // Recipient and executor of the minting are captured at delay creation time so that they cannot be
        // changed (by transferring the tag or updating its recipient/executor) during the delay. If this flag
        // is false (delay was recorded before the upgrade that introduced this field), the execution falls back
        // to resolving the values from the payment at execution time.
        bool targetStored;
        bool mintToSmartAccount;
        address recipient;
        address allowedExecutor;
    }

    struct State {
        uint8 version;
        IMintingTagManager mintingTagManager;
        IMemoInstructionsFacet smartAccountManager;
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
