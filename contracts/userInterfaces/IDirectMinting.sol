// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {IXRPPayment} from "../fdc/mockInterface/IXRPPayment.sol";


/**
 * Direct minting interface.
 */
interface IDirectMinting {
    // Events

    event DirectMintingExecuted(
        bytes32 transactionId,
        address targetAddress,
        address executor,
        uint256 mintedAmountUBA,
        uint256 systemFeeUBA,
        uint256 executorFeeUBA);

    event DirectMintingExecutedToSmartAccount(
        bytes32 transactionId,
        bytes32 sourceAddressHash,
        address executor,
        uint256 mintedAmountUBA,
        uint256 systemFeeUBA,
        bool hasMemoData,
        bytes firstMemoData);

    event LargeDirectMintingDelayed(
        bytes32 transactionId,
        uint256 amount,
        uint256 executionAllowedAt);

    event DirectMintingDelayed(
        bytes32 transactionId,
        uint256 amount,
        uint256 executionAllowedAt);

    event DirectMintingsUnblocked(
        uint256 startedUntilTimestamp);

    // Functions

    /**
     * Executes minting directly, without a collateral reservation.
     * The payment must be made to the fAsset Core Vault's XRP address.
     * @param _payment the XRP payment proof data
     */
    function executeDirectMinting(IXRPPayment.Proof calldata _payment)
        external;

    /**
     * Gets the payment address to which the underlying assets must be sent for direct minting.
     */
    function directMintingPaymentAddress()
        external view
        returns (string memory);

    /**
     * Gets the delay state of a direct minting.
     * @param _transactionId the direct minting underlying payment transaction id
     * @return _isDelayed whether the minting is delayed
     * @return _canBeExecuted whether the minting can be executed now
     * @return _allowedAt the timestamp at which the minting can be executed
     * @return _startedAt the timestamp at which the minting was started
     */
    function directMintingDelayState(bytes32 _transactionId)
        external view
        returns (bool _isDelayed, bool _canBeExecuted, uint256 _allowedAt, uint256 _startedAt);
}
