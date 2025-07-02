// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPayment} from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {Minting} from "../library/Minting.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Transfers} from "../../utils/library/Transfers.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {Agents} from "../library/Agents.sol";
import {UnderlyingBalance} from "../library/UnderlyingBalance.sol";
import {AgentCollateral} from "../library/AgentCollateral.sol";
import {TransactionAttestation} from "../library/TransactionAttestation.sol";
import {PaymentConfirmations} from "../library/data/PaymentConfirmations.sol";
import {Collateral} from "../library/data/Collateral.sol";
import {Agent} from "../library/data/Agent.sol";
import {CollateralReservation} from "../library/data/CollateralReservation.sol";
import {Conversion} from "../library/Conversion.sol";
import {Globals} from "../library/Globals.sol";
import {PaymentReference} from "../library/data/PaymentReference.sol";
import {UnderlyingBlockUpdater} from "../library/UnderlyingBlockUpdater.sol";


contract MintingFacet is AssetManagerBase, ReentrancyGuard {
    using SafeCast for uint256;
    using SafePct for uint256;
    using PaymentConfirmations for PaymentConfirmations.State;
    using AgentCollateral for Collateral.CombinedData;
    using Agent for Agent.State;

    error CannotMintZeroLots();
    error FreeUnderlyingBalanceToSmall();
    error InvalidMintingReference();
    error InvalidSelfMintReference();
    error MintingPaused();
    error MintingPaymentTooOld();
    error MintingPaymentTooSmall();
    error NotEnoughFreeCollateral();
    error NotMintingAgentsAddress();
    error OnlyMinterExecutorOrAgent();
    error SelfMintInvalidAgentStatus();
    error SelfMintNotAgentsAddress();
    error SelfMintPaymentTooOld();
    error SelfMintPaymentTooSmall();

    enum MintingType { PUBLIC, SELF_MINT, FROM_FREE_UNDERLYING }

    /**
     * After obtaining proof of underlying payment, the minter calls this method to finish the minting
     * and collect the minted f-assets.
     * NOTE: may only be called by the minter (= creator of CR, the collateral reservation request),
     *   the executor appointed by the minter, or the agent owner (= owner of the agent vault in CR).
     * @param _payment proof of the underlying payment (must contain exact `value + fee` amount and correct
     *      payment reference)
     * @param _crtId collateral reservation id
     */
    function executeMinting(
        IPayment.Proof calldata _payment,
        uint256 _crtId
    )
        external
        nonReentrant
    {
        CollateralReservation.Data storage crt = Minting.getCollateralReservation(_crtId);
        Agent.State storage agent = Agent.get(crt.agentVault);
        // verify transaction
        TransactionAttestation.verifyPaymentSuccess(_payment);
        // minter or agent can present the proof - agent may do it to unlock the collateral if minter
        // becomes unresponsive
        require(msg.sender == crt.minter || msg.sender == crt.executor || Agents.isOwner(agent, msg.sender),
            OnlyMinterExecutorOrAgent());
        require(_payment.data.responseBody.standardPaymentReference == PaymentReference.minting(_crtId),
            InvalidMintingReference());
        require(_payment.data.responseBody.receivingAddressHash == agent.underlyingAddressHash,
            NotMintingAgentsAddress());
        uint256 mintValueUBA = Conversion.convertAmgToUBA(crt.valueAMG);
        require(_payment.data.responseBody.receivedAmount >= SafeCast.toInt256(mintValueUBA + crt.underlyingFeeUBA),
            MintingPaymentTooSmall());
        // we do not allow payments before the underlying block at requests, because the payer should have guessed
        // the payment reference, which is good for nothing except attack attempts
        require(_payment.data.responseBody.blockNumber >= crt.firstUnderlyingBlock,
            MintingPaymentTooOld());
        // mark payment used
        AssetManagerState.get().paymentConfirmations.confirmIncomingPayment(_payment);
        // execute minting
        _performMinting(agent, MintingType.PUBLIC, _crtId, crt.minter, crt.valueAMG,
            uint256(_payment.data.responseBody.receivedAmount), Minting.calculatePoolFeeUBA(agent, crt));
        // update underlying block
        UnderlyingBlockUpdater.updateCurrentBlockForVerifiedPayment(_payment);
        // calculate the fee to be paid to the executor (if the executor called this method)
        address payable executor = crt.executor;
        uint256 executorFee = crt.executorFeeNatGWei * Conversion.GWEI;
        uint256 claimedExecutorFee = msg.sender == executor ? executorFee : 0;
        // pay the collateral reservation fee (guarded against reentrancy in AssetManager.executeMinting)
        // add the executor fee if it is not claimed by the executor
        Minting.distributeCollateralReservationFee(agent,
            crt.reservationFeeNatWei + executorFee - claimedExecutorFee);
        // cleanup
        Minting.releaseCollateralReservation(crt, _crtId);   // crt can't be used after this
        // pay executor in WNat to avoid reentrancy
        Transfers.depositWNat(Globals.getWNat(), executor, claimedExecutorFee);
    }

    /**
     * Agent can mint against himself.
     * This is a one-step process, skipping collateral reservation and collateral reservation fee payment.
     * Moreover, the agent doesn't have to be on the publicly available agents list to self-mint.
     * NOTE: may only be called by the agent vault owner.
     * NOTE: the caller must be a whitelisted agent.
     * @param _payment proof of the underlying payment; must contain payment reference of the form
     *      `0x4642505266410012000...0<agent_vault_address>`
     * @param _agentVault agent vault address
     * @param _lots number of lots to mint
     */
    function selfMint(
        IPayment.Proof calldata _payment,
        address _agentVault,
        uint256 _lots
    )
        external
        onlyAttached
        notEmergencyPaused
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        Agent.State storage agent = Agent.get(_agentVault);
        Agents.requireAgentVaultOwner(agent);
        Agents.requireWhitelistedAgentVaultOwner(agent);
        Collateral.CombinedData memory collateralData = AgentCollateral.combinedData(agent);
        TransactionAttestation.verifyPaymentSuccess(_payment);
        require(state.mintingPausedAt == 0, MintingPaused());
        require(agent.status == Agent.Status.NORMAL, SelfMintInvalidAgentStatus());
        require(collateralData.freeCollateralLots(agent) >= _lots, NotEnoughFreeCollateral());
        uint64 valueAMG = Conversion.convertLotsToAMG(_lots);
        uint256 mintValueUBA = Conversion.convertAmgToUBA(valueAMG);
        uint256 poolFeeUBA = Minting.calculateCurrentPoolFeeUBA(agent, mintValueUBA);
        Minting.checkMintingCap(valueAMG + Conversion.convertUBAToAmg(poolFeeUBA));
        require(_payment.data.responseBody.standardPaymentReference == PaymentReference.selfMint(_agentVault),
            InvalidSelfMintReference());
        require(_payment.data.responseBody.receivingAddressHash == agent.underlyingAddressHash,
            SelfMintNotAgentsAddress());
        require(_payment.data.responseBody.receivedAmount >= SafeCast.toInt256(mintValueUBA + poolFeeUBA),
            SelfMintPaymentTooSmall());
        require(_payment.data.responseBody.blockNumber > agent.underlyingBlockAtCreation,
            SelfMintPaymentTooOld());
        state.paymentConfirmations.confirmIncomingPayment(_payment);
        // update underlying block
        UnderlyingBlockUpdater.updateCurrentBlockForVerifiedPayment(_payment);
        // case _lots==0 is allowed for self minting because if lot size increases between the underlying payment
        // and selfMint call, the paid assets would otherwise be stuck; in this way they are converted to free balance
        uint256 receivedAmount = uint256(_payment.data.responseBody.receivedAmount);  // guarded by require
        if (_lots > 0) {
            _performMinting(agent, MintingType.SELF_MINT, 0, msg.sender, valueAMG, receivedAmount, poolFeeUBA);
        } else {
            UnderlyingBalance.increaseBalance(agent, receivedAmount);
            emit IAssetManagerEvents.SelfMint(_agentVault, false, 0, receivedAmount, 0);
        }
    }

    /**
     * If an agent has enough free underlying, they can mint immediately without any underlying payment.
     * This is a one-step process, skipping collateral reservation and collateral reservation fee payment.
     * Moreover, the agent doesn't have to be on the publicly available agents list to self-mint.
     * NOTE: may only be called by the agent vault owner.
     * NOTE: the caller must be a whitelisted agent.
     * @param _agentVault agent vault address
     * @param _lots number of lots to mint
     */
    function mintFromFreeUnderlying(
        address _agentVault,
        uint64 _lots
    )
        external
        onlyAttached
        notEmergencyPaused
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        Agent.State storage agent = Agent.get(_agentVault);
        Agents.requireAgentVaultOwner(agent);
        Agents.requireWhitelistedAgentVaultOwner(agent);
        Collateral.CombinedData memory collateralData = AgentCollateral.combinedData(agent);
        require(state.mintingPausedAt == 0, MintingPaused());
        require(_lots > 0, CannotMintZeroLots());
        require(agent.status == Agent.Status.NORMAL, SelfMintInvalidAgentStatus());
        require(collateralData.freeCollateralLots(agent) >= _lots, NotEnoughFreeCollateral());
        uint64 valueAMG = Conversion.convertLotsToAMG(_lots);
        uint256 mintValueUBA = Conversion.convertAmgToUBA(valueAMG);
        uint256 poolFeeUBA = Minting.calculateCurrentPoolFeeUBA(agent, mintValueUBA);
        Minting.checkMintingCap(valueAMG + Conversion.convertUBAToAmg(poolFeeUBA));
        uint256 requiredUnderlyingAfter = UnderlyingBalance.requiredUnderlyingUBA(agent) + mintValueUBA + poolFeeUBA;
        require(requiredUnderlyingAfter.toInt256() <= agent.underlyingBalanceUBA, FreeUnderlyingBalanceToSmall());
        _performMinting(agent, MintingType.FROM_FREE_UNDERLYING, 0, msg.sender, valueAMG, 0, poolFeeUBA);
    }

    function _performMinting(
        Agent.State storage _agent,
        MintingType _mintingType,
        uint256 _crtId,
        address _minter,
        uint64 _mintValueAMG,
        uint256 _receivedAmountUBA,
        uint256 _poolFeeUBA
    )
        private
    {
        uint64 poolFeeAMG = Conversion.convertUBAToAmg(_poolFeeUBA);
        Agents.createNewMinting(_agent, _mintValueAMG + poolFeeAMG);
        // update agent balance with deposited amount (received amount is 0 in mintFromFreeUnderlying)
        UnderlyingBalance.increaseBalance(_agent, _receivedAmountUBA);
        // perform minting
        uint256 mintValueUBA = Conversion.convertAmgToUBA(_mintValueAMG);
        Globals.getFAsset().mint(_minter, mintValueUBA);
        Globals.getFAsset().mint(address(_agent.collateralPool), _poolFeeUBA);
        _agent.collateralPool.fAssetFeeDeposited(_poolFeeUBA);
        // notify
        if (_mintingType == MintingType.PUBLIC) {
            uint256 agentFeeUBA = _receivedAmountUBA - mintValueUBA - _poolFeeUBA;
            emit IAssetManagerEvents.MintingExecuted(_agent.vaultAddress(), _crtId,
                mintValueUBA, agentFeeUBA, _poolFeeUBA);
        } else {
            bool fromFreeUnderlying = _mintingType == MintingType.FROM_FREE_UNDERLYING;
            emit IAssetManagerEvents.SelfMint(_agent.vaultAddress(), fromFreeUnderlying,
                mintValueUBA, _receivedAmountUBA, _poolFeeUBA);
        }
    }
}