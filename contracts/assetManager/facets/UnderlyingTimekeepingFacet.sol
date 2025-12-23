// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IConfirmedBlockHeightExists} from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {UnderlyingBlockUpdater} from "../library/UnderlyingBlockUpdater.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";


contract UnderlyingTimekeepingFacet is AssetManagerBase {
    /**
     * Prove that a block with given number and timestamp exists and
     * update the current underlying block info if the provided data is higher.
     * This method should be called by minters before minting and by agent's regularly
     * to prevent current block being too outdated, which gives too short time for
     * minting or redemption payment.
     * NOTE: anybody can call.
     * NOTE: the block/timestamp will only be updated if it is strictly higher than the current value.
     * For mintings and redemptions we also add the duration from the last update (on this chain) to compensate
     * for the time that passed since the last update. This mechanism can be abused by providing old block proof
     * as fresh, which will distort the compensation accounting. Due to monotonicity such an attack will only work
     * if there was no block update for some time. Therefore it is enough to have at least one honest
     * current block updater regularly providing updates to avoid this issue.
     * @param _proof proof that a block with given number and timestamp exists
     */
    function updateCurrentBlock(
        IConfirmedBlockHeightExists.Proof calldata _proof
    )
        external
    {
        UnderlyingBlockUpdater.updateCurrentBlock(_proof);
    }

    /**
     * Get block number and timestamp of the current underlying block.
     * @return _blockNumber current underlying block number tracked by asset manager
     * @return _blockTimestamp current underlying block timestamp tracked by asset manager
     * @return _lastUpdateTs the timestamp on this chain when the current underlying block was last updated
     */
    function currentUnderlyingBlock()
        external view
        returns (uint256 _blockNumber, uint256 _blockTimestamp, uint256 _lastUpdateTs)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return (
            state.currentUnderlyingBlock,
            state.currentUnderlyingBlockTimestamp,
            state.currentUnderlyingBlockUpdatedAt
        );
    }
}
