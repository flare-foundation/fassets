import { feedSettings, readFtsoV2Parameters } from "../../lib/deploy-ftsov2-price-store";
import { runDeployScript } from "../../lib/deploy-scripts";
import { performGovernanceCall } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;

    const { contracts, artifacts } = deployScriptEnvironment;

    const FtsoV2PriceStore = artifacts.require("FtsoV2PriceStore");
    const ftsoV2PriceStore = await FtsoV2PriceStore.at(contracts.FtsoV2PriceStore!.address);

    // update FtsoV2PriceStore settings
    const parameters = readFtsoV2Parameters();
    const feeds = feedSettings(parameters);
    await performGovernanceCall(deployScriptEnvironment, "FtsoV2PriceStore",
        ftsoV2PriceStore, "updateSettings",
        [
            feeds.scalingFeedIds,
            feeds.fastUpdatesFeedIds,
            feeds.symbols,
            feeds.feedDecimals,
            parameters.maxSpreadBIPS,
            parameters.minTurnoutBIPS,
        ],
        execute);
});
