// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IMintingTagManager} from "../../userInterfaces/IMintingTagManager.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {IDirectMinting} from "../../userInterfaces/IDirectMinting.sol";
import {IDirectMintingSettings} from "../../userInterfaces/IDirectMintingSettings.sol";
import {ISmartAccountManagerMock} from "../mock/ISmartAccountManagerMock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Globals} from "../library/Globals.sol";
import {Conversion} from "../library/Conversion.sol";
import {DirectMinting} from "../library/DirectMinting.sol";
import {MintingRateLimiter} from "../library/data/MintingRateLimiter.sol";
import {CollateralTypeInt} from "../library/data/CollateralTypeInt.sol";
import {GovernedProxyImplementation} from "../../governance/implementation/GovernedProxyImplementation.sol";
import {SettingsUpdater} from "../library/SettingsUpdater.sol";


contract DirectMintingSettingsFacet is AssetManagerBase, GovernedProxyImplementation, IDirectMintingSettings {
    using SafePct for uint256;
    using SafeCast for uint256;
    using MintingRateLimiter for MintingRateLimiter.State;

    error AlreadyInitialized();
    error AddressZero();
    error IncreaseTooBig();
    error DecreaseTooBig();
    error ValueTooHigh();
    error TimestampMustBeInThePast();
    error InvalidPoolCollateralSetting();

    struct InitParams {
        address mintingTagManager;
        uint256 coreVaultDonationTag;
        address smartAccountManager;
        address mintingFeeReceiver;
        uint256 minimumMintingFeeUBA;
        uint256 mintingFeeBIPS;
        uint256 executorFeeShareBIPS;
        uint256 hourlyLimitUBA;
        uint256 dailyLimitUBA;
        uint256 largeMintingThresholdUBA;
        uint256 largeMintingDelaySeconds;
    }

    modifier rateLimited() {
        SettingsUpdater.checkEnoughTimeSinceLastUpdate();
        _;
    }

    // prevent initialization of implementation contract

    constructor() {
        DirectMinting.getState().initialized = true;
    }

    // initialization

    function initialize(
        InitParams calldata _params
    )
        external
    {
        DirectMinting.State storage state = DirectMinting.getState();
        require(!state.initialized, AlreadyInitialized());
        state.initialized = true;
        require(_params.mintingTagManager != address(0), AddressZero());
        state.mintingTagManager = IMintingTagManager(_params.mintingTagManager);
        state.coreVaultDonationTag = _params.coreVaultDonationTag.toUint32();
        state.smartAccountManager = ISmartAccountManagerMock(_params.smartAccountManager);
        state.mintingFeeReceiver = _params.mintingFeeReceiver;
        state.minimumMintingFeeAmg = Conversion.convertUBAToAmg(_params.minimumMintingFeeUBA);
        state.mintingFeeBIPS = _params.mintingFeeBIPS.toUint16();
        state.executorFeeShareBIPS = _params.executorFeeShareBIPS.toUint16();
        state.hourlyLimiter.initialize(1 hours, Conversion.convertUBAToAmg(_params.hourlyLimitUBA));
        state.dailyLimiter.initialize(1 days, Conversion.convertUBAToAmg(_params.dailyLimitUBA));
        uint64 largeMintingThresholdAmg = Conversion.convertUBAToAmg(_params.largeMintingThresholdUBA);
        state.largeMintingLimiter.initialize(_params.largeMintingDelaySeconds.toUint64(), largeMintingThresholdAmg);
        state.largeMintingThresholdAmg = largeMintingThresholdAmg;
    }

    // governance methods

    function unblockDirectMintingsUntil(uint256 _timestamp)
        external
        onlyImmediateGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        // require timestamp to be in the past, because it is assumed that the mintings that are unblocked
        // have been (manually) validated
        require(_timestamp < block.timestamp, TimestampMustBeInThePast());
        state.unblockMintingsUntilTimestamp =
            Math.max(state.unblockMintingsUntilTimestamp, _timestamp).toUint64();
        emit IDirectMinting.DirectMintingsUnblocked(_timestamp);
    }

    // setters

    function setMintingTagManager(address mintingTagManager)
        external
        onlyGovernance
        rateLimited
    {
        require(mintingTagManager != address(0), AddressZero());
        DirectMinting.State storage state = DirectMinting.getState();
        state.mintingTagManager = IMintingTagManager(mintingTagManager);
        emit IAssetManagerEvents.ContractChanged("mintingTagManager", mintingTagManager);
    }

    function setSmartAccountManager(address _smartAccountManager)
        external
        onlyGovernance
        rateLimited
    {
        require(_smartAccountManager != address(0), AddressZero());
        DirectMinting.State storage state = DirectMinting.getState();
        state.smartAccountManager = ISmartAccountManagerMock(_smartAccountManager);
        emit IAssetManagerEvents.ContractChanged("smartAccountManager", _smartAccountManager);
    }

    function setDirectMintingFeeReceiver(address _mintingFeeReceiver)
        external
        onlyGovernance
        rateLimited
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.mintingFeeReceiver = _mintingFeeReceiver;
        // not really a contract, but works for any address - event name is a bit unfortunate
        // but we don't want to change it now to keep backward compatibility
        emit IAssetManagerEvents.ContractChanged("directMintingFeeReceiver", _mintingFeeReceiver);
    }

    function setDirectMintingFee(
        uint256 _mintingFeeBIPS,
        uint256 _minimumMintingFeeUBA
    )
        external
        onlyGovernance
        rateLimited
    {
        DirectMinting.State storage state = DirectMinting.getState();
        // validate
        require(_mintingFeeBIPS < SafePct.MAX_BIPS, ValueTooHigh());
        require(_mintingFeeBIPS <= state.mintingFeeBIPS * 4 + 100, IncreaseTooBig());
        require(_mintingFeeBIPS >= state.mintingFeeBIPS / 4, DecreaseTooBig());
        uint64 minimumMintingFeeAmg = Conversion.convertUBAToAmg(_minimumMintingFeeUBA);
        require(minimumMintingFeeAmg <= state.minimumMintingFeeAmg * 4 + _usd5InAssetAmg(1e5), IncreaseTooBig());
        // update
        state.mintingFeeBIPS = _mintingFeeBIPS.toUint16();
        state.minimumMintingFeeAmg = minimumMintingFeeAmg;
        emit IAssetManagerEvents.SettingChanged("directMintingFeeBIPS", _mintingFeeBIPS);
        emit IAssetManagerEvents.SettingChanged("directMintingMinimumFeeUBA", _minimumMintingFeeUBA);
    }

    function setDirectMintingExecutorFeeShareBIPS(uint256 _executorFeeShareBIPS)
        external
        onlyGovernance
        rateLimited
    {
        DirectMinting.State storage state = DirectMinting.getState();
        // validate
        // (setting executorFeeShareBIPS to MAX_BIPS makes system fee zero, which is possible)
        require(_executorFeeShareBIPS <= SafePct.MAX_BIPS, ValueTooHigh());
        require(_executorFeeShareBIPS <= state.executorFeeShareBIPS * 4 + 100, IncreaseTooBig());
        require(_executorFeeShareBIPS >= state.executorFeeShareBIPS / 4, DecreaseTooBig());
        // update
        state.executorFeeShareBIPS = _executorFeeShareBIPS.toUint16();
        emit IAssetManagerEvents.SettingChanged("directMintingExecutorFeeShareBIPS", _executorFeeShareBIPS);
    }

    function setDirectMintingHourlyLimitUBA(uint256 _hourlyLimitUBA)
        external
        onlyImmediateGovernance
        rateLimited
    {
        DirectMinting.State storage state = DirectMinting.getState();
        // validate
        uint64 currentLimitAmg = state.hourlyLimiter.maxMintingPerWindow;
        uint64 newLimitAmg = Conversion.convertUBAToAmg(_hourlyLimitUBA);
        require(newLimitAmg <= currentLimitAmg * 10 + _usd5InAssetAmg(1000e5), IncreaseTooBig());
        require(newLimitAmg >= currentLimitAmg / 10, DecreaseTooBig());
        // update
        state.hourlyLimiter.maxMintingPerWindow = newLimitAmg;
        emit IAssetManagerEvents.SettingChanged("directMintingHourlyLimitUBA", _hourlyLimitUBA);
    }

    function setDirectMintingDailyLimitUBA(uint256 _dailyLimitUBA)
        external
        onlyImmediateGovernance
        rateLimited
    {
        DirectMinting.State storage state = DirectMinting.getState();
        // validate
        uint64 currentLimitAmg = state.dailyLimiter.maxMintingPerWindow;
        uint64 newLimitAmg = Conversion.convertUBAToAmg(_dailyLimitUBA);
        require(newLimitAmg <= currentLimitAmg * 10 + _usd5InAssetAmg(1000e5), IncreaseTooBig());
        require(newLimitAmg >= currentLimitAmg / 10, DecreaseTooBig());
        // update
        state.dailyLimiter.maxMintingPerWindow = newLimitAmg;
        emit IAssetManagerEvents.SettingChanged("directMintingDailyLimitUBA", _dailyLimitUBA);
    }

    function setDirectMintingLargeMintingThrottling(
        uint256 _largeMintingThresholdUBA,
        uint256 _largeMintingDelaySeconds
    )
        external
        onlyImmediateGovernance
        rateLimited
    {
        DirectMinting.State storage state = DirectMinting.getState();
        uint64 currentThresholdAmg = state.largeMintingLimiter.maxMintingPerWindow;
        uint64 currentDelaySeconds = state.largeMintingLimiter.windowSizeSeconds;
        uint64 newThresholdAmg = Conversion.convertUBAToAmg(_largeMintingThresholdUBA);
        // validate
        require(newThresholdAmg <= currentThresholdAmg * 10 + _usd5InAssetAmg(1000e5), IncreaseTooBig());
        require(newThresholdAmg >= currentThresholdAmg / 10, DecreaseTooBig());
        require(_largeMintingDelaySeconds <= 3 days, ValueTooHigh());
        require(_largeMintingDelaySeconds <= currentDelaySeconds * 4 + 12 hours, IncreaseTooBig());
        require(_largeMintingDelaySeconds >= currentDelaySeconds / 4, DecreaseTooBig());
        // update
        state.largeMintingLimiter.maxMintingPerWindow = newThresholdAmg;
        state.largeMintingLimiter.windowSizeSeconds = _largeMintingDelaySeconds.toUint64();
        emit IAssetManagerEvents.SettingChanged("directMintingLargeMintingThresholdUBA", _largeMintingThresholdUBA);
        emit IAssetManagerEvents.SettingChanged("directMintingLargeMintingDelaySeconds", _largeMintingDelaySeconds);
    }

    // getters

    function getMintingTagManager()
        external view
        returns (address)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return address(state.mintingTagManager);
    }

    function getCoreVaultDonationTag()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.coreVaultDonationTag;
    }

    function getSmartAccountManager()
        external view
        returns (address)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return address(state.smartAccountManager);
    }

    function getDirectMintingFeeReceiver()
        external view
        returns (address)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.mintingFeeReceiver;
    }

    function getDirectMintingMinimumFeeUBA()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return Conversion.convertAmgToUBA(state.minimumMintingFeeAmg);
    }

    function getDirectMintingFeeBIPS()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.mintingFeeBIPS;
    }

    function getDirectMintingExecutorFeeShareBIPS()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.executorFeeShareBIPS;
    }

    function getDirectMintingLargeMintingThresholdUBA()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return Conversion.convertAmgToUBA(state.largeMintingThresholdAmg);
    }

    function getDirectMintingLargeMintingDelaySeconds()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.largeMintingLimiter.windowSizeSeconds;
    }

    function getDirectMintingHourlyLimitUBA()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return Conversion.convertAmgToUBA(state.hourlyLimiter.maxMintingPerWindow);
    }

    function getDirectMintingDailyLimitUBA()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return Conversion.convertAmgToUBA(state.dailyLimiter.maxMintingPerWindow);
    }

    // limiter state

    function getDirectMintingsUnblockUntilTimestamp()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.unblockMintingsUntilTimestamp;
    }

    function getDirectMintingDailyLimiterState()
        external view
        returns (uint64 _windowStartTimestamp, uint64 _mintedInCurrentWindow)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        _windowStartTimestamp = state.dailyLimiter.windowStartTimestamp;
        _mintedInCurrentWindow = state.dailyLimiter.mintedInCurrentWindow;
    }

    function getDirectMintingHourlyLimiterState()
        external view
        returns (uint64 _windowStartTimestamp, uint64 _mintedInCurrentWindow)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        _windowStartTimestamp = state.hourlyLimiter.windowStartTimestamp;
        _mintedInCurrentWindow = state.hourlyLimiter.mintedInCurrentWindow;
    }

    // helpers

    function _underlyingAssetFtsoSymbol()
        internal view
        returns (string memory)
    {
        CollateralTypeInt.Data storage poolCollateral = Globals.getPoolCollateral();
        // pool collateral must not use direct price pair for this to work
        // (it never makes sense anyway, as direct price pairs are only for stablecoins)
        require(!poolCollateral.directPricePair, InvalidPoolCollateralSetting());
        return poolCollateral.assetFtsoSymbol;
    }

    function _usd5InAssetAmg(uint256 _amountUSD5)
        internal view
        returns (uint256)
    {
        uint8 assetMintingDecimals = Globals.getSettings().assetMintingDecimals;
        return Conversion.convertFromUSD5(_amountUSD5, _underlyingAssetFtsoSymbol(), assetMintingDecimals);
    }
}
