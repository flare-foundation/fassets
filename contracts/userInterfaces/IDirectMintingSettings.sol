// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import {IForbiddenAddressList} from "../flareSmartContracts/interfaces/IForbiddenAddressList.sol";


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

    function setMintingTagManager(address _mintingTagManager)
        external;

    function setSmartAccountManager(address _smartAccountManager)
        external;

    /**
     * Set the forbidden address list: fsc-v2's `ForbiddenAddressList`. The asset manager checks both ends of every
     * bridge crossing against it. Underlying addresses are looked up by hash in the string list of its own chain's
     * source (`AssetManagerSettings.chainId`, an FDC source id such as `XRP` or `testXRP`) - the source of an FDC
     * payment (direct minting, agent minting, self-mint, top-up, core vault donation), a redeemer's address; an
     * address listed only under another source does not block it. Flare addresses - the minter of an agent minting,
     * the executor of a direct minting and its recipient (a minting to a smart account has none), the redeemer of a
     * redemption or a core vault redemption, a collateral pool self-close exit's LP and recipient - are looked up on
     * the list's one EVM list (`isForbiddenEvmAddress`), which covers every EVM chain. The agents' own addresses are
     * not checked: agents are vetted by governance. The list's maintainers (compliance multisigs) and its governance
     * (without timelock) add addresses at any time; only its governance removes them, with timelock. The list is
     * read with a static call, so a list that reverts stops every flow that checks it until it is replaced - and
     * the list reverts every lookup under a source it holds no string list for (`UnsupportedSourceId`): `chainId`
     * must be a BTC or XRP source id of the list's kind of network (a mainnet id on a Mainnet list, a `test`
     * id on a Testnet one, either on a Local one), or every flow that checks an underlying address reverts. The list
     * cannot be unset (`AddressZero`).
     * NOTE: only governance can call this function (with timelock); rate-limited.
     */
    function setForbiddenAddressList(IForbiddenAddressList _forbiddenAddressList)
        external;

    function setDirectMintingFeeReceiver(address _mintingFeeReceiver)
        external;

    function setDirectMintingFee(uint256 _mintingFeeBIPS, uint256 _minimumMintingFeeUBA)
        external;

    function setDirectMintingExecutorFee(uint256 _executorFeeUBA)
        external;

    function setDirectMintingHourlyLimitUBA(uint256 _hourlyLimitUBA)
        external;

    function setDirectMintingDailyLimitUBA(uint256 _dailyLimitUBA)
        external;

    function setDirectMintingOthersCanExecuteAfterSeconds(uint256 _seconds)
        external;

    function setDirectMintingLargeMintingThrottling(
        uint256 _largeMintingThresholdUBA,
        uint256 _largeMintingDelaySeconds
    ) external;

    // getters

    function getMintingTagManager()
        external view
        returns (address);

    function getSmartAccountManager()
        external view
        returns (address);

    /**
     * The forbidden address list (see `setForbiddenAddressList`); zero while none is set.
     */
    function getForbiddenAddressList()
        external view
        returns (IForbiddenAddressList);

    function getDirectMintingFeeReceiver()
        external view
        returns (address);

    function getDirectMintingMinimumFeeUBA()
        external view
        returns (uint256);

    function getDirectMintingFeeBIPS()
        external view
        returns (uint256);

    function getDirectMintingExecutorFeeUBA()
        external view
        returns (uint256);

    function getDirectMintingOthersCanExecuteAfterSeconds()
        external view
        returns (uint256);

    function getDirectMintingLargeMintingThresholdUBA()
        external view
        returns (uint256);

    function getDirectMintingLargeMintingDelaySeconds()
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
