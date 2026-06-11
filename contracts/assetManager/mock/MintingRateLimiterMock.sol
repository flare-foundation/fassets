// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {MintingRateLimiter} from "../library/data/MintingRateLimiter.sol";


/**
 * @title MintingRateLimiter mock contract
 * @notice A contract to expose the MintingRateLimiter library for unit testing.
 **/
contract MintingRateLimiterMock {
    using MintingRateLimiter for MintingRateLimiter.State;

    MintingRateLimiter.State private state;

    function initialize(uint64 _windowSizeSeconds, uint64 _maxMintingPerWindow) external {
        state.initialize(_windowSizeSeconds, _maxMintingPerWindow);
    }

    function recordMinting(uint64 _amount) external returns (bool _delayed, uint256 _allowedAt) {
        return state.recordMinting(_amount);
    }

    function setMaxMintingPerWindow(uint64 _newMaxMintingPerWindow) external {
        state.setMaxMintingPerWindow(_newMaxMintingPerWindow);
    }

    function setWindowSizeSeconds(uint64 _newWindowSizeSeconds) external {
        state.setWindowSizeSeconds(_newWindowSizeSeconds);
    }

    function getState() external view returns (MintingRateLimiter.State memory) {
        return state;
    }
}
