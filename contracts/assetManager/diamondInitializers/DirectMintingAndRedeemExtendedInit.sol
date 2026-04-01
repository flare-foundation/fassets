// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IInstructionsFacet} from "@flarenetwork/flare-periphery-contracts/flare/IInstructionsFacet.sol";
import {IMintingTagManager} from "../../userInterfaces/IMintingTagManager.sol";
import {IDirectMinting} from "../../userInterfaces/IDirectMinting.sol";
import {IDirectMintingSettings} from "../../userInterfaces/IDirectMintingSettings.sol";
import {ICoreVaultClient} from "../../userInterfaces/ICoreVaultClient.sol";
import {ICoreVaultClientSettings} from "../../userInterfaces/ICoreVaultClientSettings.sol";
import {IRedeemExtended} from "../../userInterfaces/IRedeemExtended.sol";
import {IRedeemExtendedSettings} from "../../userInterfaces/IRedeemExtendedSettings.sol";
import {LibDiamond} from "../../diamond/library/LibDiamond.sol";
import {Conversion} from "../library/Conversion.sol";
import {DirectMinting} from "../library/DirectMinting.sol";
import {MintingRateLimiter} from "../library/data/MintingRateLimiter.sol";
import {RedemptionRequests} from "../library/RedemptionRequests.sol";
import {CoreVaultClient} from "../library/CoreVaultClient.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {Globals} from "../library/Globals.sol";


contract DirectMintingAndRedeemExtendedInit {
    using SafeCast for uint256;
    using MintingRateLimiter for MintingRateLimiter.State;

    error AlreadyInitialized();
    error DiamondNotInitialized();
    error ValueTooHigh();

    struct InitParams {
        // core vault new setting
        uint256 coreVaultDonationTag;
        // direct minting settings
        address mintingTagManager;
        address smartAccountManager;
        address mintingFeeReceiver;
        uint256 minimumMintingFeeUBA;
        uint256 mintingFeeBIPS;
        uint256 executorFeeUBA;
        uint256 othersCanExecuteAfterSeconds;
        uint256 hourlyLimitUBA;
        uint256 dailyLimitUBA;
        uint256 largeMintingThresholdUBA;
        uint256 largeMintingDelaySeconds;
        // redemption with tag settings
        bool redeemWithTagSupported;
        uint256 minimumRedeemAmountUBA;
    }

    // prevent initialization or upgrade of implementation contract

    constructor() {
        DirectMinting.State storage state = DirectMinting.getState();
        state.version = type(uint8).max;
    }

    // initialization

    function initialize(
        InitParams calldata _params
    )
        external
    {
        _ensureSingleInitialization();
        _updateInterfacesAtDeploy();
        _initDirectMinting(_params);
        _initRedemptionWithTag(_params);
        _updateCoreVaultClient(_params);
    }

    function _ensureSingleInitialization() private {
        DirectMinting.State storage state = DirectMinting.getState();
        require(state.version == 0, AlreadyInitialized());
        state.version = 1;
    }

    function _updateInterfacesAtDeploy() private {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        require(ds.supportedInterfaces[type(IERC165).interfaceId], DiamondNotInitialized());
        // DirectMinting interfaces added
        ds.supportedInterfaces[type(IDirectMinting).interfaceId] = true;
        ds.supportedInterfaces[type(IDirectMintingSettings).interfaceId] = true;
        ds.supportedInterfaces[type(IRedeemExtended).interfaceId] = true;
        ds.supportedInterfaces[type(IRedeemExtendedSettings).interfaceId] = true;
        ds.supportedInterfaces[type(ICoreVaultClient).interfaceId] = true;  // changed
        ds.supportedInterfaces[type(ICoreVaultClientSettings).interfaceId] = true;  // changed
    }

    function _initDirectMinting(InitParams calldata _params) private {
        DirectMinting.State storage state = DirectMinting.getState();
        state.mintingTagManager = IMintingTagManager(_params.mintingTagManager);
        state.smartAccountManager = IInstructionsFacet(_params.smartAccountManager);
        state.mintingFeeReceiver = _params.mintingFeeReceiver;
        state.minimumMintingFeeAmg = Conversion.convertUBAToAmg(_params.minimumMintingFeeUBA);
        state.mintingFeeBIPS = _params.mintingFeeBIPS.toUint16();
        state.executorFeeAmg = Conversion.convertUBAToAmg(_params.executorFeeUBA);
        state.othersCanExecuteAfterSeconds = _params.othersCanExecuteAfterSeconds.toUint64();
        state.hourlyLimiter.initialize(1 hours, Conversion.convertUBAToAmg(_params.hourlyLimitUBA));
        state.dailyLimiter.initialize(1 days, Conversion.convertUBAToAmg(_params.dailyLimitUBA));
        uint64 largeMintingThresholdAmg = Conversion.convertUBAToAmg(_params.largeMintingThresholdUBA);
        state.largeMintingDelaySeconds = _params.largeMintingDelaySeconds.toUint64();
        state.largeMintingThresholdAmg = largeMintingThresholdAmg;
    }

    function _initRedemptionWithTag(InitParams calldata _params) private {
        RedemptionRequests.Settings storage settings = RedemptionRequests.getSettings();
        settings.redeemWithTagSupported = _params.redeemWithTagSupported;
        AssetManagerSettings.Data storage assetManagerSettings = Globals.getSettings();
        uint64 minimumRedeemAmountAMG = Conversion.convertUBAToAmg(_params.minimumRedeemAmountUBA);
        require(minimumRedeemAmountAMG <= assetManagerSettings.lotSizeAMG * 10, ValueTooHigh());
        settings.minimumRedeemAmountAMG = minimumRedeemAmountAMG;
    }

    function _updateCoreVaultClient(InitParams calldata _params) private {
        CoreVaultClient.State storage state = CoreVaultClient.getState();
        state.coreVaultDonationTag = _params.coreVaultDonationTag.toUint32();
    }
}
