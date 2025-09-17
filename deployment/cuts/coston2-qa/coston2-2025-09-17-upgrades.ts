import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;
    await upgradeAssetManagerController(deployScriptEnvironment, execute);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
