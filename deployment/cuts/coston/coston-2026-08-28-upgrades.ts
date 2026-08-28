import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;
    await upgradeGovernedProxy(deployScriptEnvironment, "FtsoV2PriceStore", "FtsoV2PriceStoreImplementation", "FtsoV2PriceStore", execute);
});
