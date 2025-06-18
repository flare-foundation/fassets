// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {IICoreVaultManager} from "../../coreVaultManager/interfaces/IICoreVaultManager.sol";
import {MathUtils} from "../../utils/library/MathUtils.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICoreVault} from "../../userInterfaces/ICoreVault.sol";
import {AssetManagerState} from "./data/AssetManagerState.sol";
import {PaymentReference} from "./data/PaymentReference.sol";
import {AgentCollateral} from "./AgentCollateral.sol";
import {Redemptions} from "./Redemptions.sol";
import {RedemptionRequests} from "./RedemptionRequests.sol";
import {UnderlyingBalance} from "./UnderlyingBalance.sol";
import {Agent} from "./data/Agent.sol";
import {Collateral} from "./data/Collateral.sol";
import {PaymentConfirmations} from "./data/PaymentConfirmations.sol";
import {IPayment} from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {Redemption} from "./data/Redemption.sol";
import {Agents} from "./Agents.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {Globals} from "./Globals.sol";
import {Conversion} from "./Conversion.sol";
import {SafeMath64} from "../../utils/library/SafeMath64.sol";
import {Transfers} from "../../utils/library/Transfers.sol";
import {TransactionAttestation} from "./TransactionAttestation.sol";
import {ICoreVault} from "../../userInterfaces/ICoreVault.sol";



