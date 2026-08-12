import hre from "hardhat";
import { decodeFeedId } from "../../lib/deploy-ftsov2-price-store";
import { loadCurrentDeployContracts, runAsyncMain } from "../../lib/deploy-utils";

// feed categories, as defined by FTSOv2 (https://dev.flare.network/ftso/feeds)
const CATEGORY_NAMES: Record<number, string> = {
    1: "Crypto",
    2: "Foreign exchange",
    3: "Commodity",
    4: "Equity",
};

function categoryName(category: number) {
    return CATEGORY_NAMES[category] ?? "unknown";
}

runAsyncMain(async () => {
    const artifacts = hre.artifacts as Truffle.Artifacts;
    const contracts = loadCurrentDeployContracts(false);

    const FtsoV2 = artifacts.require("FtsoV2Interface");
    const ftsoV2 = await FtsoV2.at(contracts.FtsoV2.address);

    console.log(`FtsoV2 at ${ftsoV2.address} (network ${hre.network.name}, protocol id ${await ftsoV2.getFtsoProtocolId()})`);

    // feeds used by the FAsset system, so that they can be marked in the listing
    const usedFeedIds = new Set<string>();
    if (contracts.FtsoV2PriceStore != null) {
        const FtsoV2PriceStore = artifacts.require("FtsoV2PriceStore");
        const priceStore = await FtsoV2PriceStore.at(contracts.FtsoV2PriceStore.address);
        for (const feedId of await priceStore.getFeedIds()) {
            usedFeedIds.add(feedId.toLowerCase());
        }
    }

    const feedIds = await ftsoV2.getSupportedFeedIds();
    console.log(`\nSupported feeds (${feedIds.length}):`);
    for (const feedId of feedIds) {
        const { category, name } = decodeFeedId(feedId);
        const used = usedFeedIds.has(feedId.toLowerCase()) ? "   <-- used by FAsset" : "";
        console.log(`    ${feedId}  ${name.padEnd(20)} ${categoryName(category)}${used}`);
    }

    const feedIdChanges = await ftsoV2.getFeedIdChanges();
    if (feedIdChanges.length > 0) {
        console.log(`\nFeed id changes (${feedIdChanges.length}):`);
        for (const change of feedIdChanges) {
            const oldFeed = decodeFeedId(change.oldFeedId);
            const newFeed = decodeFeedId(change.newFeedId);
            console.log(`    ${change.oldFeedId} (${oldFeed.name}) -> ${change.newFeedId} (${newFeed.name})`);
        }
    }

    // report FAsset feeds that are no longer supported by FtsoV2
    const supportedFeedIds = new Set(feedIds.map(feedId => feedId.toLowerCase()));
    const unsupported = Array.from(usedFeedIds).filter(feedId => !supportedFeedIds.has(feedId));
    if (unsupported.length > 0) {
        console.log(`\nWARNING: feeds used by FtsoV2PriceStore that are not supported by FtsoV2 (${unsupported.length}):`);
        for (const feedId of unsupported) {
            console.log(`    ${feedId}  ${decodeFeedId(feedId).name}`);
        }
    }
});
