// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/flare/FtsoV2Interface.sol";


/**
 * A minimal FtsoV2 implementation for testing the fast updates / custom feeds.
 * The feed values are set directly by `setFeed`. The fee and the feeds timestamp can also be set,
 * to test the fee payment and the feed staleness check.
 */
contract FtsoV2Mock is FtsoV2Interface {

    struct FeedValue {
        uint256 value;
        int8 decimals;
        bool exists;
    }

    error FeedNotSupported();
    error FeeTooLow();
    error NotImplemented();

    /// The fee for reading a single feed.
    uint256 public feePerFeed;
    /// The timestamp reported for all the feeds; when zero, the current block timestamp is reported.
    uint64 public feedsTimestamp;

    mapping(bytes21 feedId => FeedValue) private feedValues;
    bytes21[] private feedIds;

    /**
     * Sets (or updates) the value of the feed `_feedId`.
     */
    function setFeed(bytes21 _feedId, uint256 _value, int8 _decimals) external {
        if (!feedValues[_feedId].exists) {
            feedIds.push(_feedId);
        }
        feedValues[_feedId] = FeedValue({ value: _value, decimals: _decimals, exists: true });
    }

    /**
     * Sets the fee that has to be paid for reading a single feed (zero by default).
     */
    function setFeePerFeed(uint256 _feePerFeed) external {
        feePerFeed = _feePerFeed;
    }

    /**
     * Sets the timestamp reported for all the feeds. When set to zero (the default),
     * the current block timestamp is reported instead.
     */
    function setFeedsTimestamp(uint64 _feedsTimestamp) external {
        feedsTimestamp = _feedsTimestamp;
    }

    /**
     * @inheritdoc FtsoV2Interface
     */
    function getFeedById(bytes21 _feedId)
        external payable
        returns (uint256 _value, int8 _decimals, uint64 _timestamp)
    {
        _payFee(1);
        (_value, _decimals) = _getFeedValue(_feedId);
        _timestamp = _getFeedsTimestamp();
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
            (_values[i], _decimals[i]) = _getFeedValue(_feedIds[i]);
        }
        _timestamp = _getFeedsTimestamp();
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
    function verifyFeedData(FeedDataWithProof calldata) external pure returns (bool) {
        revert NotImplemented();
    }

    function _payFee(uint256 _numberOfFeeds) private view {
        require(msg.value >= feePerFeed * _numberOfFeeds, FeeTooLow());
    }

    function _getFeedValue(bytes21 _feedId) private view returns (uint256 _value, int8 _decimals) {
        FeedValue storage feedValue = feedValues[_feedId];
        require(feedValue.exists, FeedNotSupported());
        return (feedValue.value, feedValue.decimals);
    }

    function _getFeedsTimestamp() private view returns (uint64) {
        return feedsTimestamp != 0 ? feedsTimestamp : uint64(block.timestamp);
    }
}
