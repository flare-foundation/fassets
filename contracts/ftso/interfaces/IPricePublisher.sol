// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


interface IPricePublisher {

    /// The FTSO feed struct.
    struct Feed {
        uint32 votingRoundId;
        bytes21 id;
        int32 value;
        uint16 turnoutBIPS;
        int8 decimals;
    }

    /// The FTSO feed with proof struct.
    struct FeedWithProof {
        bytes32[] proof;
        Feed body;
    }

    /// The trusted provider feed struct.
    struct TrustedProviderFeed {
        bytes21 id;
        uint32 value;
        int8 decimals;
    }

    /**
     * Publishes the prices of all the required feeds and calculates the median of the trusted prices.
     * The prices of the `getScalingFeedIds()` feeds are provided by the caller as FTSO scaling feeds
     * with Merkle proofs, ordered as in the `getScalingFeedIds()` list. The prices of the remaining
     * feeds (`getFastUpdatesFeedIds()`) are read from the FTSOv2 fast updates (or custom feeds) contract
     * by this method, so no proofs or other arguments are needed for them.
     * All the prices are published for the same voting round id - the one the proofs are for, or the
     * previous voting round id when there are no FTSO scaling feeds. The values read from fast updates
     * are the current ones, so they are typically a bit newer than that voting round; since such feeds
     * are also not necessarily all updated in the same round (custom feeds have their own update
     * schedule), each of them keeps its own timestamp, which is reported as the price timestamp by
     * `IPriceReader.getPrice`.
     * @param _proofs The list of FTSO scaling feeds with Merkle proofs; empty when all the prices are
     *  read from fast updates.
     * @dev The fee for reading the fast update feeds (see `FtsoV2Interface.calculateFeeByIds`) has to be paid
     *  by the caller - the whole `msg.value` is forwarded to the FtsoV2 contract and any overpayment is lost.
     *  No payment is required (and none is accepted) when all the prices are provided from FTSO scaling.
     */
    function publishPrices(FeedWithProof[] calldata _proofs) external payable;

    /**
     * Submits trusted prices for the voting round id.
     * It must be called for all feeds ordered as in the `getFeedIds()` list.
     * @param _votingRoundId The previous voting round id.
     * @param _feeds The list of trusted provider feeds.
     */
    function submitTrustedPrices(uint32 _votingRoundId, TrustedProviderFeed[] calldata _feeds) external;

    /**
     * Returns the list of all the required feed ids - the `getScalingFeedIds()` list, followed by the
     * `getFastUpdatesFeedIds()` list.
     * @return The list of feed ids.
     */
    function getFeedIds() external view returns (bytes21[] memory);

    /**
     * Returns the list of the required feed ids whose prices are published from FTSO scaling,
     * i.e. by passing Merkle proofs to `publishPrices`.
     * @return The list of feed ids.
     */
    function getScalingFeedIds() external view returns (bytes21[] memory);

    /**
     * Returns the list of the required feed ids whose prices are read from the FTSOv2 fast updates
     * (or custom feeds) contract by `publishPrices`.
     * @return The list of feed ids.
     */
    function getFastUpdatesFeedIds() external view returns (bytes21[] memory);

    /**
     * Returns the list of required feed ids with decimals (for the trusted providers),
     * ordered as in the `getFeedIds()` list.
     * @return _feedIds The list of feed ids.
     * @return _decimals The list of feed decimals.
     */
    function getFeedIdsWithDecimals() external view returns (bytes21[] memory _feedIds, int8[] memory _decimals);

    /**
     * Returns the list of supported symbols, ordered as in the `getFeedIds()` list.
     * @return _symbols The list of symbols.
     */
    function getSymbols() external view returns (string[] memory _symbols);

    /**
     * Returns the feed id for the given symbol.
     * @param _symbol The symbol.
     * @return The feed id.
     */
    function getFeedId(string memory _symbol) external view returns (bytes21);

    /**
     * Returns the trusted providers list.
     * @return The list of trusted providers.
     */
    function getTrustedProviders() external view returns (address[] memory);
}
