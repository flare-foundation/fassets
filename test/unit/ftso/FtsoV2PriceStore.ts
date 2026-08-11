/* eslint-disable no-var */
import { ZERO_BYTES_20 } from "@flarenetwork/js-flare-common";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestContracts } from "../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { BNish, erc165InterfaceId, MAX_BIPS, toBN, ZERO_ADDRESS } from "../../../lib/utils/helpers";
import { FtsoV2MockInstance, FtsoV2PriceStoreInstance, MockContractInstance } from "../../../typechain-truffle";
import { filterEvents } from "../../../lib/utils/events/truffle";

const FtsoV2PriceStore = artifacts.require('FtsoV2PriceStore');
const FtsoV2PriceStoreProxy = artifacts.require('FtsoV2PriceStoreProxy');
const MockContract = artifacts.require('MockContract');
const FtsoV2Mock = artifacts.require('FtsoV2Mock');

contract(`FtsoV2PriceStore.sol; ${getTestFile(__filename)}; FtsoV2PriceStore basic tests`, accounts => {
    let contracts: TestSettingsContracts;
    let priceStoreImpl: FtsoV2PriceStoreInstance;
    let priceStore: FtsoV2PriceStoreInstance;
    let relayMock: MockContractInstance;
    let ftsoV2Mock: FtsoV2MockInstance;
    const governance = accounts[10];
    const votingEpochDurationSeconds = 90;
    const ftsoScalingProtocolId = 100;
    let startTs: number;

    const trustedProviders = [accounts[1], accounts[2], accounts[3]];
    const feedIds = ["0x01464c522f55534400000000000000000000000000", "0x01555344432f555344000000000000000000000000"];
    const feedSymbols = ["FLR", "USDC"];
    const feedDecimals = [6, 5];

    async function initialize() {
        contracts = await createTestContracts(governance);
        startTs = (await time.latest()).toNumber() - votingEpochDurationSeconds;
        priceStoreImpl = await FtsoV2PriceStore.new();
        const priceStoreProxy = await FtsoV2PriceStoreProxy.new(
            priceStoreImpl.address,
            contracts.governanceSettings.address,
            governance,
            contracts.addressUpdater.address,
            startTs,
            votingEpochDurationSeconds,
            ftsoScalingProtocolId
        );
        priceStore = await FtsoV2PriceStore.at(priceStoreProxy.address);
        relayMock = await MockContract.new();
        ftsoV2Mock = await FtsoV2Mock.new();
        await priceStore.setTrustedProviders(trustedProviders, 1, { from: governance });
        await priceStore.updateSettings(feedIds, feedSymbols, feedDecimals, 50, 0, { from: governance });
        await contracts.addressUpdater.update(["AddressUpdater", "Relay", "FtsoV2"],
            [contracts.addressUpdater.address, relayMock.address, ftsoV2Mock.address],
            [priceStore.address],
            { from: governance });
        return { contracts, priceStore };
    }

    beforeEach(async () => {
        ({ contracts, priceStore } = await loadFixtureCopyVars(initialize));
    });

    describe("initialization", () => {
        it("should revert if deploying contract with invalid start time", async () => {
            await expectRevert.custom(FtsoV2PriceStoreProxy.new(
                priceStoreImpl.address,
                contracts.governanceSettings.address,
                governance,
                contracts.addressUpdater.address,
                startTs + 10,
                votingEpochDurationSeconds,
                ftsoScalingProtocolId
            ), "InvalidStartTime", []);
        });

        it("should revert if deploying contract with too short voting epoch duration", async () => {
            await expectRevert.custom(FtsoV2PriceStoreProxy.new(
                priceStoreImpl.address,
                contracts.governanceSettings.address,
                governance,
                contracts.addressUpdater.address,
                startTs,
                1,
                ftsoScalingProtocolId
            ), "VotingEpochDurationTooShort", []);
        });

    });

    describe("publishing prices", () => {
        it("should revert if wrong number of proofs is provided", async () => {
            // update settings
            const feedIds = ["0x01464c522f55534400000000000000000000000000", "0x01555344432f555344000000000000000000000000"];
            await priceStore.updateSettings(["0x01464c522f55534400000000000000000000000000"], ["FLR"], [6], 50, 0, { from: governance });

            await expectRevert.custom(publishPrices(), "WrongNumberOfProofs", []);
        });

        it("should revert if (newer) prices already published", async () => {
            await publishPrices(true, 2, 2);

            // publish prices for voting round 1
            await expectRevert.custom(publishPrices(false, 1), "PricesAlreadyPublished", []);
        });

        it("should revert if submission window for trusted providers not yet closed", async () => {
            await expectRevert.custom(publishPrices(false, 1), "SubmissionWindowNotClosed", []);
        });

        it("should revert if voting round id mismatch", async () => {
            await expectRevert.custom(publishPrices(true, 1, 2), "VotingRoundIdMismatch", []);
        });

        it("should revert if feed id mismatch", async () => {
            await expectRevert.custom(publishPrices(true, 1, 1, feedIds[0], feedIds[0]), "FeedIdMismatch", []);
        });

        it("should revert if value is negative", async () => {
            await expectRevert.custom(publishPrices(true, 1, 1, feedIds[0], feedIds[1], -1), "ValueMustBeNonNegative", []);
        });

        it("should revert if Merkle proof is invalid", async () => {
            await expectRevert.custom(publishPrices(true, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true), "MerkleProofInvalid", []);
        });

    });

    describe("submitting trusted prices", () => {
        it("should revert if submitter is not trusted provider", async () => {
            await expectRevert.custom(priceStore.submitTrustedPrices(1, []), "OnlyTrustedProvider", []);
        });

        it("should revert if all prices are not provided", async () => {
            const feeds0 = [];
            for (let i = 1; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
            }
            const tx1 = priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await expectRevert.custom(tx1, "AllPricesMustBeProvided", []);
        });

        it("should revert if submission windows is closed", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds + votingEpochDurationSeconds / 2 + 1); // one second after end of submission window
            const feeds0 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
            }
            const tx1 = priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await expectRevert.custom(tx1, "SubmissionWindowClosed", []);
        });

        it("should revert if voting round id mismatch", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
            }
            const tx1 = priceStore.submitTrustedPrices(0, feeds0, { from: trustedProviders[0] });
            await expectRevert.custom(tx1, "VotingRoundIdMismatch", []);
        });

        it("should revert if trying to submit twice", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds);
            const feeds0 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });

            // try to submit again
            const tx1 = priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await expectRevert.custom(tx1, "AlreadySubmitted", []);
        });

        it("should revert if feed id mismatch", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds);
            const feeds0 = [];
            for (let i = feedIds.length - 1; i >= 0; i--) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
            }
            const tx1 = priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await expectRevert.custom(tx1, "FeedIdMismatch", []);
        });

        it("should revert if decimals mismatch", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds);
            const feeds0 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] + 1 });
            }
            const tx1 = priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await expectRevert.custom(tx1, "DecimalsMismatch", []);
        });

        it("should calculate median price from 4 trusted prices", async () => {
            const newTrustedProviders = [accounts[1], accounts[2], accounts[3], accounts[4]];
            await priceStore.setTrustedProviders(newTrustedProviders, 2, { from: governance });

            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            const feeds1 = [];
            const feeds2 = [];
            const feeds3 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
                feeds1.push({ id: feedIds[i], value: 123455, decimals: feedDecimals[i] });
                feeds2.push({ id: feedIds[i], value: 123456, decimals: feedDecimals[i] });
                feeds3.push({ id: feedIds[i], value: 123457, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds0, { from: newTrustedProviders[0] });
            await priceStore.submitTrustedPrices(1, feeds1, { from: newTrustedProviders[1] });
            await priceStore.submitTrustedPrices(1, feeds2, { from: newTrustedProviders[2] });
            await priceStore.submitTrustedPrices(1, feeds3, { from: newTrustedProviders[3] });

            await publishPrices();

            const { 0: price, 1: timestamp, 2: decimals, 3: noOfSubmits } = await priceStore.getPriceFromTrustedProvidersWithQuality(feedSymbols[1]);
            const { 0: price2, 1: timestamp2, 2: decimals2 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            // price should be floor(123456 + 123457) / 2 = 123456
            assertWeb3Equal(price, 123456);
            assertWeb3Equal(price2, 123456);
            assertWeb3Equal(timestamp, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(timestamp2, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, feedDecimals[1]);
            assertWeb3Equal(decimals2, feedDecimals[1]);
            assertWeb3Equal(noOfSubmits, 4);
        });

        it("should calculate median price from 1 trusted price", async () => {
            const newTrustedProviders = [accounts[1]];
            await priceStore.setTrustedProviders(newTrustedProviders, 1, { from: governance });

            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123462, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds0, { from: newTrustedProviders[0] });

            await publishPrices();

            const { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            assertWeb3Equal(price, 123462);

            await time.increaseTo(startTs + 3 * votingEpochDurationSeconds); // start of voting round 3
            feeds0[1].value = 50;
            await priceStore.submitTrustedPrices(2, feeds0, { from: newTrustedProviders[0] });

            await publishPrices(true, 2, 2);

            const { 0: price1, 1: timestamp1, 2: decimals1 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[0]);
            assert(timestamp1.gt(timestamp)); // timestamp should be updated
            const { 0: price2, 1: timestamp2, 2: decimals2 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            // should change as spread is 0 (only one trusted provider)
            assert(!price.eq(price2));
            assert(timestamp2.gt(timestamp)); // timestamp should be updated
            assertWeb3Equal(decimals, decimals2);
        });

        it("should calculate median price from 3 trusted prices but not update it with new one if spread is too big", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            const feeds1 = [];
            const feeds2 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123462, decimals: feedDecimals[i] });
                feeds1.push({ id: feedIds[i], value: 123453, decimals: feedDecimals[i] });
                feeds2.push({ id: feedIds[i], value: 123456, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await priceStore.submitTrustedPrices(1, feeds1, { from: trustedProviders[1] });
            await priceStore.submitTrustedPrices(1, feeds2, { from: trustedProviders[2] });

            await publishPrices();

            const { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            assertWeb3Equal(price, 123456);

            await time.increaseTo(startTs + 3 * votingEpochDurationSeconds); // start of voting round 3
            feeds0[1].value = 50;
            feeds1[1].value = 7;
            feeds2[1].value = 5000;
            await priceStore.submitTrustedPrices(2, feeds0, { from: trustedProviders[0] });
            await priceStore.submitTrustedPrices(2, feeds1, { from: trustedProviders[1] });
            await priceStore.submitTrustedPrices(2, feeds2, { from: trustedProviders[2] });

            await publishPrices(true, 2, 2);

            const { 0: price1, 1: timestamp1, 2: decimals1 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[0]);
            assert(timestamp1.gt(timestamp)); // timestamp should be updated
            const { 0: price2, 1: timestamp2, 2: decimals2 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            // nothing should change as spread is too big
            assertWeb3Equal(price, price2);
            assertWeb3Equal(timestamp, timestamp2);
            assertWeb3Equal(decimals, decimals2);
        });

        async function submitTrustedPrices(votingRoundId: number, providers: string[], prices: BNish[]) {
            for (let p = 0; p < providers.length; p++) {
                const feed: TrustedPriceFeed[] = [];
                for (let i = 0; i < feedIds.length; i++) {
                    feed.push({ id: feedIds[i], value: prices[p], decimals: feedDecimals[i] });
                }
                await priceStore.submitTrustedPrices(votingRoundId, feed, { from: providers[p] });
            }
        }

        it("should clear trusted price submissions when setTrustedProviders is called", async () => {

            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2

            await submitTrustedPrices(1, trustedProviders, [123258, 123255, 123256]);

            const newTrustedProviders = [accounts[1], accounts[11], accounts[12]];
            await priceStore.setTrustedProviders(newTrustedProviders, 2, { from: governance });

            await submitTrustedPrices(1, newTrustedProviders, [123458, 123455, 123456]);

            await publishPrices();

            const { 0: price, 1: timestamp, 2: decimals, 3: noOfSubmits } = await priceStore.getPriceFromTrustedProvidersWithQuality(feedSymbols[1]);
            const { 0: price2, 1: timestamp2, 2: decimals2 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            assertWeb3Equal(noOfSubmits, 3);
            assertWeb3Equal(price, 123456);
            assertWeb3Equal(price2, 123456);
            assertWeb3Equal(timestamp, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(timestamp2, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, feedDecimals[1]);
            assertWeb3Equal(decimals2, feedDecimals[1]);
        });

        it("should calculate median price from 4 trusted prices but not update it with new one if spread is too big", async () => {
            const newTrustedProviders = [accounts[1], accounts[2], accounts[3], accounts[4]];
            await priceStore.setTrustedProviders(newTrustedProviders, 2, { from: governance });

            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            const feeds1 = [];
            const feeds2 = [];
            const feeds3 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123462, decimals: feedDecimals[i] });
                feeds1.push({ id: feedIds[i], value: 123453, decimals: feedDecimals[i] });
                feeds2.push({ id: feedIds[i], value: 123456, decimals: feedDecimals[i] });
                feeds3.push({ id: feedIds[i], value: 123459, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds0, { from: newTrustedProviders[0] });
            await priceStore.submitTrustedPrices(1, feeds1, { from: newTrustedProviders[1] });
            await priceStore.submitTrustedPrices(1, feeds2, { from: newTrustedProviders[2] });
            await priceStore.submitTrustedPrices(1, feeds3, { from: newTrustedProviders[3] });

            await publishPrices();

            const { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            // price should be floor(123456 + 123459) / 2 = 123457
            assertWeb3Equal(price, 123457);

            await time.increaseTo(startTs + 3 * votingEpochDurationSeconds); // start of voting round 3
            feeds0[1].value = 50;
            feeds1[1].value = 7;
            feeds2[1].value = 5000;
            feeds3[1].value = 6000;
            await priceStore.submitTrustedPrices(2, feeds0, { from: newTrustedProviders[0] });
            await priceStore.submitTrustedPrices(2, feeds1, { from: newTrustedProviders[1] });
            await priceStore.submitTrustedPrices(2, feeds2, { from: newTrustedProviders[2] });
            await priceStore.submitTrustedPrices(2, feeds3, { from: newTrustedProviders[3] });

            await publishPrices(true, 2, 2);

            const { 0: price1, 1: timestamp1, 2: decimals1 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[0]);
            assert(timestamp1.gt(timestamp)); // timestamp should be updated
            const { 0: price2, 1: timestamp2, 2: decimals2 } = await priceStore.getPriceFromTrustedProviders(feedSymbols[1]);
            // nothing should change as spread is too big
            assertWeb3Equal(price, price2);
            assertWeb3Equal(timestamp, timestamp2);
            assertWeb3Equal(decimals, decimals2);
        });
    });

    describe("update settings", () => {
        it("should revert if not governance", async () => {
            await expectRevert.custom(priceStore.updateSettings([], [], [], 50, 0), "OnlyGovernance", []);
        });

        it("should revert if lengths mismatch", async () => {
            await expectRevert.custom(priceStore.updateSettings([], [], [6], 50, 0, { from: governance }), "LengthMismatch", []);
        });

        it("should revert if max spread too big", async () => {
            await expectRevert.custom(priceStore.updateSettings([], [], [], 10001, 0, { from: governance }), "MaxSpreadTooBig", []);
        });

        it("should revert if min turnout too big", async () => {
            await expectRevert.custom(priceStore.updateSettings([], [], [], 50, 10001, { from: governance }), "MinTurnoutTooBig", []);
        });

        it("should delete trusted price for a symbol if changing decimals", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            const feeds1 = [];
            const feeds2 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
                feeds1.push({ id: feedIds[i], value: 123455, decimals: feedDecimals[i] });
                feeds2.push({ id: feedIds[i], value: 123456, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds1, { from: trustedProviders[1] });
            await priceStore.submitTrustedPrices(1, feeds2, { from: trustedProviders[2] });
            await priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });

            await publishPrices();

            var { 0: price, 1: timestamp, 2: decimals, 3: turnout } = await priceStore.getPriceFromTrustedProvidersWithQuality("USDC");
            assertWeb3Equal(price, 123456);
            assertWeb3Equal(timestamp, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 5);
            assertWeb3Equal(turnout, 3);

            // update settings; change trusted decimals for USDC
            await priceStore.updateSettings(feedIds, feedSymbols, [6, 4], 50, 0, { from: governance });
            var { 0: price, 1: timestamp, 2: decimals, 3: turnout } = await priceStore.getPriceFromTrustedProvidersWithQuality("USDC");
            assertWeb3Equal(price, 0);
            assertWeb3Equal(timestamp, startTs + 1 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 4);
            assertWeb3Equal(turnout, 0);
        });

        it("should delete submitted trusted prices and therefore not calculate median price", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            const feeds1 = [];
            const feeds2 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
                feeds1.push({ id: feedIds[i], value: 123455, decimals: feedDecimals[i] });
                feeds2.push({ id: feedIds[i], value: 123456, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await priceStore.submitTrustedPrices(1, feeds1, { from: trustedProviders[1] });
            await priceStore.submitTrustedPrices(1, feeds2, { from: trustedProviders[2] });

            // go to voting round 3
            await time.increaseTo(startTs + 3 * votingEpochDurationSeconds);
            await priceStore.submitTrustedPrices(2, feeds0, { from: trustedProviders[0] });
            await priceStore.submitTrustedPrices(2, feeds1, { from: trustedProviders[1] });
            await priceStore.submitTrustedPrices(2, feeds2, { from: trustedProviders[2] });

            var { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders("USDC");
            assertWeb3Equal(price, 0);
            assertWeb3Equal(timestamp, startTs + 1 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 5);

            // update settings; change trusted decimals for USDC
            const newUSDCDecimals = 4;
            await priceStore.updateSettings(feedIds, feedSymbols, [feedDecimals[0], newUSDCDecimals], 50, 0, { from: governance });
            var { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders("USDC");
            assertWeb3Equal(price, 0);
            assertWeb3Equal(timestamp, startTs + 1 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 4);

            var { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPrice("USDC");
            assertWeb3Equal(price, 0);
            assertWeb3Equal(timestamp, startTs + 1 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 0);

            // publish prices for voting round 1
            await publishPrices(false, 1, 1, undefined, undefined, undefined, undefined, feedDecimals[0], newUSDCDecimals);

            var { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders("USDC");
            assertWeb3Equal(price, 0);
            assertWeb3Equal(timestamp, startTs + 1 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 4);

            var { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPrice("USDC");
            assertWeb3Equal(price, 123456);
            assertWeb3Equal(timestamp, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 4);
        });
    });

    describe("set trusted providers", () => {
        it ("should revert if not governance", async () => {
            await expectRevert.custom(priceStore.setTrustedProviders([], 1), "OnlyGovernance", []);
        });

        it("should revert if threshold is too high", async () => {
            await expectRevert.custom(priceStore.setTrustedProviders(trustedProviders, 4, { from: governance }), "ThresholdTooHigh", []);
        });

        it("should revert if too many trusted providers", async () => {
            await expectRevert.custom(priceStore.setTrustedProviders(accounts, 2, { from: governance }), "TooManyTrustedProviders", []);
        });

        it("should change trusted providers", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
            }
            await priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });

            // remove trusted provider 0 and replace it
            await priceStore.setTrustedProviders([trustedProviders[1], trustedProviders[2], accounts[123]], 1, { from: governance });

            // go to voting round 3
            await time.increaseTo(startTs + 3 * votingEpochDurationSeconds);

            // trusted provider 0 should not be able to submit prices
            await expectRevert.custom(priceStore.submitTrustedPrices(2, feeds0, { from: trustedProviders[0] }), "OnlyTrustedProvider", []);

            // new trusted provider can submit prices
            await priceStore.submitTrustedPrices(2, feeds0, { from: accounts[123] });
        });

    });

    describe("get prices", () => {
        it("should get price", async () => {
            await publishPrices();

            const { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPrice("USDC");
            assertWeb3Equal(price, 123456);
            assertWeb3Equal(timestamp, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 5);
        });

        it("should revert if symbol is not supported", async () => {
            await expectRevert.custom(priceStore.getPrice("USDT"), "SymbolNotSupported", []);
        });

        it("should get price if decimals are negative", async () => {
            await publishPrices(true, undefined, undefined, undefined, undefined, undefined, undefined, undefined, -2);

            var { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPrice("FLR");
            assertWeb3Equal(price, 123123);
            assertWeb3Equal(decimals, feedDecimals[0]);

            // decimals are -2
            var { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPrice("USDC");
            assertWeb3Equal(price, 123456 * 10 ** 2);
            assertWeb3Equal(decimals, 0);
        });

        //// get trusted prices
        it("should get trusted price", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            const feeds1 = [];
            const feeds2 = [];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: feedDecimals[i] });
                feeds1.push({ id: feedIds[i], value: 123455, decimals: feedDecimals[i] });
                feeds2.push({ id: feedIds[i], value: 123456, decimals: feedDecimals[i] });
            }
            const tx1 = await priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            console.log(`submitTrustedPrices1 gas used: ${tx1.receipt.gasUsed}`);   // eslint-disable-line @typescript-eslint/no-unsafe-member-access
            const tx2 = await priceStore.submitTrustedPrices(1, feeds1, { from: trustedProviders[1] });
            console.log(`submitTrustedPrices2 gas used: ${tx2.receipt.gasUsed}`);   // eslint-disable-line @typescript-eslint/no-unsafe-member-access
            const tx3 = await priceStore.submitTrustedPrices(1, feeds2, { from: trustedProviders[2] });
            console.log(`submitTrustedPrices3 gas used: ${tx3.receipt.gasUsed}`);   // eslint-disable-line @typescript-eslint/no-unsafe-member-access

            await publishPrices(true, undefined, undefined, undefined, undefined, undefined, undefined, undefined, -2);

            const { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders("USDC");
            assertWeb3Equal(price, 123456);
            assertWeb3Equal(timestamp, startTs + 2 * votingEpochDurationSeconds);
            assertWeb3Equal(decimals, 5);
        });

        it("should revert if symbol is not supported", async () => {
            await expectRevert.custom(priceStore.getPriceFromTrustedProviders("USDT"), "SymbolNotSupported", []);
        });

        it("should revert if getting price from trusted providers with quality for unsupported symbol", async () => {
            await expectRevert.custom(priceStore.getPriceFromTrustedProvidersWithQuality(ZERO_BYTES_20), "SymbolNotSupported", []);
        });

        it("should get trusted price if decimals are negative", async () => {
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds); // start of voting round 2
            const feeds0 = [];
            const feeds1 = [];
            const feeds2 = [];
            const newFeedDecimals = [3, -4];
            for (let i = 0; i < feedIds.length; i++) {
                feeds0.push({ id: feedIds[i], value: 123458, decimals: newFeedDecimals[i] });
                feeds1.push({ id: feedIds[i], value: 123455, decimals: newFeedDecimals[i] });
                feeds2.push({ id: feedIds[i], value: 123456, decimals: newFeedDecimals[i] });
            }
            await priceStore.updateSettings(feedIds, feedSymbols, newFeedDecimals, 50, 0, { from: governance });
            await priceStore.submitTrustedPrices(1, feeds0, { from: trustedProviders[0] });
            await priceStore.submitTrustedPrices(1, feeds1, { from: trustedProviders[1] });

            await publishPrices();


            const { 0: price, 1: timestamp, 2: decimals } = await priceStore.getPriceFromTrustedProviders("FLR");
            assertWeb3Equal(price, 123456);
            assertWeb3Equal(decimals, newFeedDecimals[0]);

            const { 0: price1, 1: timestamp1, 2: decimals1 } = await priceStore.getPriceFromTrustedProviders("USDC");
            assertWeb3Equal(price1, 123456 * 10 ** 4);
            assertWeb3Equal(decimals1, 0);
        });

    });

    describe("reading settings", () => {
        it("should get feed ids", async () => {
            const feeds = await priceStore.getFeedIds();
            expect(feeds.toString()).to.eq(feedIds.toString());
        });

        it("should get feed ids and decimals", async () => {
            const {0: feeds, 1: decimals} = await priceStore.getFeedIdsWithDecimals();
            expect(feeds.toString()).to.eq(feedIds.toString());
            expect(decimals.toString()).to.eq(feedDecimals.toString());
        });

        it("should get supported symbols", async () => {
            const symbols = await priceStore.getSymbols();
            expect(symbols.toString()).to.eq(feedSymbols.toString());
        });

        it("should get feed id for symbol", async () => {
            const flrFeed = await priceStore.getFeedId("FLR");
            expect(flrFeed).to.eq(feedIds[0]);

            const usdcFeed = await priceStore.getFeedId("USDC");
            expect(usdcFeed).to.eq(feedIds[1]);

            let xdcFeed = await priceStore.getFeedId("SGB");
            expect(xdcFeed).to.eq("0x" + "00".repeat(21));

            // update settings
            await priceStore.updateSettings(
                ["0x01464c522f55534400000000000000000000000000", "0x01555344432f555344000000000000000000000000", "0x015452582f55534400000000000000000000000000"],
                ["FLR", "USDC", "XDC"],
                [6, 7, 8],
                50, 0,
                { from: governance });

            xdcFeed = await priceStore.getFeedId("XDC");
            expect(xdcFeed).to.eq("0x015452582f55534400000000000000000000000000");
        });

        it("should get trusted providers", async () => {
            let trProviders = await priceStore.getTrustedProviders();
            expect(trProviders.toString()).to.eq(trustedProviders.toString());

            // update trusted providers
            const newTrustedProviders = [accounts[1], accounts[2], accounts[4], accounts[5]];
            await priceStore.setTrustedProviders(newTrustedProviders, 2, { from: governance });

            trProviders = await priceStore.getTrustedProviders();
            expect(trProviders.toString()).to.eq(newTrustedProviders.toString());
        });

    });

    describe("minimum turnout", () => {
        it("should set minTurnoutBIPS", async () => {
            await priceStore.setMinTurnoutBIPS(1234, { from: governance });
            assertWeb3Equal(await priceStore.minTurnoutBIPS(), 1234);
        });

        it("only governance can set minTurnoutBIPS", async () => {
            await expectRevert.custom(priceStore.setMinTurnoutBIPS(1234, { from: accounts[15] }), "OnlyGovernance", []);
        });

        it("should revert if minTurnoutBIPS is set to higher than MAX_BIPS", async () => {
            await expectRevert.custom(priceStore.setMinTurnoutBIPS(MAX_BIPS + 1, { from: governance }), "MinTurnoutTooBig", []);
            // but MAX_BIPS works
            await priceStore.setMinTurnoutBIPS(MAX_BIPS, { from: governance });
        });

        it("should publish all prices if turnout is high enough", async () => {
            await priceStore.setMinTurnoutBIPS(6000, { from: governance });
            const feed0: PriceFeed = { votingRoundId: 1, id: feedIds[0], value: 1234, turnoutBIPS: 6000, decimals: 5 };
            const feed1: PriceFeed = { votingRoundId: 1, id: feedIds[1], value: 12345, turnoutBIPS: 6000, decimals: 5 };
            const res = await publishPriceFeeds(feed0, feed1);
            expectEvent.notEmitted(res, "LowTurnoutForFeed");
            assertWeb3Equal((await priceStore.getPrice("FLR"))[0], 1234);
            assertWeb3Equal((await priceStore.getPrice("USDC"))[0], 12345);
        });

        it("should only publish prices for which turnout is high enough", async () => {
            await priceStore.setMinTurnoutBIPS(6000, { from: governance });
            // init prices
            const feed0: PriceFeed = { votingRoundId: 1, id: feedIds[0], value: 1000, turnoutBIPS: 10000, decimals: 5 };
            const feed1: PriceFeed = { votingRoundId: 1, id: feedIds[1], value: 1001, turnoutBIPS: 10000, decimals: 5 };
            await publishPriceFeeds(feed0, feed1);
            // change prices (only second feed has turnout high enough)
            const feed0_1: PriceFeed = { votingRoundId: 2, id: feedIds[0], value: 2000, turnoutBIPS: 5999, decimals: 5 };
            const feed1_1: PriceFeed = { votingRoundId: 2, id: feedIds[1], value: 2001, turnoutBIPS: 6000, decimals: 5 };
            const res1 = await publishPriceFeeds(feed0_1, feed1_1);
            expectEvent(res1, "LowTurnoutForFeed", { feedId: feedIds[0].padEnd(66, "0"), votingRoundId: 2, turnoutBIPS: 5999 });
            assert.equal(filterEvents(res1, "LowTurnoutForFeed").length, 1);
            assertWeb3Equal((await priceStore.getPrice("FLR"))[0], 1000);
            assertWeb3Equal((await priceStore.getPrice("USDC"))[0], 2001);
        });
    });

    describe("publishing prices from fast updates", () => {

        // sets the feeds on the FtsoV2 mock and switches the price store to fast updates
        async function enableFastUpdates(value0: BNish = 123123, value1: BNish = 123456,
            decimals0: number = feedDecimals[0], decimals1: number = feedDecimals[1]
        ) {
            await ftsoV2Mock.setFeed(feedIds[0], value0, decimals0);
            await ftsoV2Mock.setFeed(feedIds[1], value1, decimals1);
            await priceStore.setUseFtsoV2FastUpdates(true, { from: governance });
        }

        // increases time to the end of the submission window of `votingRound` and publishes the prices
        async function publishPricesFromFastUpdates(votingRound: number = 1, fee?: BNish) {
            await time.increaseTo(endOfRevealTime(votingRound));
            return fee != null
                ? await priceStore.publishPricesFromFastUpdates({ value: String(fee) })
                : await priceStore.publishPricesFromFastUpdates();
        }

        async function submitTrustedPrices(votingRoundId: number, providers: string[], prices: BNish[]) {
            for (let p = 0; p < providers.length; p++) {
                const feed: TrustedPriceFeed[] = [];
                for (let i = 0; i < feedIds.length; i++) {
                    feed.push({ id: feedIds[i], value: prices[p], decimals: feedDecimals[i] });
                }
                await priceStore.submitTrustedPrices(votingRoundId, feed, { from: providers[p] });
            }
        }

        it("only governance can enable fast updates", async () => {
            await expectRevert.custom(priceStore.setUseFtsoV2FastUpdates(true, { from: accounts[15] }), "OnlyGovernance", []);
        });

        it("should not enable fast updates before the FtsoV2 contract address is set", async () => {
            // create a price store that has not received the contract addresses yet
            const priceStoreProxy = await FtsoV2PriceStoreProxy.new(priceStoreImpl.address, contracts.governanceSettings.address,
                governance, contracts.addressUpdater.address, startTs, votingEpochDurationSeconds, ftsoScalingProtocolId);
            const newPriceStore = await FtsoV2PriceStore.at(priceStoreProxy.address);
            assert.equal(await newPriceStore.ftsoV2FastUpdates(), ZERO_ADDRESS);
            await expectRevert.custom(newPriceStore.setUseFtsoV2FastUpdates(true, { from: governance }), "FtsoV2FastUpdatesContractNotSet", []);
        });

        it("should not publish prices from fast updates when they are not enabled", async () => {
            assert.isFalse(await priceStore.useFtsoV2FastUpdates());
            await expectRevert.custom(priceStore.publishPricesFromFastUpdates(), "UsePublishPrices", []);
        });

        it("should not publish prices with proofs when fast updates are enabled", async () => {
            await enableFastUpdates();
            assert.isTrue(await priceStore.useFtsoV2FastUpdates());
            await expectRevert.custom(publishPrices(), "UsePublishPricesFromFastUpdates", []);
        });

        it("should publish prices from fast updates", async () => {
            await enableFastUpdates();
            const feedsTimestamp = endOfRevealTime(1) - 10;
            await ftsoV2Mock.setFeedsTimestamp(feedsTimestamp);
            const res = await publishPricesFromFastUpdates(1);
            expectEvent(res, "PricesPublished", { votingRoundId: "1" });
            assertWeb3Equal(await priceStore.lastPublishedVotingRoundId(), 1);
            // the reported timestamp is the feed timestamp, not the end of the voting round
            const { 0: price0, 1: timestamp0, 2: decimals0 } = await priceStore.getPrice(feedSymbols[0]);
            assertWeb3Equal(price0, 123123);
            assertWeb3Equal(timestamp0, feedsTimestamp);
            assertWeb3Equal(decimals0, feedDecimals[0]);
            const { 0: price1, 1: timestamp1, 2: decimals1 } = await priceStore.getPrice(feedSymbols[1]);
            assertWeb3Equal(price1, 123456);
            assertWeb3Equal(timestamp1, feedsTimestamp);
            assertWeb3Equal(decimals1, feedDecimals[1]);
        });

        it("should also calculate trusted prices when publishing from fast updates", async () => {
            await enableFastUpdates();
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds);   // start of voting round 2
            await submitTrustedPrices(1, trustedProviders, [123258, 123255, 123256]);
            await publishPricesFromFastUpdates(1);
            const { 0: price, 1: timestamp, 2: decimals, 3: noOfSubmits } =
                await priceStore.getPriceFromTrustedProvidersWithQuality(feedSymbols[1]);
            assertWeb3Equal(price, 123256);
            assertWeb3Equal(noOfSubmits, 3);
            assertWeb3Equal(decimals, feedDecimals[1]);
            // the trusted price timestamp is still the end of the voting round
            assertWeb3Equal(timestamp, startTs + 2 * votingEpochDurationSeconds);
        });

        it("should not publish prices from fast updates twice for the same voting round", async () => {
            await enableFastUpdates();
            await publishPricesFromFastUpdates(1);
            await expectRevert.custom(priceStore.publishPricesFromFastUpdates(), "PricesAlreadyPublished", []);
        });

        it("should not publish prices from fast updates before the submission window closes", async () => {
            await enableFastUpdates();
            await time.increaseTo(startTs + 2 * votingEpochDurationSeconds);   // start of voting round 2
            await expectRevert.custom(priceStore.publishPricesFromFastUpdates(), "SubmissionWindowNotClosed", []);
        });

        it("should not publish too old prices from fast updates", async () => {
            await enableFastUpdates();
            // the feeds must not be older than the start of the published voting round
            await ftsoV2Mock.setFeedsTimestamp(startTs + votingEpochDurationSeconds - 1);
            await time.increaseTo(endOfRevealTime(1));
            await expectRevert.custom(priceStore.publishPricesFromFastUpdates(), "FastUpdatesFeedTooOld", []);
            // exactly at the start of the voting round the feeds are still fresh enough
            await ftsoV2Mock.setFeedsTimestamp(startTs + votingEpochDurationSeconds);
            await priceStore.publishPricesFromFastUpdates();
            assertWeb3Equal(await priceStore.lastPublishedVotingRoundId(), 1);
        });

        it("should rescale feed values that do not fit into uint32", async () => {
            await enableFastUpdates(toBN("12345678901234"), 1000, 8, 5);
            await publishPricesFromFastUpdates(1);
            // the value is divided by 10^4 to fit into uint32 and the decimals are reduced by 4,
            // so the price 12345678901234e-8 is published as 1234567890e-4
            const { 0: price0, 2: decimals0 } = await priceStore.getPrice(feedSymbols[0]);
            assertWeb3Equal(price0, 1234567890);
            assertWeb3Equal(decimals0, 4);
            // a value that fits into uint32 is published unchanged
            const { 0: price1, 2: decimals1 } = await priceStore.getPrice(feedSymbols[1]);
            assertWeb3Equal(price1, 1000);
            assertWeb3Equal(decimals1, 5);
        });

        it("should read a rescaled price with negative decimals", async () => {
            // 10^20 with 0 decimals has to be divided by 10^11, which makes the stored decimals negative (-11)
            await enableFastUpdates(toBN(10).pow(toBN(20)), 1000, 0, 5);
            await publishPricesFromFastUpdates(1);
            // getPrice multiplies the value back when the decimals are negative
            const { 0: price, 2: decimals } = await priceStore.getPrice(feedSymbols[0]);
            assertWeb3Equal(price, toBN(10).pow(toBN(20)));
            assertWeb3Equal(decimals, 0);
        });

        it("should forward the feed fee to the FtsoV2 contract", async () => {
            await enableFastUpdates();
            await ftsoV2Mock.setFeePerFeed(10);
            await time.increaseTo(endOfRevealTime(1));
            // reading the feeds fails when the fee is not paid
            await expectRevert.custom(priceStore.publishPricesFromFastUpdates(), "FeeTooLow", []);
            // the caller has to send the fee for all the feeds
            await priceStore.publishPricesFromFastUpdates({ value: "20" });
            assertWeb3Equal(await web3.eth.getBalance(ftsoV2Mock.address), 20);
            assertWeb3Equal(await web3.eth.getBalance(priceStore.address), 0);
        });

        it("should switch back to publishing prices with proofs", async () => {
            await enableFastUpdates(50000, 60000);
            const feedsTimestamp = endOfRevealTime(1) - 10;
            await ftsoV2Mock.setFeedsTimestamp(feedsTimestamp);
            await publishPricesFromFastUpdates(1);
            const { 0: fastPrice, 1: fastTimestamp } = await priceStore.getPrice(feedSymbols[0]);
            assertWeb3Equal(fastPrice, 50000);
            assertWeb3Equal(fastTimestamp, feedsTimestamp);
            // switch back to FTSO scaling
            await priceStore.setUseFtsoV2FastUpdates(false, { from: governance });
            await expectRevert.custom(priceStore.publishPricesFromFastUpdates(), "UsePublishPrices", []);
            // the prices published with proofs report the end of the voting round as the timestamp again
            await publishPrices(true, 2, 2);
            const { 0: price, 1: timestamp } = await priceStore.getPrice(feedSymbols[0]);
            assertWeb3Equal(price, 123123);
            assertWeb3Equal(timestamp, startTs + 3 * votingEpochDurationSeconds);
        });
    });

    describe("upgrade", () => {
        it("should update contract addresses", async () => {
            await contracts.addressUpdater.update(["AddressUpdater", "Relay", "FtsoV2"],
                [accounts[79], accounts[80], accounts[81]],
                [priceStore.address],
                { from: governance });
            assert.equal(await priceStore.getAddressUpdater(), accounts[79]);
            assert.equal(await priceStore.relay(), accounts[80]);
            assert.equal(await priceStore.ftsoV2FastUpdates(), accounts[81]);
        });

        it("should upgrade and downgrade", async () => {
            const FtsoV2PriceStoreMock = artifacts.require('FtsoV2PriceStoreMock');
            const mockStore = await FtsoV2PriceStoreMock.at(priceStore.address);
            const mockStoreImpl = await FtsoV2PriceStoreMock.new();
            // should not support setCurrentPrice at start
            await expectRevert(mockStore.setCurrentPrice("USDC", "123456", 0), "function selector was not recognized and there's no fallback function");
            assertWeb3Equal((await mockStore.getPrice("USDC"))[0], "0");
            // upgrade
            await priceStore.upgradeTo(mockStoreImpl.address, { from: governance });
            // setCurrentPrice should work now
            await mockStore.setCurrentPrice("USDC", "123456", 0);
            assertWeb3Equal((await mockStore.getPrice("USDC"))[0], "123456");
            // downgrade
            const priceStoreImpl = await FtsoV2PriceStore.new();
            await priceStore.upgradeTo(priceStoreImpl.address, { from: governance });
            // setCurrentPrice should not work anymore
            await expectRevert(mockStore.setCurrentPrice("USDC", "100000", 0), "function selector was not recognized and there's no fallback function");
            assertWeb3Equal((await mockStore.getPrice("USDC"))[0], "123456");
        });
    });

    describe("ERC-165 interface identification", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as 'IERC165');
            const IPriceReader = artifacts.require("IPriceReader");
            const IPricePublisher = artifacts.require("IPricePublisher");
            const iERC165 = await IERC165.at(priceStore.address);
            const iPriceReader = await IPriceReader.at(priceStore.address);
            const iPricePublisher = await IPricePublisher.at(priceStore.address);
            assert.isTrue(await priceStore.supportsInterface(erc165InterfaceId(iERC165.abi)));
            assert.isTrue(await priceStore.supportsInterface(erc165InterfaceId(iPriceReader.abi)));
            assert.isTrue(await priceStore.supportsInterface(erc165InterfaceId(iPricePublisher.abi)));
            assert.isFalse(await priceStore.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });

    type PriceFeed = Parameters<FtsoV2PriceStoreInstance["publishPrices"]>[0][0]["body"];
    type TrustedPriceFeed = Parameters<FtsoV2PriceStoreInstance["submitTrustedPrices"]>[1][0];

    async function publishPrices(increaseTime = true, votingRound1: number = 1, votingRound2: number = 1, feedId1: string = feedIds[0], feedId2: string = feedIds[1], value1: number = 123123, value2: number = 123456, decimals1: number = feedDecimals[0], decimals2: number = feedDecimals[1], zeroRoot: boolean = false) {
        const feed0: PriceFeed = { votingRoundId: votingRound1, id: feedId1, value: value1, turnoutBIPS: 10000, decimals: decimals1 };
        const feed1: PriceFeed = { votingRoundId: votingRound2, id: feedId2, value: value2, turnoutBIPS: 10000, decimals: decimals2 };
        await publishPriceFeeds(feed0, feed1, increaseTime, votingRound1, zeroRoot);
    }

    function endOfRevealTime(votingRound: number) {
        return startTs + (votingRound + 1) * votingEpochDurationSeconds + votingEpochDurationSeconds / 2;
    }

    async function publishPriceFeeds(feed0: PriceFeed, feed1: PriceFeed, increaseTime: boolean = true, votingRound: number = Number(feed0.votingRoundId), zeroRoot: boolean = false) {
        if (increaseTime) {
            // increase time to the end of reveal time and submission window of voting round
            await time.increaseTo(endOfRevealTime(votingRound));
        }

        const leaf0 = web3.utils.keccak256(web3.eth.abi.encodeParameters(
            ["tuple(uint32,bytes21,int32,uint16,int8)"], // IFtsoFeedPublisher.Feed (uint32 votingRoundId, bytes21 id, int32 value, uint16 turnoutBIPS, int8 decimals)
            [[feed0.votingRoundId, feed0.id, feed0.value, feed0.turnoutBIPS, feed0.decimals]]
        ));

        const leaf1 = web3.utils.keccak256(web3.eth.abi.encodeParameters(
            ["tuple(uint32,bytes21,int32,uint16,int8)"], // IFtsoFeedPublisher.Feed (uint32 votingRoundId, bytes21 id, int32 value, uint16 turnoutBIPS, int8 decimals)
            [[feed1.votingRoundId, feed1.id, feed1.value, feed1.turnoutBIPS, feed1.decimals]]
        ));

        const merkleRoot = web3.utils.keccak256(web3.eth.abi.encodeParameters(
            ["bytes32", "bytes32"],
            leaf0 < leaf1 ? [leaf0, leaf1] : [leaf1, leaf0]
        ));

        if (zeroRoot) {
            await relayMock.givenCalldataReturn(
                web3.eth.abi.encodeFunctionCall({ type: "function", name: "merkleRoots", inputs: [{ name: "_protocolId", type: "uint256" }, { name: "_votingRoundId", type: "uint256" }] } as AbiItem, [String(ftsoScalingProtocolId), String(votingRound)]),
                web3.eth.abi.encodeParameter("bytes32", "0x" + "00".repeat(32))
            );
        } else {
            await relayMock.givenCalldataReturn(
                web3.eth.abi.encodeFunctionCall({ type: "function", name: "merkleRoots", inputs: [{ name: "_protocolId", type: "uint256" }, { name: "_votingRoundId", type: "uint256" }] } as AbiItem, [String(ftsoScalingProtocolId), String(votingRound)]),
                web3.eth.abi.encodeParameter("bytes32", merkleRoot)
            );
        }

        const tx = await priceStore.publishPrices([{ proof: [leaf1], body: feed0 }, { proof: [leaf0], body: feed1 }]);
        console.log(`publishPrices gas used: ${tx.receipt.gasUsed}`);   // eslint-disable-line @typescript-eslint/no-unsafe-member-access
        return tx;
    }
});
