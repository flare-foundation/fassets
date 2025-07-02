// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Agents} from "../library/Agents.sol";
import {Globals} from "../library/Globals.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";


abstract contract AssetManagerBase {
    error OnlyAssetManagerController();
    error NotAttached();
    error NotWhitelisted();
    error EmergencyPauseActive();

    modifier onlyAssetManagerController {
        _checkOnlyAssetManagerController();
        _;
    }

    modifier onlyAttached {
        _checkOnlyAttached();
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
        require(msg.sender == settings.assetManagerController, OnlyAssetManagerController());
    }

    function _checkOnlyAttached() private view {
        require(AssetManagerState.get().attached, NotAttached());
    }

    function _checkEmergencyPauseNotActive() private view {
        AssetManagerState.State storage state = AssetManagerState.get();
        require(state.emergencyPausedUntil <= block.timestamp, EmergencyPauseActive());
    }
}