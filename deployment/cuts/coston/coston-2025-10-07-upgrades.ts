import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultFactory, upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeCollateralPoolTokenFactory, upgradeFAsset, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;
    await upgradeAssetManagerController(deployScriptEnvironment, execute);
    await upgradeAgentVaultFactory(deployScriptEnvironment, "all", execute);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);
    await upgradeCollateralPoolTokenFactory(deployScriptEnvironment, "all", execute);
    await upgradeFAsset(deployScriptEnvironment, "all", execute);
    await upgradeGovernedProxy(deployScriptEnvironment, "CoreVaultManager_FTestXRP", "CoreVaultManagerImplementation", "CoreVaultManager", execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
