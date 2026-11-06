import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultsAndPools, upgradeCollateralPoolFactory } from "../../lib/upgrade-contracts";

// Goes together with flare-2026-11-06.cuts.json.
// The new CollateralPool calls `isForbiddenFlareAddress`, which is added by the diamond cut, so execute
// setCollateralPoolFactory and upgradeAgentVaultsAndPools only after the diamond cut has been executed.
// The forbidden address list is set by the diamond cut init (ForbiddenAddressesInit).

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;

    // upgrades (timelocked)

    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);

    // immediate governance

    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
