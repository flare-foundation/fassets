// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/flare/FtsoV2Interface.sol";


/**
 * A minimal FtsoV2 implementation for testing the fast updates / custom feeds.
 * The feed values are set directly by `setFeed`. The fee and the feed timestamps can also be set,
 * to test the fee payment and the timestamps reported for the published prices.
 */
contract FtsoV2Mock is FtsoV2Interface {

    struct FeedValue {
        // the value is signed, as a custom feed may report negative values
        int256 value;
        int8 decimals;
        // the feed's own timestamp (as reported by custom feeds); when zero, `feedsTimestamp` is used
        uint64 timestamp;
        bool exists;
    }

    error FeedNotSupported();
    error FeeTooLow();
    error TimestampsDiffer();
    // the real contract reverts with the string "value negative"
    error ValueNegative();
    error NotImplemented();

    /// The fee for reading a single feed.
    uint256 public feePerFeed;
    /// The timestamp reported for the feeds without their own timestamp (as for the fast update feeds);
    /// when zero, the current block timestamp is reported.
    uint64 public feedsTimestamp;

    mapping(bytes21 feedId => FeedValue) private feedValues;
    bytes21[] private feedIds;

    /**
     * Sets (or updates) the value of the feed `_feedId`. The feed reports the shared timestamp
     * (see `setFeedsTimestamp`), unless its own timestamp is set by `setFeedTimestamp`.
     * The value may be negative, as for a custom feed with a signed source.
     */
    function setFeed(bytes21 _feedId, int256 _value, int8 _decimals) external {
        FeedValue storage feedValue = feedValues[_feedId];
        if (!feedValue.exists) {
            feedIds.push(_feedId);
            feedValue.exists = true;
        }
        feedValue.value = _value;
        feedValue.decimals = _decimals;
    }

    /**
     * Sets the fee that has to be paid for reading a single feed (zero by default).
     */
    function setFeePerFeed(uint256 _feePerFeed) external {
        feePerFeed = _feePerFeed;
    }

    /**
     * Sets the timestamp shared by all the feeds without their own timestamp.
     * When set to zero (the default), the current block timestamp is reported instead.
     */
    function setFeedsTimestamp(uint64 _feedsTimestamp) external {
        feedsTimestamp = _feedsTimestamp;
    }

    /**
     * Sets the feed's own timestamp, which makes it behave as a custom feed - it no longer reports
     * the timestamp shared by the fast update feeds. Setting it to zero reverts to the shared timestamp.
     */
    function setFeedTimestamp(bytes21 _feedId, uint64 _timestamp) external {
        require(feedValues[_feedId].exists, FeedNotSupported());
        feedValues[_feedId].timestamp = _timestamp;
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getFeedById(bytes21 _feedId)
        external payable
        returns (uint256 _value, int8 _decimals, uint64 _timestamp)
    {
        _payFee(1);
        int256 value;
        (value, _decimals, _timestamp) = _getFeedValue(_feedId);
        _value = _toUnsigned(value);
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getFeedsById(bytes21[] memory _feedIds)
        external payable
        returns (uint256[] memory _values, int8[] memory _decimals, uint64 _timestamp)
    {
        _payFee(_feedIds.length);
        _values = new uint256[](_feedIds.length);
        _decimals = new int8[](_feedIds.length);
        for (uint256 i = 0; i < _feedIds.length; i++) {
            uint64 feedTimestamp;
            int256 value;
            (value, _decimals[i], feedTimestamp) = _getFeedValue(_feedIds[i]);
            _values[i] = _toUnsigned(value);
            // all the feeds must report the same timestamp, otherwise there is nothing to return
            require(i == 0 || feedTimestamp == _timestamp, TimestampsDiffer());
            _timestamp = feedTimestamp;
        }
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getCurrentFeed(bytes21 _feedId)
        external payable
        returns (int256 _value, int8 _decimals, uint64 _timestamp)
    {
        _payFee(1);
        return _getFeedValue(_feedId);
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getCurrentFeeds(bytes21[] memory _feedIds)
        external payable
        returns (int256[] memory _values, int8[] memory _decimals, uint64[] memory _timestamps)
    {
        _payFee(_feedIds.length);
        _values = new int256[](_feedIds.length);
        _decimals = new int8[](_feedIds.length);
        _timestamps = new uint64[](_feedIds.length);
        for (uint256 i = 0; i < _feedIds.length; i++) {
            (_values[i], _decimals[i], _timestamps[i]) = _getFeedValue(_feedIds[i]);
        }
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function calculateFeeById(bytes21) external view returns (uint256) {
        return feePerFeed;
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function calculateFeeByIds(bytes21[] memory _feedIds) external view returns (uint256) {
        return feePerFeed * _feedIds.length;
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getSupportedFeedIds() external view returns (bytes21[] memory) {
        return feedIds;
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getFeedIdChanges() external pure returns (FeedIdChange[] memory) {
        return new FeedIdChange[](0);
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getFtsoProtocolId() external pure returns (uint256) {
        return 100;
    }

    /**
     * Not needed for the FAsset tests.
     */
    function getFeedByIdInWei(bytes21) external payable returns (uint256, uint64) {
        revert NotImplemented();
    }

    /**
     * Not needed for the FAsset tests.
     */
    function getFeedsByIdInWei(bytes21[] memory) external payable returns (uint256[] memory, uint64) {
        revert NotImplemented();
    }

    /**
     * Not needed for the FAsset tests.
     */
    function getCurrentFeedInWei(bytes21) external payable returns (int256, uint64) {
        revert NotImplemented();
    }

    /**
     * Not needed for the FAsset tests.
     */
    function getCurrentFeedsInWei(bytes21[] memory)
        external payable
        returns (int256[] memory, uint64[] memory)
    {
        revert NotImplemented();
    }

    /**
     * Not needed for the FAsset tests.
     */
    function verifyFeedData(FeedDataWithProof calldata) external pure returns (bool) {
        revert NotImplemented();
    }

    function _payFee(uint256 _numberOfFeeds) private view {
        require(msg.value >= feePerFeed * _numberOfFeeds, FeeTooLow());
    }

    function _getFeedValue(bytes21 _feedId)
        private view
        returns (int256 _value, int8 _decimals, uint64 _timestamp)
    {
        FeedValue storage feedValue = feedValues[_feedId];
        require(feedValue.exists, FeedNotSupported());
        _value = feedValue.value;
        _decimals = feedValue.decimals;
        _timestamp = feedValue.timestamp;
        if (_timestamp == 0) {
            _timestamp = feedsTimestamp != 0 ? feedsTimestamp : uint64(block.timestamp);
        }
    }

    /**
     * The unsigned methods revert for the feeds reporting a negative value.
     */
    function _toUnsigned(int256 _value) private pure returns (uint256) {
        require(_value >= 0, ValueNegative());
        return uint256(_value);
    }
}
