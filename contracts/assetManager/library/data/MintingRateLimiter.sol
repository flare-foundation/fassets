// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {MathUtils} from "../../../utils/library/MathUtils.sol";


library MintingRateLimiter {
    using SafeCast for uint256;
    using MathUtils for uint64;

    struct State {
        uint64 windowSizeSeconds;
        uint64 maxMintingPerWindow;
        uint64 windowStartTimestamp;
        uint64 mintedInCurrentWindow;
    }

    function initialize(
        State storage _state,
        uint64 _windowSizeSeconds,
        uint64 _maxMintingPerWindow
    ) internal {
        _state.windowSizeSeconds = _windowSizeSeconds;
        _state.maxMintingPerWindow = _maxMintingPerWindow;
        _state.windowStartTimestamp = (block.timestamp - block.timestamp % _windowSizeSeconds).toUint64();
        _state.mintedInCurrentWindow = 0;
    }

    function recordMinting(
        State storage _state,
        uint64 _amount
    )
        internal
        returns (bool _delayed, uint256 _allowedAt)
    {
        _processElapsedWindows(_state);
        // record minting (even if it is going to be delayed)
        _state.mintedInCurrentWindow = _state.mintedInCurrentWindow + _amount;
        // delay if necessary
        if (_state.mintedInCurrentWindow <= _state.maxMintingPerWindow) {
            _delayed = false;
            _allowedAt = block.timestamp;
        } else {
            _delayed = true;
            _allowedAt = _state.windowStartTimestamp +
                _state.windowSizeSeconds * _state.mintedInCurrentWindow / _state.maxMintingPerWindow;
        }
    }

    function setMaxMintingPerWindow(
        State storage _state,
        uint64 _newMaxMintingPerWindow
    ) internal {
        _processElapsedWindows(_state);
        _state.maxMintingPerWindow = _newMaxMintingPerWindow;
    }

    function setWindowSizeSeconds(
        State storage _state,
        uint64 _newWindowSizeSeconds
    ) internal {
        _processElapsedWindows(_state);
        _state.windowSizeSeconds = _newWindowSizeSeconds;
        // Align on new window size; this may increase the current window length a bit too much,
        // but this is acceptable as it will only increase the amount of allowed minting by less than 1 window.
        _state.windowStartTimestamp =
            _state.windowStartTimestamp - _state.windowStartTimestamp % _newWindowSizeSeconds;
    }

    function _processElapsedWindows(State storage _state) internal {
        uint256 windowsElapsed = (block.timestamp - _state.windowStartTimestamp) / _state.windowSizeSeconds;
        if (windowsElapsed > 0) {
            _state.mintedInCurrentWindow =
                _state.mintedInCurrentWindow.subOrZero(windowsElapsed * _state.maxMintingPerWindow).toUint64();
            _state.windowStartTimestamp =
                (_state.windowStartTimestamp + windowsElapsed * _state.windowSizeSeconds).toUint64();
        }
    }
}
