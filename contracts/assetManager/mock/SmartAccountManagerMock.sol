// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IMemoInstructionsFacet} from "@flarenetwork/flare-periphery-contracts/flare/IMemoInstructionsFacet.sol";
import {IFAsset} from "../../userInterfaces/IFAsset.sol";
import {IRedeemExtended} from "../../userInterfaces/IRedeemExtended.sol";

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

    // memo data that triggers an immediate redemption back to the source address
    bytes private constant REDEEM_INSTRUCTION = "REDEEM";

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
        // The asset manager (msg.sender) disables its reentrancy guard before calling this method, so the
        // smart account manager is allowed to call back into it. Use that to immediately redeem the minted
        // FAssets back to the original payment source address when instructed to do so.
        if (keccak256(_memoData) == keccak256(REDEEM_INSTRUCTION)) {
            IRedeemExtended(msg.sender).redeemAmount(_amount, _sourceAddress, _executor);
        } else {
            fAsset.transfer(_executor, _amount);
        }
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
