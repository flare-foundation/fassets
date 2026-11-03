// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IPayment} from "@flarenetwork/flare-periphery-contracts/flare/IPayment.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {Minting} from "../library/Minting.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {Agents} from "../library/Agents.sol";
import {UnderlyingBalance} from "../library/UnderlyingBalance.sol";
import {AgentCollateral} from "../library/AgentCollateral.sol";
import {TransactionAttestation} from "../library/TransactionAttestation.sol";
import {PaymentConfirmations} from "../library/data/PaymentConfirmations.sol";
import {Collateral} from "../library/data/Collateral.sol";
import {Agent} from "../library/data/Agent.sol";
import {AgentBacking} from "../library/AgentBacking.sol";
import {CollateralReservation} from "../library/data/CollateralReservation.sol";
import {Conversion} from "../library/Conversion.sol";
import {Globals} from "../library/Globals.sol";
import {PaymentReference} from "../library/data/PaymentReference.sol";
import {ForbiddenAddresses} from "../library/ForbiddenAddresses.sol";


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
    error InvalidCollateralReservationStatus();
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
    error AnnouncedUnderlyingWithdrawalActive();
    /// A minting paid from a forbidden underlying address, for a minter that is not forbidden, is released only
    /// after the payment time and `confirmationByOthersAfterSeconds` have passed
    /// (see `releaseMintingWithForbiddenPayment`).
    error ForbiddenMintingReleaseTooEarly();
    /// Neither the payment's source nor the minter is forbidden: the payment must be executed (`executeMinting`).
    error MintingPaymentNotForbidden();

    enum MintingType { PUBLIC, SELF_MINT, FROM_FREE_UNDERLYING }

    /**
     * After obtaining proof of underlying payment, the minter calls this method to finish the minting
     * and collect the minted f-assets.
     * A payment from a forbidden underlying address, or for a forbidden minter, is refused
     * (`ForbiddenSourceAddress`, `ForbiddenFlareAddress`); the agent can release the reservation for it with
     * `releaseMintingWithForbiddenPayment`.
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
        notFullyEmergencyPaused
        nonReentrant
    {
        CollateralReservation.Data storage crt = Minting.getCollateralReservation(_crtId, true);
        Agent.State storage agent = Agent.get(crt.agentVault);
        // verify transaction
        TransactionAttestation.verifyPaymentSuccess(_payment);
        // minter or agent can present the proof - agent may do it to unlock the collateral if minter
        // becomes unresponsive
        require(msg.sender == crt.minter || msg.sender == crt.executor || Agents.isOwner(agent, msg.sender),
            OnlyMinterExecutorOrAgent());
        _requireValidMintingPayment(agent, crt, _crtId, _payment);
        // both ends of the crossing: the minter and the payment's source must not be forbidden (the agent can
        // release the reservation for such a payment with `releaseMintingWithForbiddenPayment`)
        ForbiddenAddresses.requireFlareAddressAllowed(crt.minter);
        ForbiddenAddresses.requireSourceAddressAllowed(_payment.data.responseBody.sourceAddressHash);
        // mark payment used
        AssetManagerState.get().paymentConfirmations.confirmIncomingPayment(_payment);
        // execute minting
        _performMinting(agent, MintingType.PUBLIC, _crtId, crt.minter, crt.valueAMG,
            uint256(_payment.data.responseBody.receivedAmount), Minting.calculatePoolFeeUBA(agent, crt));
        // release agent's reserved collateral
        Minting.releaseCollateralReservation(crt, CollateralReservation.Status.SUCCESSFUL);
        // pay the executor if they executed the minting
        Minting.payOrBurnExecutorFee(crt);
        // share collateral reservation fee between the agent's vault and pool
        Minting.distributeCollateralReservationFee(agent, crt, crt.reservationFeeNatWei);
    }

    /**
     * The agent releases the collateral reservation for a payment that `executeMinting` refuses because it came
     * from a forbidden underlying address or the minter is a forbidden Flare address. The reservation is the one
     * the payment reference names, and the proof must pass the payment checks of `executeMinting`. Nothing is
     * minted: the payment is marked used but not added to the agent's underlying balance, the reservation is
     * released with status FORBIDDEN, and the collateral reservation fee and the executor fee go to the agent and
     * the pool as on a payment default.
     * When only the payment's source is forbidden, the release waits until the payment time and
     * `confirmationByOthersAfterSeconds` have passed (`ForbiddenMintingReleaseTooEarly`), since the agent could
     * pay the minter's reference from a forbidden address itself: until then the minter can still execute their
     * own, clean payment. A forbidden minter's reservation is released at once.
     * NOTE: may only be called by the agent vault owner.
     * @param _payment proof of the underlying payment (must contain the full `value + fee` amount and the
     *      reservation's payment reference)
     */
    function releaseMintingWithForbiddenPayment(
        IPayment.Proof calldata _payment
    )
        external
        notFullyEmergencyPaused
        nonReentrant
    {
        // verify transaction
        TransactionAttestation.verifyPaymentSuccess(_payment);
        // the reservation is the one the payment reference names
        bytes32 paymentReference = _payment.data.responseBody.standardPaymentReference;
        require(PaymentReference.isValid(paymentReference, PaymentReference.MINTING), InvalidMintingReference());
        uint256 crtId = PaymentReference.decodeId(paymentReference);
        CollateralReservation.Data storage crt = Minting.getCollateralReservation(crtId, true);
        Agent.State storage agent = Agent.get(crt.agentVault);
        // only the agent releases its collateral
        Agents.requireAgentVaultOwner(agent);
        _requireValidMintingPayment(agent, crt, crtId, _payment);
        // only a payment that `executeMinting` refuses: from a forbidden source or for a forbidden minter
        bool minterForbidden = ForbiddenAddresses.isForbiddenFlare(crt.minter);
        require(minterForbidden
            || ForbiddenAddresses.isForbiddenUnderlying(_payment.data.responseBody.sourceAddressHash),
            MintingPaymentNotForbidden());
        AssetManagerState.State storage state = AssetManagerState.get();
        // Only the payment's source is forbidden: wait until the payment time is over, plus the margin others get
        // to confirm, so that a forbidden payment to the minter's reference - which the agent could make itself -
        // cannot release the reservation while the minter can still execute their clean payment in time.
        // A forbidden minter can mint nothing anyway.
        if (!minterForbidden) {
            require(state.currentUnderlyingBlock > crt.lastUnderlyingBlock &&
                state.currentUnderlyingBlockTimestamp >
                    crt.lastUnderlyingTimestamp + Globals.getSettings().confirmationByOthersAfterSeconds,
                ForbiddenMintingReleaseTooEarly());
        }
        // mark payment used; the received underlying stays unaccounted (not added to the agent's balance),
        // even after the address is delisted
        state.paymentConfirmations.confirmIncomingPayment(_payment);
        // send event (before the external calls of the fee distribution, as in `mintingPaymentDefault`)
        uint256 reservedValueUBA =
            Conversion.convertAmgToUBA(crt.valueAMG) + Minting.calculatePoolFeeUBA(agent, crt);
        emit IAssetManagerEvents.MintingPaymentForbidden(crt.agentVault, crt.minter, crtId,
            _payment.data.requestBody.transactionId, uint256(_payment.data.responseBody.receivedAmount),
            reservedValueUBA);
        // calculate total fee before releasing the collateral reservation
        uint256 totalFee = crt.reservationFeeNatWei + crt.executorFeeNatGWei * Conversion.GWEI;
        // release agent's reserved collateral
        Minting.releaseCollateralReservation(crt, CollateralReservation.Status.FORBIDDEN);
        // share collateral reservation fee and executor fee between the agent's vault and pool
        Minting.distributeCollateralReservationFee(agent, crt, totalFee);
    }

    /**
     * The minter can make several mistakes in the underlying payment:
     * - the payment is too late and is already defaulted before executing
     * - the payment is too small so executeMinting reverts
     * - the payment is performed twice
     * In all of these cases the paid amount ends up on the agent vault's underlying account, but it is not
     * confirmed and therefore the agent cannot withdraw it without triggering full liquidation (of course
     * the agent can legally withdraw it once the vault is closed).
     * This method enables the agent to confirm such payments, converting the deposited amount to agent's
     * free underlying. A payment from a forbidden underlying address is refused (`ForbiddenSourceAddress`): it
     * would become free underlying, which `mintFromFreeUnderlying` mints.
     * NOTE: may only be called by the agent vault owner.
     * @param _payment proof of the underlying payment (must have correct payment reference)
     * @param _crtId collateral reservation id
     */
    function confirmClosedMintingPayment(
        IPayment.Proof calldata _payment,
        uint256 _crtId
    )
        external
        notFullyEmergencyPaused
        nonReentrant
    {
        CollateralReservation.Data storage crt = Minting.getCollateralReservation(_crtId, false);
        Agent.State storage agent = Agent.get(crt.agentVault);
        // verify transaction
        TransactionAttestation.verifyPaymentSuccess(_payment);
        // only agent can present proof once the payment is defaulted
        Agents.requireAgentVaultOwner(agent);
        require(_payment.data.responseBody.standardPaymentReference == PaymentReference.minting(_crtId),
            InvalidMintingReference());
        require(_payment.data.responseBody.receivingAddressHash == agent.underlyingAddressHash,
            NotMintingAgentsAddress());
        // we do not allow payments before the underlying block at requests, because the payer should have guessed
        // the payment reference, which is good for nothing except attack attempts
        require(_payment.data.responseBody.blockNumber >= crt.firstUnderlyingBlock,
            MintingPaymentTooOld());
        // Only closed (SUCCESSFUL or DEFAULTED) minting payments can be confirmed in this way -
        // ACTIVE minting payments should be confirmed by executeMinting.
        // We also prevent EXPIRED mintings to be confirmed this way, to extra incentivize agent to execute minting
        // (when paid) instead of waiting and calling unstick minting.
        // FORBIDDEN mintings are refused like EXPIRED ones: an agent paying every reference from a forbidden address
        // could release a reservation (`releaseMintingWithForbiddenPayment`) once the release gate opens and then
        // confirm the slow minter's clean, in-time payment here as its own free underlying. So any payment for a
        // released reservation stays unaccounted on the agent's address until the vault is closed - also a clean one.
        CollateralReservation.Status status = crt.status;
        require(status == CollateralReservation.Status.SUCCESSFUL || status == CollateralReservation.Status.DEFAULTED,
            InvalidCollateralReservationStatus());
        // a payment from a forbidden source must not become free underlying
        ForbiddenAddresses.requireSourceAddressAllowed(_payment.data.responseBody.sourceAddressHash);
        // mark payment confirmed, which also checks that it hasn't been confirmed already
        AssetManagerState.get().paymentConfirmations.confirmIncomingPayment(_payment);
        // preform underlying balance topup
        uint256 amountUBA = SafeCast.toUint256(_payment.data.responseBody.receivedAmount);
        UnderlyingBalance.increaseBalance(agent, amountUBA.toUint128());
        // notify
        emit IAssetManagerEvents.ConfirmedClosedMintingPayment(agent.vaultAddress(),
            _payment.data.requestBody.transactionId, amountUBA);
    }

    /**
     * Agent can mint against himself.
     * This is a one-step process, skipping collateral reservation and collateral reservation fee payment.
     * Moreover, the agent doesn't have to be on the publicly available agents list to self-mint.
     * The payment's source must not be a forbidden underlying address - also for `_lots == 0`, which converts
     * the payment to free underlying. The agent's underlying address and the caller (who receives the minted
     * FAssets) are not checked: agents are vetted by governance.
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
        require(_payment.data.responseBody.blockNumber >= agent.underlyingBlockAtCreation,
            SelfMintPaymentTooOld());
        // the payer must not be forbidden; the agent's address and the owner, who is minted to, are not checked
        // (agents are vetted by governance)
        ForbiddenAddresses.requireSourceAddressAllowed(_payment.data.responseBody.sourceAddressHash);
        state.paymentConfirmations.confirmIncomingPayment(_payment);
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
        require(agent.announcedUnderlyingWithdrawalId == 0, AnnouncedUnderlyingWithdrawalActive());
        require(collateralData.freeCollateralLots(agent) >= _lots, NotEnoughFreeCollateral());
        uint64 valueAMG = Conversion.convertLotsToAMG(_lots);
        uint256 mintValueUBA = Conversion.convertAmgToUBA(valueAMG);
        uint256 poolFeeUBA = Minting.calculateCurrentPoolFeeUBA(agent, mintValueUBA);
        Minting.checkMintingCap(valueAMG + Conversion.convertUBAToAmg(poolFeeUBA));
        uint256 requiredUnderlyingAfter = UnderlyingBalance.requiredUnderlyingUBA(agent) + mintValueUBA + poolFeeUBA;
        require(requiredUnderlyingAfter.toInt256() <= agent.underlyingBalanceUBA, FreeUnderlyingBalanceToSmall());
        _performMinting(agent, MintingType.FROM_FREE_UNDERLYING, 0, msg.sender, valueAMG, 0, poolFeeUBA);
    }

    // the checks every proof of a minting payment must pass,
    // in `executeMinting` and `releaseMintingWithForbiddenPayment`
    function _requireValidMintingPayment(
        Agent.State storage _agent,
        CollateralReservation.Data storage _crt,
        uint256 _crtId,
        IPayment.Proof calldata _payment
    )
        private view
    {
        require(_payment.data.responseBody.standardPaymentReference == PaymentReference.minting(_crtId),
            InvalidMintingReference());
        require(_payment.data.responseBody.receivingAddressHash == _agent.underlyingAddressHash,
            NotMintingAgentsAddress());
        uint256 mintValueUBA = Conversion.convertAmgToUBA(_crt.valueAMG);
        require(_payment.data.responseBody.receivedAmount >= SafeCast.toInt256(mintValueUBA + _crt.underlyingFeeUBA),
            MintingPaymentTooSmall());
        // we do not allow payments before the underlying block at requests, because the payer should have guessed
        // the payment reference, which is good for nothing except attack attempts
        require(_payment.data.responseBody.blockNumber >= _crt.firstUnderlyingBlock,
            MintingPaymentTooOld());
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
        AgentBacking.createNewMinting(_agent, _mintValueAMG + poolFeeAMG);
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