import { runDeployScript } from "../../lib/deploy-scripts";
import { printExecuteData } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    // remove FDOGE and FBTC
    const { contracts } = deployScriptEnvironment;
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    printExecuteData("AssetManagerController", assetManagerController, "removeAssetManager", [contracts.getAddress("AssetManager_FDOGE")]);
    printExecuteData("AssetManagerController", assetManagerController, "removeAssetManager", [contracts.getAddress("AssetManager_FBTC")]);
});
