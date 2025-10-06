import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeFAsset, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;
    await upgradeGovernedProxy(deployScriptEnvironment, "AgentOwnerRegistry", "AgentOwnerRegistryImplementation", "AgentOwnerRegistry", execute);
    await upgradeAssetManagerController(deployScriptEnvironment, execute);
    await upgradeFAsset(deployScriptEnvironment, ["FXRP"], execute);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, ["FXRP"], execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, ["FXRP"], execute);
});
