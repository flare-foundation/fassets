// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {
    IRelay,
    IAddressValidityVerification,
    IBalanceDecreasingTransactionVerification,
    IConfirmedBlockHeightExistsVerification,
    IEVMTransactionVerification,
    IPaymentVerification,
    IReferencedPaymentNonexistenceVerification,
    IWeb2JsonVerification
} from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {IXRPPaymentVerification} from "./IXRPPaymentVerification.sol";

/**
 * FdcVerification interface.
 */
interface IFdcVerification is
    IAddressValidityVerification,
    IBalanceDecreasingTransactionVerification,
    IConfirmedBlockHeightExistsVerification,
    IEVMTransactionVerification,
    IPaymentVerification,
    IReferencedPaymentNonexistenceVerification,
    IXRPPaymentVerification,
    IWeb2JsonVerification
{
    /**
     * The FDC protocol id.
     */
    function fdcProtocolId() external view returns (uint8 _fdcProtocolId);

    /**
     * Relay contract address.
     */
    function relay() external view returns (IRelay);
}
