import { deployFacet } from "../lib/deploy-asset-manager-facets";
import { runDeployScript } from "../lib/deploy-scripts";
import { abiEncodeCall } from "../lib/deploy-utils";

runDeployScript(async ({ hre, artifacts, contracts, deployer }) => {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const FAsset = artifacts.require("FAsset");

    const assetManagerController = await AssetManagerController.at(contracts.AssetManagerController!.address);

    const assetManagerAddresses = await assetManagerController.getAssetManagers();  // all asset managers

    const newFAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");

    const fAssetImpl = await FAsset.at(newFAssetImplAddress); // only used for abi

    const abi = abiEncodeCall(assetManagerController,
        (amc) => amc.upgradeFAssetImplementation(
            assetManagerAddresses,
            newFAssetImplAddress,
            abiEncodeCall(fAssetImpl, (fasset) => fasset.initializeV1r1())));
    console.log(JSON.stringify([assetManagerAddresses,
        newFAssetImplAddress,
        abiEncodeCall(fAssetImpl, (fasset) => fasset.initializeV1r1())], null, 4))
    console.log(abi);
});
