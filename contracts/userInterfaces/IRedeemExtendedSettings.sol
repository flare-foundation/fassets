// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


/**
 * Extended redemption settings interface.
 */
interface IRedeemExtendedSettings {
    /**
     * Minimum amount in UBA for redemption with tag.
     * Redemption with tag requests with smaller amount will be rejected.
     */
    function minimumRedeemAmountUBA()
        external view
        returns (uint256);

    /**
     * The part of the redemption value, in BIPS, that is charged as a system fee at the creation of
     * every redemption request (except for the transfers to the core vault). The fee is subtracted
     * from the redemption value and re-minted to the system redemption fee receiver.
     * If zero, no system redemption fee is charged.
     */
    function systemRedemptionFeeBIPS()
        external view
        returns (uint256);

    /**
     * The address to which the system redemption fee is re-minted.
     * If zero, no system redemption fee is charged.
     */
    function systemRedemptionFeeReceiver()
        external view
        returns (address);

    /**
     * Set the minimum amount in UBA for redemption with tag.
     * Redemption with tag requests with smaller amount will be rejected.
     * NOTE: may only be called by the governance.
     * @param _valueUBA the new minimum redeem with tag amount in UBA;
     *      must be at most 10 lots (in UBA)
     */
    function setMinimumRedeemAmountUBA(uint256 _valueUBA)
        external;

    /**
     * Set the part of the redemption value, in BIPS, that is charged as the system redemption fee.
     * Setting it to zero disables the system redemption fee.
     * NOTE: may only be called by the governance.
     * @param _feeBIPS the new system redemption fee in BIPS; must be less than 10000
     */
    function setSystemRedemptionFeeBIPS(uint256 _feeBIPS)
        external;

    /**
     * Set the address to which the system redemption fee is re-minted.
     * Setting it to zero address disables the system redemption fee.
     * NOTE: may only be called by the governance.
     * @param _receiver the new system redemption fee receiver
     */
    function setSystemRedemptionFeeReceiver(address _receiver)
        external;
}
