// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ISmartAccountManagerMock {
    function mintedFAssets(
        bytes32 _transactionId,
        string calldata _sourceAddress,
        uint256 _amount,
        uint256 _underlyingTimestamp,
        bytes calldata _memoData,
        address _executor
    ) external;
}
