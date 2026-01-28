// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {IXrpPayment} from "./IXrpPayment.sol";

interface IXrpPaymentVerification {
    function verifyXrpPayment(
        IXrpPayment.Proof calldata _proof
    ) external view returns (bool _proved);
}
