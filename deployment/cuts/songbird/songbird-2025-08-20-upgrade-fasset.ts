import { deployFacet } from "../../lib/deploy-asset-manager-facets";
import { runDeployScript } from "../../lib/deploy-scripts";
import { abiEncodeCall } from "../../lib/deploy-utils";
import { getAssetManagers } from "../../lib/upgrade-contracts";

runDeployScript(async ({ hre, artifacts, contracts, deployer }) => {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const FAsset = artifacts.require("FAsset");

    const assetManagerController = await AssetManagerController.at(contracts.AssetManagerController!.address);

    const assetManagerAddresses = await getAssetManagers(contracts, assetManagerController, ["FXRP"]);

    const newFAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");

    const fAssetImpl = await FAsset.at(newFAssetImplAddress); // only used for abi

    const upgradeParams: Parameters<typeof assetManagerController.upgradeFAssetImplementation> = [
        assetManagerAddresses,
        newFAssetImplAddress,
        abiEncodeCall(fAssetImpl, (fasset) => fasset.initializeV1r1())
    ];

    const abi = abiEncodeCall(assetManagerController,
        (amc) => amc.upgradeFAssetImplementation(...upgradeParams));

    console.log("PARAMS:", JSON.stringify(upgradeParams))
    console.log("ABI:", abi);
});
