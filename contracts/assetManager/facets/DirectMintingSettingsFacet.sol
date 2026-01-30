// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IFAssetMintingTag} from "../../userInterfaces/IFAssetMintingTag.sol";
import {ISmartAccountManagerMock} from "../mock/ISmartAccountManagerMock.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Conversion} from "../library/Conversion.sol";
import {DirectMinting} from "../library/DirectMinting.sol";
import {MintingRateLimiter} from "../library/data/MintingRateLimiter.sol";
import {GovernedProxyImplementation} from "../../governance/implementation/GovernedProxyImplementation.sol";


contract DirectMintingSettingsFacet is AssetManagerBase, GovernedProxyImplementation {
    using SafePct for uint256;
    using SafeCast for uint256;
    using MintingRateLimiter for MintingRateLimiter.State;

    error AlreadyInitialized();
    error AddressZero();
    error TimestampMustBeInThePast();

    struct InitParams {
        address mintingTags;
        uint256 coreVaultDonationTag;
        address smartAccountManager;
        address mintingFeeReceiver;
        uint256 minimumMintingFeeUBA;
        uint256 mintingFeeBIPS;
        uint256 executorFeeBIPS;
        uint256 hourlyLimitUBA;
        uint256 dailyLimitUBA;
        uint256 largeMintingThresholdUBA;
        uint256 largeMintingDelaySeconds;
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
        require(_params.mintingTags != address(0), AddressZero());
        require(_params.smartAccountManager != address(0), AddressZero());
        state.mintingTags = IFAssetMintingTag(_params.mintingTags);
        state.coreVaultDonationTag = _params.coreVaultDonationTag.toUint32();
        state.smartAccountManager = ISmartAccountManagerMock(_params.smartAccountManager);
        state.mintingFeeReceiver = _params.mintingFeeReceiver;
        state.minimumMintingFeeAmg = Conversion.convertUBAToAmg(_params.minimumMintingFeeUBA);
        state.mintingFeeBIPS = _params.mintingFeeBIPS.toUint16();
        state.executorFeeBIPS = _params.executorFeeBIPS.toUint16();
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
        require(_timestamp < block.timestamp, TimestampMustBeInThePast());
        state.unblockMintingsUntilTimestamp =
            Math.max(state.unblockMintingsUntilTimestamp, _timestamp).toUint64();
    }

    // setters

    function setDirectMintingTagsToken(address _mintingTags)
        external
        onlyGovernance
    {
        require(_mintingTags != address(0), AddressZero());
        DirectMinting.State storage state = DirectMinting.getState();
        state.mintingTags = IFAssetMintingTag(_mintingTags);
    }

    function setCoreVaultDonationTag(uint256 _coreVaultDonationTag)
        external
        onlyGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.coreVaultDonationTag = _coreVaultDonationTag.toUint32();
    }

    function setSmartAccountManager(address _smartAccountManager)
        external
        onlyGovernance
    {
        require(_smartAccountManager != address(0), AddressZero());
        DirectMinting.State storage state = DirectMinting.getState();
        state.smartAccountManager = ISmartAccountManagerMock(_smartAccountManager);
    }

    function setDirectMintingFeeReceiver(address _mintingFeeReceiver)
        external
        onlyGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.mintingFeeReceiver = _mintingFeeReceiver;
    }

    function setDirectMintingFee(
        uint256 _mintingFeeBIPS,
        uint256 _minimumMintingFeeUBA
    )
        external
        onlyGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.mintingFeeBIPS = _mintingFeeBIPS.toUint16();
        state.minimumMintingFeeAmg = Conversion.convertUBAToAmg(_minimumMintingFeeUBA);
    }

    function setDirectMintingExecutorFeeBIPS(uint256 _executorFeeBIPS)
        external
        onlyGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.executorFeeBIPS = _executorFeeBIPS.toUint16();
    }

    function setDirectMintingHourlyLimitUBA(uint256 _hourlyLimitUBA)
        external
        onlyGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.hourlyLimiter.maxMintingPerWindow = Conversion.convertUBAToAmg(_hourlyLimitUBA);
    }

    function setDirectMintingDailyLimitUBA(uint256 _dailyLimitUBA)
        external
        onlyGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        state.dailyLimiter.maxMintingPerWindow = Conversion.convertUBAToAmg(_dailyLimitUBA);
    }

    function setDirectMintingLargeMintingThrottling(
        uint256 _largeMintingThresholdUBA,
        uint256 _largeMintingDelaySeconds
    )
        external
        onlyGovernance
    {
        DirectMinting.State storage state = DirectMinting.getState();
        uint64 largeMintingThresholdAmg = Conversion.convertUBAToAmg(_largeMintingThresholdUBA);
        state.largeMintingThresholdAmg = largeMintingThresholdAmg;
        state.largeMintingLimiter.maxMintingPerWindow = largeMintingThresholdAmg;
        state.largeMintingLimiter.windowSizeSeconds = uint64(_largeMintingDelaySeconds);
    }

    // getters

    function getDirectMintingTagsToken()
        external view
        returns (address)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return address(state.mintingTags);
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

    function getDirectMintingExecutorFeeBIPS()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return state.executorFeeBIPS;
    }

    function getDirectMintingLargeMintingThresholdUBA()
        external view
        returns (uint256)
    {
        DirectMinting.State storage state = DirectMinting.getState();
        return Conversion.convertAmgToUBA(state.largeMintingThresholdAmg);
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
}
