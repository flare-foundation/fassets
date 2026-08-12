import { runDeployScript } from "../../lib/deploy-scripts";
import { getAssetManagersAndController, performGovernanceCall, upgradeAgentVaultFactory, upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeCollateralPoolTokenFactory, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;

    const { contracts, artifacts } = deployScriptEnvironment;
    const { assetManagers, assetManagerController } = await getAssetManagersAndController(artifacts, contracts, "all");

    // upgrade factories and controller
    await upgradeAssetManagerController(deployScriptEnvironment, execute);
    await upgradeAgentVaultFactory(deployScriptEnvironment, "all", execute);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, "all", execute);
    await upgradeCollateralPoolTokenFactory(deployScriptEnvironment, "all", execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, "all", execute);

    // upgrade core vault manager
    await upgradeGovernedProxy(deployScriptEnvironment, "CoreVaultManager_FTestXRP", "CoreVaultManagerImplementation", "CoreVaultManager", execute);

    // set new FtsoV2PriceStore
    await performGovernanceCall(deployScriptEnvironment, "AssetManagerController", assetManagerController,
        "setPriceReader", [assetManagers, contracts.FtsoV2PriceStore!.address], execute);

    // set new FdcVerification
    await performGovernanceCall(deployScriptEnvironment, "AssetManagerController", assetManagerController,
        "setFdcVerification", [assetManagers, contracts.FdcVerification!.address], execute);
});
