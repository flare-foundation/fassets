// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {AssetManagerBase} from "./AssetManagerBase.sol";
import {Globals} from "../library/Globals.sol";
import {AssetManagerState} from "../library/data/AssetManagerState.sol";
import {EmergencyPause} from "../../userInterfaces/data/EmergencyPause.sol";
import {EffectiveEmergencyPause} from "../library/EffectiveEmergencyPause.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";


contract EmergencyPauseFacet is AssetManagerBase, IAssetManagerEvents {
    using SafeCast for uint256;

    error InconsistentLevelAndDuration();
    error NotAuthorizedToPause();
    error NotAuthorizedToUnpause();

    function emergencyPause(EmergencyPause.Level _level, uint256 _permissions, uint256 _duration)
        external
        onlyAssetManagerController
    {
        // either _level=NONE or _duration=0 cancels pause - require that either both cancel pause or neither
        require((_level == EmergencyPause.Level.NONE) == (_duration == 0), InconsistentLevelAndDuration());
        if (_permissions & EmergencyPause.GOVERNANCE != 0) {
            _governanceEmergencyPause(_level, _duration);
        } else {
            _checkExternalPausePermission(_level, _permissions, _duration);
            _externalEmergencyPause(_level, _duration);
        }
    }

    function resetEmergencyPauseTotalDuration()
        external
        onlyAssetManagerController
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        if (state.emergencyPausedTotalDuration != 0) {
            state.emergencyPausedTotalDuration = 0;
            emit EmergencyPauseTotalDurationReset();
        }
    }

    function emergencyPaused()
        external view
        returns (bool)
    {
        return EffectiveEmergencyPause.level() != EmergencyPause.Level.NONE;
    }

    function emergencyPauseLevel()
        external view
        returns (EmergencyPause.Level)
    {
        return EffectiveEmergencyPause.level();
    }

    function emergencyPausedUntil()
        external view
        returns (uint256)
    {
        return Math.max(EffectiveEmergencyPause.externalEndTime(), EffectiveEmergencyPause.governanceEndTime());
    }

    function emergencyPauseDetails()
        external view
        returns (
            EmergencyPause.Level _level,
            uint256 _pausedUntil,
            uint256 _totalPauseDuration,
            EmergencyPause.Level _governanceLevel,
            uint256 _governancePausedUntil
        )
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        return (EffectiveEmergencyPause.externalLevel(),
            state.emergencyPausedUntil,
            state.emergencyPausedTotalDuration,
            EffectiveEmergencyPause.governanceLevel(),
            state.governanceEmergencyPausedUntil);
    }

    function _governanceEmergencyPause(EmergencyPause.Level _level, uint256 _duration) private {
        AssetManagerState.State storage state = AssetManagerState.get();
        uint256 endTime = block.timestamp + _duration;
        state.governanceEmergencyPausedUntil = endTime.toUint64();
        state.governanceEmergencyPauseLevel = _level;
        _emitPauseEvent();
    }

    function _externalEmergencyPause(EmergencyPause.Level _level, uint256 _duration) private {
        AssetManagerState.State storage state = AssetManagerState.get();
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        // reset total pause duration if enough time elapsed since the last pause ended
        if (state.emergencyPausedUntil + settings.emergencyPauseDurationResetAfterSeconds <= block.timestamp) {
            state.emergencyPausedTotalDuration = 0;
        }
        // limit total pause duration to settings.maxEmergencyPauseDurationSeconds
        (uint256 endTime, uint256 totalDuration) = _calculateExternalPauseEndTime(_duration);
        state.emergencyPausedUntil = endTime.toUint64();
        state.emergencyPausedTotalDuration = totalDuration.toUint64();
        state.emergencyPauseLevel = _level;
        _emitPauseEvent();
    }

    function _checkExternalPausePermission(EmergencyPause.Level _level, uint256 _permissions, uint256 _duration)
        private view
    {
        // Level and duration are independent axes: PAUSE is required to raise either, UNPAUSE to lower either.
        // A call that raises one axis and lowers the other (e.g. raises level but shortens duration) needs both.
        EmergencyPause.Level currentLevel = EffectiveEmergencyPause.externalLevel();
        // When no pause is active, externalEndTime() returns 0; normalize to block.timestamp so the comparison
        // reflects remaining pause duration rather than the stale stored value.
        uint256 currentEndTime = Math.max(EffectiveEmergencyPause.externalEndTime(), block.timestamp);
        uint256 newEndTime = block.timestamp + _duration;
        bool needPause = _level > currentLevel || newEndTime > currentEndTime;
        bool needUnpause = _level < currentLevel || newEndTime < currentEndTime;
        if (needPause) {
            require(_permissions & EmergencyPause.PAUSE != 0, NotAuthorizedToPause());
        }
        if (needUnpause) {
            require(_permissions & EmergencyPause.UNPAUSE != 0, NotAuthorizedToUnpause());
        }
    }

    function _emitPauseEvent() private {
        EmergencyPause.Level externalLevel = EffectiveEmergencyPause.externalLevel();
        EmergencyPause.Level governanceLevel = EffectiveEmergencyPause.governanceLevel();
        if (externalLevel != EmergencyPause.Level.NONE || governanceLevel != EmergencyPause.Level.NONE) {
            emit EmergencyPauseTriggered(externalLevel, EffectiveEmergencyPause.externalEndTime(),
                governanceLevel, EffectiveEmergencyPause.governanceEndTime());
        } else {
            emit EmergencyPauseCanceled();
        }
    }

    function _calculateExternalPauseEndTime(uint256 _duration)
        private view
        returns (uint256 _endTime, uint256 _totalDuration)
    {
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
