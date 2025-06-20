// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IWhitelist} from "../../userInterfaces/IWhitelist.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {Globals} from "../library/Globals.sol";
import {Agents} from "../library/Agents.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";


abstract contract AssetManagerBase {
    modifier onlyAssetManagerController {
        _checkOnlyAssetManagerController();
        _;
    }

    modifier onlyAttached {
        _checkOnlyAttached();
        _;
    }

    modifier onlyWhitelistedSender {
        _checkOnlyWhitelistedSender();
        _;
    }

    modifier notEmergencyPaused {
        _checkEmergencyPauseNotActive();
        _;
    }

    modifier onlyAgentVaultOwner(address _agentVault) {
        Agents.requireAgentVaultOwner(_agentVault);
        _;
    }

    function _checkOnlyAssetManagerController() private view {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        require(msg.sender == settings.assetManagerController, "only asset manager controller");
    }

    function _checkOnlyAttached() private view {
        require(AssetManagerState.get().attached, "not attached");
    }

    function _checkOnlyWhitelistedSender() private view {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        if (settings.whitelist != address(0)) {
            require(IWhitelist(settings.whitelist).isWhitelisted(msg.sender), "not whitelisted");
        }
    }

    function _checkEmergencyPauseNotActive() private view {
        AssetManagerState.State storage state = AssetManagerState.get();
        require(state.emergencyPausedUntil <= block.timestamp, "emergency pause active");
    }
}
