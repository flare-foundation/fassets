import { runDeployScript } from "../lib/deploy-scripts";
import { upgradeAgentVaultFactory, upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeCollateralPoolTokenFactory, upgradeFAsset } from "../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    // const { hre, artifacts, contracts, deployer } = deployScriptEnvironment;
    await upgradeAssetManagerController(deployScriptEnvironment, true);
    await upgradeAgentVaultFactory(deployScriptEnvironment, "all", true);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", true);
    await upgradeCollateralPoolTokenFactory(deployScriptEnvironment, "all", true);
    await upgradeFAsset(deployScriptEnvironment, "all", true);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", true);
});
