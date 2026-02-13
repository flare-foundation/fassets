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
    error PaymentIsCoreVaultDonation();
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
        // MintingTagManager and smartAccountManager need not exist at deploy time, so they are checked here
        // instead of in initialization function. However, once they are set they cannot be unset again
        // (so direct minting won't stop working once it works).
        require(address(state.mintingTagManager) != address(0), MissingMintingTagManager());
        require(address(state.smartAccountManager) != address(0), MissingSmartAccountManager());
        (bool mintToSmartAccount, address recipient, address allowedExecutor) = _decodeTarget(_payment);
        require(allowedExecutor == address(0) || allowedExecutor == msg.sender, InvalidExecutor());
        // check rate limits
        bool mintingDelayed = _checkRateLimits(_payment.data.requestBody.transactionId, receivedAmount);
        if (mintingDelayed) {
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
            _mintToSmartAccounts(_payment, receivedAmount, mintingFeeUBA);
        } else {
            _mintToRecipient(_payment, recipient, receivedAmount, mintingFeeUBA, executorFeeUBA);
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
        returns (bool _mintToSmartAccount, address _targetAddress, address _allowedExecutor)
    {
        IXRPPayment.ResponseBody calldata body = _payment.data.responseBody;
        DirectMinting.State storage state = DirectMinting.getState();
        // has registered tag (ignore memo data in this case)
        if (body.hasDestinationTag) {
            uint256 destinationTag = body.destinationTag;
            // forbid core vault donation tag - it should be confirmed using method confirmCoreVaultDonation
            require(destinationTag != state.coreVaultDonationTag, PaymentIsCoreVaultDonation());
            address registeredAddress = DirectMinting.mintingRecipientForTag(destinationTag);
            if (registeredAddress != address(0)) {
                return (false, registeredAddress, DirectMinting.allowedExecutorForTag(body.destinationTag));
            }
        }
        // has valid DIRECT_MINTING payment reference
        if (body.hasMemoData && body.firstMemoData.length == 32) {
            // normal direct minting payment reference
            bytes32 paymentReference = bytes32(body.firstMemoData);
            if (PaymentReference.isValid(paymentReference, PaymentReference.DIRECT_MINTING)) {
                uint256 addressNumeric = PaymentReference.decodeId(paymentReference);
                if (addressNumeric <= type(uint160).max) {
                    return (false, address(uint160(addressNumeric)), address(0));
                }
            }
            // forbid REDEMPTION payment reference, because it could be used to steal agents' core vault deposits
            require(!PaymentReference.isValid(paymentReference, PaymentReference.REDEMPTION),
                ForbiddenPaymentReference());
        } else if (body.hasMemoData && body.firstMemoData.length == 48) {
            uint64 prefix = uint64(bytes8(body.firstMemoData[0:8]));
            if (prefix == PaymentReference.DIRECT_MINTING_EX) {
                address target = address(bytes20(body.firstMemoData[8:28]));
                address executor = address(bytes20(body.firstMemoData[28:48]));
                if (target != address(0)) {
                    return (false, target, executor);
                }
            }
        }
        // no direct minting - mint through smart account manager
        return (true, address(0), address(0));
    }

    // mint to target address and pay executor directly
    function _mintToRecipient(
        IXRPPayment.Proof calldata _payment,
        address _targetAddress,
        uint256 _receivedAmountUBA,
        uint256 _mintingFeeUBA,
        uint256 _executorFeeUBA
    ) private {
        uint256 mintedAmountUBA = _receivedAmountUBA - _mintingFeeUBA - _executorFeeUBA;
        _mintFAssets(_targetAddress, mintedAmountUBA);
        _mintFAssets(msg.sender, _executorFeeUBA);
        emit DirectMintingExecuted(
            _payment.data.requestBody.transactionId,
            _targetAddress,
            msg.sender,
            mintedAmountUBA,
            _mintingFeeUBA,
            _executorFeeUBA
        );
    }

    // Mint everything except minting fee to smart account manager and notify it.
    // NOTE: smart account manager must pay the executor in this case
    function _mintToSmartAccounts(
        IXRPPayment.Proof calldata _payment,
        uint256 _receivedAmountUBA,
        uint256 _mintingFeeUBA
    ) private {
        DirectMinting.State storage state = DirectMinting.getState();
        uint256 mintedAmountUBA = _receivedAmountUBA - _mintingFeeUBA;
        _mintFAssets(address(state.smartAccountManager), mintedAmountUBA);
        state.smartAccountManager.mintedFAssets(
            _payment.data.requestBody.transactionId,
            _payment.data.responseBody.sourceAddress,
            mintedAmountUBA,
            _payment.data.responseBody.blockTimestamp,
            _payment.data.responseBody.firstMemoData,
            msg.sender
        );
        emit DirectMintingExecutedToSmartAccount(
            _payment.data.requestBody.transactionId,
            _payment.data.responseBody.sourceAddress,
            msg.sender,
            mintedAmountUBA,
            _mintingFeeUBA,
            _payment.data.responseBody.firstMemoData
        );
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
