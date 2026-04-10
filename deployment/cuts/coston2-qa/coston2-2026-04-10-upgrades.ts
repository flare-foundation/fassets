import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeCollateralPoolFactory } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
