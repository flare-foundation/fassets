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
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xd7e88db2D81EF6EC0DB3aa51741d453eD89ae9C3", "Iztok Test", "", "", "")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x6631F4C0af9Ee89ed67cC14c20414d032664889e", "David Test Agent", "", "", "")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x9b43a7071eA81c6F3b7F9C0C5246abF6881BC43A", "supermario", "autotests ", "https//:supermario.io", "")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xfF0396De97d3C0435dFc8cA0701a6378B0F34366", "3appes", "3appes", "neki", "neki")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xDAF667A846eBE962D2F7eCD459B3be157eBf52BB", "jurij", "jurij", "neki", "neki")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x8cC3363d27a0B4ca4464CbE16183Ac20027d2764", "AndreiQA", "", "", "")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x37d5558f64605a4c0A0cD36BE2C246228Ba02588", "AU", "-", "-", "-")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x278F11EEEe212a796C750f03382Ddb0970F7A631", "Atlas", "-", "-", "-")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xC51309F8E91AF2df945F80dd8Cb1a3f431b295bd", "jonnern", "-", "-", "-")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xBE34545760E4C75218bd4374F96a4834b62bE589", "Bifrost", "-", "-", "-")
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x8BC7faa5e147E0a5Ac46F9ce788AFe7e15E92A1A", "Nejc", "-", "-", "-")
});
