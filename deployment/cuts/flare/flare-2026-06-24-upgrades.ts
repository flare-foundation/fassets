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
    await performGovernanceCall(deployScriptEnvironment, "AssetManagerController", assetManagerController, "addEmergencyUnpauseSender", ["0xFE82f260698315F1EDDe937c53655b8F8E4da2B4"], execute);
    await performGovernanceCall(deployScriptEnvironment, "CoreVaultManager", coreVaultManager, "addEmergencyUnpauseSenders", [["0xFE82f260698315F1EDDe937c53655b8F8E4da2B4"]], execute);

    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);
});
