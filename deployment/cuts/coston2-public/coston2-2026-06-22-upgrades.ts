import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;

    // upgrades (timelocked)

    await upgradeAssetManagerController(deployScriptEnvironment, execute);

    await upgradeGovernedProxy(deployScriptEnvironment, "MintingTagManager", "MintingTagManagerImplementation", "MintingTagManager", execute);

    await upgradeGovernedProxy(deployScriptEnvironment, "CoreVaultManager_FTestXRP", "CoreVaultManagerImplementation", "CoreVaultManager", execute);

    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);

    // immediate governance

    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
