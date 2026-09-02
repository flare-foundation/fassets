import { encodeFeedIds, readFtsoV2Parameters } from "../../lib/deploy-ftsov2-price-store";
import { runDeployScript } from "../../lib/deploy-scripts";
import { performGovernanceCall } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;

    const { contracts, artifacts } = deployScriptEnvironment;

    const FtsoV2PriceStore = artifacts.require("FtsoV2PriceStore");
    const ftsoV2PriceStore = await FtsoV2PriceStore.at(contracts.FtsoV2PriceStore!.address);

    const parameters = readFtsoV2Parameters();

    // // update FtsoV2PriceStore settings
    // await performGovernanceCall(deployScriptEnvironment, "FtsoV2PriceStore",
    //     ftsoV2PriceStore, "updateSettings",
    //     [
    //         encodeFeedIds(parameters.feeds.map(feed => ({ category: 1, name: feed.feedId }))),
    //         parameters.feeds.map(feed => feed.symbol),
    //         parameters.feeds.map(feed => feed.feedDecimals),
    //         parameters.maxSpreadBIPS,
    //         parameters.minTurnoutBIPS,
    //     ],
    //     execute);
});
