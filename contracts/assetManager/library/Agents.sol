// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeMath64} from "../../utils/library/SafeMath64.sol";
import {IIAgentVault} from "../../agentVault/interfaces/IIAgentVault.sol";
import {AssetManagerState} from "./data/AssetManagerState.sol";
import {Collateral} from "./data/Collateral.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {Globals} from "./Globals.sol";
import {Conversion} from "./Conversion.sol";
import {CollateralTypes} from "./CollateralTypes.sol";
import {AgentCollateral} from "./AgentCollateral.sol";
import {Agent} from "./data/Agent.sol";
import {RedemptionQueue} from "./data/RedemptionQueue.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CollateralTypeInt} from "./data/CollateralTypeInt.sol";
import {IWNat} from "../../flareSmartContracts/interfaces/IWNat.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {CollateralType} from "../../userInterfaces/data/CollateralType.sol";
import {AgentInfo} from "../../userInterfaces/data/AgentInfo.sol";
import {Liquidation} from "./Liquidation.sol";

library Agents {
    using SafeCast for uint256;
    using SafePct for uint256;
    using Agent for Agent.State;
    using RedemptionQueue for RedemptionQueue.State;

    error CollateralRatioTooSmall();
    error FeeTooHigh();
    error ValueTooHigh();
    error ValueTooLow();
    error NotEnoughFundsProvided();
    error CollateralDeprecated();
    error NotEnoughCollateral();
    error AgentNotWhitelisted();
    error OnlyAgentVaultOwner();
    error OnlyCollateralPool();
    error IncreaseTooBig();

    function setMintingVaultCollateralRatioBIPS(
        Agent.State storage _agent,
        uint256 _mintingVaultCollateralRatioBIPS
    )
        internal
    {
        CollateralTypeInt.Data storage collateral = getVaultCollateral(_agent);
        require(_mintingVaultCollateralRatioBIPS >= collateral.minCollateralRatioBIPS,
            CollateralRatioTooSmall());
        _agent.mintingVaultCollateralRatioBIPS = _mintingVaultCollateralRatioBIPS.toUint32();
    }

    function setMintingPoolCollateralRatioBIPS(
        Agent.State storage _agent,
        uint256 _mintingPoolCollateralRatioBIPS
    )
        internal
    {
        CollateralTypeInt.Data storage collateral = getPoolCollateral(_agent);
        require(_mintingPoolCollateralRatioBIPS >= collateral.minCollateralRatioBIPS,
            CollateralRatioTooSmall());
        _agent.mintingPoolCollateralRatioBIPS = _mintingPoolCollateralRatioBIPS.toUint32();
    }

    function setFeeBIPS(
        Agent.State storage _agent,
        uint256 _feeBIPS
    )
        internal
    {
        require(_feeBIPS <= SafePct.MAX_BIPS, FeeTooHigh());
        _agent.feeBIPS = _feeBIPS.toUint16();
    }

    function setPoolFeeShareBIPS(
        Agent.State storage _agent,
        uint256 _poolFeeShareBIPS
    )
        internal
    {
        require(_poolFeeShareBIPS <= SafePct.MAX_BIPS, ValueTooHigh());
        _agent.poolFeeShareBIPS = _poolFeeShareBIPS.toUint16();
    }

    function setRedemptionPoolFeeShareBIPS(
        Agent.State storage _agent,
        uint256 _redemptionPoolFeeShareBIPS
    )
        internal
    {
        require(_redemptionPoolFeeShareBIPS <= SafePct.MAX_BIPS, ValueTooHigh());
        _agent.redemptionPoolFeeShareBIPS = _redemptionPoolFeeShareBIPS.toUint16();
    }

    function setBuyFAssetByAgentFactorBIPS(
        Agent.State storage _agent,
        uint256 _buyFAssetByAgentFactorBIPS
    )
        internal
    {
        // This factor's function is to compensate agent in case of price fluctuations, so allowing it
        // above 100% doesn't make sense - it is only good for exploits.
        require(_buyFAssetByAgentFactorBIPS <= SafePct.MAX_BIPS, ValueTooHigh());
        // We also don't want to allow it to be too low as this allows agents to underpay
        // the exiting collateral providers.
        require(_buyFAssetByAgentFactorBIPS >= 9000, ValueTooLow());
        _agent.buyFAssetByAgentFactorBIPS = _buyFAssetByAgentFactorBIPS.toUint16();
    }

    function setPoolExitCollateralRatioBIPS(
        Agent.State storage _agent,
        uint256 _poolExitCollateralRatioBIPS
    )
        internal
    {
        CollateralTypeInt.Data storage collateral = getPoolCollateral(_agent);
        uint256 minCR = collateral.minCollateralRatioBIPS;
        require(_poolExitCollateralRatioBIPS >= minCR, ValueTooLow());
        uint256 currentExitCR = _agent.collateralPool.exitCollateralRatioBIPS();
        // if minCollateralRatioBIPS is increased too quickly, it may be impossible for pool exit CR
        // to be increased fast enough, so it can always be changed up to 1.2 * minCR
        require(_poolExitCollateralRatioBIPS <= currentExitCR * 3 / 2 ||
                _poolExitCollateralRatioBIPS <= minCR * 12 / 10,
                IncreaseTooBig());
        _agent.collateralPool.setExitCollateralRatioBIPS(_poolExitCollateralRatioBIPS);
    }

    function releaseMintedAssets(
        Agent.State storage _agent,
        uint64 _valueAMG
    )
        internal
    {
        _agent.mintedAMG = SafeMath64.sub64(_agent.mintedAMG, _valueAMG, "not enough minted");
    }

    function startRedeemingAssets(
        Agent.State storage _agent,
        uint64 _valueAMG,
        bool _poolSelfCloseRedemption
    )
        internal
    {
        _agent.redeemingAMG += _valueAMG;
        if (!_poolSelfCloseRedemption) {
            _agent.poolRedeemingAMG += _valueAMG;
        }
        releaseMintedAssets(_agent, _valueAMG);
    }

    function endRedeemingAssets(
        Agent.State storage _agent,
        uint64 _valueAMG,
        bool _poolSelfCloseRedemption
    )
        internal
    {
        _agent.redeemingAMG = SafeMath64.sub64(_agent.redeemingAMG, _valueAMG, "not enough redeeming");
        if (!_poolSelfCloseRedemption) {
            _agent.poolRedeemingAMG = SafeMath64.sub64(_agent.poolRedeemingAMG, _valueAMG, "not enough redeeming");
        }
    }

    function createNewMinting(
        Agent.State storage _agent,
        uint64 _valueAMG
    )
        internal
    {
        // allocate minted assets
        _agent.mintedAMG += _valueAMG;

        AssetManagerSettings.Data storage settings = Globals.getSettings();
        // Add value with dust, then take the whole number of lots from it to create the new ticket,
        // and the remainder as new dust. At the end, there will always be less than 1 lot of dust left.
        uint64 valueWithDustAMG = _agent.dustAMG + _valueAMG;
        uint64 newDustAMG = valueWithDustAMG % settings.lotSizeAMG;
        uint64 ticketValueAMG = valueWithDustAMG - newDustAMG;
        // create ticket and change dust
        if (ticketValueAMG > 0) {
            createRedemptionTicket(_agent, ticketValueAMG);
        }
        changeDust(_agent, newDustAMG);
    }

    function createRedemptionTicket(
        Agent.State storage _agent,
        uint64 _ticketValueAMG
    )
        internal
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        if (_ticketValueAMG == 0) return;
        address vaultAddress = _agent.vaultAddress();
        uint64 lastTicketId = state.redemptionQueue.lastTicketId;
        RedemptionQueue.Ticket storage lastTicket = state.redemptionQueue.getTicket(lastTicketId);
        if (lastTicket.agentVault == vaultAddress) {
            // last ticket is from the same agent - merge the new ticket with the last
            lastTicket.valueAMG += _ticketValueAMG;
            uint256 ticketValueUBA = Conversion.convertAmgToUBA(lastTicket.valueAMG);
            emit IAssetManagerEvents.RedemptionTicketUpdated(vaultAddress, lastTicketId, ticketValueUBA);
        } else {
            // either queue is empty or the last ticket belongs to another agent - create new ticket
            uint64 ticketId = state.redemptionQueue.createRedemptionTicket(vaultAddress, _ticketValueAMG);
            uint256 ticketValueUBA = Conversion.convertAmgToUBA(_ticketValueAMG);
            emit IAssetManagerEvents.RedemptionTicketCreated(vaultAddress, ticketId, ticketValueUBA);
        }
    }

    function changeDust(
        Agent.State storage _agent,
        uint64 _newDustAMG
    )
        internal
    {
        if (_agent.dustAMG == _newDustAMG) return;
        _agent.dustAMG = _newDustAMG;
        uint256 dustUBA = Conversion.convertAmgToUBA(_newDustAMG);
        emit IAssetManagerEvents.DustChanged(_agent.vaultAddress(), dustUBA);
    }

    function decreaseDust(
        Agent.State storage _agent,
        uint64 _dustDecreaseAMG
    )
        internal
    {
        uint64 newDustAMG = SafeMath64.sub64(_agent.dustAMG, _dustDecreaseAMG, "not enough dust");
        changeDust(_agent, newDustAMG);
    }

    function payoutFromVault(
        Agent.State storage _agent,
        address _receiver,
        uint256 _amountWei
    )
        internal
        returns (uint256 _amountPaid)
    {
        CollateralTypeInt.Data storage collateral = getVaultCollateral(_agent);
        // don't want the calling method to fail due to too small balance for payout
        IIAgentVault vault = IIAgentVault(_agent.vaultAddress());
        _amountPaid = Math.min(_amountWei, collateral.token.balanceOf(address(vault)));
        vault.payout(collateral.token, _receiver, _amountPaid);
    }

    function tryPayoutFromVault(
        Agent.State storage _agent,
        address _receiver,
        uint256 _amountWei
    )
        internal
        returns (bool _success, uint256 _amountPaid)
    {
        CollateralTypeInt.Data storage collateral = getVaultCollateral(_agent);
        // don't want the calling method to fail due to too small balance for payout
        IIAgentVault vault = IIAgentVault(_agent.vaultAddress());
        _amountPaid = Math.min(_amountWei, collateral.token.balanceOf(address(vault)));
        try vault.payout(collateral.token, _receiver, _amountPaid) {
            _success = true;
        } catch {
            _success = false;
            _amountPaid = 0;
        }
    }

    function payoutFromPool(
        Agent.State storage _agent,
        address _receiver,
        uint256 _amountWei,
        uint256 _agentResponsibilityWei
    )
        internal
        returns (uint256 _amountPaid)
    {
        // don't want the calling method to fail due to too small balance for payout
        uint256 poolBalance = _agent.collateralPool.totalCollateral();
        _amountPaid = Math.min(_amountWei, poolBalance);
        _agentResponsibilityWei = Math.min(_agentResponsibilityWei, _amountPaid);
        _agent.collateralPool.payout(_receiver, _amountPaid, _agentResponsibilityWei);
    }

    function payForConfirmationByOthers(
        Agent.State storage _agent,
        address _receiver
    )
        internal
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        uint256 amount = Agents.convertUSD5ToVaultCollateralWei(_agent, settings.confirmationByOthersRewardUSD5);
        Agents.payoutFromVault(_agent, _receiver, amount);
    }

    // We cannot burn typical vault collateral (stablecoins), so the agent must buy them for NAT
    // at FTSO price multiplied by vaultCollateralBuyForFlareFactorBIPS and then we burn the NATs.
    function burnVaultCollateral(
        Agent.State storage _agent,
        uint256 _amountVaultCollateralWei
    )
        internal
        returns (uint256 _burnedNatWei)
    {
        CollateralTypeInt.Data storage vaultCollateral = getVaultCollateral(_agent);
        CollateralTypeInt.Data storage poolCollateral = getPoolCollateral(_agent);
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        IIAgentVault vault = IIAgentVault(_agent.vaultAddress());
        // Calculate NAT amount the agent has to pay to receive the "burned" vault collateral tokens.
        // The price is FTSO price plus configurable premium (vaultCollateralBuyForFlareFactorBIPS).
        _burnedNatWei = Conversion.convert(_amountVaultCollateralWei, vaultCollateral, poolCollateral)
            .mulBips(settings.vaultCollateralBuyForFlareFactorBIPS);
        // Transfer vault collateral to the agent vault owner
        vault.payout(vaultCollateral.token, getOwnerPayAddress(_agent), _amountVaultCollateralWei);
        // Burn the NAT equivalent (must be provided with the call).
        require(msg.value >= _burnedNatWei, NotEnoughFundsProvided());
        burnDirectNAT(_burnedNatWei);
    }

    function burnDirectNAT(
        uint256 _amountNATWei
    )
        internal
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        settings.burnAddress.transfer(_amountNATWei);
    }

    function setVaultCollateral(
        Agent.State storage _agent,
        IERC20 _token
    )
        internal
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        uint256 tokenIndex = CollateralTypes.getIndex(CollateralType.Class.VAULT, _token);
        CollateralTypeInt.Data storage collateral = state.collateralTokens[tokenIndex];
        assert(collateral.collateralClass == CollateralType.Class.VAULT);
        // agent should never switch to a deprecated or already invalid collateral
        require(collateral.validUntil == 0, CollateralDeprecated());
        // set the new index
        _agent.vaultCollateralIndex = tokenIndex.toUint16();
        // check there is enough collateral for current mintings
        Collateral.Data memory switchCollateralData = AgentCollateral.agentVaultCollateralData(_agent);
        uint256 crBIPS = AgentCollateral.collateralRatioBIPS(switchCollateralData, _agent);
        require(crBIPS >= collateral.minCollateralRatioBIPS, NotEnoughCollateral());
    }

    function isOwner(
        Agent.State storage _agent,
        address _address
    )
        internal view
        returns (bool)
    {
        return _address == _agent.ownerManagementAddress || _address == getWorkAddress(_agent);
    }

    function getWorkAddress(Agent.State storage _agent)
        internal view
        returns (address)
    {
        return Globals.getAgentOwnerRegistry().getWorkAddress(_agent.ownerManagementAddress);
    }

    function getOwnerPayAddress(Agent.State storage _agent)
        internal view
        returns (address payable)
    {
        address workAddress = getWorkAddress(_agent);
        return workAddress != address(0) ? payable(workAddress) : payable(_agent.ownerManagementAddress);
    }

    function requireWhitelisted(
        address _ownerManagementAddress
    )
        internal view
    {
        require(Globals.getAgentOwnerRegistry().isWhitelisted(_ownerManagementAddress),
            AgentNotWhitelisted());
    }

    function requireWhitelistedAgentVaultOwner(
        Agent.State storage _agent
    )
        internal view
    {
        requireWhitelisted(_agent.ownerManagementAddress);
    }

    function requireAgentVaultOwner(
        address _agentVault
    )
        internal view
    {
        require(isOwner(Agent.get(_agentVault), msg.sender), OnlyAgentVaultOwner());
    }

    function requireAgentVaultOwner(
        Agent.State storage _agent
    )
        internal view
    {
        require(isOwner(_agent, msg.sender), OnlyAgentVaultOwner());
    }

    function requireCollateralPool(
        Agent.State storage _agent
    )
        internal view
    {
        require(msg.sender == address(_agent.collateralPool), OnlyCollateralPool());
    }

    function isCollateralToken(
        Agent.State storage _agent,
        IERC20 _token
    )
        internal view
        returns (bool)
    {
        return _token == getPoolWNat(_agent) || _token == getVaultCollateralToken(_agent);
    }

    function getVaultCollateralToken(Agent.State storage _agent)
        internal view
        returns (IERC20)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return state.collateralTokens[_agent.vaultCollateralIndex].token;
    }

    function getVaultCollateral(Agent.State storage _agent)
        internal view
        returns (CollateralTypeInt.Data storage)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return state.collateralTokens[_agent.vaultCollateralIndex];
    }

    function convertUSD5ToVaultCollateralWei(Agent.State storage _agent, uint256 _amountUSD5)
        internal view
        returns (uint256)
    {
        return Conversion.convertFromUSD5(_amountUSD5, getVaultCollateral(_agent));
    }

    function getPoolWNat(Agent.State storage _agent)
        internal view
        returns (IWNat)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return IWNat(address(state.collateralTokens[_agent.poolCollateralIndex].token));
    }

    function getPoolCollateral(Agent.State storage _agent)
        internal view
        returns (CollateralTypeInt.Data storage)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return state.collateralTokens[_agent.poolCollateralIndex];
    }

    function getCollateral(Agent.State storage _agent, Collateral.Kind _kind)
        internal view
        returns (CollateralTypeInt.Data storage)
    {
        assert (_kind != Collateral.Kind.AGENT_POOL);   // there is no agent pool collateral token
        AssetManagerState.State storage state = AssetManagerState.get();
        if (_kind == Collateral.Kind.VAULT) {
            return state.collateralTokens[_agent.vaultCollateralIndex];
        } else {
            return state.collateralTokens[_agent.poolCollateralIndex];
        }
    }

    function collateralUnderwater(Agent.State storage _agent, Collateral.Kind _kind)
        internal view
        returns (bool)
    {
        if (_kind == Collateral.Kind.VAULT) {
            return (_agent.collateralsUnderwater & Agent.LF_VAULT) != 0;
        } else {
            // AGENT_POOL collateral cannot be underwater (it only affects minting),
            // so this function will only be used for VAULT and POOL
            assert(_kind == Collateral.Kind.POOL);
            return (_agent.collateralsUnderwater & Agent.LF_POOL) != 0;
        }
    }

    function withdrawalAnnouncement(Agent.State storage _agent, Collateral.Kind _kind)
        internal view
        returns (Agent.WithdrawalAnnouncement storage)
    {
        assert (_kind != Collateral.Kind.POOL);     // agent cannot withdraw from pool
        return _kind == Collateral.Kind.VAULT
            ? _agent.vaultCollateralWithdrawalAnnouncement
            : _agent.poolTokenWithdrawalAnnouncement;
    }

    function totalBackedAMG(Agent.State storage _agent)
        internal view
        returns (uint64)
    {
        // this must always hold, so assert it is true, otherwise the following line
        // would need `max(redeemingAMG, poolRedeemingAMG)`
        assert(_agent.poolRedeemingAMG <= _agent.redeemingAMG);
        return _agent.mintedAMG + _agent.reservedAMG + _agent.redeemingAMG;
    }

    function getAgentStatus(
        Agent.State storage _agent
    )
        internal view
        returns (AgentInfo.Status)
    {
        Agent.Status status = _agent.status;
        if (status == Agent.Status.NORMAL) {
            return AgentInfo.Status.NORMAL;
        } else if (status == Agent.Status.LIQUIDATION) {
            Agent.LiquidationPhase phase = Liquidation.currentLiquidationPhase(_agent);
            return phase == Agent.LiquidationPhase.CCB ? AgentInfo.Status.CCB : AgentInfo.Status.LIQUIDATION;
        } else if (status == Agent.Status.FULL_LIQUIDATION) {
            return AgentInfo.Status.FULL_LIQUIDATION;
        } else {
            assert (status == Agent.Status.DESTROYING);
            return AgentInfo.Status.DESTROYING;
        }
    }

    function getAllAgents(
        uint256 _start,
        uint256 _end
    )
        internal view
        returns (address[] memory _agents, uint256 _totalLength)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        _totalLength = state.allAgents.length;
        _end = Math.min(_end, _totalLength);
        _start = Math.min(_start, _end);
        _agents = new address[](_end - _start);
        for (uint256 i = _start; i < _end; i++) {
            _agents[i - _start] = state.allAgents[i];
        }
    }
}