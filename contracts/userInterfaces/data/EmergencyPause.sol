// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

library EmergencyPause {
    enum Level {
        // Pause is not active.
        NONE,
        // Prevent starting mint, redeem, liquidation and core vault transfer/return.
        START_OPERATIONS,
        // Everything from START_OPERATIONS, plus prevent finishing or defaulting already started mints and redeems.
        FULL,
        // Everything from FULL, plus prevent FAsset transfers.
        FULL_AND_TRANSFER
    }

    // Permission flag: caller may increase the external emergency pause level.
    uint256 internal constant PAUSE = 1;
    // Permission flag: caller may decrease the external emergency pause level.
    uint256 internal constant UNPAUSE = 2;
    // Permission flag: caller has governance powers and the pause is recorded as a governance pause.
    uint256 internal constant GOVERNANCE = 4;
}
