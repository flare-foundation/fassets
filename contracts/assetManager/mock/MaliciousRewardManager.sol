// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "../../userInterfaces/IAssetManager.sol";
import "flare-smart-contracts-v2/contracts/userInterfaces/IRewardManager.sol";

contract MaliciousRewardManager {
    uint256 public amount = 0;

    constructor (uint256 _claim) {
        amount = _claim;
    }

    function claim(
        address /* _rewardOwner */,
        address payable /* _recipient */,
        uint24 /* _rewardEpochId */,
        bool /* _wrap */,
        IRewardManager.RewardClaimWithProof[] calldata /* _proofs */
    )
        external
        returns (uint256 _rewardAmountWei)
    {
        return amount;
    }
}