// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IForbiddenAddressList} from "../../flareSmartContracts/interfaces/IForbiddenAddressList.sol";
import {IAssetManager} from "../../userInterfaces/IAssetManager.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {IDirectMintingSettings} from "../../userInterfaces/IDirectMintingSettings.sol";
import {IRedeemExtendedSettings} from "../../userInterfaces/IRedeemExtendedSettings.sol";
import {IIAssetManager} from "../interfaces/IIAssetManager.sol";
import {LibDiamond} from "../../diamond/library/LibDiamond.sol";
import {DirectMinting} from "../library/DirectMinting.sol";
import {Globals} from "../library/Globals.sol";


/**
 * Diamond cut initializer for the upgrade that adds the forbidden address checks: it can set the forbidden address
 * list in the same (timelocked) diamond cut that adds the checks, so no separate `setForbiddenAddressList` call is
 * needed.
 */
contract ForbiddenAddressesInit {
    error DiamondNotInitialized();

    /**
     * Marks the new ERC165 identifiers of the extended interfaces as supported and, if `_forbiddenAddressList` is
     * nonzero, sets the forbidden address list.
     * The list is probed with both kinds of lookup the asset manager makes, so a wrong address (not a list, or a list
     * holding no string list under this asset manager's `chainId`, which would revert every underlying address
     * check) reverts the cut instead of blocking the minting and redemption flows.
     * @param _forbiddenAddressList fsc-v2's `ForbiddenAddressList`; when zero, the list is left as it is (unset on
     *  the first upgrade - it can be set later with `setForbiddenAddressList`)
     */
    function initialize(IForbiddenAddressList _forbiddenAddressList)
        external
    {
        _upgradeERC165Identifiers();
        if (address(_forbiddenAddressList) == address(0)) return;
        _forbiddenAddressList.isForbiddenHash(Globals.getSettings().chainId, bytes32(0));
        _forbiddenAddressList.isForbiddenEvmAddress(address(0));
        DirectMinting.getState().forbiddenAddressList = _forbiddenAddressList;
        emit IAssetManagerEvents.ContractChanged("forbiddenAddressList", address(_forbiddenAddressList));
    }

    // The new interfaces are backward compatible, so the identifiers of the old versions stay supported.
    function _upgradeERC165Identifiers() private {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        require(ds.supportedInterfaces[type(IERC165).interfaceId], DiamondNotInitialized());
        ds.supportedInterfaces[type(IAssetManager).interfaceId] = true;
        ds.supportedInterfaces[type(IIAssetManager).interfaceId] = true;
        ds.supportedInterfaces[type(IDirectMintingSettings).interfaceId] = true;
        ds.supportedInterfaces[type(IRedeemExtendedSettings).interfaceId] = true;
    }
}
