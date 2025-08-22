import { DeployScriptEnvironment, runDeployScript } from "../lib/deploy-scripts";
import { upgradeAgentVaultFactory, upgradeAssetManagerController, upgradeCollateralPoolFactory } from "../lib/upgrade-contracts";

runDeployScript(async (dse: DeployScriptEnvironment) => {
    await upgradeAssetManagerController(dse, false);
    await upgradeAgentVaultFactory(dse, "all", false);
    await upgradeCollateralPoolFactory(dse, "all", false);
});
