// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {FtsoV2PriceStore, IPricePublisher} from "../../../contracts/ftso/implementation/FtsoV2PriceStore.sol";
import {FtsoV2PriceStoreProxy} from "../../../contracts/ftso/implementation/FtsoV2PriceStoreProxy.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";
import {IRelay} from "@flarenetwork/flare-periphery-contracts/flare/IRelay.sol";
import {FtsoV2Interface} from "@flarenetwork/flare-periphery-contracts/flare/FtsoV2Interface.sol";
import {IPriceChangeEmitter} from "../../../contracts/ftso/interfaces/IPriceChangeEmitter.sol";

// solhint-disable func-name-mixedcase
contract FtsoV2PriceStoreTest is Test {

    FtsoV2PriceStore private ftsoV2PriceStoreImpl;
    FtsoV2PriceStore private ftsoV2PriceStore;
    FtsoV2PriceStoreProxy private ftsoV2PriceStoreProxy;

    address private relayMock;

    address private governance;
    address private addressUpdater;

    bytes32[] private contractNameHashes;
    address[] private contractAddresses;

    uint64 private firstVotingRoundStartTs;
    uint8 private votingEpochDurationSeconds;
    uint8 private ftsoProtocolId;

    bytes21[] private feedIds;
    string[] private symbols;
    int8[] private trustedDecimals;

    bytes32[] private leaves = new bytes21[](4);

    mapping(string => uint256) private previousTimestamps;
    mapping(string => uint256) private previousTrustedTimestamps;

    function setUp() public {
        relayMock = makeAddr("relayMock");
        governance = makeAddr("governance");
        addressUpdater = makeAddr("addressUpdater");

        firstVotingRoundStartTs = 12345;
        votingEpochDurationSeconds = 90;
        ftsoProtocolId = 30;
        vm.warp(firstVotingRoundStartTs + votingEpochDurationSeconds + 1);

        ftsoV2PriceStoreImpl = new FtsoV2PriceStore();
        ftsoV2PriceStoreProxy = new FtsoV2PriceStoreProxy(
            address(ftsoV2PriceStoreImpl),
            IGovernanceSettings(makeAddr("governanceSettings")),
            governance,
            addressUpdater,
            firstVotingRoundStartTs,
            votingEpochDurationSeconds,
            ftsoProtocolId
        );
        ftsoV2PriceStore = FtsoV2PriceStore(address(ftsoV2PriceStoreProxy));

        contractNameHashes = new bytes32[](3);
        contractAddresses = new address[](3);
        contractNameHashes[0] = keccak256(abi.encode("Relay"));
        contractAddresses[0] = address(relayMock);
        contractNameHashes[1] = keccak256(abi.encode("AddressUpdater"));
        contractAddresses[1] = addressUpdater;
        contractNameHashes[2] = keccak256(abi.encode("FtsoV2"));
        contractAddresses[2] = makeAddr("ftsoV2Mock");
        vm.prank(addressUpdater);
        ftsoV2PriceStore.updateContractAddresses(contractNameHashes, contractAddresses);
    }

    function testFuzz_publishPrices(
        uint32[4] memory valueSeeds,
        int8[4] memory decimalSeeds,
        bytes21[4] memory feedIdSeeds,
        uint256[4] memory trustedValueSeeds,
        uint256 ts
    )
        public
    {
        uint8 numFeeds = 4;
        _setFeeds(numFeeds, decimalSeeds, feedIdSeeds);

        vm.warp(bound(ts, firstVotingRoundStartTs + 1000, type(uint32).max));
        uint32 votingRoundId = _getPreviousVotingEpochId();
        uint256 startTimestamp = _getEndTimestamp(votingRoundId);
        vm.warp(startTimestamp + 1);

        IPricePublisher.TrustedProviderFeed[] memory trustedFeeds =
            new IPricePublisher.TrustedProviderFeed[](numFeeds);
        for (uint256 i = 0; i < numFeeds; i++) {
            trustedFeeds[i] = IPricePublisher.TrustedProviderFeed({
                id: feedIds[i],
                value: uint32(bound(trustedValueSeeds[i], 0, type(uint32).max) / 2),
                decimals: trustedDecimals[i]
            });
        }
        address[] memory trustedProviders = new address[](1);
        trustedProviders[0] = makeAddr("trustedProvider");
        vm.prank(governance);
        ftsoV2PriceStore.setTrustedProviders(trustedProviders, 1);
        vm.prank(makeAddr("trustedProvider"));
        ftsoV2PriceStore.submitTrustedPrices(votingRoundId, trustedFeeds);

        votingRoundId = uint32(bound(votingRoundId, ftsoV2PriceStore.lastPublishedVotingRoundId() + 1,
            type(uint32).max));

        uint256 endTimestamp = _getEndTimestamp(votingRoundId);
        vm.warp(endTimestamp + ftsoV2PriceStore.submitTrustedPricesWindowSeconds() + 1);

        uint32[] memory values = new uint32[](numFeeds);
        int8[] memory decimals = new int8[](numFeeds);

        IPricePublisher.FeedWithProof[] memory proofs = new IPricePublisher.FeedWithProof[](numFeeds);
        for (uint256 i = 0; i < numFeeds; i++) {
            values[i] = uint32(bound(valueSeeds[i], 0, type(uint32).max/2));
            decimals[i] = int8(bound(decimalSeeds[i], -18, 18)); // common decimal range

            IPricePublisher.Feed memory feed = IPricePublisher.Feed({
                id: feedIds[i],
                votingRoundId: votingRoundId,
                value: int32(values[i]),
                decimals: decimals[i],
                turnoutBIPS: 1000
            });

            proofs[i].body = feed;
            leaves[i] = keccak256(abi.encode(feed));
        }

        for (uint256 i = 0; i < numFeeds; i++) {
            proofs[i].proof = _getProof(i);
        }

        vm.mockCall(
            relayMock,
            abi.encodeWithSelector(IRelay.merkleRoots.selector, ftsoProtocolId, votingRoundId),
            abi.encode(_calculateRoot(leaves))
        );

        // Call function
        ftsoV2PriceStore.publishPrices(proofs);

        // Verify state
        for (uint256 i = 0; i < feedIds.length; i++) {
            (uint256 price, uint256 timestamp, uint256 priceDecimals) = ftsoV2PriceStore.getPrice(symbols[i]);
            int256 decimal = decimals[i];
            uint256 uintDecimals;
            uint256 value = values[i];
            if (decimal < 0) {
                uintDecimals = 0;
                value *= 10 ** uint256(-decimal);
            } else {
                uintDecimals = uint256(decimal);
            }
            assertEq(price, value);
            assertEq(priceDecimals, uintDecimals);
            assertEq(timestamp, endTimestamp);

            (uint256 trustedPrice, , uint256 trustedDecimal, uint8 numOfSubmits) =
                ftsoV2PriceStore.getPriceFromTrustedProvidersWithQuality(symbols[i]);
            decimal = trustedDecimals[i];
            value = trustedFeeds[i].value;
            if (decimal < 0) {
                uintDecimals = 0;
                value *= 10 ** uint256(-decimal);
            } else {
                uintDecimals = uint256(decimal);
            }
            assertEq(numOfSubmits, 1);
            assertEq(trustedDecimal, uintDecimals);
            assertEq(trustedPrice, value);
        }
    }

    // one feed from FTSO scaling and one from FTSOv2 fast updates must both be published for the
    // same voting round, by a single call to publishPrices
    function test_publishPricesFromBothSources() public {
        bytes21 scalingFeedId = bytes21(keccak256("scalingFeed"));
        bytes21 fastUpdatesFeedId = bytes21(keccak256("fastUpdatesFeed"));
        _setMixedFeeds(scalingFeedId, fastUpdatesFeedId);

        // the trusted providers submit the prices of both feeds for the previous voting round
        vm.warp(firstVotingRoundStartTs + 10 * uint256(votingEpochDurationSeconds) + 1);
        uint32 votingRoundId = _getPreviousVotingEpochId();
        vm.warp(_getEndTimestamp(votingRoundId) + 1);
        IPricePublisher.TrustedProviderFeed[] memory trustedFeeds = new IPricePublisher.TrustedProviderFeed[](2);
        trustedFeeds[0] = IPricePublisher.TrustedProviderFeed({ id: scalingFeedId, value: 111, decimals: 5 });
        trustedFeeds[1] = IPricePublisher.TrustedProviderFeed({ id: fastUpdatesFeedId, value: 222, decimals: 5 });
        address trustedProvider = makeAddr("trustedProvider");
        address[] memory trustedProviders = new address[](1);
        trustedProviders[0] = trustedProvider;
        vm.prank(governance);
        ftsoV2PriceStore.setTrustedProviders(trustedProviders, 1);
        vm.prank(trustedProvider);
        ftsoV2PriceStore.submitTrustedPrices(votingRoundId, trustedFeeds);

        // publish as soon as the submission window closes - the previous voting round id is still
        // the same as the voting round id of the proofs
        uint256 endTimestamp = _getEndTimestamp(votingRoundId);
        vm.warp(endTimestamp + ftsoV2PriceStore.submitTrustedPricesWindowSeconds() + 1);
        assertEq(_getPreviousVotingEpochId(), votingRoundId);

        // the scaling feed comes with a Merkle proof - a single leaf, so the root is the leaf itself
        IPricePublisher.FeedWithProof[] memory proofs = new IPricePublisher.FeedWithProof[](1);
        proofs[0].body = IPricePublisher.Feed({
            id: scalingFeedId,
            votingRoundId: votingRoundId,
            value: 1000,
            decimals: 5,
            turnoutBIPS: 10000
        });
        proofs[0].proof = new bytes32[](0);
        vm.mockCall(
            relayMock,
            abi.encodeWithSelector(IRelay.merkleRoots.selector, ftsoProtocolId, votingRoundId),
            abi.encode(keccak256(abi.encode(proofs[0].body)))
        );

        // the fast updates feed is read from the FtsoV2 contract
        bytes21[] memory fastUpdatesFeedIds = new bytes21[](1);
        fastUpdatesFeedIds[0] = fastUpdatesFeedId;
        int256[] memory values = new int256[](1);
        values[0] = 2000;
        int8[] memory decimals = new int8[](1);
        decimals[0] = 5;
        uint64[] memory timestamps = new uint64[](1);
        timestamps[0] = uint64(block.timestamp - 10);
        vm.mockCall(
            contractAddresses[2],
            abi.encodeWithSelector(FtsoV2Interface.getCurrentFeeds.selector, fastUpdatesFeedIds),
            abi.encode(values, decimals, timestamps)
        );

        // only a single PricesPublished event must be emitted, for the voting round of the proofs
        vm.expectEmit(true, true, true, true, address(ftsoV2PriceStore));
        emit IPriceChangeEmitter.PricesPublished(votingRoundId);
        ftsoV2PriceStore.publishPrices(proofs);
        assertEq(ftsoV2PriceStore.lastPublishedVotingRoundId(), votingRoundId);

        // the scaling price is timestamped by the end of the voting round, the fast updates price by its own timestamp
        (uint256 price, uint256 timestamp, uint256 priceDecimals) = ftsoV2PriceStore.getPrice("SCALING");
        assertEq(price, 1000);
        assertEq(priceDecimals, 5);
        assertEq(timestamp, endTimestamp);
        (price, timestamp, priceDecimals) = ftsoV2PriceStore.getPrice("FAST_UPDATES");
        assertEq(price, 2000);
        assertEq(priceDecimals, 5);
        assertEq(timestamp, timestamps[0]);

        // the trusted prices of both feeds are taken from the same voting round
        (price, timestamp, priceDecimals) = ftsoV2PriceStore.getPriceFromTrustedProviders("SCALING");
        assertEq(price, 111);
        assertEq(timestamp, endTimestamp);
        (price, timestamp, priceDecimals) = ftsoV2PriceStore.getPriceFromTrustedProviders("FAST_UPDATES");
        assertEq(price, 222);
        assertEq(timestamp, endTimestamp);
    }

    // no fee may be paid when there are no fast updates feeds - it could not be recovered
    function test_publishPricesRevertsIfFeePaidWithoutFastUpdatesFeeds() public {
        bytes21[] memory scalingIds = new bytes21[](0);
        string[] memory syms = new string[](0);
        int8[] memory dec = new int8[](0);
        vm.prank(governance);
        ftsoV2PriceStore.updateSettings(scalingIds, new bytes21[](0), syms, dec, 500, 0);

        vm.deal(address(this), 1 ether);
        vm.expectRevert(FtsoV2PriceStore.NoFeeRequired.selector);
        ftsoV2PriceStore.publishPrices{ value: 1 }(new IPricePublisher.FeedWithProof[](0));
    }

    function _setMixedFeeds(bytes21 _scalingFeedId, bytes21 _fastUpdatesFeedId) internal {
        bytes21[] memory scalingIds = new bytes21[](1);
        scalingIds[0] = _scalingFeedId;
        bytes21[] memory fastUpdatesIds = new bytes21[](1);
        fastUpdatesIds[0] = _fastUpdatesFeedId;
        string[] memory syms = new string[](2);
        syms[0] = "SCALING";
        syms[1] = "FAST_UPDATES";
        int8[] memory dec = new int8[](2);
        dec[0] = 5;
        dec[1] = 5;
        vm.prank(governance);
        ftsoV2PriceStore.updateSettings(scalingIds, fastUpdatesIds, syms, dec, 500, 0);
    }

    function _getEndTimestamp(uint256 _votingEpochId) internal view returns(uint256) {
        return firstVotingRoundStartTs + (_votingEpochId + 1) * votingEpochDurationSeconds;
    }

    function _setFeeds(
        uint8 _numFeeds,
        int8[4] memory decimalSeeds,
        bytes21[4] memory feedIdSeeds
    )
        internal
    {
        // generate dynamic feedIds, symbols, and trustedDecimals
        feedIds = new bytes21[](_numFeeds);
        symbols = new string[](_numFeeds);
        trustedDecimals = new int8[](_numFeeds);
        for (uint256 i = 0; i < _numFeeds; i++) {
            feedIds[i] = bytes21(keccak256(abi.encode(feedIdSeeds[i], i)));
            symbols[i] =  string.concat("symbol", vm.toString(i));
            trustedDecimals[i] = int8(bound(decimalSeeds[i], -18, 18)); // Common decimal range
        }
        vm.prank(governance);
        ftsoV2PriceStore.updateSettings(feedIds, new bytes21[](0), symbols, trustedDecimals, 500, 0);
    }


    function _calculateRoot(bytes32[] memory _treeLeaves) public returns (bytes32) {
        bytes32 h12 = _hashPair(_treeLeaves[0], _treeLeaves[1]);
        bytes32 h34 = _hashPair(_treeLeaves[2], _treeLeaves[3]);
        return _hashPair(h12, h34);
    }

    function _getProof(uint256 _index) internal returns (bytes32[] memory proof) {
        require(_index < 4, "Index out of bounds");
        proof = new bytes32[](2);

        if (_index == 0) {
            proof[0] = leaves[1];
            proof[1] = _hashPair(leaves[2], leaves[3]);
        } else if (_index == 1) {
            proof[0] = leaves[0];
            proof[1] = _hashPair(leaves[2], leaves[3]);
        } else if (_index == 2) {
            proof[0] = leaves[3];
            proof[1] = _hashPair(leaves[0], leaves[1]);
        } else {
            proof[0] = leaves[2];
            proof[1] = _hashPair(leaves[0], leaves[1]);
        }
    }

    function _hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _getPreviousVotingEpochId() internal view returns(uint32) {
        return uint32((block.timestamp - firstVotingRoundStartTs) / votingEpochDurationSeconds) - 1;
    }
}
