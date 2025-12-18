// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Agents} from "../library/Agents.sol";
import {Globals} from "../library/Globals.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {EmergencyPause} from "../../userInterfaces/data/EmergencyPause.sol";
import {EffectiveEmergencyPause} from "../library/EffectiveEmergencyPause.sol";
import {IGoverned} from "../../governance/interfaces/IGoverned.sol";


abstract contract AssetManagerBase {
    error OnlyAssetManagerController();
    error NotAttached();
    error EmergencyPauseActive();
    error OnlyImmediateGovernanceOrExecutor();

    modifier onlyAssetManagerController {
        _checkOnlyAssetManagerController();
        _;
    }

    modifier onlyAttached {
        _checkOnlyAttached();
        _;
    }

    modifier notEmergencyPaused {
        _checkEmergencyPauseNotActive(EmergencyPause.Level.START_OPERATIONS);
        _;
    }

    modifier notFullyEmergencyPaused {
        _checkEmergencyPauseNotActive(EmergencyPause.Level.FULL);
        _;
    }

    // require the caller to be the owner of _agentVault and it has to be active (not destroyed)
    modifier onlyActiveAgentVaultOwner(address _agentVault) {
        Agents.requireActiveAgentVaultOwner(_agentVault);
        _;
    }

    modifier onlyImmediateGovernanceOrExecutor() {
        _checkOnlyImmediateGovernanceOrExecutor();
        _;
    }

    function _checkOnlyAssetManagerController() private view {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        require(msg.sender == settings.assetManagerController, OnlyAssetManagerController());
    }

    function _checkOnlyAttached() private view {
        require(AssetManagerState.get().attached, NotAttached());
    }

    function _checkEmergencyPauseNotActive(EmergencyPause.Level _leastLevel) private view {
        bool paused = EffectiveEmergencyPause.level() >= _leastLevel;
        require(!paused, EmergencyPauseActive());
    }

    function _checkOnlyImmediateGovernanceOrExecutor() private view{
        require(_isGovernanceOrExecutor(msg.sender), OnlyImmediateGovernanceOrExecutor());
    }

    function _isGovernanceOrExecutor(address _address) internal view returns (bool) {
        IGoverned thisGoverned = IGoverned(address(this));
        return _address == thisGoverned.governance() || thisGoverned.isExecutor(_address);
    }
}
