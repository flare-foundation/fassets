// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IRelay} from "@flarenetwork/flare-periphery-contracts/flare/IRelay.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/flare/FtsoV2Interface.sol";
import {MathUtils} from "../../utils/library/MathUtils.sol";
import {GovernedUUPSProxyImplementation} from "../../governance/implementation/GovernedUUPSProxyImplementation.sol";
import {AddressUpdatable} from "../../flareSmartContracts/implementation/AddressUpdatable.sol";
import {IPriceReader} from "../../ftso/interfaces/IPriceReader.sol";
import {IPricePublisher} from "../interfaces/IPricePublisher.sol";
import {IPriceChangeEmitter} from "../interfaces/IPriceChangeEmitter.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";


contract FtsoV2PriceStore is
    GovernedUUPSProxyImplementation,
    IPriceReader,
    IPricePublisher,
    IPriceChangeEmitter,
    IERC165,
    AddressUpdatable
{
    using MerkleProof for bytes32[];

    uint256 internal constant MAX_BIPS = 1e4;

    struct PriceStore {
        uint32 votingRoundId;
        uint32 value;
        int8 decimals;

        uint32 trustedVotingRoundId;
        uint32 trustedValue;
        int8 trustedDecimals;
        uint8 numberOfSubmits;

        // The timestamp of the value, when it was obtained from FTSOv2 fast updates.
        // Zero when the value was obtained from FTSO scaling (then the end of `votingRoundId` is used).
        uint64 fastUpdatesTimestamp;
    }

    error InvalidStartTime();
    error VotingEpochDurationTooShort();
    error WrongNumberOfProofs();
    error PricesAlreadyPublished();
    error SubmissionWindowNotClosed();
    error VotingRoundIdMismatch();
    error FeedIdMismatch();
    error ValueMustBeNonNegative();
    error MerkleProofInvalid();
    error OnlyTrustedProvider();
    error AllPricesMustBeProvided();
    error SubmissionWindowClosed();
    error AlreadySubmitted();
    error DecimalsMismatch();
    error LengthMismatch();
    error MaxSpreadTooBig();
    error TooManyTrustedProviders();
    error ThresholdTooHigh();
    error SymbolNotSupported();
    error MinTurnoutTooBig();
    error FtsoV2FastUpdatesContractNotSet();
    error NoFeeRequired();
    error DuplicateFeedId();

    /// Timestamp when the first voting epoch started, in seconds since UNIX epoch.
    uint64 public firstVotingRoundStartTs;
    /// Duration of voting epochs, in seconds.
    uint64 public votingEpochDurationSeconds;
    /// Duration of a window for submitting trusted prices, in seconds.
    uint64 public submitTrustedPricesWindowSeconds;
    /// The FTSO protocol id.
    uint8 public ftsoProtocolId;

    /// The list of feed ids whose prices are published from FTSO scaling (with Merkle proofs).
    bytes21[] internal scalingFeedIds;
    /// Mapping from symbol to feed id - used for price lookups (backwards compatibility).
    mapping(string symbol => bytes21 feedId) internal symbolToFeedId;
    /// Mapping from feed id to symbol - used for list of supported symbols.
    mapping(bytes21 feedId => string symbol) internal feedIdToSymbol;
    /// Mapping from feed id to price store which holds the latest published FTSO scaling price and trusted price.
    mapping(bytes21 feedId => PriceStore) internal latestPrices;
    /// Mapping from feed id to submitted trusted prices for the given voting round.
    mapping(bytes21 feedId => mapping (uint32 votingRoundId => bytes)) internal submittedTrustedPrices;
    /// Mapping from trusted provider to the last submitted voting epoch id.
    mapping(address trustedProvider => uint256 lastVotingEpochId) internal lastVotingEpochIdByProvider;

    /// The list of trusted providers.
    address[] internal trustedProviders;
    mapping(address trustedProvider => bool isTrustedProvider) internal trustedProvidersMap;
    /// Trusted providers threshold for calculating the median price.
    uint8 public trustedProvidersThreshold;
    /// The maximum spread between the median price and the nearby trusted prices in BIPS in order to update the price.
    uint16 public maxSpreadBIPS;

    /// The Relay contract.
    IRelay public relay;
    /// The last published voting round id.
    uint32 public lastPublishedVotingRoundId;

    /// The minimum percentage of providers that have to send a price for a feed in a round to be published
    /// (for FTSO, not for trusted providers).
    uint16 public minTurnoutBIPS;

    /// The FtsoV2 contract, which provides the fast updates and custom feeds.
    /// Only used (and required) when `fastUpdatesFeedIds` is non-empty.
    FtsoV2Interface public ftsoV2FastUpdates;

    /// The list of feed ids whose prices are read from FTSOv2 fast updates (or custom feeds).
    bytes21[] internal fastUpdatesFeedIds;

    event LowTurnoutForFeed(bytes21 indexed feedId, uint32 indexed votingRoundId, uint16 turnoutBIPS);

    constructor()
        GovernedUUPSProxyImplementation()   // marks as initialized
        AddressUpdatable(address(0))
    {}

    function initialize(
        IGovernanceSettings _governanceSettings,
        address _initialGovernance,
        address _addressUpdater,
        uint64 _firstVotingRoundStartTs,
        uint8 _votingEpochDurationSeconds,
        uint8 _ftsoProtocolId
    )
        external
    {
        require(_firstVotingRoundStartTs + _votingEpochDurationSeconds <= block.timestamp, InvalidStartTime());
        require(_votingEpochDurationSeconds > 1, VotingEpochDurationTooShort()); // 90 s

        initialise(_governanceSettings, _initialGovernance);    // also marks as initialized
        setAddressUpdaterValue(_addressUpdater);
        firstVotingRoundStartTs = _firstVotingRoundStartTs;
        votingEpochDurationSeconds = _votingEpochDurationSeconds;
        submitTrustedPricesWindowSeconds = _votingEpochDurationSeconds / 2; // 45 s
        ftsoProtocolId = _ftsoProtocolId;
        lastPublishedVotingRoundId = _getPreviousVotingEpochId();
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function publishPrices(FeedWithProof[] calldata _proofs) external payable {
        require(msg.value == 0 || fastUpdatesFeedIds.length > 0, NoFeeRequired());
        require(_proofs.length == scalingFeedIds.length, WrongNumberOfProofs());
        // All the prices are published for the same voting round. This way the trusted prices
        // of all the feeds are taken from the same voting round, too.
        uint32 votingRoundId = _proofs.length > 0 ? _proofs[0].body.votingRoundId : _getPreviousVotingEpochId();
        _publishNewVotingRound(votingRoundId);

        _publishPricesFromFtsoV2Scaling(_proofs, votingRoundId);
        _publishPricesFromFastUpdates(votingRoundId);
    }

    /**
     * Publishes the prices of the `getScalingFeedIds()` feeds, provided by the caller as FTSO scaling
     * feeds with Merkle proofs, and calculates the median of the trusted prices.
     * The price of a feed whose turnout was too low is not published, only the `LowTurnoutForFeed` event
     * is emitted for it (its trusted price is still calculated).
     * @param _proofs The list of FTSO scaling feeds with Merkle proofs, ordered as `scalingFeedIds`;
     *  its length has already been validated by `publishPrices`.
     * @param _votingRoundId The voting round id the prices are published for; it has already been validated
     *  and marked as published by `_publishNewVotingRound`.
     */
    function _publishPricesFromFtsoV2Scaling(FeedWithProof[] calldata _proofs, uint32 _votingRoundId) private {
        if (_proofs.length == 0) return;
        // the Merkle root is the same for all the proofs, so it is only read once
        bytes32 merkleRoot = relay.merkleRoots(ftsoProtocolId, _votingRoundId);

        for (uint256 i = 0; i < _proofs.length; i++) {
            FeedWithProof calldata proof = _proofs[i];
            Feed calldata feed = proof.body;
            require(feed.votingRoundId == _votingRoundId, VotingRoundIdMismatch());
            bytes21 feedId = scalingFeedIds[i];
            require(feed.id == feedId, FeedIdMismatch());
            require(feed.value >= 0, ValueMustBeNonNegative());

            bytes32 feedHash = keccak256(abi.encode(feed));
            require(proof.proof.verifyCalldata(merkleRoot, feedHash), MerkleProofInvalid());

            PriceStore storage priceStore = latestPrices[feedId];

            if (feed.turnoutBIPS >= minTurnoutBIPS) {
                priceStore.votingRoundId = _votingRoundId;
                priceStore.value = uint32(feed.value);
                priceStore.decimals = feed.decimals;
                priceStore.fastUpdatesTimestamp = 0;
            } else {
                emit LowTurnoutForFeed(feedId, _votingRoundId, feed.turnoutBIPS);
            }

            // calculate trusted prices for the same voting round
            _setTrustedPrices(priceStore, feedId, _votingRoundId);
        }
    }

    /**
     * Publishes the prices of the `getFastUpdatesFeedIds()` feeds, read from the FTSOv2 fast updates
     * (or custom feeds) contract, and calculates the median of the trusted prices.
     * The prices are read from the FtsoV2 contract, so no proofs are needed - they are just the current
     * values, which are typically a bit newer than the voting round `_votingRoundId` they are published for.
     * Since the feeds are not necessarily all updated in the same round (custom feeds have their own update
     * schedule), each feed keeps its own timestamp, which is reported as the price timestamp by
     * `IPriceReader.getPrice`.
     * @param _votingRoundId The voting round id the prices are published for; it has already been validated
     *  and marked as published by `_publishNewVotingRound`.
     * @dev The fee for reading the feeds is paid from `msg.value` of the enclosing `publishPrices` call.
     */
    function _publishPricesFromFastUpdates(uint32 _votingRoundId) private {
        if (fastUpdatesFeedIds.length == 0) return;

        require(address(ftsoV2FastUpdates) != address(0), FtsoV2FastUpdatesContractNotSet());

        bytes21[] memory feedIdsFU = fastUpdatesFeedIds;
        (int256[] memory values, int8[] memory decimals, uint64[] memory timestamps) =
            ftsoV2FastUpdates.getCurrentFeeds{ value: msg.value }(feedIdsFU);

        for (uint256 i = 0; i < feedIdsFU.length; i++) {
            bytes21 feedId = feedIdsFU[i];

            require(values[i] >= 0, ValueMustBeNonNegative());

            PriceStore storage priceStore = latestPrices[feedId];
            priceStore.votingRoundId = _votingRoundId;
            (priceStore.value, priceStore.decimals) = _rescaleToUint32(uint256(values[i]), decimals[i]);
            priceStore.fastUpdatesTimestamp = timestamps[i];

            // calculate trusted prices for the same voting round
            _setTrustedPrices(priceStore, feedId, _votingRoundId);
        }
    }

    /**
     * Validate the timing for publishing a voting round, emit event and mark it published.
     */
    function _publishNewVotingRound(uint32 _votingRoundId) private {
        require(_votingRoundId > lastPublishedVotingRoundId, PricesAlreadyPublished());
        require(_getEndTimestamp(_votingRoundId) + submitTrustedPricesWindowSeconds <= block.timestamp,
            SubmissionWindowNotClosed());
        // update last published voting round id
        lastPublishedVotingRoundId = _votingRoundId;
        // emit event
        emit PricesPublished(_votingRoundId);
    }

    /**
     * Calculates the median of the trusted providers' prices, submitted for the feed `_feedId` in the voting
     * round `_votingRoundId`, and stores it into `_priceStore`.
     * The median is only stored if enough prices were submitted and if they are close enough together
     * (see `_calculateMedian`). In any case, the submitted prices are deleted, since they are used only once
     * and the window for submitting trusted prices is already over when the method is called.
     * @param _priceStore The price store entry for the feed `_feedId`.
     * @param _feedId The feed id.
     * @param _votingRoundId The voting round id for which the prices are being published.
     */
    function _setTrustedPrices(PriceStore storage _priceStore, bytes21 _feedId, uint32 _votingRoundId) private {
        bytes memory trustedPrices = submittedTrustedPrices[_feedId][_votingRoundId];
        if (trustedPrices.length > 0 && trustedPrices.length >= 4 * trustedProvidersThreshold) {
            // calculate median price
            (uint256 medianPrice, bool priceOk) = _calculateMedian(trustedPrices);
            if (priceOk) {
                // store the median price
                _priceStore.trustedVotingRoundId = _votingRoundId;
                _priceStore.trustedValue = uint32(medianPrice);
                _priceStore.numberOfSubmits = uint8(trustedPrices.length / 4);
            }
            // delete submitted trusted prices
            delete submittedTrustedPrices[_feedId][_votingRoundId];
        }
    }

    /**
     * The prices are stored as `uint32`, but FtsoV2 returns them as `uint256`, so the value has to be
     * divided by a power of 10 to fit into `uint32`, with the number of decimals reduced accordingly.
     * This does not change the price, only its precision (which is still at least 9 significant digits).
     * @param _value The feed value, as returned by FtsoV2.
     * @param _decimals The number of decimals of `_value`, as returned by FtsoV2.
     * @return The value and the number of decimals of the rescaled price, such that
     *  `value * 10**-decimals` approximates `_value * 10**-_decimals`.
     */
    function _rescaleToUint32(uint256 _value, int8 _decimals)
        private pure
        returns (uint32, int8)
    {
        (uint256 rescaled, uint256 scaleDec) = MathUtils.rescale(_value, type(uint32).max);
        // rescaled is at most type(uint32).max, so it fits uint32
        // scaleDec always fits int8 - see doc comment for MathUtils.rescale()
        return (uint32(rescaled), _decimals - int8(uint8(scaleDec)));
    }

    /**
     * @inheritdoc IPricePublisher
     * @dev The function can be called by trusted providers only.
     */
    function submitTrustedPrices(uint32 _votingRoundId, TrustedProviderFeed[] calldata _feeds) external {
        require(trustedProvidersMap[msg.sender], OnlyTrustedProvider());
        require(_feeds.length == _getFeedIdsLength(), AllPricesMustBeProvided());
        uint32 previousVotingEpochId = _getPreviousVotingEpochId();
        require(_votingRoundId == previousVotingEpochId, VotingRoundIdMismatch());
        // end of previous voting epoch = start of current voting epoch
        uint256 startTimestamp = _getEndTimestamp(previousVotingEpochId);
        uint256 endTimestamp = startTimestamp + submitTrustedPricesWindowSeconds;
        require(block.timestamp >= startTimestamp && block.timestamp < endTimestamp, SubmissionWindowClosed());
        require(lastVotingEpochIdByProvider[msg.sender] < previousVotingEpochId, AlreadySubmitted());
        // mark the trusted provider submission
        lastVotingEpochIdByProvider[msg.sender] = previousVotingEpochId;

        for (uint256 i = 0; i < _feeds.length; i++) {
            TrustedProviderFeed calldata feed = _feeds[i];
            bytes21 feedId = _getFeedId(i);
            require(feed.id == feedId, FeedIdMismatch());
            require(feed.decimals == latestPrices[feedId].trustedDecimals, DecimalsMismatch());
            submittedTrustedPrices[feedId][previousVotingEpochId] =
                bytes.concat(submittedTrustedPrices[feedId][previousVotingEpochId], bytes4(feed.value));
        }
    }

    /**
     * Updates the settings.
     * The full list of the required feeds is the concatenation of `_scalingFeedIds` and `_fastUpdatesFeedIds`
     * (in this order), so `_symbols` and `_trustedDecimals` must be ordered accordingly.
     * A feed id must not appear in both lists.
     * @param _scalingFeedIds The list of feed ids whose prices are published from FTSO scaling,
     *  i.e. by passing Merkle proofs to `publishPrices`.
     * @param _fastUpdatesFeedIds The list of feed ids whose prices are read from the FTSOv2 fast updates
     *  (or custom feeds) contract by `publishPrices`.
     * @param _symbols The list of symbols, one for every feed id.
     * @param _trustedDecimals The list of trusted decimals, one for every feed id.
     * @param _maxSpreadBIPS The maximum spread between the median price and the nearby trusted prices in BIPS.
     * @param _minTurnoutBIPS The minimum percentage of providers that have to send a price for an
     *  FTSO scaling feed in a round for it to be published.
     * @dev Can only be called by the governance.
     */
    function updateSettings(
        bytes21[] calldata _scalingFeedIds,
        bytes21[] calldata _fastUpdatesFeedIds,
        string[] calldata _symbols,
        int8[] calldata _trustedDecimals,
        uint16 _maxSpreadBIPS,
        uint16 _minTurnoutBIPS
    )
        external onlyGovernance
    {
        uint256 totalFeedLength = _scalingFeedIds.length + _fastUpdatesFeedIds.length;
        require(totalFeedLength == _symbols.length && totalFeedLength == _trustedDecimals.length, LengthMismatch());
        require(_maxSpreadBIPS <= MAX_BIPS, MaxSpreadTooBig());
        maxSpreadBIPS = _maxSpreadBIPS;
        require(_minTurnoutBIPS <= MAX_BIPS, MinTurnoutTooBig());
        minTurnoutBIPS = _minTurnoutBIPS;
        // a feed id must not be in both lists, otherwise the trusted prices would be submitted for it twice
        for (uint256 i = 0; i < _scalingFeedIds.length; i++) {
            for (uint256 j = 0; j < _fastUpdatesFeedIds.length; j++) {
                require(_scalingFeedIds[i] != _fastUpdatesFeedIds[j], DuplicateFeedId());
            }
        }
        scalingFeedIds = _scalingFeedIds;
        fastUpdatesFeedIds = _fastUpdatesFeedIds;
        for (uint256 i = 0; i < totalFeedLength; i++) {
            bytes21 feedId =
                i < _scalingFeedIds.length ? _scalingFeedIds[i] : _fastUpdatesFeedIds[i - _scalingFeedIds.length];
            symbolToFeedId[_symbols[i]] = feedId;
            feedIdToSymbol[feedId] = _symbols[i];
            PriceStore storage latestPrice = latestPrices[feedId];
            if (latestPrice.trustedDecimals != _trustedDecimals[i]) {
                latestPrice.trustedDecimals = _trustedDecimals[i];
                latestPrice.trustedValue = 0;
                latestPrice.trustedVotingRoundId = 0;
                latestPrice.numberOfSubmits = 0;
                // delete all submitted trusted prices for the symbol
                for (uint32 j = lastPublishedVotingRoundId + 1; j <= _getPreviousVotingEpochId(); j++) {
                    delete submittedTrustedPrices[feedId][j];
                }
            }
        }
    }

    /**
     * Sets the trusted providers.
     * @param _trustedProviders The list of trusted providers.
     * @param _trustedProvidersThreshold The trusted providers threshold for calculating the median price.
     * @dev Can only be called by the governance.
     */
    function setTrustedProviders(
        address[] calldata _trustedProviders,
        uint8 _trustedProvidersThreshold
    )
        external onlyGovernance
    {
        require(_trustedProviders.length < 2**8, TooManyTrustedProviders());
        require(_trustedProviders.length >= _trustedProvidersThreshold, ThresholdTooHigh());
        trustedProvidersThreshold = _trustedProvidersThreshold;
        // reset already submitted data
        _clearSubmittedTrustedPricesForLastEpoch();
        // reset all trusted providers
        for (uint256 i = 0; i < trustedProviders.length; i++) {
            trustedProvidersMap[trustedProviders[i]] = false;
        }
        // set new trusted providers
        trustedProviders = _trustedProviders;
        for (uint256 i = 0; i < _trustedProviders.length; i++) {
            trustedProvidersMap[_trustedProviders[i]] = true;
        }
    }

    /**
     * Sets the minTurnoutBIPS.
     * @param _minTurnoutBIPS The minimum percentage of providers that have to send a price to be published.
     * @dev Can only be called by the governance.
     */
    function setMinTurnoutBIPS(
        uint16 _minTurnoutBIPS
    )
        external onlyGovernance
    {
        require(_minTurnoutBIPS <= MAX_BIPS, MinTurnoutTooBig());
        minTurnoutBIPS = _minTurnoutBIPS;
    }

    /**
     * @inheritdoc IPriceReader
     */
    function getPrice(string memory _symbol)
        external view
        returns (uint256 _price, uint256 _timestamp, uint256 _priceDecimals)
    {
        bytes21 feedId = symbolToFeedId[_symbol];
        require(feedId != bytes21(0), SymbolNotSupported());
        PriceStore storage feed = latestPrices[feedId];
        _price = feed.value;
        _timestamp = feed.fastUpdatesTimestamp != 0
            ? feed.fastUpdatesTimestamp
            : _getEndTimestamp(feed.votingRoundId);
        int256 decimals = feed.decimals; // int8
        if (decimals < 0) {
            _priceDecimals = 0;
            _price *= 10 ** uint256(-decimals);
        } else {
            _priceDecimals = uint256(decimals);
        }
    }

    /**
     * @inheritdoc IPriceReader
     */
    function getPriceFromTrustedProviders(string memory _symbol)
        external view
        returns (uint256 _price, uint256 _timestamp, uint256 _priceDecimals)
    {
        bytes21 feedId = symbolToFeedId[_symbol];
        require(feedId != bytes21(0), SymbolNotSupported());
        PriceStore storage feed = latestPrices[feedId];
        (_price, _timestamp, _priceDecimals) = _getPriceFromTrustedProviders(feed);
    }

    /**
     * @inheritdoc IPriceReader
     */
    function getPriceFromTrustedProvidersWithQuality(string memory _symbol)
        external view
        returns (uint256 _price, uint256 _timestamp, uint256 _priceDecimals, uint8 _numberOfSubmits)
    {
        bytes21 feedId = symbolToFeedId[_symbol];
        require(feedId != bytes21(0), SymbolNotSupported());
        PriceStore storage feed = latestPrices[feedId];
        (_price, _timestamp, _priceDecimals) = _getPriceFromTrustedProviders(feed);
        _numberOfSubmits = feed.numberOfSubmits;
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function getFeedIds() public view returns (bytes21[] memory _feedIds) {
        uint256 scalingLength = scalingFeedIds.length;
        uint256 fastUpdatesLength = fastUpdatesFeedIds.length;
        _feedIds = new bytes21[](scalingLength + fastUpdatesLength);
        for (uint256 i = 0; i < scalingLength; i++) {
            _feedIds[i] = scalingFeedIds[i];
        }
        for (uint256 i = 0; i < fastUpdatesLength; i++) {
            _feedIds[i + scalingLength] = fastUpdatesFeedIds[i];
        }
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function getScalingFeedIds() external view returns (bytes21[] memory) {
        return scalingFeedIds;
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function getFastUpdatesFeedIds() external view returns (bytes21[] memory) {
        return fastUpdatesFeedIds;
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function getFeedIdsWithDecimals() external view returns (bytes21[] memory _feedIds, int8[] memory _decimals) {
        _feedIds = getFeedIds();
        _decimals = new int8[](_feedIds.length);
        for (uint256 i = 0; i < _feedIds.length; i++) {
            _decimals[i] = latestPrices[_feedIds[i]].trustedDecimals;
        }
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function getSymbols() external view returns (string[] memory _symbols) {
        uint256 scalingLength = scalingFeedIds.length;
        uint256 fastUpdatesLength = fastUpdatesFeedIds.length;
        _symbols = new string[](scalingLength + fastUpdatesLength);
        for (uint256 i = 0; i < scalingLength; i++) {
            _symbols[i] = feedIdToSymbol[scalingFeedIds[i]];
        }
        for (uint256 i = 0; i < fastUpdatesLength; i++) {
            _symbols[i + scalingLength] = feedIdToSymbol[fastUpdatesFeedIds[i]];
        }
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function getFeedId(string memory _symbol) external view returns (bytes21) {
        return symbolToFeedId[_symbol];
    }

    /**
     * @inheritdoc IPricePublisher
     */
    function getTrustedProviders() external view returns (address[] memory) {
        return trustedProviders;
    }

    /**
     * @notice virtual method that a contract extending AddressUpdatable must implement
     */
    function _updateContractAddresses(
        bytes32[] memory _contractNameHashes,
        address[] memory _contractAddresses
    )
        internal override
    {
        relay = IRelay(_getContractAddress(_contractNameHashes, _contractAddresses, "Relay"));
        ftsoV2FastUpdates = FtsoV2Interface(_getContractAddress(_contractNameHashes, _contractAddresses, "FtsoV2"));
    }

    /**
     * When calling setTrustedProviders, the already submitted trusted prices for the last epoch
     * have to be cleared, otherwise there can be double submissions.
     */
    function _clearSubmittedTrustedPricesForLastEpoch() private {
        uint32 previousVotingEpochId = _getPreviousVotingEpochId();
        uint256 numTrustedProviders = trustedProviders.length;
        for (uint256 i = 0; i < numTrustedProviders; i++) {
            lastVotingEpochIdByProvider[trustedProviders[i]] = 0;
        }
        uint256 numFeeds = _getFeedIdsLength();
        for (uint256 i = 0; i < numFeeds; i++) {
            bytes21 feedId = _getFeedId(i);
            delete submittedTrustedPrices[feedId][previousVotingEpochId];
        }
    }

    /**
     * Returns the previous voting epoch id.
     */
    function _getPreviousVotingEpochId() internal view returns(uint32) {
        return uint32((block.timestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds) - 1;
    }

    /**
     * Returns the end timestamp for the given voting epoch id.
     */
    function _getEndTimestamp(uint256 _votingEpochId) internal view returns(uint256) {
        return firstVotingRoundStartTs + (_votingEpochId + 1) * votingEpochDurationSeconds;
    }

    /**
     * Returns price data from trusted providers.
     */
    function _getPriceFromTrustedProviders(PriceStore storage _feed)
        internal view
        returns (uint256 _price, uint256 _timestamp, uint256 _priceDecimals)
    {
        _price = _feed.trustedValue;
        _timestamp = _getEndTimestamp(_feed.trustedVotingRoundId);
        int256 decimals = _feed.trustedDecimals; // int8
        if (decimals < 0) {
            _priceDecimals = 0;
            _price *= 10 ** uint256(-decimals);
        } else {
            _priceDecimals = uint256(decimals);
        }
    }

    /**
     * Returns the total number of the required feeds - see `getFeedIds()`.
     */
    function _getFeedIdsLength() private view returns (uint256) {
        return scalingFeedIds.length + fastUpdatesFeedIds.length;
    }

    /**
     * Returns the `_index`-th feed id in the list of all the required feeds - see `getFeedIds()`.
     */
    function _getFeedId(uint256 _index) private view returns (bytes21) {
        uint256 scalingLength = scalingFeedIds.length;
        return _index < scalingLength ? scalingFeedIds[_index] : fastUpdatesFeedIds[_index - scalingLength];
    }

    /**
     * @notice Calculates the simple median price (using insertion sort) - sorts original array
     * @param _prices positional array of prices to be sorted
     * @return _medianPrice median price
     * @return _priceOk true if the median price is within the spread
     */
    function _calculateMedian(bytes memory _prices) internal view returns (uint256 _medianPrice, bool _priceOk) {
        uint256 length = _prices.length;
        assert(length > 0 && length % 4 == 0);
        length /= 4;
        uint256[] memory prices = new uint256[](length);
        for (uint256 i = 0; i < length; i++) {
            bytes memory price = new bytes(4);
            for (uint256 j = 0; j < 4; j++) {
                price[j] = _prices[i * 4 + j];
            }
            prices[i] = uint32(bytes4(price));
        }

        for (uint256 i = 1; i < length; i++) {
            // price to sort next
            uint256 currentPrice = prices[i];

            // shift bigger prices right
            uint256 j = i;
            while (j > 0 && prices[j - 1] > currentPrice) {
                prices[j] = prices[j - 1];
                j--; // no underflow
            }
            // insert
            prices[j] = currentPrice;
        }

        uint256 spread = 0;
        uint256 middleIndex = length / 2;
        if (length % 2 == 1) {
            _medianPrice = prices[middleIndex];
            if (length >= 3) {
                spread = (prices[middleIndex + 1] - prices[middleIndex - 1]) / 2;
            }
        } else {
            // if median is "in the middle", take the average price of the two consecutive prices
            _medianPrice = (prices[middleIndex - 1] + prices[middleIndex]) / 2;
            spread = prices[middleIndex] - prices[middleIndex - 1];
        }
        // check if spread is within the limit
        _priceOk = spread <= maxSpreadBIPS * _medianPrice / MAX_BIPS; // no overflow
    }

    /**
     * Implementation of ERC-165 interface.
     */
    function supportsInterface(bytes4 _interfaceId)
        external pure override
        returns (bool)
    {
        return _interfaceId == type(IERC165).interfaceId
            || _interfaceId == type(IPriceReader).interfaceId
            || _interfaceId == type(IPricePublisher).interfaceId
            || _interfaceId == type(IPriceChangeEmitter).interfaceId;
    }
}