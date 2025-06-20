// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "../interfaces/IWNat.sol";

contract DistributionToDelegators {
    IWNat private wNat;

    event OptedOutOfAirdrop(address account);

    constructor(IWNat _wNat) {
        wNat = _wNat;
    }

    receive() external payable {}

    function claim(address /* _rewardOwner */, address _recipient, uint256 /* _month */, bool _wrap)
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

    function optOutOfAirdrop() external {
        emit OptedOutOfAirdrop(msg.sender);
    }

}
