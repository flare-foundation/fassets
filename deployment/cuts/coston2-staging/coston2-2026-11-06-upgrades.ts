import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeCollateralPoolFactory } from "../../lib/upgrade-contracts";

// Run after coston2-2026-11-06.cuts.json has been executed - the new CollateralPool calls `isForbiddenFlareAddress`,
// which is added by the diamond cut.
// The forbidden address list is set by the diamond cut init (ForbiddenAddressesInit).

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;

    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);

    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
