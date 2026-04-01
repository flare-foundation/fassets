// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IInstructionsFacet} from "@flarenetwork/flare-periphery-contracts/flare/IInstructionsFacet.sol";
import {IPayment} from "@flarenetwork/flare-periphery-contracts/flare/IPayment.sol";
import {IFAsset} from "../../userInterfaces/IFAsset.sol";


contract SmartAccountManagerMock is IInstructionsFacet {
    event MintedToSmartAccount(
        bytes32 transactionId,
        string sourceAddress,
        uint256 amount,
        uint256 underlyingTimestamp,
        bytes memoData,
        uint256 nativeValueReceived
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
        address payable _executor
    ) external payable {
        fAsset.transfer(_executor, _amount);
        emit MintedToSmartAccount(_transactionId, _sourceAddress, _amount, _underlyingTimestamp, _memoData, msg.value);
    }

    // the following methods are here just to satisfy interface

    function reserveCollateral(
        string calldata _xrplAddress,
        bytes32 _paymentReference,
        bytes32 _transactionId
    ) external payable returns (uint256 _collateralReservationId) {}

    function executeDepositAfterMinting(
        uint256 _collateralReservationId,
        IPayment.Proof calldata _proof,
        string calldata _xrplAddress
    ) external {}

    function executeInstruction(
        IPayment.Proof calldata _proof,
        string calldata _xrplAddress
    ) external payable {}

    function isTransactionIdUsed(
        bytes32 _transactionId
    ) external view returns (bool) {}

    function getTransactionIdForCollateralReservation(
        uint256 _collateralReservationId
    ) external view returns (bytes32 _transactionId) {}

    function getNonce(address _personalAccount) external view returns (uint256) {}

    function getExecutor(
        address _personalAccount
    ) external view returns (address) {}
}
