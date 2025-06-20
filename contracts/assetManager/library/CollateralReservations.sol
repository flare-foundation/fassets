// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafeMath64} from "../../utils/library/SafeMath64.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Transfers} from "../../utils/library/Transfers.sol";
import {AssetManagerState} from "./data/AssetManagerState.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {Conversion} from "./Conversion.sol";
import {Agents} from "./Agents.sol";
import {Minting} from "./Minting.sol";
import {AgentCollateral} from "./AgentCollateral.sol";
import {TransactionAttestation} from "./TransactionAttestation.sol";
import {Collateral} from "./data/Collateral.sol";
import {Agent} from "./data/Agent.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IReferencedPaymentNonexistence, IConfirmedBlockHeightExists}
    from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {CollateralReservation} from "./data/CollateralReservation.sol";
import {PaymentReference} from "./data/PaymentReference.sol";
import {Globals} from "./Globals.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";



library CollateralReservations {
    using SafePct for *;
    using SafeCast for uint256;
    using AgentCollateral for Collateral.CombinedData;
    using Agent for Agent.State;
    using EnumerableSet for EnumerableSet.AddressSet;

    function reserveCollateral(
        address _minter, // msg.sender
        address _agentVault,
        uint64 _lots,
        uint64 _maxMintingFeeBIPS,
        address payable _executor
    )
        internal
        returns (uint64 _collateralReservationId)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        Agents.requireWhitelistedAgentVaultOwner(agent);
        Collateral.CombinedData memory collateralData = AgentCollateral.combinedData(agent);
        AssetManagerState.State storage state = AssetManagerState.get();
        require(state.mintingPausedAt == 0, "minting paused");
        require(agent.availableAgentsPos != 0 || agent.alwaysAllowedMinters.contains(_minter),
            "agent not in mint queue");
        require(_lots > 0, "cannot mint 0 lots");
        require(agent.status == Agent.Status.NORMAL, "rc: invalid agent status");
        require(collateralData.freeCollateralLots(agent) >= _lots, "not enough free collateral");
        require(_maxMintingFeeBIPS >= agent.feeBIPS, "agent's fee too high");
        uint64 valueAMG = _lots * Globals.getSettings().lotSizeAMG;
        _reserveCollateral(agent, valueAMG + _currentPoolFeeAMG(agent, valueAMG));
        // - only charge reservation fee for public minting, not for alwaysAllowedMinters on non-public agent
        // - poolCollateral is WNat, so we can use its price for calculation of CR fee
        uint256 reservationFee = agent.availableAgentsPos != 0
            ? _reservationFee(collateralData.poolCollateral.amgToTokenWeiPrice, valueAMG)
            : 0;
        require(msg.value >= reservationFee, "inappropriate fee amount");
        // create new crt id - pre-increment, so that id can never be 0
        state.newCrtId += PaymentReference.randomizedIdSkip();
        uint64 crtId = state.newCrtId;
        // create in-memory cr and then put it to storage to not go out-of-stack
        CollateralReservation.Data memory cr;
        cr.valueAMG = valueAMG;
        cr.underlyingFeeUBA = Conversion.convertAmgToUBA(valueAMG).mulBips(agent.feeBIPS).toUint128();
        cr.reservationFeeNatWei = reservationFee.toUint128();
        // 1 is added for backward compatibility where 0 means "value not stored" - it is subtracted when used
        cr.poolFeeShareBIPS = agent.poolFeeShareBIPS + 1;
        cr.agentVault = _agentVault;
        cr.minter = _minter;
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

        _emitCollateralReservationEvent(agent, cr, crtId);

        // if executor is not set, we return the change to the minter
        if (cr.executor == address(0) && msg.value > reservationFee) {
            Transfers.transferNAT(payable(cr.minter), msg.value - reservationFee); // cr.minter = msg.sender
        }
        return crtId;
    }

    function mintingPaymentDefault(
        IReferencedPaymentNonexistence.Proof calldata _nonPayment,
        uint64 _crtId
    )
        internal
    {
        CollateralReservation.Data storage crt = getCollateralReservation(_crtId);
        require(!_nonPayment.data.requestBody.checkSourceAddresses, "source addresses not supported");
        Agent.State storage agent = Agent.get(crt.agentVault);
        Agents.requireAgentVaultOwner(agent);
        // check requirements
        TransactionAttestation.verifyReferencedPaymentNonexistence(_nonPayment);
        uint256 underlyingValueUBA = Conversion.convertAmgToUBA(crt.valueAMG);
        require(_nonPayment.data.requestBody.standardPaymentReference == PaymentReference.minting(_crtId) &&
            _nonPayment.data.requestBody.destinationAddressHash == agent.underlyingAddressHash &&
            _nonPayment.data.requestBody.amount == underlyingValueUBA + crt.underlyingFeeUBA,
            "minting non-payment mismatch");
        require(_nonPayment.data.responseBody.firstOverflowBlockNumber > crt.lastUnderlyingBlock &&
            _nonPayment.data.responseBody.firstOverflowBlockTimestamp > crt.lastUnderlyingTimestamp,
            "minting default too early");
        require(_nonPayment.data.requestBody.minimalBlockNumber <= crt.firstUnderlyingBlock,
            "minting non-payment proof window too short");

        // send event
        uint256 reservedValueUBA = underlyingValueUBA + Minting.calculatePoolFeeUBA(agent, crt);
        emit IAssetManagerEvents.MintingPaymentDefault(crt.agentVault, crt.minter, _crtId, reservedValueUBA);
        // share collateral reservation fee between the agent's vault and pool
        uint256 totalFee = crt.reservationFeeNatWei + crt.executorFeeNatGWei * Conversion.GWEI;
        distributeCollateralReservationFee(agent, totalFee);
        // release agent's reserved collateral
        releaseCollateralReservation(crt, _crtId);  // crt can't be used after this
    }

    function unstickMinting(
        IConfirmedBlockHeightExists.Proof calldata _proof,
        uint64 _crtId
    )
        internal
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        CollateralReservation.Data storage crt = getCollateralReservation(_crtId);
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
        releaseCollateralReservation(crt, _crtId);  // crt can't be used after this
        // If there is some overpaid NAT, send it back.
        Transfers.transferNAT(payable(msg.sender), msg.value - burnedNatWei);
    }

    function distributeCollateralReservationFee(
        Agent.State storage _agent,
        uint256 _fee
    )
        internal
    {
        if (_fee == 0) return;
        uint256 poolFeeShare = _fee.mulBips(_agent.poolFeeShareBIPS);
        _agent.collateralPool.depositNat{value: poolFeeShare}();
        Transfers.depositWNat(Globals.getWNat(), Agents.getOwnerPayAddress(_agent), _fee - poolFeeShare);
    }

    function calculateReservationFee(
        uint64 _lots
    )
        internal view
        returns (uint256)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        uint256 amgToTokenWeiPrice = Conversion.currentAmgPriceInTokenWei(state.poolCollateralIndex);
        return _reservationFee(amgToTokenWeiPrice, _lots * settings.lotSizeAMG);
    }

    function releaseCollateralReservation(
        CollateralReservation.Data storage crt,
        uint64 _crtId
    )
        internal
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        Agent.State storage agent = Agent.get(crt.agentVault);
        uint64 reservationAMG = crt.valueAMG + Conversion.convertUBAToAmg(Minting.calculatePoolFeeUBA(agent, crt));
        agent.reservedAMG = SafeMath64.sub64(agent.reservedAMG, reservationAMG, "invalid reservation");
        state.totalReservedCollateralAMG -= reservationAMG;
        delete state.crts[_crtId];
    }

    function getCollateralReservation(
        uint64 _crtId
    )
        internal view
        returns (CollateralReservation.Data storage)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        require(_crtId > 0 && state.crts[_crtId].valueAMG != 0, "invalid crt id");
        return state.crts[_crtId];
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
        uint64 _crtId
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
