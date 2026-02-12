// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IXRPPayment} from "../../fdc/mockInterface/IXRPPayment.sol";
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


contract DirectMintingFacet is AssetManagerBase, ReentrancyGuard, IDirectMinting {
    using SafePct for uint256;
    using SafeCast for uint256;
    using PaymentConfirmations for PaymentConfirmations.State;
    using MintingRateLimiter for MintingRateLimiter.State;

    error InvalidExecutor();
    error InvalidReceivingAddress();
    error AmountNotPositive();
    error CoreVaultDonation();
    error ForbiddenPaymentReference();
    error DirectMintingStillDelayed(uint256 allowedAt);
    error MissingMintingTagManager();
    error MissingSmartAccountManager();

    function executeDirectMinting(
        IXRPPayment.Proof calldata _payment
    )
        external
        onlyAttached
        notEmergencyPaused
        nonReentrant
    {
        TransactionAttestation.verifyXRPPaymentSuccess(_payment);
        DirectMinting.State storage state = DirectMinting.getState();
        require(_payment.data.responseBody.receivingAddressHash == CoreVaultClient.coreVaultUnderlyingAddressHash(),
            InvalidReceivingAddress());
        if (_payment.data.requestBody.preferredProofPresenter != address(0)) {
            require(msg.sender == _payment.data.requestBody.preferredProofPresenter, InvalidExecutor());
        }
        require(_payment.data.responseBody.receivedAmount > 0, AmountNotPositive());
        uint256 receivedAmount = uint256(_payment.data.responseBody.receivedAmount);
        // MintingTagManager and smartAccountManager may not exist at deploy time, so they are checked here
        // instead of in initialization function. However, once they are set they cannot be unset again
        // (so direct minting won't stop working once it works).
        require(address(state.mintingTagManager) != address(0), MissingMintingTagManager());
        require(address(state.smartAccountManager) != address(0), MissingSmartAccountManager());
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
        (uint256 mintingFeeUBA, uint256 executorFeeUBA) =_computeFees(receivedAmount);
        // mint system fees to fee receiver
        _mintFAssets(state.mintingFeeReceiver, mintingFeeUBA);
        if (mintToSmartAccount) {
            // Mint everything except minting fee to smart account manager and notify it.
            // NOTE: smart account manager must pay the executor in this case
            uint256 sendToTargetUBA = receivedAmount - mintingFeeUBA;
            _mintFAssets(targetAddress, sendToTargetUBA);
            state.smartAccountManager.mintedFAssets(
                _payment.data.requestBody.transactionId,
                _payment.data.responseBody.sourceAddress,
                sendToTargetUBA,
                _payment.data.responseBody.blockTimestamp,
                _payment.data.responseBody.firstMemoData,
                msg.sender);
            emit DirectMintingExecutedToSmartAccount(
                _payment.data.requestBody.transactionId,
                _payment.data.responseBody.sourceAddress,
                msg.sender,
                sendToTargetUBA,
                mintingFeeUBA,
                _payment.data.responseBody.firstMemoData);
        } else {
            // mint to target address and pay executor directly
            uint256 minterReceivesUBA = receivedAmount - mintingFeeUBA - executorFeeUBA;
            _mintFAssets(targetAddress, minterReceivesUBA);
            _mintFAssets(msg.sender, executorFeeUBA);
            emit DirectMintingExecuted(
                _payment.data.requestBody.transactionId,
                targetAddress,
                msg.sender,
                minterReceivesUBA,
                mintingFeeUBA,
                executorFeeUBA);
        }
    }

    function directMintingPaymentAddress()
        external view
        returns (string memory)
    {
        return CoreVaultClient.coreVaultUnderlyingAddress();
    }

    function directMintingDelayState(bytes32 _transactionId)
        external view
        returns (bool _isDelayed, bool _canBeExecuted, uint256 _allowedAt, uint256 _startedAt)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        DirectMinting.DelayedMinting storage delayed = state.delayedMintings[_transactionId];
        _isDelayed = delayed.allowedAt != 0;
        _canBeExecuted = _isDelayed &&
            (block.timestamp >= delayed.allowedAt || delayed.startedAt < state.unblockMintingsUntilTimestamp);
        _allowedAt = delayed.allowedAt;
        _startedAt = delayed.startedAt;
    }

    // internal functions

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

    function _decodeTarget(IXRPPayment.Proof calldata _payment)
        private view
        returns (bool _mintToSmartAccount, address _targetAddress)
    {
        IXRPPayment.ResponseBody memory body = _payment.data.responseBody;
        DirectMinting.State storage state = DirectMinting.getState();
        // has registered tag (ignore memo data in this case)
        if (body.hasDestinationTag) {
            // forbid core vault donation tag - it should be confirmed using method confirmCoreVaultDonation
            require(body.destinationTag != state.coreVaultDonationTag, CoreVaultDonation());
            address registeredAddress = DirectMinting.mintingRecipientForTag(body.destinationTag);
            if (registeredAddress != address(0)) {
                return (false, registeredAddress);
            }
        }
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
        // no direct minting - mint through smart account manager
        return (true, address(state.smartAccountManager));
    }

    function _mintFAssets(address _to, uint256 _amount) private {
        if (_amount > 0) {
            Globals.getFAsset().mint(_to, _amount);
        }
    }

    function _computeFees(uint256 _receivedAmount)
        private view
        returns (uint256 _mintingFeeUBA, uint256 _executorFeeUBA)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        uint256 relativeFeeUBA = _receivedAmount.mulBips(state.mintingFeeBIPS);
        uint256 minimumFeeUBA = Conversion.convertAmgToUBA(state.minimumMintingFeeAmg);
        _mintingFeeUBA = Math.min(Math.max(relativeFeeUBA, minimumFeeUBA), _receivedAmount);
        // prioritize system fee over executor fee
        uint256 executorFeeUBA = Conversion.convertAmgToUBA(state.executorFeeAmg);
        _executorFeeUBA = Math.min(executorFeeUBA, _receivedAmount - _mintingFeeUBA);
    }
}
