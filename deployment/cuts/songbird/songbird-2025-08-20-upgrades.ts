import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultFactory, upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeCollateralPoolTokenFactory, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    await upgradeAssetManagerController(deployScriptEnvironment, false);
    await upgradeAgentVaultFactory(deployScriptEnvironment, ["FXRP"], false);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, ["FXRP"], false);
    await upgradeCollateralPoolTokenFactory(deployScriptEnvironment, ["FXRP"], false);
    await upgradeGovernedProxy(deployScriptEnvironment, "CoreVaultManager_FXRP", "CoreVaultManagerImplementation", "CoreVaultManager", false);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, ["FXRP"], false);
});
