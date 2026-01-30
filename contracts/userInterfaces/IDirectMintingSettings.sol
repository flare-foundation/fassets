// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


/**
 * Direct minting settings interface.
 */
interface IDirectMintingSettings {
    /**
     * Unblocks direct mintings until the given timestamp.
     * NOTE: only governance can call this function.
     * @param _timestamp the timestamp until which direct mintings are unblocked
     */
    function unblockDirectMintingsUntil(uint256 _timestamp)
        external;

    // setters

    function setDirectMintingTagsToken(address _mintingTags)
        external;

    function setCoreVaultDonationTag(uint256 _coreVaultDonationTag)
        external;

    function setSmartAccountManager(address _smartAccountManager)
        external;

    function setDirectMintingFeeReceiver(address _mintingFeeReceiver)
        external;

    function setDirectMintingFee(uint256 _mintingFeeBIPS, uint256 _minimumMintingFeeUBA)
        external;

    function setDirectMintingExecutorFeeBIPS(uint256 _executorFeeBIPS)
        external;

    function setDirectMintingHourlyLimitUBA(uint256 _hourlyLimitUBA)
        external;

    function setDirectMintingDailyLimitUBA(uint256 _dailyLimitUBA)
        external;

    function setDirectMintingLargeMintingThrottling(
        uint256 _largeMintingThresholdUBA,
        uint256 _largeMintingDelaySeconds
    ) external;

    // getters

    function getDirectMintingTagsToken()
        external view
        returns (address);

    function getCoreVaultDonationTag()
        external view
        returns (uint256);

    function getSmartAccountManager()
        external view
        returns (address);

    function getDirectMintingFeeReceiver()
        external view
        returns (address);

    function getDirectMintingMinimumFeeUBA()
        external view
        returns (uint256);

    function getDirectMintingFeeBIPS()
        external view
        returns (uint256);

    function getDirectMintingExecutorFeeBIPS()
        external view
        returns (uint256);

    function getDirectMintingLargeMintingThresholdUBA()
        external view
        returns (uint256);

    function getDirectMintingHourlyLimitUBA()
        external view
        returns (uint256);

    function getDirectMintingDailyLimitUBA()
        external view
        returns (uint256);

    function getDirectMintingsUnblockUntilTimestamp()
        external view
        returns (uint256);

    function getDirectMintingDailyLimiterState()
        external view
        returns (uint64 _windowStartTimestamp, uint64 _mintedInCurrentWindow);

    function getDirectMintingHourlyLimiterState()
        external view
        returns (uint64 _windowStartTimestamp, uint64 _mintedInCurrentWindow);
}
