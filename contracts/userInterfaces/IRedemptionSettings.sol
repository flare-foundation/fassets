// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


/**
 * Redemption settings interface.
 */
interface IRedemptionSettings {
    /**
     * Minimum redemption amount in UBA for redemption with tag.
     * Redemption requests with smaller amount will be rejected.
     */
    function minimumRedemptionAmountUBA()
        external view
        returns (uint256);

    /**
     * Set the minimum redemption amount in UBA.
     * Redemption requests with smaller amount will be rejected.
     * NOTE: may only be called by the governance.
     * @param _valueUBA the new minimum redemption amount in UBA;
     *      must be at most 10 lots (in UBA)
     */
    function setMinimumRedemptionAmountUBA(uint256 _valueUBA)
        external;
}
