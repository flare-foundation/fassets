// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@flarenetwork/flare-periphery-contracts/flare/IFdcRequestFeeConfigurations.sol";


contract FdcRequestFeeConfigurationsMock is IFdcRequestFeeConfigurations {
    function getRequestFee(bytes calldata /* _data */) external pure returns (uint256) {
        return 0;
    }
}
