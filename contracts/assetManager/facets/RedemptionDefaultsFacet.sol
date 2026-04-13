// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IReferencedPaymentNonexistence}
    from "@flarenetwork/flare-periphery-contracts/flare/IReferencedPaymentNonexistence.sol";
import {IConfirmedBlockHeightExists}
    from "@flarenetwork/flare-periphery-contracts/flare/IConfirmedBlockHeightExists.sol";
import {IXRPPaymentNonexistence} from "@flarenetwork/flare-periphery-contracts/flare/IXRPPaymentNonexistence.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {RedemptionDefaults} from "../library/RedemptionDefaults.sol";
import {Redemptions} from "../library/Redemptions.sol";
import {TransactionAttestation} from "../library/TransactionAttestation.sol";
import {Agent} from "../library/data/Agent.sol";
import {Agents} from "../library/Agents.sol";
import {AgentPayout} from "../library/AgentPayout.sol";
import {Redemption} from "../library/data/Redemption.sol";
import {Liquidation} from "../library/Liquidation.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {PaymentReference} from "../library/data/PaymentReference.sol";
import {Globals} from "../library/Globals.sol";


contract RedemptionDefaultsFacet is AssetManagerBase, ReentrancyGuard {
    using SafeCast for uint256;

    error ShouldDefaultFirst();
    error OnlyRedeemerExecutorOrAgent();
    error RedemptionNonPaymentProofWindowTooShort();
    error RedemptionDefaultTooEarly();
    error RedemptionNonPaymentMismatch();
    error InvalidRedemptionStatus();
    error SourceAddressesNotSupported();
    error DestinationTagNotSupported();

    /**
     * If the agent doesn't transfer the redeemed underlying assets in time (until the last allowed block on
     * the underlying chain), the redeemer calls this method and receives payment in collateral (with some extra).
     * The agent can also call default if the redeemer is unresponsive, to payout the redeemer and free the
     * remaining collateral.
     * NOTE: The attestation request must be done with `checkSourceAddresses=false`.
     * NOTE: may only be called by the redeemer (= creator of the redemption request),
     *   the executor appointed by the redeemer,
     *   or the agent owner (= owner of the agent vault in the redemption request)
     * @param _proof proof that the agent didn't pay with correct payment reference on the underlying chain
     * @param _redemptionRequestId id of an existing redemption request
     */
    function redemptionPaymentDefault(
        IReferencedPaymentNonexistence.Proof calldata _proof,
        uint256 _redemptionRequestId
    )
        external
        notFullyEmergencyPaused
        nonReentrant
    {
        require(!_proof.data.requestBody.checkSourceAddresses, SourceAddressesNotSupported());
        Redemption.Request storage request = Redemptions.getRedemptionRequest(_redemptionRequestId, true);
        require(request.status == Redemption.Status.ACTIVE, InvalidRedemptionStatus());
        require(!request.requiresDestinationTag, DestinationTagNotSupported());
        // verify transaction
        TransactionAttestation.verifyReferencedPaymentNonexistence(_proof);
        // check non-payment proof
        require(_proof.data.requestBody.standardPaymentReference ==
                PaymentReference.redemption(_redemptionRequestId) &&
            _proof.data.requestBody.destinationAddressHash == request.redeemerUnderlyingAddressHash &&
            _proof.data.requestBody.amount == request.underlyingValueUBA - request.underlyingFeeUBA,
            RedemptionNonPaymentMismatch());
        require(_proof.data.responseBody.firstOverflowBlockNumber > request.lastUnderlyingBlock &&
            _proof.data.responseBody.firstOverflowBlockTimestamp > request.lastUnderlyingTimestamp,
            RedemptionDefaultTooEarly());
        require(_proof.data.requestBody.minimalBlockNumber <= request.firstUnderlyingBlock,
            RedemptionNonPaymentProofWindowTooShort());
        // FDC request is valid, execute default
        _executePaymentDefault(request, _redemptionRequestId);
    }

    /**
     * If the agent doesn't transfer the redeemed underlying assets in time (until the last allowed block on
     * the underlying chain), the redeemer calls this method and receives payment in collateral (with some extra).
     * The agent can also call default if the redeemer is unresponsive, to payout the redeemer and free the
     * remaining collateral.
     * NOTE: the only difference between this method and `redemptionPaymentDefault` is that this one accepts
     *   IXRPPayment proof type and supports destination tags.
     * NOTE: may only be called by the redeemer (= creator of the redemption request),
     *   the executor appointed by the redeemer,
     *   or the agent owner (= owner of the agent vault in the redemption request)
     * @param _proof proof that the agent didn't pay with correct payment reference on the underlying chain
     * @param _redemptionRequestId id of an existing redemption request
     */
    function xrpRedemptionPaymentDefault(
        IXRPPaymentNonexistence.Proof calldata _proof,
        uint256 _redemptionRequestId
    )
        external
        notFullyEmergencyPaused
        nonReentrant
    {
        Redemption.Request storage request = Redemptions.getRedemptionRequest(_redemptionRequestId, true);
        require(request.status == Redemption.Status.ACTIVE, InvalidRedemptionStatus());
        // verify transaction
        TransactionAttestation.verifyXRPPaymentNonexistence(_proof);
        TransactionAttestation.verifyProofOwnership(_proof.data.requestBody.proofOwner);
        // check non-payment proof
        IXRPPaymentNonexistence.RequestBody calldata rqb = _proof.data.requestBody;
        bool paymentReferenceMatches = rqb.checkFirstMemoData &&
            rqb.firstMemoDataHash == keccak256(abi.encodePacked(PaymentReference.redemption(_redemptionRequestId)));
        bool destinationTagMatches = request.requiresDestinationTag
            ? rqb.checkDestinationTag && rqb.destinationTag == request.destinationTag
            : !rqb.checkDestinationTag;
        require(paymentReferenceMatches &&
            destinationTagMatches &&
            rqb.destinationAddressHash == request.redeemerUnderlyingAddressHash &&
            rqb.amount == request.underlyingValueUBA - request.underlyingFeeUBA,
            RedemptionNonPaymentMismatch());
        require(_proof.data.responseBody.firstOverflowBlockNumber > request.lastUnderlyingBlock &&
            _proof.data.responseBody.firstOverflowBlockTimestamp > request.lastUnderlyingTimestamp,
            RedemptionDefaultTooEarly());
        require(rqb.minimalBlockNumber <= request.firstUnderlyingBlock,
            RedemptionNonPaymentProofWindowTooShort());
        // FDC request is valid, execute default
        _executePaymentDefault(request, _redemptionRequestId);
    }

    function _executePaymentDefault(
        Redemption.Request storage _request,
        uint256 _redemptionRequestId
    )
        private
    {
        Agent.State storage agent = Agent.get(_request.agentVault);
        // We allow only redeemers or agents to trigger redemption default, since they may want
        // to do it at some particular time. (Agent might want to call default to unstick redemption when
        // the redeemer is unresponsive.)
        // The exception is transfer to core vault, where anybody can call default after enough time.
        bool expectedSender = msg.sender == _request.redeemer || msg.sender == _request.executor ||
            Agents.isOwner(agent, msg.sender);
        require(expectedSender || _othersCanConfirmDefault(_request), OnlyRedeemerExecutorOrAgent());
        // pay redeemer in collateral / cancel transfer to core vault
        RedemptionDefaults.executeDefaultOrCancel(agent, _request, _redemptionRequestId);
        // in case of confirmation by other for core vault transfer, pay the reward
        if (!expectedSender) {
            AgentPayout.payForConfirmationByOthers(agent, msg.sender);
        }
        // redemption can make agent healthy, so check and pull out of liquidation
        Liquidation.endLiquidationIfHealthy(agent);
        // pay the executor if the executor called this
        // guarded against reentrancy in RedemptionDefaultsFacet
        Redemptions.payOrBurnExecutorFee(_request);
        // don't finish redemption request at end - the agent might still confirm failed payment
        _request.status = Redemption.Status.DEFAULTED;
    }

    /**
     * If the agent hasn't performed the payment, the agent can close the redemption request to free underlying funds.
     * This method can trigger the default payment without proof, but only after enough time has passed so that
     * attestation proof of non-payment is not available any more.
     * NOTE: may only be called by the owner of the agent vault in the redemption request.
     * @param _proof proof that the attestation query window can not not contain
     *      the payment/non-payment proof anymore
     * @param _redemptionRequestId id of an existing, but already defaulted, redemption request
     */
    function finishRedemptionWithoutPayment(
        IConfirmedBlockHeightExists.Proof calldata _proof,
        uint256 _redemptionRequestId
    )
        external
        notFullyEmergencyPaused
        nonReentrant
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        Redemption.Request storage request = Redemptions.getRedemptionRequest(_redemptionRequestId, true);
        Agent.State storage agent = Agent.get(request.agentVault);
        Agents.requireAgentVaultOwner(agent);
        // the request should have been defaulted by providing a non-payment proof to redemptionPaymentDefault(),
        // except in very rare case when both agent and redeemer cannot perform confirmation while the attestation
        // is still available (~ 1 day) - in this case the agent can perform default without proof
        if (request.status == Redemption.Status.ACTIVE) {
            // verify proof
            TransactionAttestation.verifyConfirmedBlockHeightExists(_proof);
            // if non-payment proof is still available, should use redemptionPaymentDefault() instead
            // (the last inequality tests that the query window in proof is at least as big as configured)
            require(_proof.data.responseBody.lowestQueryWindowBlockNumber > request.lastUnderlyingBlock
                && _proof.data.responseBody.lowestQueryWindowBlockTimestamp > request.lastUnderlyingTimestamp
                && _proof.data.responseBody.lowestQueryWindowBlockTimestamp + settings.attestationWindowSeconds <=
                    _proof.data.responseBody.blockTimestamp,
                ShouldDefaultFirst());
            RedemptionDefaults.executeDefaultOrCancel(agent, request, _redemptionRequestId);
            // redemption can make agent healthy, so check and pull out of liquidation
            Liquidation.endLiquidationIfHealthy(agent);
            // burn the executor fee
            // guarded against reentrancy in RedemptionDefaultsFacet
            Redemptions.burnExecutorFee(request);
            // make sure it cannot be defaulted again
            request.status = Redemption.Status.DEFAULTED;
        }
        // we do not finish redemption request here, because we cannot be certain that proofs have expired,
        // so finishing the request could lead to successful challenge of the agent that paid, but the proof expired
    }

    function _othersCanConfirmDefault(
        Redemption.Request storage _request
    )
        private view
        returns (bool)
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        // others can confirm default only for core vault transfers and only after enough time
        return _request.transferToCoreVault &&
            block.timestamp > _request.timestamp + settings.confirmationByOthersAfterSeconds;
    }
}