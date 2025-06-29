// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;
pragma abicoder v2;

import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "../../userInterfaces/IAssetManagerController.sol";
import "../../governance/interfaces/IAddressUpdatable.sol";
import "../../utils/interfaces/IUUPSUpgradeable.sol";
import "./IIAssetManager.sol";


interface IIAssetManagerController is
    IERC165,
    IAssetManagerController,
    IGoverned,
    IAddressUpdatable,
    IUUPSUpgradeable
{
    /**
     * New address in case this controller was replaced.
     * Note: this code contains no checks that replacedBy==0, because when replaced,
     * all calls to AssetManager's updateSettings/pause/terminate will fail anyway
     * since they will arrive from wrong controller address.
     */
    function replacedBy() external view returns (address);

    ///////////////////////////////////////////////////////////////////////////////////////////////
    // Manage list of asset managers

    /**
     * Add an asset manager to this controller. The asset manager controller address in the settings of the
     * asset manager must match this. This method automatically marks the asset manager as attached.
     */
    function addAssetManager(IIAssetManager _assetManager)
        external;

    /**
     * Remove an asset manager from this controller, if it is attached to this controller.
     * The asset manager won't be attached any more, so it will be unusable.
     */
    function removeAssetManager(IIAssetManager _assetManager)
        external;

    ///////////////////////////////////////////////////////////////////////////////////////////////
    // Setters

    function setWhitelist(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function setAgentOwnerRegistry(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function setAgentVaultFactory(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function setCollateralPoolFactory(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function setCollateralPoolTokenFactory(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function upgradeAgentVaultsAndPools(IIAssetManager[] memory _assetManagers, uint256 _start, uint256 _end)
        external;

    function setPriceReader(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function setFdcVerification(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function setCleanerContract(IIAssetManager[] memory _assetManagers, address _value)
        external;

    function setCleanupBlockNumberManager(IIAssetManager[] memory _assetManagers, address _value)
        external;

    // if callData is not empty, it is abi encoded call to init function in the new proxy implementation
    function upgradeFAssetImplementation(
        IIAssetManager[] memory _assetManagers,
        address _implementation,
        bytes memory _callData
    ) external;

    function setMinUpdateRepeatTimeSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setLotSizeAmg(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setMinUnderlyingBackingBips(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setTimeForPayment(
        IIAssetManager[] memory _assetManagers,
        uint256 _underlyingBlocks,
        uint256 _underlyingSeconds
    ) external;

    function setPaymentChallengeReward(
        IIAssetManager[] memory _assetManagers,
        uint256 _rewardVaultCollateralWei,
        uint256 _rewardBIPS
    ) external;

    function setMaxTrustedPriceAgeSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setCollateralReservationFeeBips(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setRedemptionFeeBips(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setRedemptionDefaultFactorBips(IIAssetManager[] memory _assetManagers, uint256 _vaultF, uint256 _poolF)
        external;

    function setConfirmationByOthersAfterSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setConfirmationByOthersRewardUSD5(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setMaxRedeemedTickets(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setWithdrawalOrDestroyWaitMinSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setCcbTimeSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setAttestationWindowSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setAverageBlockTimeMS(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setAnnouncedUnderlyingConfirmationMinSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setMintingPoolHoldingsRequiredBIPS(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setMintingCapAmg(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setTokenInvalidationTimeMinSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setVaultCollateralBuyForFlareFactorBIPS(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setAgentExitAvailableTimelockSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setAgentFeeChangeTimelockSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setAgentMintingCRChangeTimelockSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setPoolExitAndTopupChangeTimelockSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setAgentTimelockedOperationWindowSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setCollateralPoolTokenTimelockSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setLiquidationStepSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setLiquidationPaymentFactors(
        IIAssetManager[] memory _assetManagers,
        uint256[] memory _paymentFactors,
        uint256[] memory _vaultCollateralFactors
    ) external;

    function setCancelCollateralReservationAfterSeconds(
        IIAssetManager[] memory _assetManagers,
        uint256 _value
    ) external;

    function setRejectOrCancelCollateralReservationReturnFactorBIPS(
        IIAssetManager[] memory _assetManagers,
        uint256 _value
    ) external;

    function setRejectRedemptionRequestWindowSeconds(
        IIAssetManager[] memory _assetManagers,
        uint256 _value
    ) external;

    function setTakeOverRedemptionRequestWindowSeconds(
        IIAssetManager[] memory _assetManagers,
        uint256 _value
    ) external;

    function setRejectedRedemptionDefaultFactorBips(
        IIAssetManager[] memory _assetManagers,
        uint256 _vaultF,
        uint256 _poolF
    ) external;

    function setRedemptionPaymentExtensionSeconds(
        IIAssetManager[] memory _assetManagers,
        uint256 _value
    ) external;

    function setTransferFeeMillionths(
        IIAssetManager[] memory _assetManagers,
        uint256 _value,
        uint256 _scheduledAt
    ) external;

    ///////////////////////////////////////////////////////////////////////////////////////////////
    // Collateral tokens

    function addCollateralType(
        IIAssetManager[] memory _assetManagers,
        CollateralType.Data calldata _data
    ) external;

    function setCollateralRatiosForToken(
        IIAssetManager[] memory _assetManagers,
        CollateralType.Class _class,
        IERC20 _token,
        uint256 _minCollateralRatioBIPS,
        uint256 _ccbMinCollateralRatioBIPS,
        uint256 _safetyMinCollateralRatioBIPS
    ) external;

    function deprecateCollateralType(
        IIAssetManager[] memory _assetManagers,
        CollateralType.Class _class,
        IERC20 _token,
        uint256 _invalidationTimeSec
    ) external;

    ///////////////////////////////////////////////////////////////////////////////////////////////
    // Upgrade (second phase)

    /**
     * When asset manager is paused, no new minting can be made.
     * All other operations continue normally.
     */
    function pauseMinting(IIAssetManager[] calldata _assetManagers)
        external;

    /**
     * If f-asset was not terminated yet, minting can continue.
     */
    function unpauseMinting(IIAssetManager[] calldata _assetManagers)
        external;

    /**
     * When f-asset is terminated, no transfers can be made anymore.
     * This is an extreme measure to be used only when the asset manager minting has been already paused
     * for a long time but there still exist unredeemable f-assets. In such case, the f-asset contract is
     * terminated and then agents can buy back the collateral at market rate (i.e. they burn market value
     * of backed f-assets in collateral to release the rest of the collateral).
     */
    function terminate(IIAssetManager[] calldata _assetManagers)
        external;

    ///////////////////////////////////////////////////////////////////////////////////////////////
    // Update contracts

    /**
     * Can be called to update address updater managed contracts if there are too many asset managers
     * to update in one block. In such a case, running AddressUpdater.updateContractAddresses will fail
     * and there will be no way to update contracts. This method allow the update to only change some
     * of the asset managers.
     */
    function updateContracts(IIAssetManager[] calldata _assetManagers)
        external;

    ///////////////////////////////////////////////////////////////////////////////////////////////
    // Emergency pause

    function emergencyPause(IIAssetManager[] memory _assetManagers, uint256 _duration)
        external;

    function emergencyPauseTransfers(IIAssetManager[] memory _assetManagers, uint256 _duration)
        external;

    function resetEmergencyPauseTotalDuration(IIAssetManager[] memory _assetManagers)
        external;

    function addEmergencyPauseSender(address _address)
        external;

    function removeEmergencyPauseSender(address _address)
        external;

    function setMaxEmergencyPauseDurationSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;

    function setEmergencyPauseDurationResetAfterSeconds(IIAssetManager[] memory _assetManagers, uint256 _value)
        external;
}
