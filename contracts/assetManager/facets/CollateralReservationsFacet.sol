// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IReferencedPaymentNonexistence, IConfirmedBlockHeightExists}
    from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Transfers} from "../../utils/library/Transfers.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {Conversion} from "../library/Conversion.sol";
import {Agents} from "../library/Agents.sol";
import {Minting} from "../library/Minting.sol";
import {AgentCollateral} from "../library/AgentCollateral.sol";
import {TransactionAttestation} from "../library/TransactionAttestation.sol";
import {Collateral} from "../library/data/Collateral.sol";
import {Agent} from "../library/data/Agent.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {CollateralReservation} from "../library/data/CollateralReservation.sol";
import {PaymentReference} from "../library/data/PaymentReference.sol";
import {Globals} from "../library/Globals.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";

contract CollateralReservationsFacet is AssetManagerBase, ReentrancyGuard {
    using SafePct for uint256;
    using SafeCast for uint256;
    using AgentCollateral for Collateral.CombinedData;
    using Agent for Agent.State;
    using EnumerableSet for EnumerableSet.AddressSet;

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
        Agent.State storage agent = Agent.get(_agentVault);
        Agents.requireWhitelistedAgentVaultOwner(agent);
        Collateral.CombinedData memory collateralData = AgentCollateral.combinedData(agent);
        AssetManagerState.State storage state = AssetManagerState.get();
        require(state.mintingPausedAt == 0, "minting paused");
        require(agent.availableAgentsPos != 0 || agent.alwaysAllowedMinters.contains(msg.sender),
            "agent not in mint queue");
        require(_lots > 0, "cannot mint 0 lots");
        require(agent.status == Agent.Status.NORMAL, "rc: invalid agent status");
        require(collateralData.freeCollateralLots(agent) >= _lots, "not enough free collateral");
        require(_maxMintingFeeBIPS >= agent.feeBIPS, "agent's fee too high");
        uint64 valueAMG = _lots.toUint64() * Globals.getSettings().lotSizeAMG;
        _reserveCollateral(agent, valueAMG + _currentPoolFeeAMG(agent, valueAMG));
        // - only charge reservation fee for public minting, not for alwaysAllowedMinters on non-public agent
        // - poolCollateral is WNat, so we can use its price for calculation of CR fee
        uint256 reservationFee = agent.availableAgentsPos != 0
            ? _reservationFee(collateralData.poolCollateral.amgToTokenWeiPrice, valueAMG)
            : 0;
        require(msg.value >= reservationFee, "inappropriate fee amount");
        // create new crt id - pre-increment, so that id can never be 0
        state.newCrtId += PaymentReference.randomizedIdSkip();
        uint256 crtId = state.newCrtId;
        // create in-memory cr and then put it to storage to not go out-of-stack
        CollateralReservation.Data memory cr;
        cr.valueAMG = valueAMG;
        cr.underlyingFeeUBA = Conversion.convertAmgToUBA(valueAMG).mulBips(agent.feeBIPS).toUint128();
        cr.reservationFeeNatWei = reservationFee.toUint128();
        // 1 is added for backward compatibility where 0 means "value not stored" - it is subtracted when used
        cr.poolFeeShareBIPS = agent.poolFeeShareBIPS + 1;
        cr.agentVault = _agentVault;
        cr.minter = msg.sender;
        if (_executor != address(0)) {
            cr.executor = _executor;
            cr.executorFeeNatGWei = ((msg.value - reservationFee) / Conversion.GWEI).toUint64();
        }
        (uint64 lastUnderlyingBlock, uint64 lastUnderlyingTimestamp) = _lastPaymentBlock();
        cr.firstUnderlyingBlock = state.currentUnderlyingBlock;
        cr.lastUnderlyingBlock = lastUnderlyingBlock;
        cr.lastUnderlyingTimestamp = lastUnderlyingTimestamp;
        // store cr
        state.crts[crtId] = cr;
        // emit event
        _emitCollateralReservationEvent(agent, cr, crtId);
        // if executor is not set, we return the change to the minter
        if (cr.executor == address(0) && msg.value > reservationFee) {
            Transfers.transferNAT(payable(cr.minter), msg.value - reservationFee); // cr.minter = msg.sender
        }
        return crtId;
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
        AssetManagerState.State storage state = AssetManagerState.get();
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        uint256 amgToTokenWeiPrice = Conversion.currentAmgPriceInTokenWei(state.poolCollateralIndex);
        return _reservationFee(amgToTokenWeiPrice, _lots.toUint64() * settings.lotSizeAMG);
    }

    /**
     * When the time for minter to pay underlying amount is over (i.e. the last underlying block has passed),
     * the agent can declare payment default. Then the agent collects collateral reservation fee
     * (it goes directly to the vault), and the reserved collateral is unlocked.
     * NOTE: The attestation request must be done with `checkSourceAddresses=false`.
     * NOTE: may only be called by the owner of the agent vault in the collateral reservation request.
     * @param _proof proof that the minter didn't pay with correct payment reference on the underlying chain
     * @param _crtId id of a collateral reservation created by the minter
     */
    function mintingPaymentDefault(
        IReferencedPaymentNonexistence.Proof calldata _proof,
        uint256 _crtId
    )
        external
        nonReentrant
    {
        CollateralReservation.Data storage crt = Minting.getCollateralReservation(_crtId);
        require(!_proof.data.requestBody.checkSourceAddresses, "source addresses not supported");
        Agent.State storage agent = Agent.get(crt.agentVault);
        Agents.requireAgentVaultOwner(agent);
        // check requirements
        TransactionAttestation.verifyReferencedPaymentNonexistence(_proof);
        uint256 underlyingValueUBA = Conversion.convertAmgToUBA(crt.valueAMG);
        require(_proof.data.requestBody.standardPaymentReference == PaymentReference.minting(_crtId) &&
            _proof.data.requestBody.destinationAddressHash == agent.underlyingAddressHash &&
            _proof.data.requestBody.amount == underlyingValueUBA + crt.underlyingFeeUBA,
            "minting non-payment mismatch");
        require(_proof.data.responseBody.firstOverflowBlockNumber > crt.lastUnderlyingBlock &&
            _proof.data.responseBody.firstOverflowBlockTimestamp > crt.lastUnderlyingTimestamp,
            "minting default too early");
        require(_proof.data.requestBody.minimalBlockNumber <= crt.firstUnderlyingBlock,
            "minting non-payment proof window too short");
        // send event
        uint256 reservedValueUBA = underlyingValueUBA + Minting.calculatePoolFeeUBA(agent, crt);
        emit IAssetManagerEvents.MintingPaymentDefault(crt.agentVault, crt.minter, _crtId, reservedValueUBA);
        // share collateral reservation fee between the agent's vault and pool
        uint256 totalFee = crt.reservationFeeNatWei + crt.executorFeeNatGWei * Conversion.GWEI;
        Minting.distributeCollateralReservationFee(agent, totalFee);
        // release agent's reserved collateral
        Minting.releaseCollateralReservation(crt, _crtId);  // crt can't be used after this
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
     * @param _crtId collateral reservation id
     */
    function unstickMinting(
        IConfirmedBlockHeightExists.Proof calldata _proof,
        uint256 _crtId
    )
        external payable
        nonReentrant
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        CollateralReservation.Data storage crt = Minting.getCollateralReservation(_crtId);
        Agent.State storage agent = Agent.get(crt.agentVault);
        Agents.requireAgentVaultOwner(agent);
        // verify proof
        TransactionAttestation.verifyConfirmedBlockHeightExists(_proof);
        // enough time must pass so that proofs are no longer available
        require(_proof.data.responseBody.lowestQueryWindowBlockNumber > crt.lastUnderlyingBlock
            && _proof.data.responseBody.lowestQueryWindowBlockTimestamp > crt.lastUnderlyingTimestamp
            && _proof.data.responseBody.lowestQueryWindowBlockTimestamp + settings.attestationWindowSeconds <=
                _proof.data.responseBody.blockTimestamp,
            "cannot unstick minting yet");
        // burn collateral reservation fee (guarded against reentrancy in AssetManager.unstickMinting)
        Agents.burnDirectNAT(crt.reservationFeeNatWei + crt.executorFeeNatGWei * Conversion.GWEI);
        // burn reserved collateral at market price
        uint256 amgToTokenWeiPrice = Conversion.currentAmgPriceInTokenWei(agent.vaultCollateralIndex);
        uint256 reservedCollateral = Conversion.convertAmgToTokenWei(crt.valueAMG, amgToTokenWeiPrice);
        uint256 burnedNatWei = Agents.burnVaultCollateral(agent, reservedCollateral);
        // send event
        uint256 reservedValueUBA = Conversion.convertAmgToUBA(crt.valueAMG) + Minting.calculatePoolFeeUBA(agent, crt);
        emit IAssetManagerEvents.CollateralReservationDeleted(crt.agentVault, crt.minter, _crtId, reservedValueUBA);
        // release agent's reserved collateral
        Minting.releaseCollateralReservation(crt, _crtId);  // crt can't be used after this
        // If there is some overpaid NAT, send it back.
        Transfers.transferNAT(payable(msg.sender), msg.value - burnedNatWei);
    }

    function _reserveCollateral(
        Agent.State storage _agent,
        uint64 _reservationAMG
    )
        private
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        Minting.checkMintingCap(_reservationAMG);
        _agent.reservedAMG += _reservationAMG;
        state.totalReservedCollateralAMG += _reservationAMG;
    }

    function _emitCollateralReservationEvent(
        Agent.State storage _agent,
        CollateralReservation.Data memory _cr,
        uint256 _crtId
    )
        private
    {
        emit IAssetManagerEvents.CollateralReserved(
            _agent.vaultAddress(),
            _cr.minter,
            _crtId,
            Conversion.convertAmgToUBA(_cr.valueAMG),
            _cr.underlyingFeeUBA,
            _cr.firstUnderlyingBlock,
            _cr.lastUnderlyingBlock,
            _cr.lastUnderlyingTimestamp,
            _agent.underlyingAddressString,
            PaymentReference.minting(_crtId),
            _cr.executor,
            _cr.executorFeeNatGWei * Conversion.GWEI);
    }

    function _currentPoolFeeAMG(
        Agent.State storage _agent,
        uint64 _valueAMG
    )
        private view
        returns (uint64)
    {
        uint256 underlyingValueUBA = Conversion.convertAmgToUBA(_valueAMG);
        uint256 poolFeeUBA = Minting.calculateCurrentPoolFeeUBA(_agent, underlyingValueUBA);
        return Conversion.convertUBAToAmg(poolFeeUBA);
    }

    function _lastPaymentBlock()
        private view
        returns (uint64 _lastUnderlyingBlock, uint64 _lastUnderlyingTimestamp)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        // timeshift amortizes for the time that passed from the last underlying block update
        uint64 timeshift = block.timestamp.toUint64() - state.currentUnderlyingBlockUpdatedAt;
        uint64 blockshift = (uint256(timeshift) * 1000 / settings.averageBlockTimeMS).toUint64();
        _lastUnderlyingBlock =
            state.currentUnderlyingBlock + blockshift + settings.underlyingBlocksForPayment;
        _lastUnderlyingTimestamp =
            state.currentUnderlyingBlockTimestamp + timeshift + settings.underlyingSecondsForPayment;
    }

    function _reservationFee(
        uint256 amgToTokenWeiPrice,
        uint64 _valueAMG
    )
        private view
        returns (uint256)
    {
        uint256 valueNATWei = Conversion.convertAmgToTokenWei(_valueAMG, amgToTokenWeiPrice);
        return valueNATWei.mulBips(Globals.getSettings().collateralReservationFeeBIPS);
    }
}
