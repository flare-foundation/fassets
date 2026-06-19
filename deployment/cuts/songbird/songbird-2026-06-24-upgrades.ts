import { runDeployScript } from "../../lib/deploy-scripts";
import { abiEncodeCall } from "../../lib/deploy-utils";
import { performGovernanceCall, upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeGovernedProxy, upgradeGovernedProxyAndCall } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;

    const { contracts, artifacts } = deployScriptEnvironment;
    const assetManagerController = await artifacts.require("AssetManagerController").at(contracts.getAddress("AssetManagerController"));
    const mintingTagManager = await artifacts.require("MintingTagManager").at(contracts.getAddress("MintingTagManager"));
    const coreVaultManager = await artifacts.require("CoreVaultManager").at(contracts.getAddress("CoreVaultManager"));

    // upgrades (timelocked)

    await upgradeAssetManagerController(deployScriptEnvironment, execute);

    const calldata = abiEncodeCall(mintingTagManager, (inst) => inst.initializeV2(600));
    await upgradeGovernedProxyAndCall(deployScriptEnvironment, "MintingTagManager", "MintingTagManagerImplementation", "MintingTagManager", calldata, execute);

    await upgradeGovernedProxy(deployScriptEnvironment, "CoreVaultManager_FXRP", "CoreVaultManagerImplementation", "CoreVaultManager", execute);

    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);

    // immediate governance

    // add small governance address to unpause senders
    await performGovernanceCall(deployScriptEnvironment, "AssetManagerController", assetManagerController, "addEmergencyUnpauseSender", ["0xbe41f722b72fd91637c8660c8BDe3f4a7441aA5c"], execute);
    await performGovernanceCall(deployScriptEnvironment, "CoreVaultManager", coreVaultManager, "addEmergencyUnpauseSenders", [["0xbe41f722b72fd91637c8660c8BDe3f4a7441aA5c"]], execute);

    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
