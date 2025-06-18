// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {LibDiamond} from "../../diamond/library/LibDiamond.sol";
import {GovernedProxyImplementation} from "../../governance/implementation/GovernedProxyImplementation.sol";
import {CoreVault} from "../library/CoreVault.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {ICoreVaultSettings} from "../../userInterfaces/ICoreVaultSettings.sol";
import {IICoreVaultManager} from "../../coreVaultManager/interfaces/IICoreVaultManager.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {IAssetManager} from "../../userInterfaces/IAssetManager.sol";
import {ICoreVault} from "../../userInterfaces/ICoreVault.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";


contract CoreVaultSettingsFacet is AssetManagerBase, GovernedProxyImplementation, ICoreVaultSettings {
    using SafeCast for uint256;

    // prevent initialization of implementation contract
    constructor() {
        CoreVault.getState().initialized = true;
    }

    function initCoreVaultFacet(
        IICoreVaultManager _coreVaultManager,
        address payable _nativeAddress,
        uint256 _transferTimeExtensionSeconds,
        uint256 _redemptionFeeBIPS,
        uint256 _minimumAmountLeftBIPS,
        uint256 _minimumRedeemLots
    )
        external
    {
        updateInterfacesAtCoreVaultDeploy();
        // init settings
        require(_redemptionFeeBIPS <= SafePct.MAX_BIPS, "bips value too high");
        require(_minimumAmountLeftBIPS <= SafePct.MAX_BIPS, "bips value too high");
        CoreVault.State storage state = CoreVault.getState();
        require(!state.initialized, "already initialized");
        state.initialized = true;
        state.coreVaultManager = _coreVaultManager;
        state.nativeAddress = _nativeAddress;
        state.transferTimeExtensionSeconds = _transferTimeExtensionSeconds.toUint64();
        state.redemptionFeeBIPS = _redemptionFeeBIPS.toUint16();
        state.minimumAmountLeftBIPS = _minimumAmountLeftBIPS.toUint16();
        state.minimumRedeemLots = _minimumRedeemLots.toUint64();
    }

    function updateInterfacesAtCoreVaultDeploy()
        public
    {
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        require(ds.supportedInterfaces[type(IERC165).interfaceId], "diamond not initialized");
        // IAssetManager has new methods (at CoreVault deploy on Songbird)
        ds.supportedInterfaces[type(IAssetManager).interfaceId] = true;
        // Core Vault interfaces added
        ds.supportedInterfaces[type(ICoreVault).interfaceId] = true;
        ds.supportedInterfaces[type(ICoreVaultSettings).interfaceId] = true;
    }

    ///////////////////////////////////////////////////////////////////////////////////
    // Settings

    function setCoreVaultManager(
        address _coreVaultManager
    )
        external
        onlyGovernance
    {
        // core vault cannot be disabled once it has been enabled (it can be disabled initially
        // in initCoreVaultFacet method, for chains where core vault is not supported)
        require(_coreVaultManager != address(0), "cannot disable");
        IICoreVaultManager coreVaultManager = IICoreVaultManager(_coreVaultManager);
        require(coreVaultManager.assetManager() == address(this), "wrong asset manager");
        CoreVault.State storage state = CoreVault.getState();
        state.coreVaultManager = coreVaultManager;
        emit IAssetManagerEvents.ContractChanged("coreVaultManager", _coreVaultManager);
    }

    function setCoreVaultNativeAddress(
        address payable _nativeAddress
    )
        external
        onlyImmediateGovernance
    {
        CoreVault.State storage state = CoreVault.getState();
        state.nativeAddress = _nativeAddress;
        // not really a contract, but works for any address - event name is a bit unfortunate
        // but we don't want to change it now to keep backward compatibility
        emit IAssetManagerEvents.ContractChanged("coreVaultNativeAddress", _nativeAddress);
    }

    function setCoreVaultTransferTimeExtensionSeconds(
        uint256 _transferTimeExtensionSeconds
    )
        external
        onlyImmediateGovernance
    {
        CoreVault.State storage state = CoreVault.getState();
        state.transferTimeExtensionSeconds = _transferTimeExtensionSeconds.toUint64();
        emit IAssetManagerEvents.SettingChanged("coreVaultTransferTimeExtensionSeconds",
            _transferTimeExtensionSeconds);
    }

    function setCoreVaultRedemptionFeeBIPS(
        uint256 _redemptionFeeBIPS
    )
        external
        onlyImmediateGovernance
    {
        require(_redemptionFeeBIPS <= SafePct.MAX_BIPS, "bips value too high");
        CoreVault.State storage state = CoreVault.getState();
        state.redemptionFeeBIPS = _redemptionFeeBIPS.toUint16();
        emit IAssetManagerEvents.SettingChanged("coreVaultRedemptionFeeBIPS", _redemptionFeeBIPS);
    }

    function setCoreVaultMinimumAmountLeftBIPS(
        uint256 _minimumAmountLeftBIPS
    )
        external
        onlyImmediateGovernance
    {
        require(_minimumAmountLeftBIPS <= SafePct.MAX_BIPS, "bips value too high");
        CoreVault.State storage state = CoreVault.getState();
        state.minimumAmountLeftBIPS = _minimumAmountLeftBIPS.toUint16();
        emit IAssetManagerEvents.SettingChanged("coreVaultMinimumAmountLeftBIPS", _minimumAmountLeftBIPS);
    }

    function setCoreVaultMinimumRedeemLots(
        uint256 _minimumRedeemLots
    )
        external
        onlyImmediateGovernance
    {
        CoreVault.State storage state = CoreVault.getState();
        state.minimumRedeemLots = _minimumRedeemLots.toUint64();
        emit IAssetManagerEvents.SettingChanged("coreVaultMinimumRedeemLots", _minimumRedeemLots);
    }

    function getCoreVaultManager()
        external view
        returns (address)
    {
        CoreVault.State storage state = CoreVault.getState();
        return address(state.coreVaultManager);
    }

    function getCoreVaultNativeAddress()
        external view
        returns (address)
    {
        CoreVault.State storage state = CoreVault.getState();
        return state.nativeAddress;
    }

    function getCoreVaultTransferTimeExtensionSeconds()
        external view
        returns (uint256)
    {
        CoreVault.State storage state = CoreVault.getState();
        return state.transferTimeExtensionSeconds;
    }

    function getCoreVaultRedemptionFeeBIPS()
        external view
        returns (uint256)
    {
        CoreVault.State storage state = CoreVault.getState();
        return state.redemptionFeeBIPS;
    }

    function getCoreVaultMinimumAmountLeftBIPS()
        external view
        returns (uint256)
    {
        CoreVault.State storage state = CoreVault.getState();
        return state.minimumAmountLeftBIPS;
    }

    function getCoreVaultMinimumRedeemLots()
        external view
        returns (uint256)
    {
        CoreVault.State storage state = CoreVault.getState();
        return state.minimumRedeemLots;
    }
}
