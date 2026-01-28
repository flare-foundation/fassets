// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {IXrpPayment} from "../fdc/mockInterface/IXrpPayment.sol";


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

    // Functions

    function executeDirectMinting(
        IXrpPayment.Proof calldata _payment
    ) external;
}
