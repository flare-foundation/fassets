// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {IXRPPayment} from "@flarenetwork/flare-periphery-contracts/flare/IXRPPayment.sol";


/**
 * Direct minting interface.
 */
interface IDirectMinting {
    enum DirectMintingDelayState {
        NotDelayed,
        Delayed,
        Released
    }

    // Events

    event DirectMintingExecuted(
        bytes32 transactionId,
        address targetAddress,
        address executor,
        uint256 mintedAmountUBA,
        uint256 mintingFeeUBA,
        uint256 executorFeeUBA);

    event DirectMintingExecutedToSmartAccount(
        bytes32 transactionId,
        string sourceAddress,
        address executor,
        uint256 mintedAmountUBA,
        uint256 mintingFeeUBA,
        bytes memoData);

    event DirectMintingPaymentTooSmallForFee(
        bytes32 transactionId,
        uint256 receivedAmountUBA,
        uint256 minimumMintingFeeUBA);

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
        external payable;

    /**
     * This method is not strictly necessary to allow an unblocked delayed minting to be executed.
     * However, if the minter has set an allowed executor, it has the exclusive right
     * to execute minting for fixed time after the minting is allowed to execute. This method makes sure
     * that the exclusive period begins from the moment the minting was unblocked, not from later allowedAt.
     * @param _transactionId transaction id of the delayed minting to mark as allowed
     */
    function markUnblockedDirectMintingAllowed(bytes32 _transactionId)
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
     * @return _delayState the delay state of the direct minting
     * @return _allowedAt the timestamp at which the minting can be executed
     * @return _startedAt the timestamp at which the minting was started
     */
    function directMintingDelayState(bytes32 _transactionId)
        external view
        returns (DirectMintingDelayState _delayState, uint256 _allowedAt, uint256 _startedAt);
}
