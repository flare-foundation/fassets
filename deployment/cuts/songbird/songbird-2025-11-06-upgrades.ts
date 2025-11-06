import { runDeployScript } from "../../lib/deploy-scripts";
import { performGovernanceCall, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;

    const { contracts, artifacts } = deployScriptEnvironment;

    await upgradeGovernedProxy(deployScriptEnvironment, "FtsoV2PriceStore", "FtsoV2PriceStoreImplementation", "FtsoV2PriceStore", execute);

    const FtsoV2PriceStore = artifacts.require("FtsoV2PriceStore");
    const priceStore = await FtsoV2PriceStore.at(contracts.getAddress("FtsoV2PriceStore"));
    await performGovernanceCall(deployScriptEnvironment, "FtsoV2PriceStore", priceStore, "setMinTurnoutBIPS", [5000], execute);
});
