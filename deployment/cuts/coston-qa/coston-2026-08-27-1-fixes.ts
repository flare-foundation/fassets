import { runDeployScript } from "../../lib/deploy-scripts";

runDeployScript(async ({ artifacts, contracts }) => {
    const AgentOwnerRegistry = artifacts.require("AgentOwnerRegistry");
    const AssetManagerController = artifacts.require("AssetManagerController");
    const agentOwnerRegistry = await AgentOwnerRegistry.at(contracts.AgentOwnerRegistry!.address);
    // set to assetManagers
    const assetManagerController = await AssetManagerController.at(contracts.AssetManagerController!.address);
    const assetManagers = await assetManagerController.getAssetManagers();
    await assetManagerController.setAgentOwnerRegistry(assetManagers, agentOwnerRegistry.address);
    // whitelist
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xDAF667A846eBE962D2F7eCD459B3be157eBf52BB", "jurij", "jurij", "neki", "neki")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x8BC7faa5e147E0a5Ac46F9ce788AFe7e15E92A1A", "Nejc", "-", "-", "-")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x8cC3363d27a0B4ca4464CbE16183Ac20027d2764", "Andrei", "-", "-", "-")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x9b43a7071eA81c6F3b7F9C0C5246abF6881BC43A", "SuperMario", "-", "-", "-")
});
