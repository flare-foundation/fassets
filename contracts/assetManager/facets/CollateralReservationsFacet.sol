// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {CollateralReservations} from "../library/CollateralReservations.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IReferencedPaymentNonexistence, IConfirmedBlockHeightExists}
    from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";

contract CollateralReservationsFacet is AssetManagerBase, ReentrancyGuard {
    using SafeCast for uint256;

    /**
     * Before paying underlying assets for minting, minter has to reserve collateral and
     * pay collateral reservation fee. Collateral is reserved at ratio of agent's agentMinCollateralRatio
     * to requested lots NAT market price.
     * The minter receives instructions for underlying payment
     * (value, fee and payment reference) in event CollateralReserved.
     * Then the minter has to pay `value + fee` on the underlying chain.
     * If the minter pays the underlying amount, minter obtains f-assets.
     * The collateral reservation fee is split between the agent and the collateral pool.
     * NOTE: may only be called by a whitelisted caller when whitelisting is enabled.
     * NOTE: the owner of the agent vault must be in the AgentOwnerRegistry.
     * @param _agentVault agent vault address
     * @param _lots the number of lots for which to reserve collateral
     * @param _maxMintingFeeBIPS maximum minting fee (BIPS) that can be charged by the agent - best is just to
     *      copy current agent's published fee; used to prevent agent from front-running reservation request
     *      and increasing fee (that would mean that the minter would have to pay raised fee or forfeit
     *      collateral reservation fee)
     * @param _executor the account that is allowed to execute minting (besides minter and agent)
     */
    function reserveCollateral(
        address _agentVault,
        uint256 _lots,
        uint256 _maxMintingFeeBIPS,
        address payable _executor
    )
        external payable
        onlyAttached
        onlyWhitelistedSender
        notEmergencyPaused
        nonReentrant
        returns (uint256 _collateralReservationId)
    {
        return CollateralReservations.reserveCollateral(msg.sender, _agentVault,
            _lots.toUint64(), _maxMintingFeeBIPS.toUint64(), _executor);
    }

    /**
     * Return the collateral reservation fee amount that has to be passed to the `reserveCollateral` method.
     * NOTE: the amount paid may be larger than the required amount, but the difference is not returned.
     * It is advised that the minter pays the exact amount, but when the amount is so small that the revert
     * would cost more than the lost difference, the minter may want to send a slightly larger amount to compensate
     * for the possibility of a FTSO price change between obtaining this value and calling `reserveCollateral`.
     * @param _lots the number of lots for which to reserve collateral
     * @return _reservationFeeNATWei the amount of reservation fee in NAT wei
     */
    function collateralReservationFee(
        uint256 _lots
    )
        external view
        returns (uint256 _reservationFeeNATWei)
    {
        return CollateralReservations.calculateReservationFee(_lots.toUint64());
    }

    /**
     * When the time for minter to pay underlying amount is over (i.e. the last underlying block has passed),
     * the agent can declare payment default. Then the agent collects collateral reservation fee
     * (it goes directly to the vault), and the reserved collateral is unlocked.
     * NOTE: The attestation request must be done with `checkSourceAddresses=false`.
     * NOTE: may only be called by the owner of the agent vault in the collateral reservation request.
     * @param _proof proof that the minter didn't pay with correct payment reference on the underlying chain
     * @param _collateralReservationId id of a collateral reservation created by the minter
     */
    function mintingPaymentDefault(
        IReferencedPaymentNonexistence.Proof calldata _proof,
        uint256 _collateralReservationId
    )
        external
        nonReentrant
    {
        CollateralReservations.mintingPaymentDefault(_proof, _collateralReservationId.toUint64());
    }

    /**
     * If collateral reservation request exists for more than 24 hours, payment or non-payment proof are no longer
     * available. In this case agent can call this method, which burns reserved collateral at market price
     * and releases the remaining collateral (CRF is also burned).
     * NOTE: may only be called by the owner of the agent vault in the collateral reservation request.
     * NOTE: the agent (management address) receives the vault collateral (if not NAT) and NAT is burned instead.
     *      Therefore this method is `payable` and the caller must provide enough NAT to cover the received vault
     *      collateral amount multiplied by `vaultCollateralBuyForFlareFactorBIPS`.
     *      If vault collateral is NAT, it is simply burned and msg.value must be zero.
     * @param _proof proof that the attestation query window can not not contain
     *      the payment/non-payment proof anymore
     * @param _collateralReservationId collateral reservation id
     */
    function unstickMinting(
        IConfirmedBlockHeightExists.Proof calldata _proof,
        uint256 _collateralReservationId
    )
        external payable
        nonReentrant
    {
        CollateralReservations.unstickMinting(_proof, _collateralReservationId.toUint64());
    }
}
