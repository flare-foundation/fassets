import { runDeployScript } from "../../lib/deploy-scripts";
import { performGovernanceCall } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;
    const { contracts, artifacts } = deployScriptEnvironment;

    const IIAssetManager = artifacts.require("IIAssetManager");
    const assetManager = await IIAssetManager.at(contracts.getAddress("AssetManager_FTestXRP"));
    await performGovernanceCall(deployScriptEnvironment, "AssetManager_FTestXRP", assetManager, "setMintingTagManager", [contracts.getAddress("MintingTagManager")], execute);
});
