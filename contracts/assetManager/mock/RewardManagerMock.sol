// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@flarenetwork/flare-periphery-contracts/flare/IRewardManager.sol";
import "../../flareSmartContracts/interfaces/IWNat.sol";

contract RewardManagerMock {
    IWNat private wNat;

    constructor(IWNat _wNat) {
        wNat = _wNat;
    }

    receive() external payable {}

    function claim(
        address /* _rewardOwner */,
        address payable _recipient,
        uint24 /* _rewardEpochId */,
        bool _wrap,
        IRewardManager.RewardClaimWithProof[] calldata /* _proofs */
    )
        external returns(uint256 _rewardAmount)
    {
        uint256 reward = 1 ether;
        if (_wrap) {
            wNat.transfer(_recipient, reward);
        } else {
            wNat.withdraw(reward);
            /* solhint-disable avoid-low-level-calls */
            //slither-disable-next-line arbitrary-send-eth
            (bool success, ) = _recipient.call{value: reward}("");
            /* solhint-enable avoid-low-level-calls */
            require(success, "transfer failed");
        }
        return reward;
    }
}
