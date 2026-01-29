// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IXrpPayment} from "../../fdc/mockInterface/IXrpPayment.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {IDirectMinting} from "../../userInterfaces/IDirectMinting.sol";
import {TransactionAttestation} from "../library/TransactionAttestation.sol";
import {Globals} from "../library/Globals.sol";
import {Conversion} from "../library/Conversion.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {PaymentReference} from "../library/data/PaymentReference.sol";
import {DirectMinting} from "../library/DirectMinting.sol";
import {CoreVaultClient} from "../library/CoreVaultClient.sol";
import {PaymentConfirmations} from "../library/data/PaymentConfirmations.sol";
import {MintingRateLimiter} from "../library/data/MintingRateLimiter.sol";


contract DirectMintingFacet is AssetManagerBase, IDirectMinting, ReentrancyGuard {
    using SafePct for uint256;
    using SafeCast for uint256;
    using PaymentConfirmations for PaymentConfirmations.State;
    using MintingRateLimiter for MintingRateLimiter.State;

    error InvalidExecutor();
    error InvalidReceivingAddress();
    error AmountNotPositive();
    error CoreVaultDonation();
    error NotACoreVaultDonation();
    error ForbiddenPaymentReference();
    error DirectMintingStillDelayed(uint256 allowedAt);

    function executeDirectMinting(
        IXrpPayment.Proof calldata _payment
    )
        external
        onlyAttached
        notEmergencyPaused
        nonReentrant
    {
        TransactionAttestation.verifyXrpPaymentSuccess(_payment);
        DirectMinting.State storage state = DirectMinting.getState();
        require(_payment.data.responseBody.receivingAddressHash == CoreVaultClient.coreVaultUnderlyingAddressHash(),
            InvalidReceivingAddress());
        if (_payment.data.requestBody.allowedExecutor != address(0)) {
            require(msg.sender == _payment.data.requestBody.allowedExecutor, InvalidExecutor());
        }
        require(_payment.data.responseBody.receivedAmount > 0, AmountNotPositive());
        uint256 receivedAmount = uint256(_payment.data.responseBody.receivedAmount);
        (bool mintToSmartAccount, address targetAddress) = _decodeTarget(_payment);
        // check rate limits
        bool delayed = _checkRateLimits(_payment.data.requestBody.transactionId, receivedAmount);
        if (delayed) {
            return;
        }
        // mark payment used
        AssetManagerState.get().paymentConfirmations.confirmIncomingPayment(_payment);
        // update core vault accounting
        CoreVaultClient.confirmCoreVaultPayment(_payment.data.requestBody.transactionId,
            _payment.data.responseBody.receivedAmount);
        // calculate fees
        uint256 mintingFeeUBA = _computeMintingFeeUBA(receivedAmount);
        uint256 executorFeeUBA = mintingFeeUBA.mulBips(state.executorFeeBIPS);
        uint256 systemFeeUBA = mintingFeeUBA - executorFeeUBA;
        // mint system fees to fee receiver
        Globals.getFAsset().mint(state.mintingFeeReceiver, systemFeeUBA);
        if (mintToSmartAccount) {
            // mint everything except minting fee to smart account manager and notify it
            // NOTE: smart account manager must pay the executor
            Globals.getFAsset().mint(targetAddress, receivedAmount - systemFeeUBA);
            state.smartAccountManager.mintedFAssets(
                _payment.data.responseBody.sourceAddressHash,
                receivedAmount - systemFeeUBA,
                _payment.data.responseBody.hasMemoData,
                _payment.data.responseBody.firstMemoData,
                msg.sender,
                executorFeeUBA);
            emit DirectMintingExecutedToSmartAccount(
                _payment.data.requestBody.transactionId,
                _payment.data.responseBody.sourceAddressHash,
                msg.sender,
                receivedAmount - systemFeeUBA,
                systemFeeUBA,
                _payment.data.responseBody.hasMemoData,
                _payment.data.responseBody.firstMemoData);
        } else {
            // mint to target address and pay executor directly
            Globals.getFAsset().mint(targetAddress, receivedAmount - mintingFeeUBA);
            Globals.getFAsset().mint(msg.sender, executorFeeUBA);
            emit DirectMintingExecuted(
                _payment.data.requestBody.transactionId,
                targetAddress,
                msg.sender,
                receivedAmount - mintingFeeUBA,
                systemFeeUBA,
                executorFeeUBA);
        }
    }

    function _checkRateLimits(bytes32 _transactionId, uint256 _amount)
        private
        returns (bool _delayed)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        // already delayed?
        DirectMinting.DelayedMinting storage alreadyDelayed = state.delayedMintings[_transactionId];
        if (alreadyDelayed.allowedAt != 0) {
            bool delayFinished = block.timestamp >= alreadyDelayed.allowedAt;
            bool mintingsUnblocked = alreadyDelayed.startedAt < state.unblockMintingsUntilTimestamp;
            // initial delay emits event, but calling while still delayed just reverts to avoid multiple events
            require(delayFinished || mintingsUnblocked, DirectMintingStillDelayed(alreadyDelayed.allowedAt));
            // delay finished - delete delay state and allow execution
            delete state.delayedMintings[_transactionId];
            return false;
        }
        // large mintings have separate limiter
        uint64 amountAmg = Conversion.convertUBAToAmg(_amount);
        if (amountAmg >= state.largeMintingThresholdAmg) {
            (bool delayed, uint256 allowedAt) = state.largeMintingLimiter.recordMinting(amountAmg);
            if (delayed) {
                _addDelayedMinting(_transactionId, allowedAt);
                emit LargeDirectMintingDelayed(_transactionId, _amount, allowedAt);
                return true;
            }
        } else {
            (bool delayedHourly, uint256 allowedAtHourly) = state.hourlyLimiter.recordMinting(amountAmg);
            (bool delayedDaily, uint256 allowedAtDaily) = state.dailyLimiter.recordMinting(amountAmg);
            if (delayedHourly || delayedDaily) {
                uint256 allowedAt = Math.max(allowedAtHourly, allowedAtDaily);
                _addDelayedMinting(_transactionId, allowedAt);
                emit DirectMintingDelayed(_transactionId, _amount, allowedAt);
                return true;
            }
        }
        return false;
    }

    function _addDelayedMinting(bytes32 _transactionId, uint256 _allowedAt)
        private
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.delayedMintings[_transactionId] = DirectMinting.DelayedMinting({
            startedAt: block.timestamp.toUint64(),
            allowedAt: _allowedAt.toUint64()
        });
    }

    function _decodeTarget(IXrpPayment.Proof calldata _payment)
        private view
        returns (bool _mintToSmartAccount, address _targetAddress)
    {
        IXrpPayment.ResponseBody memory body = _payment.data.responseBody;
        DirectMinting.State storage state = DirectMinting.getState();
        // has valid DIRECT_MINTING payment reference
        if (body.hasMemoData && body.firstMemoData.length == 32) {
            bytes32 paymentReference = bytes32(body.firstMemoData);
            if (PaymentReference.isValid(paymentReference, PaymentReference.DIRECT_MINTING)) {
                uint256 addressNumeric = PaymentReference.decodeId(paymentReference);
                if (addressNumeric <= type(uint160).max) {
                    return (false, address(uint160(addressNumeric)));
                }
            }
            // forbid REDEMPTION payment reference, because it could be used to steal agents' core vault deposits
            require(!PaymentReference.isValid(paymentReference, PaymentReference.REDEMPTION),
                ForbiddenPaymentReference());
        }
        // has registered tag (both tag and memo data is invalid combination that goes to smart account)
        if (body.hasTag && !body.hasMemoData) {
            // forbid core vault donation tag - it should be confirmed using method confirmCoreVaultDonation
            require(body.tag != state.coreVaultDonationTag, CoreVaultDonation());
            address registeredAddress = DirectMinting.mintingRecipientForTag(body.tag);
            if (registeredAddress != address(0)) {
                return (false, registeredAddress);
            }
        }
        // no direct minting - mint to smart account manager
        return (true, address(state.smartAccountManager));
    }

    function _computeMintingFeeUBA(uint256 _receivedAmount) private view returns (uint256) {
        DirectMinting.State storage state = DirectMinting.getState();
        uint256 relativeFeeUBA = _receivedAmount.mulBips(state.mintingFeeBIPS);
        uint256 minimumFeeUBA = Conversion.convertAmgToUBA(state.minimumMintingFeeAmg);
        return Math.min(Math.max(relativeFeeUBA, minimumFeeUBA), _receivedAmount);
    }
}
