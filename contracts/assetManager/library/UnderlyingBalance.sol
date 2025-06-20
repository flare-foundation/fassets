// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeMath} from "@openzeppelin/contracts/utils/math/SafeMath.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {AssetManagerState} from "./data/AssetManagerState.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {Agents} from "./Agents.sol";
import {Agent} from "./data/Agent.sol";
import {Liquidation} from "./Liquidation.sol";
import {TransactionAttestation} from "./TransactionAttestation.sol";
import {PaymentConfirmations} from "./data/PaymentConfirmations.sol";
import {IPayment} from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {PaymentReference} from "../../assetManager/library/data/PaymentReference.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {Globals} from "./Globals.sol";


library UnderlyingBalance {
    using SafeMath for uint256;
    using SafeCast for *;
    using SafePct for *;
    using PaymentConfirmations for PaymentConfirmations.State;
    using Agent for Agent.State;

    function confirmTopupPayment(
        IPayment.Proof calldata _payment,
        address _agentVault
    )
        internal
    {
        Agent.State storage agent = Agent.get(_agentVault);
        Agents.requireAgentVaultOwner(_agentVault);
        AssetManagerState.State storage state = AssetManagerState.get();
        TransactionAttestation.verifyPaymentSuccess(_payment);
        require(_payment.data.responseBody.receivingAddressHash == agent.underlyingAddressHash,
            "not underlying address");
        require(_payment.data.responseBody.standardPaymentReference == PaymentReference.topup(_agentVault),
            "not a topup payment");
        require(_payment.data.responseBody.blockNumber >= agent.underlyingBlockAtCreation,
            "topup before agent created");
        state.paymentConfirmations.confirmIncomingPayment(_payment);
        uint256 amountUBA = SafeCast.toUint256(_payment.data.responseBody.receivedAmount);
        increaseBalance(agent, amountUBA.toUint128());
        emit IAssetManagerEvents.UnderlyingBalanceToppedUp(_agentVault, _payment.data.requestBody.transactionId,
            amountUBA);
    }

    function updateBalance(
        Agent.State storage _agent,
        int256 _balanceChange
    )
        internal
    {
        int256 newBalance = _agent.underlyingBalanceUBA + _balanceChange;
        uint256 requiredBalance = requiredUnderlyingUBA(_agent);
        if (newBalance < requiredBalance.toInt256()) {
            emit IAssetManagerEvents.UnderlyingBalanceTooLow(_agent.vaultAddress(), newBalance, requiredBalance);
            Liquidation.startFullLiquidation(_agent);
        }
        _agent.underlyingBalanceUBA = newBalance.toInt128();
        emit IAssetManagerEvents.UnderlyingBalanceChanged(_agent.vaultAddress(), _agent.underlyingBalanceUBA);
    }

    // Like updateBalance, but it can never make balance negative and trigger liquidation.
    // Separate implementation to avoid dependency on liquidation for balance increases.
    function increaseBalance(
        Agent.State storage _agent,
        uint256 _balanceIncrease
    )
        internal
    {
        _agent.underlyingBalanceUBA += _balanceIncrease.toInt256().toInt128();
        emit IAssetManagerEvents.UnderlyingBalanceChanged(_agent.vaultAddress(), _agent.underlyingBalanceUBA);
    }

    // The minimum underlying balance that has to be held by the agent. Below this, agent is liquidated.
    // The only exception is that outstanding redemption payments can push the balance below by the redeemed amount.
    function requiredUnderlyingUBA(Agent.State storage _agent)
        internal view
        returns (uint256)
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        uint256 backedUBA = uint256(_agent.mintedAMG + _agent.redeemingAMG) * settings.assetMintingGranularityUBA;
        return backedUBA.mulBips(settings.minUnderlyingBackingBIPS);
    }
}