library CoreVault {
    using SafePct for *;
    using SafeCast for *;
    using Agent for Agent.State;
    using AgentCollateral for Collateral.CombinedData;
    using PaymentConfirmations for PaymentConfirmations.State;

    struct State {
        // settings
        IICoreVaultManager coreVaultManager;
        uint64 transferTimeExtensionSeconds;
        address payable nativeAddress;
        uint16 __transferFeeBIPS; // only storage placeholder now
        uint16 redemptionFeeBIPS;
        uint16 minimumAmountLeftBIPS;
        uint64 minimumRedeemLots;

        // state
        bool initialized;
        uint64 newTransferFromCoreVaultId;
        uint64 newRedemptionFromCoreVaultId;
    }

    // core vault may not be enabled on all chains
    modifier onlyEnabled {
        _checkEnabled();
        _;
    }

    function transferToCoreVault(
        Agent.State storage _agent,
        uint64 _amountAMG
    )
        internal
        onlyEnabled
    {
        State storage state = getState();
        address agentVault = _agent.vaultAddress();
        // for agent in full liquidation, the system cannot know if there is enough underlying for the transfer
        require(_agent.status != Agent.Status.FULL_LIQUIDATION, "invalid agent status");
        // forbid 0 transfer
        require(_amountAMG > 0, "zero transfer not allowed");
        // agent must have enough underlying for the transfer (if the required backing < 100%, they may have less)
        require(Conversion.convertAmgToUBA(_amountAMG).toInt256() <= _agent.underlyingBalanceUBA,
            "not enough underlying");
        // only one transfer can be active
        require(_agent.activeTransferToCoreVault == 0, "transfer already active");
        // close agent's redemption tickets
        (uint64 transferredAMG,) = Redemptions.closeTickets(_agent, _amountAMG, false, false);
        require(transferredAMG > 0, "nothing minted");
        // check the remaining amount
        (uint256 maximumTransferAMG,) = getMaximumTransferToCoreVaultAMG(_agent);
        require(transferredAMG <= maximumTransferAMG, "too little minting left after transfer");
        // create ordinary redemption request to core vault address
        string memory underlyingAddress = state.coreVaultManager.coreVaultAddress();
        // NOTE: there will be no redemption fee, so the agent needs enough free underlying for the
        // underlying transaction fee, otherwise they will go into full liquidation
        uint64 redemptionRequestId = RedemptionRequests.createRedemptionRequest(
            RedemptionRequests.AgentRedemptionData(_agent.vaultAddress(), transferredAMG),
            state.nativeAddress, underlyingAddress, false, payable(address(0)), 0,
            state.transferTimeExtensionSeconds, true);
        // set the active request
        _agent.activeTransferToCoreVault = redemptionRequestId;
        // send event
        uint256 transferredUBA = Conversion.convertAmgToUBA(transferredAMG);
        emit ICoreVault.TransferToCoreVaultStarted(agentVault, redemptionRequestId, transferredUBA);
    }

    // only called by RedemptionConfirmations.confirmRedemptionPayment, so all checks are done there
    function confirmTransferToCoreVault(
        IPayment.Proof calldata _payment,
        Agent.State storage _agent,
        uint64 _redemptionRequestId
    )
        internal
        onlyEnabled
    {
        State storage state = getState();
        state.coreVaultManager.confirmPayment(_payment);
        uint256 receivedAmount = _payment.data.responseBody.receivedAmount.toUint256();
        emit ICoreVault.TransferToCoreVaultSuccessful(_agent.vaultAddress(), _redemptionRequestId, receivedAmount);
    }

    // only called by RedemptionFailures, RedemptionConfirmations etc., so all checks are done there
    function cancelTransferToCoreVault(
        Agent.State storage _agent,
        Redemption.Request storage _request,
        uint64 _redemptionRequestId
    )
        internal
        onlyEnabled
    {
        // core vault transfer default - re-create tickets
        Redemptions.releaseTransferToCoreVault(_redemptionRequestId);
        Redemptions.reCreateRedemptionTicket(_agent, _request);
        emit ICoreVault.TransferToCoreVaultDefaulted(_agent.vaultAddress(), _redemptionRequestId,
            _request.underlyingValueUBA);
    }

    function requestReturnFromCoreVault(
        Agent.State storage _agent,
        uint64 _lots
    )
        internal
        onlyEnabled
    {
        State storage state = getState();
        require(state.coreVaultManager.isDestinationAddressAllowed(_agent.underlyingAddressString),
            "agent's underlying address not allowed by core vault");
        require(_agent.activeReturnFromCoreVaultId == 0, "return from core vault already requested");
        Collateral.CombinedData memory collateralData = AgentCollateral.combinedData(_agent);
        require(_lots > 0, "cannot return 0 lots");
        require(_agent.status == Agent.Status.NORMAL, "invalid agent status");
        require(collateralData.freeCollateralLotsOptionalFee(_agent, false) >= _lots, "not enough free collateral");
        uint64 availableLots = getCoreVaultAmountLots();
        require(_lots <= availableLots, "not enough available on core vault");
        // create new request id
        state.newTransferFromCoreVaultId += PaymentReference.randomizedIdSkip();
        uint64 requestId = state.newTransferFromCoreVaultId;
        _agent.activeReturnFromCoreVaultId = requestId;
        // reserve collateral
        assert(_agent.returnFromCoreVaultReservedAMG == 0);
        uint64 amountAMG = _lots * Globals.getSettings().lotSizeAMG;
        _agent.returnFromCoreVaultReservedAMG = amountAMG;
        _agent.reservedAMG += amountAMG;
        // request
        bytes32 paymentReference = PaymentReference.returnFromCoreVault(requestId);
        uint128 amountUBA = Conversion.convertAmgToUBA(amountAMG).toUint128();
        state.coreVaultManager.requestTransferFromCoreVault(
            _agent.underlyingAddressString, paymentReference, amountUBA, true);
        emit ICoreVault.ReturnFromCoreVaultRequested(_agent.vaultAddress(), requestId, paymentReference, amountUBA);
    }

    function cancelReturnFromCoreVault(
        Agent.State storage _agent
    )
        internal
        onlyEnabled
    {
        State storage state = getState();
        uint64 requestId = _agent.activeReturnFromCoreVaultId;
        require(requestId != 0, "no active return request");
        state.coreVaultManager.cancelTransferRequestFromCoreVault(_agent.underlyingAddressString);
        _deleteReturnFromCoreVaultRequest(_agent);
        emit ICoreVault.ReturnFromCoreVaultCancelled(_agent.vaultAddress(), requestId);
    }

    function confirmReturnFromCoreVault(
        IPayment.Proof calldata _payment,
        Agent.State storage _agent
    )
        internal
        onlyEnabled
    {
        State storage state = getState();
        TransactionAttestation.verifyPaymentSuccess(_payment);
        uint64 requestId = _agent.activeReturnFromCoreVaultId;
        require(requestId != 0, "no active return request");
        require(_payment.data.responseBody.sourceAddressHash == state.coreVaultManager.coreVaultAddressHash(),
            "payment not from core vault");
        require(_payment.data.responseBody.receivingAddressHash == _agent.underlyingAddressHash,
            "payment not to agent's address");
        require(_payment.data.responseBody.standardPaymentReference == PaymentReference.returnFromCoreVault(requestId),
            "invalid payment reference");
        // make sure payment isn't used again
        AssetManagerState.get().paymentConfirmations.confirmIncomingPayment(_payment);
        // we account for the option that CV pays more or less than the reserved amount:
        // - if less, only the amount received gets converted to redemption ticket
        // - if more, the extra amount becomes the agent's free underlying
        uint256 receivedAmountUBA = _payment.data.responseBody.receivedAmount.toUint256();
        uint64 receivedAmountAMG = Conversion.convertUBAToAmg(receivedAmountUBA);
        uint64 remintedAMG = SafeMath64.min64(_agent.returnFromCoreVaultReservedAMG, receivedAmountAMG);
        // create redemption ticket
        Agents.createNewMinting(_agent, remintedAMG);
        // update underlying amount
        UnderlyingBalance.increaseBalance(_agent, receivedAmountUBA);
        // clear the reservation
        _deleteReturnFromCoreVaultRequest(_agent);
        // send event
        uint256 remintedUBA = Conversion.convertAmgToUBA(remintedAMG);
        emit ICoreVault.ReturnFromCoreVaultConfirmed(_agent.vaultAddress(), requestId, receivedAmountUBA, remintedUBA);
    }

    function redeemFromCoreVault(
        uint64 _lots,
        string memory _redeemerUnderlyingAddress
    )
        internal
        onlyEnabled
    {
        State storage state = getState();
        require(state.coreVaultManager.isDestinationAddressAllowed(_redeemerUnderlyingAddress),
            "underlying address not allowed by core vault");
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        uint64 availableLots = getCoreVaultAmountLots();
        require(_lots <= availableLots, "not enough available on core vault");
        uint64 minimumRedeemLots = SafeMath64.min64(state.minimumRedeemLots, availableLots);
        require(_lots >= minimumRedeemLots, "requested amount too small");
        // burn the senders fassets
        uint64 redeemedAMG = _lots * settings.lotSizeAMG;
        uint256 redeemedUBA = Conversion.convertAmgToUBA(redeemedAMG);
        Redemptions.burnFAssets(msg.sender, redeemedUBA);
        // subtract the redemption fee
        uint256 redemptionFeeUBA = redeemedUBA.mulBips(state.redemptionFeeBIPS);
        uint128 paymentUBA = (redeemedUBA - redemptionFeeUBA).toUint128();
        // create new request id
        state.newRedemptionFromCoreVaultId += PaymentReference.randomizedIdSkip();
        bytes32 paymentReference = PaymentReference.redemptionFromCoreVault(state.newRedemptionFromCoreVaultId);
        // transfer from core vault (paymentReference may change when the request is merged)
        paymentReference = state.coreVaultManager.requestTransferFromCoreVault(
            _redeemerUnderlyingAddress, paymentReference, paymentUBA, false);
        emit ICoreVault.CoreVaultRedemptionRequested(msg.sender, _redeemerUnderlyingAddress, paymentReference,
            redeemedUBA, redemptionFeeUBA);
    }

    function getMaximumTransferToCoreVaultAMG(
        Agent.State storage _agent
    )
        internal view
        returns (uint256 _maximumTransferAMG, uint256 _minimumLeftAmountAMG)
    {
        _minimumLeftAmountAMG = _minimumRemainingAfterTransferAMG(_agent);
        _maximumTransferAMG = MathUtils.subOrZero(_agent.mintedAMG, _minimumLeftAmountAMG);
    }

    function getCoreVaultAvailableAmount()
        internal view
        returns (uint256 _immediatelyAvailableUBA, uint256 _totalAvailableUBA)
    {
        State storage state = getState();
        uint256 availableFunds = state.coreVaultManager.availableFunds();
        uint256 escrowedFunds = state.coreVaultManager.escrowedFunds();
        // account for fee for one more request, because this much must remain available on any transfer
        uint256 requestedAmountWithFee =
            state.coreVaultManager.totalRequestAmountWithFee() + getCoreVaultUnderlyingPaymentFee();
        _immediatelyAvailableUBA = MathUtils.subOrZero(availableFunds, requestedAmountWithFee);
        _totalAvailableUBA = MathUtils.subOrZero(availableFunds + escrowedFunds, requestedAmountWithFee);
    }

    function getCoreVaultAmountLots()
        internal view
        returns (uint64)
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        (, uint256 totalAmountUBA) = getCoreVaultAvailableAmount();
        return Conversion.convertUBAToAmg(totalAmountUBA) / settings.lotSizeAMG;
    }

    function getCoreVaultUnderlyingPaymentFee()
        internal view
        returns (uint256)
    {
        State storage state = getState();
        (,,, uint256 fee) = state.coreVaultManager.getSettings();
        return fee;
    }

    function _minimumRemainingAfterTransferAMG(
        Agent.State storage _agent
    )
        private view
        returns (uint256)
    {
        Collateral.CombinedData memory cd = AgentCollateral.combinedData(_agent);
        uint256 resultWRTVault = _minimumRemainingAfterTransferForCollateralAMG(_agent, cd.agentCollateral);
        uint256 resultWRTPool = _minimumRemainingAfterTransferForCollateralAMG(_agent, cd.poolCollateral);
        uint256 resultWRTAgentPT = _minimumRemainingAfterTransferForCollateralAMG(_agent, cd.agentPoolTokens);
        return Math.min(resultWRTVault, Math.min(resultWRTPool, resultWRTAgentPT));
    }

    function _minimumRemainingAfterTransferForCollateralAMG(
        Agent.State storage _agent,
        Collateral.Data memory _data
    )
        private view
        returns (uint256)
    {
        State storage state = getState();
        (, uint256 systemMinCrBIPS) = AgentCollateral.mintingMinCollateralRatio(_agent, _data.kind);
        uint256 collateralEquivAMG = Conversion.convertTokenWeiToAMG(_data.fullCollateral, _data.amgToTokenWeiPrice);
        uint256 maxSupportedAMG = collateralEquivAMG.mulDiv(SafePct.MAX_BIPS, systemMinCrBIPS);
        return maxSupportedAMG.mulBips(state.minimumAmountLeftBIPS);
    }

    function _deleteReturnFromCoreVaultRequest(Agent.State storage _agent) private {
        assert(_agent.activeReturnFromCoreVaultId != 0 && _agent.returnFromCoreVaultReservedAMG != 0);
        _agent.reservedAMG -= _agent.returnFromCoreVaultReservedAMG;
        _agent.activeReturnFromCoreVaultId = 0;
        _agent.returnFromCoreVaultReservedAMG = 0;
    }

    function _checkEnabled() private view {
        State storage state = getState();
        require(address(state.coreVaultManager) != address(0), "core vault not enabled");
    }

    bytes32 internal constant STATE_POSITION = keccak256("fasset.CoreVault.State");

    function getState()
        internal pure
        returns (State storage _state)
    {
        bytes32 position = STATE_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            _state.slot := position
        }
    }
}
