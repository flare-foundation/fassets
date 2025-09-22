import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;
    await upgradeGovernedProxy(deployScriptEnvironment, "AgentOwnerRegistry", "AgentOwnerRegistryImplementation", "AgentOwnerRegistry", execute);
    await upgradeAssetManagerController(deployScriptEnvironment, execute);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
