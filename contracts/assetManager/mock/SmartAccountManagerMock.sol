// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IMemoInstructionsFacet} from "@flarenetwork/flare-periphery-contracts/flare/IMemoInstructionsFacet.sol";
import {IFAsset} from "../../userInterfaces/IFAsset.sol";

// solhint-disable no-empty-blocks
contract SmartAccountManagerMock is IMemoInstructionsFacet {
    event MintedToSmartAccount(
        bytes32 transactionId,
        string sourceAddress,
        uint256 amount,
        uint256 underlyingTimestamp,
        bytes memoData,
        uint256 nativeValueReceived,
        bytes fullData
    );

    IFAsset public immutable fAsset;

    constructor(
        IFAsset _fAsset
    ) {
        fAsset = _fAsset;
    }

    function handleMintedFAssets(
        bytes32 _transactionId,
        string calldata _sourceAddress,
        uint256 _amount,
        uint256 _underlyingTimestamp,
        bytes calldata _memoData,
        address payable _executor,
        bytes calldata _fullData
    ) external payable {
        fAsset.transfer(_executor, _amount);
        emit MintedToSmartAccount(_transactionId, _sourceAddress, _amount, _underlyingTimestamp,
            _memoData, msg.value, _fullData);
    }

    // the following methods are here just to satisfy interface

    function isTransactionIdUsed(
        bytes32 _transactionId
    ) external view returns (bool) {}

    function getNonce(address _personalAccount) external view returns (uint256) {}

    function getExecutor(
        address _personalAccount
    ) external view returns (address) {}
}
