// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {Globals} from "../library/Globals.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {EmergencyPause} from "../../userInterfaces/data/EmergencyPause.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";


contract EmergencyPauseFacet is AssetManagerBase, IAssetManagerEvents {
    using SafeCast for uint256;

    error PausedByGovernance();

    function emergencyPause(EmergencyPause.Level _level, bool _byGovernance, uint256 _duration)
        external
        onlyAssetManagerController
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        bool pausedAtStart = _paused();
        // when governance started pause, 3rd party triggers are limited to increasing the pause
        if (pausedAtStart && state.emergencyPausedByGovernance && !_byGovernance) {
            // 3rd party can only increase pause level and should not end pause
            require(_level >= state.emergencyPauseLevel && _duration > 0, PausedByGovernance());
            // If the 3rd party pause would end sooner than governance's, ignore the new duration.
            // In this case we don't revert but rather update duration, because we expect
            // emergency pause trigger bots to set fixed duration and we don't want to block them.
            _duration = Math.max(_duration, state.emergencyPausedUntil - block.timestamp);
        }
        // reset total pause duration if enough time elapsed since the last pause ended
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        if (state.emergencyPausedUntil + settings.emergencyPauseDurationResetAfterSeconds <= block.timestamp) {
            state.emergencyPausedTotalDuration = 0;
        }
        // if _level is NONE, set duration to 0 to immediately end pause and not waste the total allowed duration
        if (_level == EmergencyPause.Level.NONE) {
            _duration = 0;
        }
        // limit total pause duration to settings.maxEmergencyPauseDurationSeconds
        (uint256 endTime, uint256 totalDuration) = _calcPauseEndTime(_duration);
        state.emergencyPausedUntil = endTime.toUint64();
        state.emergencyPausedTotalDuration = totalDuration.toUint64();
        state.emergencyPauseLevel = _level;
        state.emergencyPausedByGovernance = _byGovernance || (pausedAtStart && state.emergencyPausedByGovernance);
        // emit event
        if (_paused()) {
            emit EmergencyPauseTriggered(_level, state.emergencyPausedUntil);
        } else if (pausedAtStart) {
            emit EmergencyPauseCanceled();
        }
    }

    function emergencyPaused()
        external view
        returns (bool)
    {
        return _paused();
    }

    function emergencyPauseLevel()
        external view
        returns (EmergencyPause.Level)
    {
        return _pauseLevel();
    }

    function emergencyPausedUntil()
        external view
        returns (uint256)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return _paused() ? state.emergencyPausedUntil : 0;
    }

    function emergencyPauseDetails()
        external view
        returns (
            EmergencyPause.Level _level,
            uint256 _pausedUntil,
            uint256 _totalPauseDuration,
            bool _pausedByGovernance
        )
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return (_pauseLevel(), state.emergencyPausedUntil,
            state.emergencyPausedTotalDuration, state.emergencyPausedByGovernance);
    }

    function _paused() private view returns (bool) {
        return _pauseLevel() != EmergencyPause.Level.NONE;
    }

    function _pauseLevel() private view returns (EmergencyPause.Level) {
        AssetManagerState.State storage state = AssetManagerState.get();
        return state.emergencyPausedUntil > block.timestamp ? state.emergencyPauseLevel : EmergencyPause.Level.NONE;
    }

    function _calcPauseEndTime(uint256 _duration) private view returns (uint256 _endTime, uint256 _totalDuration) {
        AssetManagerState.State storage state = AssetManagerState.get();
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        uint256 currentPauseEndTime = Math.max(state.emergencyPausedUntil, block.timestamp);
        uint256 projectedStartTime =
            Math.min(currentPauseEndTime - state.emergencyPausedTotalDuration, block.timestamp);
        uint256 maxEndTime = projectedStartTime + settings.maxEmergencyPauseDurationSeconds;
        _endTime = Math.min(block.timestamp + _duration, maxEndTime);
        _totalDuration = _endTime - projectedStartTime;
    }
}