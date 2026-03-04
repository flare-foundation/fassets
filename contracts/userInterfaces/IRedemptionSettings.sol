// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


/**
 * Redemption settings interface.
 */
interface IRedemptionSettings {
    /**
     * Minimum amount in UBA for redemption with tag.
     * Redemption with tag requests with smaller amount will be rejected.
     */
    function minimumRedeemWithTagAmountUBA()
        external view
        returns (uint256);

    /**
     * Set the minimum amount in UBA for redemption with tag.
     * Redemption with tag requests with smaller amount will be rejected.
     * NOTE: may only be called by the governance.
     * @param _valueUBA the new minimum redeem with tag amount in UBA;
     *      must be at most 10 lots (in UBA)
     */
    function setMinimumRedeemWithTagAmountUBA(uint256 _valueUBA)
        external;
}
