import { DeployScriptEnvironment, runDeployScript } from "../lib/deploy-scripts";
import { upgradeAgentVaultFactory, upgradeAssetManagerController, upgradeCollateralPoolFactory } from "../lib/upgrade-contracts";

runDeployScript(async (dse: DeployScriptEnvironment) => {
    await upgradeAssetManagerController(dse, false);
    await upgradeAgentVaultFactory(dse, false);
    await upgradeCollateralPoolFactory(dse, false);
});
