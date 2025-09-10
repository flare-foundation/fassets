import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultFactory, upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeCollateralPoolTokenFactory, upgradeFAsset, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    await upgradeAssetManagerController(deployScriptEnvironment, true);
    await upgradeAgentVaultFactory(deployScriptEnvironment, "all", true);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", true);
    await upgradeCollateralPoolTokenFactory(deployScriptEnvironment, "all", true);
    await upgradeFAsset(deployScriptEnvironment, "all", true);
    await upgradeGovernedProxy(deployScriptEnvironment, "CoreVaultManager_FTestXRP", "CoreVaultManagerImplementation", "CoreVaultManager", true);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", true);
});
