// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ICoreVaultClient} from "../../userInterfaces/ICoreVaultClient.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {Conversion} from "../library/Conversion.sol";
import {CoreVaultClient} from "../library/CoreVaultClient.sol";
import {Agent} from "../library/data/Agent.sol";
import {Redemptions} from "../library/Redemptions.sol";
import {RedemptionRequests} from "../library/RedemptionRequests.sol";


contract TransferToCoreVaultFacet is AssetManagerBase, ReentrancyGuard {
    using SafeCast for uint256;

    error InvalidAgentStatus();
    error NotEnoughUnderlying();
    error NothingMinted();
    error TooLittleMintingLeftAfterTransfer();
    error TransferAlreadyActive();
    error ZeroTransferNotAllowed();

    // core vault may not be enabled on all chains
    modifier onlyEnabled {
        CoreVaultClient.checkEnabled();
        _;
    }

    // prevent initialization of implementation contract
    constructor() {
        CoreVaultClient.State storage state = CoreVaultClient.getState();
        state.initialized = true;
    }

    /**
     * Agent can transfer their backing to core vault.
     * They then get a redemption requests which the owner pays just like any other redemption request.
     * After that, the agent's collateral is released.
     * NOTE: only agent vault owner can call
     * @param _agentVault the agent vault address
     * @param _amountUBA the amount to transfer to the core vault
     */
    function transferToCoreVault(
        address _agentVault,
        uint256 _amountUBA
    )
        external
        onlyEnabled
        notEmergencyPaused
        nonReentrant
        onlyActiveAgentVaultOwner(_agentVault)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        CoreVaultClient.State storage state = CoreVaultClient.getState();
        // for agent in full liquidation, the system cannot know if there is enough underlying for the transfer
        require(agent.status != Agent.Status.FULL_LIQUIDATION, InvalidAgentStatus());
        // forbid 0 transfer
        require(_amountUBA > 0, ZeroTransferNotAllowed());
        // agent must have enough underlying for the transfer (if the required backing < 100%, they may have less)
        require(_amountUBA.toInt256() <= agent.underlyingBalanceUBA, NotEnoughUnderlying());
        // only one transfer can be active
        require(agent.activeTransferToCoreVault == 0, TransferAlreadyActive());
        // close agent's redemption tickets
        uint64 amountAMG = Conversion.convertUBAToAmg(_amountUBA);
        (uint64 transferredAMG,) = Redemptions.closeTickets(agent, amountAMG, false);
        require(transferredAMG > 0, NothingMinted());
        // check the remaining amount
        (uint256 maximumTransferAMG,) = CoreVaultClient.maximumTransferToCoreVaultAMG(agent);
        require(transferredAMG <= maximumTransferAMG, TooLittleMintingLeftAfterTransfer());
        // create ordinary redemption request to core vault address
        string memory underlyingAddress = state.coreVaultManager.coreVaultAddress();
        // NOTE: there will be no redemption fee, so the agent needs enough free underlying for the
        // underlying transaction fee, otherwise they will go into full liquidation
        uint64 redemptionRequestId = RedemptionRequests.createRedemptionRequest(
            RedemptionRequests.CreateRedemptionRequestArgs({
                agentVault: _agentVault,
                valueAMG: transferredAMG,
                redeemer: state.nativeAddress,
                redeemerUnderlyingAddressString: underlyingAddress,
                poolSelfClose: false,
                executor: payable(address(0)),
                executorFeeNatGWei: 0,
                additionalPaymentTime: state.transferTimeExtensionSeconds,
                transferToCoreVault: true,
                requiresDestinationTag: false,
                destinationTag: 0
            })
        );
        // set the active request
        agent.activeTransferToCoreVault = redemptionRequestId;
        // send event
        uint256 transferredUBA = Conversion.convertAmgToUBA(transferredAMG);
        emit ICoreVaultClient.TransferToCoreVaultStarted(_agentVault, redemptionRequestId, transferredUBA);
    }

    function maximumTransferToCoreVault(
        address _agentVault
    )
        external view
        returns (uint256 _maximumTransferUBA, uint256 _minimumLeftAmountUBA)
    {
        Agent.State storage agent = Agent.get(_agentVault);
        (uint256 _maximumTransferAMG, uint256 _minimumLeftAmountAMG) =
             CoreVaultClient.maximumTransferToCoreVaultAMG(agent);
        _maximumTransferUBA = Conversion.convertAmgToUBA(_maximumTransferAMG.toUint64());
        _minimumLeftAmountUBA = Conversion.convertAmgToUBA(_minimumLeftAmountAMG.toUint64());
    }
}
