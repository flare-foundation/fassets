import { deployCollateralPoolFactory } from "../lib/deploy-asset-manager-dependencies";
import { deployFacet } from "../lib/deploy-asset-manager-facets";
import { runDeployScript } from "../lib/deploy-scripts";
import { getProxyImplementationAddress } from "../lib/deploy-utils";

runDeployScript(async ({ hre, artifacts, contracts, deployer }) => {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const IIAssetManager = artifacts.require("IIAssetManager");
    const assetManagerFTestXRP = await IIAssetManager.at(contracts.getAddress("AssetManager_FTestXRP"));

    // upgrade controller
    const newAssetManagerControllerImplAddress = await deployFacet(hre, "AssetManagerControllerImplementation", contracts, deployer, "AssetManagerController");
    await assetManagerController.upgradeTo(newAssetManagerControllerImplAddress, { from: deployer });
    console.log(`AssetManagerController upgraded to ${await getProxyImplementationAddress(hre, assetManagerController.address)}`);

    // upgrade CollateralPool implementation
    await deployCollateralPoolFactory(hre, contracts);
    await assetManagerController.setCollateralPoolFactory(assetManagers, contracts.getAddress("CollateralPoolFactory"), { from: deployer });
    console.log(`CollateralPoolFactory upgraded to ${await assetManagerFTestXRP.getSettings().then(s => s.collateralPoolFactory)}`);

    // upgrade FAsset
    const newFAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");
    await assetManagerController.upgradeFAssetImplementation(assetManagers, newFAssetImplAddress, "0x");
});
