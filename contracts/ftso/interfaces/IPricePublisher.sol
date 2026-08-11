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
     * Publishes the FTSO scaling prices and calculates the median of the trusted prices.
     * It must be called for all feeds ordered as in the `getFeedIds()` list.
     * @param _proofs The list of FTSO scaling feeds with Merkle proofs.
     * @dev Can only be used when the prices are obtained from FTSO scaling, i.e. when
     *  `useFtsoV2FastUpdates()` is `false`.
     */
    function publishPrices(FeedWithProof[] calldata _proofs) external;

    /**
     * Publishes the prices, read from the FTSOv2 fast updates (or custom feeds) contract, and calculates
     * the median of the trusted prices.
     * The prices for all the feeds in the `getFeedIds()` list are published in a single call, therefore
     * no proofs and no arguments are needed.
     * The prices are published for the previous voting round id (the same round as the trusted providers'
     * prices), even though the fast updates feed values are typically a bit newer than that - the actual
     * feed timestamp is reported as the price timestamp by `IPriceReader.getPrice`.
     * @dev Can only be used when the prices are obtained from FTSOv2 fast updates, i.e. when
     *  `useFtsoV2FastUpdates()` is `true`.
     */
    function publishPricesFromFastUpdates() external payable;

    /**
     * Indicates the source of the (non-trusted) prices, which determines the method used for publishing.
     * @return `true` if the prices are obtained from the FTSOv2 fast updates contract - in this case
     *  they must be published by calling `publishPricesFromFastUpdates()`;
     *  `false` if they are obtained from FTSO scaling - in this case they must be published by
     *  calling `publishPrices()` with Merkle proofs.
     */
    function useFtsoV2FastUpdates() external view returns (bool);

    /**
     * Submits trusted prices for the voting round id.
     * It must be called for all feeds ordered as in the `getFeedIds()` list.
     * @param _votingRoundId The previous voting round id.
     * @param _feeds The list of trusted provider feeds.
     */
    function submitTrustedPrices(uint32 _votingRoundId, TrustedProviderFeed[] calldata _feeds) external;

    /**
     * Returns the list of required feed ids.
     * @return The list of feed ids.
     */
    function getFeedIds() external view returns (bytes21[] memory);

    /**
     * Returns the list of required feed ids with decimals (for the trusted providers).
     * @return _feedIds The list of feed ids.
     * @return _decimals The list of feed decimals.
     */
    function getFeedIdsWithDecimals() external view returns (bytes21[] memory _feedIds, int8[] memory _decimals);

    /**
     * Returns the list of supported symbols.
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
