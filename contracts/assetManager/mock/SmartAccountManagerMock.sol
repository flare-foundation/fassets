// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ISmartAccountManagerMock} from "./ISmartAccountManagerMock.sol";
import {IFAsset} from "../../userInterfaces/IFAsset.sol";


contract SmartAccountManagerMock is ISmartAccountManagerMock {
    event MintedToSmartAccount(
        bytes32 transactionId,
        string sourceAddress,
        uint256 amount,
        uint256 underlyingTimestamp,
        bytes memoData
    );

    IFAsset public immutable fAsset;

    constructor(
        IFAsset _fAsset
    ) {
        fAsset = _fAsset;
    }

    function mintedFAssets(
        bytes32 _transactionId,
        string calldata _sourceAddress,
        uint256 _amount,
        uint256 _underlyingTimestamp,
        bytes calldata _memoData,
        address _executor
    ) external {
        fAsset.transfer(_executor, _amount);
        emit MintedToSmartAccount(_transactionId, _sourceAddress, _amount, _underlyingTimestamp, _memoData);
    }
}
