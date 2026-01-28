// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ISmartAccountManagerMock {
    function mintedFAssets(
        bytes32 _sourceAddressHash,
        uint256 _amount,
        bool _hasMemoData,
        bytes calldata _firstMemoData,
        address _executor,
        uint256 _suggestedExecutorFeeUBA
    ) external;
}