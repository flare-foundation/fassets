// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {AssetManagerState} from "./data/AssetManagerState.sol";
import {RedemptionTimeExtension} from "./data/RedemptionTimeExtension.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {IRedeemExtended} from "../../userInterfaces/IRedeemExtended.sol";
import {Conversion} from "./Conversion.sol";
import {Redemption} from "./data/Redemption.sol";
import {Agent} from "./data/Agent.sol";
import {Globals} from "./Globals.sol";
import {AgentBacking} from "./AgentBacking.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {PaymentReference} from "./data/PaymentReference.sol";


library RedemptionRequests {
    using SafePct for uint256;
    using SafeCast for uint256;

    error CannotRedeemToAgentsAddress();
    error UnderlyingAddressTooLong();
    error ExecutorFeeWithoutExecutor();
    error InvalidUnderlyingAddress();

    struct Settings {
        bool redeemWithTagSupported;
        uint64 minimumRedeemAmountAMG;
    }

    struct AgentRedemptionData {
        address agentVault;
        uint64 valueAMG;
    }

    struct AgentRedemptionList {
        AgentRedemptionData[] items;
        uint256 length;
    }

    struct CreateRedemptionRequestArgs {
        address agentVault;
        uint64 valueAMG;
        address redeemer;
        string redeemerUnderlyingAddressString;
        bool poolSelfClose;
        address payable executor;
        uint64 executorFeeNatGWei;
        uint64 additionalPaymentTime;
        bool transferToCoreVault;
        bool requiresDestinationTag;
        uint64 destinationTag;
    }

    function createRedemptionRequest(
        CreateRedemptionRequestArgs memory _args
    )
        internal
        returns (uint64 _requestId)
    {
        require(_args.executorFeeNatGWei == 0 || _args.executor != address(0), ExecutorFeeWithoutExecutor());
        AssetManagerState.State storage state = AssetManagerState.get();
        Agent.State storage agent = Agent.get(_args.agentVault);
        // validate redemption address
        require(bytes(_args.redeemerUnderlyingAddressString).length < 128, UnderlyingAddressTooLong());
        _validateAddressCharacters(_args.redeemerUnderlyingAddressString);
        bytes32 underlyingAddressHash = keccak256(bytes(_args.redeemerUnderlyingAddressString));
        // both addresses must be normalized (agent's address is checked at vault creation,
        // and if redeemer address isn't normalized, the agent can trigger rejectInvalidRedemption),
        // so this comparison quarantees the redemption is not to the agent's address
        require(underlyingAddressHash != agent.underlyingAddressHash,
            CannotRedeemToAgentsAddress());
        // create request
        uint128 redeemedValueUBA = Conversion.convertAmgToUBA(_args.valueAMG).toUint128();
        _requestId = _newRequestId(_args.poolSelfClose);
        // create in-memory request and then put it to storage to not go out-of-stack
        Redemption.Request memory request;
        request.redeemerUnderlyingAddressHash = underlyingAddressHash;
        request.underlyingValueUBA = redeemedValueUBA;
        request.firstUnderlyingBlock = state.currentUnderlyingBlock;
        (request.lastUnderlyingBlock, request.lastUnderlyingTimestamp) =
            _lastPaymentBlock(_args.agentVault, _args.additionalPaymentTime);
        request.timestamp = block.timestamp.toUint64();
        request.underlyingFeeUBA = _args.transferToCoreVault ?
            0 : uint256(redeemedValueUBA).mulBips(Globals.getSettings().redemptionFeeBIPS).toUint128();
        request.redeemer = _args.redeemer;
        request.agentVault = _args.agentVault;
        request.valueAMG = _args.valueAMG;
        request.status = Redemption.Status.ACTIVE;
        request.poolSelfClose = _args.poolSelfClose;
        request.executor = _args.executor;
        request.executorFeeNatGWei = _args.executorFeeNatGWei;
        request.redeemerUnderlyingAddressString = _args.redeemerUnderlyingAddressString;
        request.transferToCoreVault = _args.transferToCoreVault;
        request.poolFeeShareBIPS = agent.redemptionPoolFeeShareBIPS;
        request.requiresDestinationTag = _args.requiresDestinationTag;
        request.destinationTag = _args.destinationTag;
        state.redemptionRequests[_requestId] = request;
        // decrease mintedAMG and mark it to redeemingAMG
        // do not add it to freeBalance yet (only after failed redemption payment)
        AgentBacking.startRedeemingAssets(agent, _args.valueAMG, _args.poolSelfClose);
        // emit event to remind agent to pay
        _emitRedemptionRequestedEvent(request, _requestId, _args.redeemerUnderlyingAddressString);
    }

    function redeemWithTagSupported() internal view returns (bool) {
        return getSettings().redeemWithTagSupported;
    }

    function minimumRedeemAmountAMG() internal view returns (uint64) {
        return getSettings().minimumRedeemAmountAMG;
    }

    function _emitRedemptionRequestedEvent(
        Redemption.Request memory _request,
        uint64 _requestId,
        string memory _redeemerUnderlyingAddressString
    )
        private
    {
        if (_request.requiresDestinationTag) {
            emit IRedeemExtended.RedemptionWithTagRequested(
                _request.agentVault,
                _request.redeemer,
                _requestId,
                _redeemerUnderlyingAddressString,
                _request.underlyingValueUBA,
                _request.underlyingFeeUBA,
                _request.firstUnderlyingBlock,
                _request.lastUnderlyingBlock,
                _request.lastUnderlyingTimestamp,
                PaymentReference.redemption(_requestId),
                _request.executor,
                _request.executorFeeNatGWei * Conversion.GWEI,
                _request.destinationTag);
        } else {
            emit IAssetManagerEvents.RedemptionRequested(
                _request.agentVault,
                _request.redeemer,
                _requestId,
                _redeemerUnderlyingAddressString,
                _request.underlyingValueUBA,
                _request.underlyingFeeUBA,
                _request.firstUnderlyingBlock,
                _request.lastUnderlyingBlock,
                _request.lastUnderlyingTimestamp,
                PaymentReference.redemption(_requestId),
                _request.executor,
                _request.executorFeeNatGWei * Conversion.GWEI);
        }
    }

    function _newRequestId(bool _poolSelfClose)
        private
        returns (uint64)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        uint64 nextRequestId = state.newRedemptionRequestId + PaymentReference.randomizedIdSkip();
        // the requestId will indicate in the lowest bit whether it is a pool self close redemption
        // (+1 is added so that the request id still increases after clearing lowest bit)
        uint64 requestId = ((nextRequestId + 1) & ~uint64(1)) | (_poolSelfClose ? 1 : 0);
        state.newRedemptionRequestId = requestId;
        return requestId;
    }

    function _lastPaymentBlock(address _agentVault, uint64 _additionalPaymentTime)
        private
        returns (uint64 _lastUnderlyingBlock, uint64 _lastUnderlyingTimestamp)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        // timeshift amortizes for the time that passed from the last underlying block update;
        // it also adds redemption time extension when there are many redemption requests in short time
        uint64 timeshift = block.timestamp.toUint64() - state.currentUnderlyingBlockUpdatedAt
            + RedemptionTimeExtension.extendTimeForRedemption(_agentVault)
            + _additionalPaymentTime;
        uint64 blockshift = (uint256(timeshift) * 1000 / settings.averageBlockTimeMS).toUint64();
        _lastUnderlyingBlock =
            state.currentUnderlyingBlock + blockshift + settings.underlyingBlocksForPayment;
        _lastUnderlyingTimestamp =
            state.currentUnderlyingBlockTimestamp + timeshift + settings.underlyingSecondsForPayment;
    }


    function _validateAddressCharacters(string memory _address) private pure {
        bytes memory addressBytes = bytes(_address);
        for (uint256 i = 0; i < addressBytes.length; i++) {
            uint8 char = uint8(addressBytes[i]);
            bool isValidChar = char >= 32 && char <= 126; // Check if character is in the printable ASCII range
            require(isValidChar, InvalidUnderlyingAddress());
        }
    }

    bytes32 internal constant SETTINGS_POSITION = keccak256("fasset.RedemptionRequests.Settings");

    function getSettings()
        internal pure
        returns (Settings storage settings)
    {
        bytes32 position = SETTINGS_POSITION;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            settings.slot := position
        }
    }
}