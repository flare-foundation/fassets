// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ISmartAccountManagerMock {
    event MintedToSmartAccount(
        bytes32 sourceAddressHash,
        uint256 amount,
        bool hasMemoData,
        bytes firstMemoData
    );

    function mintedFAssets(
        bytes32 _sourceAddressHash,
        uint256 _amount,
        bool _hasMemoData,
        bytes calldata _firstMemoData,
        address _executor,
        uint256 _suggestedExecutorFeeUBA
    ) external;
}
