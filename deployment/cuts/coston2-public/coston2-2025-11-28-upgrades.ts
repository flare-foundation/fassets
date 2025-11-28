import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeFAsset } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;
    await upgradeAssetManagerController(deployScriptEnvironment, execute);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);
    await upgradeFAsset(deployScriptEnvironment, "all", execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
