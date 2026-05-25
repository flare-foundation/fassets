// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IXRPPayment} from "@flarenetwork/flare-periphery-contracts/flare/IXRPPayment.sol";
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
import {Minting} from "../library/Minting.sol";
import {PaymentConfirmations} from "../library/data/PaymentConfirmations.sol";
import {MintingRateLimiter} from "../library/data/MintingRateLimiter.sol";
import {Transfers} from "../../utils/library/Transfers.sol";


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
    error DirectMintingNotUnblocked();
    error DirectMintingNotDelayed();
    error NoValueExpected();
    error NoDataExpectedForDirectMinting();

    function executeDirectMinting(
        IXRPPayment.Proof calldata _payment
    )
        external payable
        onlyAttached
        notEmergencyPaused
        nonReentrant
    {
        _executeDirectMinting(_payment, false, "");
    }

    function executeDirectMintingWithData(
        IXRPPayment.Proof calldata _payment,
        bytes calldata _data
    )
        external payable
        onlyAttached
        notEmergencyPaused
        nonReentrant
    {
        _executeDirectMinting(_payment, true, _data);
    }

    /**
     * This method is not strictly necessary to allow an unblocked delayed minting to be executed.
     * However, if the minter has set an allowed executor, it has the exclusive right
     * to execute minting for fixed time after the minting is allowed to execute. This method makes sure
     * that the exclusive period begins from the moment the minting was unblocked, not from later allowedAt.
     * NOTE: this method is intentionally callable by anybody, not just allowed executor - it is
     * in the interest of other executors to call it as soon as mintings are unblocked by the governance.
     * @param _transactionId transaction id of the delayed minting to mark as allowed
     */
    function markUnblockedDirectMintingAllowed(bytes32 _transactionId)
        external
    {
        DirectMinting.State storage state = DirectMinting.getState();
        DirectMinting.DelayedMinting storage delayed = state.delayedMintings[_transactionId];
        require(delayed.allowedAt != 0 && delayed.allowedAt > block.timestamp, DirectMintingNotDelayed());
        require(delayed.startedAt < state.unblockMintingsUntilTimestamp, DirectMintingNotUnblocked());
        delayed.allowedAt = state.mintingsUnblockedAt;
    }

    function directMintingPaymentAddress()
        external view
        returns (string memory)
    {
        return CoreVaultClient.coreVaultUnderlyingAddress();
    }

    function directMintingDelayState(bytes32 _transactionId)
        external view
        returns (DirectMintingDelayState _delayState, uint256 _allowedAt, uint256 _startedAt)
    {
        DirectMinting.DelayedMinting storage delayed = _getDelayedMinting(_transactionId);
        _delayState = _getDelayState(delayed);
        _allowedAt = delayed.allowedAt;
        _startedAt = delayed.startedAt;
    }

    // internal functions

    function _executeDirectMinting(
        IXRPPayment.Proof calldata _payment,
        bool _hasData,
        bytes memory _data
    )
        private
    {
        TransactionAttestation.verifyXRPPaymentSuccess(_payment);
        TransactionAttestation.verifyProofOwnership(_payment.data.requestBody.proofOwner);
        DirectMinting.State storage state = DirectMinting.getState();
        require(_payment.data.responseBody.receivingAddressHash == CoreVaultClient.coreVaultUnderlyingAddressHash(),
            InvalidReceivingAddress());
        require(_payment.data.responseBody.receivedAmount > 0, AmountNotPositive());
        uint256 receivedAmount = uint256(_payment.data.responseBody.receivedAmount);
        bytes32 transactionId = _payment.data.requestBody.transactionId;
        // MintingTagManager and smartAccountManager need not exist at deploy time, so they are checked here
        // instead of in initialization function. However, once they are set they cannot be unset again
        // (so direct minting won't stop working once it works).
        require(address(state.mintingTagManager) != address(0), MissingMintingTagManager());
        require(address(state.smartAccountManager) != address(0), MissingSmartAccountManager());
        _validateTagAndMemoData(_payment);
        DirectMinting.MintingTarget memory target = _getMintingTarget(_payment);
        require(target.allowedExecutor == address(0) || target.allowedExecutor == msg.sender
            || _othersCanExecute(_payment), InvalidExecutor());
        // check that payment was not confirmed before minting cap reservation and possible delay
        AssetManagerState.get().paymentConfirmations.requireIncomingPaymentUnconfirmed(transactionId);
        // check and reserve minting capacity
        _reserveMintingCapacity(transactionId, receivedAmount);
        // check rate limits
        DirectMintingDelayState mintingDelayed = _checkRateLimits(transactionId, receivedAmount, target);
        if (mintingDelayed == DirectMintingDelayState.Delayed) {
            // return the native value to the executor (delayed execution may be executed by someone else)
            Transfers.transferNAT(payable(msg.sender), msg.value);
            return;
        }
        // mark payment used
        AssetManagerState.get().paymentConfirmations.confirmIncomingPayment(_payment);
        // update core vault accounting
        CoreVaultClient.confirmCoreVaultPayment(transactionId, _payment.data.responseBody.receivedAmount);
        // calculate fees
        (bool paymentTooSmall, uint256 mintingFeeUBA, uint256 executorFeeUBA) =_computeFees(receivedAmount);
        // reserved minting capacity can now be released, as it will be calculated from minted FAsset amount
        _releaseMintingCapacity(receivedAmount);
        // mint system fees to fee receiver
        _mintFAssets(state.mintingFeeReceiver, mintingFeeUBA);
        if (paymentTooSmall) {
            // If the total payment is less than the system fee, everything goes to the fee receiver and no further
            // actions are done, to prevent smart accounts users from sending very small amounts to avoid paying fee.
            // Executor also gets nothing in this case since the minting fee has priority over the executor fee.
            require(!_hasData, NoDataExpectedForDirectMinting());
            require(msg.value == 0, NoValueExpected());
            emit DirectMintingPaymentTooSmallForFee(transactionId,
                receivedAmount, Conversion.convertAmgToUBA(state.minimumMintingFeeAmg));
        } else if (target.mintToSmartAccount) {
            _mintToSmartAccounts(_payment, receivedAmount, mintingFeeUBA, _data);
        } else {
            require(!_hasData, NoDataExpectedForDirectMinting());
            require(msg.value == 0, NoValueExpected());
            _mintToRecipient(_payment, target.recipient, receivedAmount, mintingFeeUBA, executorFeeUBA);
        }
    }

    function _reserveMintingCapacity(bytes32 _transactionId, uint256 _amount)
        private
    {
        DirectMinting.DelayedMinting storage delayed = _getDelayedMinting(_transactionId);
        // don't reserve the capacity twice (could only happen for delayed mintings)
        if (!delayed.mintingCapacityReserved) {
            AssetManagerState.State storage state = AssetManagerState.get();
            uint64 amountAmg = Conversion.convertUBAToAmg(_amount);
            Minting.checkMintingCap(amountAmg);
            state.totalReservedCollateralAMG += amountAmg;
        }
    }

    function _releaseMintingCapacity(uint256 _amount)
        private
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        uint64 amountAmg = Conversion.convertUBAToAmg(_amount);
        state.totalReservedCollateralAMG -= amountAmg;
    }

    function _checkRateLimits(
        bytes32 _transactionId,
        uint256 _amount,
        DirectMinting.MintingTarget memory _target
    )
        private
        returns (DirectMintingDelayState)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        // already delayed?
        DirectMinting.DelayedMinting storage alreadyDelayed = state.delayedMintings[_transactionId];
        if (alreadyDelayed.allowedAt != 0) {
            bool delayFinished = block.timestamp >= alreadyDelayed.allowedAt;
            bool mintingsUnblocked = alreadyDelayed.startedAt < state.unblockMintingsUntilTimestamp;
            // initial delay emits event, but calling while still delayed just reverts to avoid multiple events
            require(delayFinished || mintingsUnblocked, DirectMintingStillDelayed(alreadyDelayed.allowedAt));
            // delay finished - allow execution
            return DirectMintingDelayState.Released;
        }
        // large mintings have separate limiter
        uint64 amountAmg = Conversion.convertUBAToAmg(_amount);
        if (amountAmg >= state.largeMintingThresholdAmg) {
            uint256 allowedAt = block.timestamp + state.largeMintingDelaySeconds;
            _addDelayedMinting(_transactionId, allowedAt, _target);
            emit LargeDirectMintingDelayed(_transactionId, _amount, allowedAt);
            return DirectMintingDelayState.Delayed;
        } else {
            (bool delayedHourly, uint256 allowedAtHourly) = state.hourlyLimiter.recordMinting(amountAmg);
            (bool delayedDaily, uint256 allowedAtDaily) = state.dailyLimiter.recordMinting(amountAmg);
            if (delayedHourly || delayedDaily) {
                uint256 allowedAt = Math.max(allowedAtHourly, allowedAtDaily);
                _addDelayedMinting(_transactionId, allowedAt, _target);
                emit DirectMintingDelayed(_transactionId, _amount, allowedAt);
                return DirectMintingDelayState.Delayed;
            }
        }
        return DirectMintingDelayState.NotDelayed;
    }

    function _addDelayedMinting(
        bytes32 _transactionId,
        uint256 _allowedAt,
        DirectMinting.MintingTarget memory _target
    )
        private
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.delayedMintings[_transactionId] = DirectMinting.DelayedMinting({
            startedAt: block.timestamp.toUint64(),
            allowedAt: _allowedAt.toUint64(),
            mintingCapacityReserved: true,
            targetStored: true,
            mintToSmartAccount: _target.mintToSmartAccount,
            recipient: _target.recipient,
            allowedExecutor: _target.allowedExecutor
        });
    }

    function _getDelayedMinting(bytes32 _transactionId)
        private view
        returns (DirectMinting.DelayedMinting storage)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.delayedMintings[_transactionId];
    }

    function _getDelayState(DirectMinting.DelayedMinting storage _delayed)
        private view
        returns (DirectMintingDelayState)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        if (_delayed.allowedAt == 0) {
            return DirectMintingDelayState.NotDelayed;
        } else if (block.timestamp >= _delayed.allowedAt || _delayed.startedAt < state.unblockMintingsUntilTimestamp) {
            return DirectMintingDelayState.Released;
        } else {
            return DirectMintingDelayState.Delayed;
        }
    }

    // forbid dangerous tags/memo fields that could be used to steal assets
    function _validateTagAndMemoData(IXRPPayment.Proof calldata _payment)
        private view
    {
        IXRPPayment.ResponseBody calldata body = _payment.data.responseBody;
        if (body.hasDestinationTag) {
            uint256 destinationTag = body.destinationTag;
            // forbid core vault donation tag - it should be confirmed using method confirmCoreVaultDonation
            require(destinationTag != CoreVaultClient.coreVaultDonationTag(), PaymentIsCoreVaultDonation());
        }
        if (body.hasMemoData && body.firstMemoData.length == 32) {
            bytes32 paymentReference = bytes32(body.firstMemoData);
            // forbid REDEMPTION payment reference, because it could be used to steal agents' core vault deposits
            require(!PaymentReference.isValid(paymentReference, PaymentReference.REDEMPTION),
                ForbiddenPaymentReference());
        }
    }

    function _getMintingTarget(IXRPPayment.Proof calldata _payment)
        private view
        returns (DirectMinting.MintingTarget memory)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        DirectMinting.DelayedMinting storage delayed = state.delayedMintings[_payment.data.requestBody.transactionId];
        // For a minting that was already delayed, use the recipient and executor captured at delay creation
        // time. This prevents the tag owner from accidentally changing the recipient/executor
        // (e.g. by transferring the tag) during the delay period and losing the minted FAssets.
        if (delayed.targetStored) {
            return DirectMinting.MintingTarget({
                mintToSmartAccount: delayed.mintToSmartAccount,
                recipient: delayed.recipient,
                allowedExecutor: delayed.allowedExecutor
            });
        } else {
            return _decodeTarget(_payment);
        }
    }

    function _decodeTarget(IXRPPayment.Proof calldata _payment)
        private view
        returns (DirectMinting.MintingTarget memory)
    {
        IXRPPayment.ResponseBody calldata body = _payment.data.responseBody;
        // has registered tag (ignore memo data in this case)
        if (body.hasDestinationTag) {
            uint256 destinationTag = body.destinationTag;
            address registeredAddress = DirectMinting.mintingRecipientForTag(destinationTag);
            if (registeredAddress != address(0)) {
                return DirectMinting.MintingTarget({
                    mintToSmartAccount: false,
                    recipient: registeredAddress,
                    allowedExecutor: DirectMinting.allowedExecutorForTag(destinationTag)
                });
            }
        }
        // has valid DIRECT_MINTING payment reference
        if (body.hasMemoData && body.firstMemoData.length == 32) {
            // normal direct minting payment reference
            bytes32 paymentReference = bytes32(body.firstMemoData);
            if (PaymentReference.isValid(paymentReference, PaymentReference.DIRECT_MINTING)) {
                uint256 addressNumeric = PaymentReference.decodeId(paymentReference);
                if (addressNumeric <= type(uint160).max) {
                    return DirectMinting.MintingTarget({
                        mintToSmartAccount: false,
                        recipient: address(uint160(addressNumeric)),
                        allowedExecutor: address(0)
                    });
                }
            }
        } else if (body.hasMemoData && body.firstMemoData.length == 48) {
            uint64 prefix = uint64(bytes8(body.firstMemoData[0:8]));
            if (prefix == PaymentReference.DIRECT_MINTING_EX) {
                address recipient = address(bytes20(body.firstMemoData[8:28]));
                address executor = address(bytes20(body.firstMemoData[28:48]));
                if (recipient != address(0)) {
                    return DirectMinting.MintingTarget({
                        mintToSmartAccount: false,
                        recipient: recipient,
                        allowedExecutor: executor
                    });
                }
            }
        }
        // no direct minting - mint through smart account manager
        return DirectMinting.MintingTarget({
            mintToSmartAccount: true,
            recipient: address(0),
            allowedExecutor: address(0)
        });
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
        uint256 _mintingFeeUBA,
        bytes memory _data
    ) private {
        DirectMinting.State storage state = DirectMinting.getState();
        // use empty memo data if not present, to avoid having to check for its existence in the smart account manager
        bytes memory memoData = "";
        if (_payment.data.responseBody.hasMemoData) {
            memoData = _payment.data.responseBody.firstMemoData;
        }
        // mint to smart account manager
        uint256 mintedAmountUBA = _receivedAmountUBA - _mintingFeeUBA;
        _mintFAssets(address(state.smartAccountManager), mintedAmountUBA);
        // notify smart account manager
        state.smartAccountManager.handleMintedFAssets{ value: msg.value }(
            _payment.data.requestBody.transactionId,
            _payment.data.responseBody.sourceAddress,
            mintedAmountUBA,
            _payment.data.responseBody.blockTimestamp,
            memoData,
            payable(msg.sender),
            _data
        );
        emit DirectMintingExecutedToSmartAccount(
            _payment.data.requestBody.transactionId,
            _payment.data.responseBody.sourceAddress,
            msg.sender,
            mintedAmountUBA,
            _mintingFeeUBA,
            memoData
        );
    }

    function _mintFAssets(address _to, uint256 _amount) private {
        if (_amount > 0) {
            Globals.getFAsset().mint(_to, _amount);
        }
    }

    function _computeFees(uint256 _receivedAmount)
        private view
        returns (bool _paymentTooSmall, uint256 _mintingFeeUBA, uint256 _executorFeeUBA)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        uint256 relativeFeeUBA = _receivedAmount.mulBips(state.mintingFeeBIPS);
        uint256 minimumFeeUBA = Conversion.convertAmgToUBA(state.minimumMintingFeeAmg);
        _paymentTooSmall = _receivedAmount < minimumFeeUBA;
        _mintingFeeUBA = Math.min(Math.max(relativeFeeUBA, minimumFeeUBA), _receivedAmount);
        // prioritize system fee over executor fee
        uint256 executorFeeUBA = Conversion.convertAmgToUBA(state.executorFeeAmg);
        _executorFeeUBA = Math.min(executorFeeUBA, _receivedAmount - _mintingFeeUBA);
    }

    function _othersCanExecute(IXRPPayment.Proof calldata _payment)
        private view
        returns (bool)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        DirectMinting.DelayedMinting storage delayed = state.delayedMintings[_payment.data.requestBody.transactionId];
        DirectMintingDelayState delayState = _getDelayState(delayed);
        if (delayState == DirectMintingDelayState.NotDelayed) {
            uint256 currentUnderlyingTimestamp = AssetManagerState.get().currentUnderlyingBlockTimestamp;
            uint256 paymentTimestamp = _payment.data.responseBody.blockTimestamp;
            // if not delayed, others can execute if the payment is old enough compared to current underlying block
            return currentUnderlyingTimestamp >= paymentTimestamp + state.othersCanExecuteAfterSeconds;
        } else {
            // if delayed (and released), others can execute if the time since the execution was allowed is long enough
            return block.timestamp >= delayed.allowedAt + state.othersCanExecuteAfterSeconds;
        }
    }
}
