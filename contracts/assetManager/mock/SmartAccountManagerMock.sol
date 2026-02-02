// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ISmartAccountManagerMock} from "./ISmartAccountManagerMock.sol";
import {IFAsset} from "../../userInterfaces/IFAsset.sol";


contract SmartAccountManagerMock is ISmartAccountManagerMock {
    IFAsset public immutable fAsset;

    constructor(
        IFAsset _fAsset
    ) {
        fAsset = _fAsset;
    }

    function mintedFAssets(
        bytes32 _sourceAddressHash,
        uint256 _amount,
        bool _hasMemoData,
        bytes calldata _firstMemoData,
        address _executor,
        uint256 _suggestedExecutorFeeUBA
    ) external {
        fAsset.transfer(_executor, _suggestedExecutorFeeUBA);
        emit MintedToSmartAccount(_sourceAddressHash, _amount, _hasMemoData, _firstMemoData);
    }
}
