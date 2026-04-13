// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {IXRPPayment} from "@flarenetwork/flare-periphery-contracts/flare/IXRPPayment.sol";
import {IXRPPaymentNonexistence} from "@flarenetwork/flare-periphery-contracts/flare/IXRPPaymentNonexistence.sol";
import {RedemptionRequestInfo} from "./data/RedemptionRequestInfo.sol";


/**
 * Extended redemption interface - supports UBA-based redemption (redeemAmount) and
 * XRP destination tag redemption (redeemWithTag).
 */
interface IRedeemExtended {
    /**
     * Redeemer started the redemption with tag process and provided fassets.
     * The amount of fassets corresponding to valueUBA was burned.
     * Several RedemptionWithTagRequested events are emitted, one for every agent redeemed against.
     * (but multiple tickets for the same agent are combined).
     * The agent's collateral is still locked.
     * Such request can only be confirmed with `confirmXRPRedemptionPayment`.
     */
    event RedemptionWithTagRequested(
        address indexed agentVault,
        address indexed redeemer,
        uint256 indexed requestId,
        string paymentAddress,
        uint256 valueUBA,
        uint256 feeUBA,
        uint256 firstUnderlyingBlock,
        uint256 lastUnderlyingBlock,
        uint256 lastUnderlyingTimestamp,
        bytes32 paymentReference,
        address executor,
        uint256 executorFeeNatWei,
        uint256 destinationTag);

    /**
     * In case there were not enough tickets or more than allowed number would have to be redeemed,
     * only partial redemption is done and the `remainingAmountUBA` of the fassets are returned to
     * the redeemer.
     * Emitted by `redeemWithTag` and `redeemAmount`.
     */
    event RedemptionAmountIncomplete(
        address indexed redeemer,
        uint256 remainingAmountUBA);

    /**
     * Redeem (up to) `_amountUBA` FAssets. Like `redeem`, but accepts an arbitrary amount in UBA
     * instead of whole lots. Like `redeem`, does not require a destination tag.
     * NOTE: in some cases not all sent FAssets can be redeemed (either there are not enough tickets or
     * more than a fixed limit of tickets should be redeemed). In this case only part of the approved assets
     * are burned and redeemed and the redeemer can execute this method again for the remaining amount.
     * In such a case the `RedemptionAmountIncomplete` event will be emitted, indicating remaining amount.
     * Agent receives redemption request id and instructions for underlying payment in
     * RedemptionRequested event and has to pay `value - fee` and use the provided payment reference.
     * @param _amountUBA amount of redeemer's FAssets that will be burned; this is NOT the amount of assets
     *      that will be received by the redeemer - the redemption fee will be subtracted
     * @param _redeemerUnderlyingAddressString the address to which the agent must transfer underlying amount
     * @param _executor the account that is allowed to execute redemption default (besides redeemer and agent)
     * @return _redeemedAmountUBA the actual redeemed amount; may be less than requested if there are not enough
     *      redemption tickets available or the maximum redemption ticket limit is reached
     */
    function redeemAmount(
        uint256 _amountUBA,
        string memory _redeemerUnderlyingAddressString,
        address payable _executor
    ) external payable
        returns (uint256 _redeemedAmountUBA);

    /**
     * Redeem (up to) `_amountUBA` f-assets. The corresponding amount of the f-assets belonging
     * to the redeemer will be burned and the redeemer will get paid by the agent in underlying currency
     * (or, in case of agent's payment default, by agent's collateral with a premium).
     * NOTE: in some cases not all sent f-assets can be redeemed (either there are not enough tickets or
     * more than a fixed limit of tickets should be redeemed). In this case only part of the approved assets
     * are burned and redeemed and the redeemer can execute this method again for the remaining amount.
     * In such a case the `RedemptionAmountIncomplete` event will be emitted, indicating the remaining amount.
     * Agent receives redemption request id and instructions for underlying payment in
     * RedemptionRequested event and has to pay `value - fee` and use the provided payment reference.
     * NOTE: if the underlying block isn't updated regularly, it can happen that there is no time for underlying
     * payment. Since the agents cannot know when the next redemption will happen, they should regularly update the
     * underlying time by obtaining fresh proof of latest underlying block and calling `updateCurrentBlock`.
     * @param _amountUBA amount of redeemer's FAssets that will be burned; this is NOT the amount of assets
     *      that will be received by the redeemer - the redemption fee will be subtracted
     * @param _redeemerUnderlyingAddressString the address to which the agent must transfer underlying amount
     * @param _executor the account that is allowed to execute redemption default (besides redeemer and agent)
     * @param _destinationTag the destination tag that is required in the redemption payment (only for XRP;
     *      it must fit in 32 bits for now)
     * @return _redeemedAmountUBA the actual redeemed amount; may be less than requested if there are not enough
     *      redemption tickets available or the maximum redemption ticket limit is reached
     */
    function redeemWithTag(
        uint256 _amountUBA,
        string memory _redeemerUnderlyingAddressString,
        address payable _executor,
        uint256 _destinationTag
    ) external payable
        returns (uint256 _redeemedAmountUBA);

    /**
     * After paying to the redeemer, the agent must call this method to unlock the collateral
     * and to make sure that the redeemer cannot demand payment in collateral on timeout.
     * The same method must be called for any payment status (SUCCESS, FAILED, BLOCKED).
     * In case of FAILED, it just releases agent's underlying funds and the redeemer gets paid in collateral
     * after calling redemptionPaymentDefault.
     * In case of SUCCESS or BLOCKED, remaining underlying funds and collateral are released to the agent.
     * If the agent doesn't confirm payment in enough time (several hours, setting confirmationByOthersAfterSeconds),
     * anybody can do it and get rewarded from agent's vault.
     * NOTE: the only difference between this method and `confirmRedemptionPayment` is that this one accepts
     *   IXRPPayment proof type and supports destination tags.
     * NOTE: may only be called by the owner of the agent vault in the redemption request
     *   except if enough time has passed without confirmation - then it can be called by anybody
     * @param _payment proof of the underlying payment (must contain exact `value - fee` amount and correct
     *      payment reference)
     * @param _redemptionRequestId id of an existing redemption request
     */
    function confirmXRPRedemptionPayment(
        IXRPPayment.Proof calldata _payment,
        uint256 _redemptionRequestId
    ) external;

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
    ) external;

    /**
     * If false, calling `redeemWithTag` will revert.
     * For now, only XRP chain supports destination tags, so this flag will be true only on XRP network.
     */
    function redeemWithTagSupported()
        external view
        returns (bool);

    /**
     * Returns the data about an ongoing redemption request.
     * Note: once the redemptions is confirmed, the request is deleted and this method fails.
     * However, if there is no payment and the redemption defaults, the method works and returns status DEFAULTED.
     * Note: this method adds redemptionWithTag specific fields to the data returned by `redemptionRequestInfo`.
     * @param _redemptionRequestId the redemption request id, as used for confirming or defaulting the redemption
     */
    function redemptionRequestInfoExt(uint256 _redemptionRequestId)
        external view
        returns (RedemptionRequestInfo.DataExt memory);
}
