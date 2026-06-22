import { runDeployScript } from "../../lib/deploy-scripts";
import { abiEncodeCall } from "../../lib/deploy-utils";
import { upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeGovernedProxy, upgradeGovernedProxyAndCall } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;

    const { contracts, artifacts } = deployScriptEnvironment;
    const mintingTagManager = await artifacts.require("MintingTagManager").at(contracts.getAddress("MintingTagManager"));

    // upgrades (timelocked)

    await upgradeAssetManagerController(deployScriptEnvironment, execute);

    const calldata = abiEncodeCall(mintingTagManager, (inst) => inst.initializeV2(600));
    await upgradeGovernedProxyAndCall(deployScriptEnvironment, "MintingTagManager", "MintingTagManagerImplementation", "MintingTagManager", calldata, execute);

    await upgradeGovernedProxy(deployScriptEnvironment, "CoreVaultManager_FTestXRP", "CoreVaultManagerImplementation", "CoreVaultManager", execute);

    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);

    // immediate governance

    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
