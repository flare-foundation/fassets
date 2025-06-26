// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {Agents} from "../library/Agents.sol";
import {Conversion} from "../library/Conversion.sol";
import {Globals} from "../library/Globals.sol";
import {Liquidation} from "../library/Liquidation.sol";
import {LiquidationPaymentStrategy} from "../library/LiquidationPaymentStrategy.sol";
import {Redemptions} from "../library/Redemptions.sol";
import {Agent} from "../library/data/Agent.sol";
import {Collateral} from "../library/data/Collateral.sol";
import {CollateralTypeInt} from "../library/data/CollateralTypeInt.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {SafePct} from "../../utils/library/SafePct.sol";


contract LiquidationFacet is AssetManagerBase, ReentrancyGuard {
    using SafeCast for uint256;
    using SafePct for uint256;
    using Agent for Agent.State;

    /**
     * Checks that the agent's collateral is too low and if true, starts agent's liquidation.
     * NOTE: may only be called by a whitelisted caller when whitelisting is enabled.
     * @param _agentVault agent vault address
     * @return _liquidationStatus 0=no liquidation, 1=CCB, 2=liquidation
     * @return _liquidationStartAt if the status is LIQUIDATION, the timestamp when liquidation started;
     *  if the status is CCB, the timestamp when liquidation will start; otherwise 0
     */
    function startLiquidation(
        address _agentVault
    )
        external
        onlyWhitelistedSender
        notEmergencyPaused
        nonReentrant
        returns (uint8 _liquidationStatus, uint256 _liquidationStartAt)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        // if already in full liquidation or destroying, do nothing
        if (agent.status == Agent.Status.FULL_LIQUIDATION) {
            return (uint8(Agent.LiquidationPhase.LIQUIDATION), agent.liquidationStartedAt);
        }
        if (agent.status == Agent.Status.DESTROYING) {
            return (uint8(Agent.LiquidationPhase.NONE), 0);
        }
        // upgrade liquidation based on CR and time
        Liquidation.CRData memory cr = Liquidation.getCollateralRatiosBIPS(agent);
        (Agent.LiquidationPhase liquidationPhase, bool liquidationUpgraded) = _upgradeLiquidationPhase(agent, cr);
        require(liquidationUpgraded, "liquidation not started");
        _liquidationStatus = uint8(liquidationPhase);
        _liquidationStartAt = Liquidation.getLiquidationStartTimestamp(agent);
    }

    /**
     * Burns up to `_amountUBA` f-assets owned by the caller and pays
     * the caller the corresponding amount of native currency with premium
     * (premium depends on the liquidation state).
     * If the agent isn't in liquidation yet, but satisfies conditions,
     * automatically puts the agent in liquidation status.
     * NOTE: may only be called by a whitelisted caller when whitelisting is enabled.
     * @param _agentVault agent vault address
     * @param _amountUBA the amount of f-assets to liquidate
     * @return _liquidatedAmountUBA liquidated amount of f-asset
     * @return _amountPaidVault amount paid to liquidator (in agent's vault collateral)
     * @return _amountPaidPool amount paid to liquidator (in NAT from pool)
     */
    function liquidate(
        address _agentVault,
        uint256 _amountUBA
    )
        external
        onlyWhitelistedSender
        notEmergencyPaused
        nonReentrant
        returns (uint256 _liquidatedAmountUBA, uint256 _amountPaidVault, uint256 _amountPaidPool)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        // agent in status DESTROYING cannot be backing anything, so there can be no liquidation
        if (agent.status == Agent.Status.DESTROYING) return (0, 0, 0);
        // calculate both CRs
        Liquidation.CRData memory cr = Liquidation.getCollateralRatiosBIPS(agent);
        // allow one-step liquidation (without calling startLiquidation first)
        (Agent.LiquidationPhase currentPhase,) = _upgradeLiquidationPhase(agent, cr);
        require(currentPhase == Agent.LiquidationPhase.LIQUIDATION, "not in liquidation");
        // liquidate redemption tickets
        (uint64 liquidatedAmountAMG, uint256 payoutC1Wei, uint256 payoutPoolWei) =
            _performLiquidation(agent, cr, Conversion.convertUBAToAmg(_amountUBA));
        _liquidatedAmountUBA = Conversion.convertAmgToUBA(liquidatedAmountAMG);
        // pay the liquidator
        if (payoutC1Wei > 0) {
            _amountPaidVault = Agents.payoutFromVault(agent, msg.sender, payoutC1Wei);
        }
        if (payoutPoolWei > 0) {
            uint256 agentResponsibilityWei = _agentResponsibilityWei(agent, payoutPoolWei);
            _amountPaidPool = Agents.payoutFromPool(agent, msg.sender, payoutPoolWei, agentResponsibilityWei);
        }
        // if the agent was already safe due to price changes, there should be no LiquidationPerformed event
        // we do not revert, because it still marks agent as healthy (so there will still be a LiquidationEnded event)
        if (_liquidatedAmountUBA > 0) {
            // burn liquidated fassets
            Redemptions.burnFAssets(msg.sender, _liquidatedAmountUBA);
            // notify about liquidation
            emit IAssetManagerEvents.LiquidationPerformed(_agentVault, msg.sender,
                _liquidatedAmountUBA, _amountPaidVault, _amountPaidPool);
        }
        // try to pull agent out of liquidation
        Liquidation.endLiquidationIfHealthy(agent);
    }

    /**
     * When agent's collateral reaches safe level during liquidation, the liquidation
     * process can be stopped by calling this method.
     * Full liquidation (i.e. the liquidation triggered by illegal underlying payment)
     * cannot be stopped.
     * NOTE: anybody can call.
     * @param _agentVault agent vault address
     */
    function endLiquidation(
        address _agentVault
    )
        external
        nonReentrant
    {
        Agent.State storage agent = Agent.get(_agentVault);
        Liquidation.endLiquidationIfHealthy(agent);
        require(agent.status == Agent.Status.NORMAL, "cannot stop liquidation");
    }

     // Upgrade (CR-based) liquidation phase (NONE -> CCR -> LIQUIDATION), based on agent's collateral ratio.
    // When in full liquidation mode, do nothing.
    function _upgradeLiquidationPhase(
        Agent.State storage _agent,
        Liquidation.CRData memory _cr
    )
        private
        returns (Agent.LiquidationPhase, bool)
    {
        Agent.LiquidationPhase currentPhase = Liquidation.currentLiquidationPhase(_agent);
        // calculate new phase for both collaterals and if any is underwater, set its flag
        Agent.LiquidationPhase newPhaseVault =
            _initialLiquidationPhaseForCollateral(_cr.vaultCR, _agent.vaultCollateralIndex);
        if (newPhaseVault == Agent.LiquidationPhase.LIQUIDATION) {
            _agent.collateralsUnderwater |= Agent.LF_VAULT;
        }
        Agent.LiquidationPhase newPhasePool =
            _initialLiquidationPhaseForCollateral(_cr.poolCR, _agent.poolCollateralIndex);
        if (newPhasePool == Agent.LiquidationPhase.LIQUIDATION) {
            _agent.collateralsUnderwater |= Agent.LF_POOL;
        }
        // restart liquidation (set new phase and start time) if new cr based phase is higher than time based
        Agent.LiquidationPhase newPhase = newPhaseVault >= newPhasePool ? newPhaseVault : newPhasePool;
        if (newPhase > currentPhase) {
            _agent.status = Agent.Status.LIQUIDATION;
            _agent.liquidationStartedAt = block.timestamp.toUint64();
            _agent.initialLiquidationPhase = newPhase;
            _agent.collateralsUnderwater =
                (newPhase == newPhaseVault ? Agent.LF_VAULT : 0) | (newPhase == newPhasePool ? Agent.LF_POOL : 0);
            if (newPhase == Agent.LiquidationPhase.CCB) {
                emit IAssetManagerEvents.AgentInCCB(_agent.vaultAddress(), block.timestamp);
            } else {
                emit IAssetManagerEvents.LiquidationStarted(_agent.vaultAddress(), block.timestamp);
            }
            return (newPhase, true);
        } else if (
            _agent.status == Agent.Status.LIQUIDATION &&
            _agent.initialLiquidationPhase == Agent.LiquidationPhase.CCB &&
            currentPhase == Agent.LiquidationPhase.LIQUIDATION
        ) {
            // If the liquidation starts because CCB time expired and CR didn't go up, then we still want
            // the LiquidationStarted event to be sent, but it has to be sent just once.
            // So we reset the initial phase to liquidation and send events.
            uint256 liquidationStartedAt = _agent.liquidationStartedAt + Globals.getSettings().ccbTimeSeconds;
            _agent.liquidationStartedAt = liquidationStartedAt.toUint64();
            _agent.initialLiquidationPhase = Agent.LiquidationPhase.LIQUIDATION;
            emit IAssetManagerEvents.LiquidationStarted(_agent.vaultAddress(), liquidationStartedAt);
            return (currentPhase, true);
        }
        return (currentPhase, false);
    }

    // Liquidation phase when starting liquidation (depends only on collateral ratio)
    function _initialLiquidationPhaseForCollateral(
        uint256 _collateralRatioBIPS,
        uint256 _collateralIndex
    )
        private view
        returns (Agent.LiquidationPhase)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        CollateralTypeInt.Data storage collateral = state.collateralTokens[_collateralIndex];
        if (_collateralRatioBIPS >= collateral.minCollateralRatioBIPS) {
            return Agent.LiquidationPhase.NONE;
        } else if (_collateralRatioBIPS >= collateral.ccbMinCollateralRatioBIPS) {
            return Agent.LiquidationPhase.CCB;
        } else {
            return Agent.LiquidationPhase.LIQUIDATION;
        }
    }

     function _performLiquidation(
        Agent.State storage _agent,
        Liquidation.CRData memory _cr,
        uint64 _amountAMG
    )
        private
        returns (uint64 _liquidatedAMG, uint256 _payoutC1Wei, uint256 _payoutPoolWei)
    {
        // split liquidation payment between agent vault and pool
        (uint256 vaultFactor, uint256 poolFactor) =
            LiquidationPaymentStrategy.currentLiquidationFactorBIPS(_agent, _cr.vaultCR, _cr.poolCR);
        // calculate liquidation amount
        uint256 maxLiquidatedAMG = Math.max(
            Liquidation.maxLiquidationAmountAMG(_agent, _cr.vaultCR, vaultFactor, Collateral.Kind.VAULT),
            Liquidation.maxLiquidationAmountAMG(_agent, _cr.poolCR, poolFactor, Collateral.Kind.POOL));
        uint64 amountToLiquidateAMG = Math.min(maxLiquidatedAMG, _amountAMG).toUint64();
        // liquidate redemption tickets
        (_liquidatedAMG,) = Redemptions.closeTickets(_agent, amountToLiquidateAMG, true, false);
        // calculate payouts to liquidator
        _payoutC1Wei =
            Conversion.convertAmgToTokenWei(uint256(_liquidatedAMG).mulBips(vaultFactor), _cr.amgToC1WeiPrice);
        _payoutPoolWei =
            Conversion.convertAmgToTokenWei(uint256(_liquidatedAMG).mulBips(poolFactor), _cr.amgToPoolWeiPrice);
    }

    // Share of amount paid by pool that is the fault of the agent
    // (affects how many of the agent's pool tokens will be slashed).
    function _agentResponsibilityWei(
        Agent.State storage _agent,
        uint256 _amount
    )
        private view
        returns (uint256)
    {
        if (_agent.status == Agent.Status.FULL_LIQUIDATION || _agent.collateralsUnderwater == Agent.LF_VAULT) {
            return _amount;
        } else if (_agent.collateralsUnderwater == Agent.LF_POOL) {
            return 0;
        } else {    // both collaterals were underwater - only half responsibility assigned to agent
            return _amount / 2;
        }
    }
}
