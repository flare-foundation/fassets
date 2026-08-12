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
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x18Aad7eE6CDC41050b2650045E8F12a7D0679540", "David Staging Agent 2", "David Staging agent 2", "https://raw.githubusercontent.com/TowoLabs/ftso-signal-providers/master/assets/0xfe532cB6Fb3C47940aeA7BeAd4d61C5e041D950e.png", "");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x8cC3363d27a0B4ca4464CbE16183Ac20027d2764", "TestAgent", "", "", "");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x199C0411b8A0cBa275ae0eFeD86D2742C751CC4F", "Ico", "Test Ico", "", "");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x9b43a7071eA81c6F3b7F9C0C5246abF6881BC43A", "SUPER-MARIO", "", "", "flarenetwork");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xDAF667A846eBE962D2F7eCD459B3be157eBf52BB", "tessJ", "devJurij", "no", "www.google.com");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xAF523ef91A29d26c2c3F9a493C53a003c1c7975E", "QA Test Agent 1", "First V1.1 agent", "-", "-");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xBD8513e6712d7d7d5493Fd073f16D83BAA26A9FF", "3appes", "dev", "dev", "dev");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x980e83274e27DC0EC04f6d12FB8e49f85DbAB43e", "A1", "Staging agent 1", "", "");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x8be281772F7af7FaCe0b9bf298b0A33BF57081f9", "kuco23", "Be best", "", "kuco23.github.io");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x6631F4C0af9Ee89ed67cC14c20414d032664889e", "A5", "Staging agent 5", "", "");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xC51309F8E91AF2df945F80dd8Cb1a3f431b295bd", "jonnern", "-", "-", "-");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x278F11EEEe212a796C750f03382Ddb0970F7A631", "kostas", "-", "-", "-");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x37d5558f64605a4c0A0cD36BE2C246228Ba02588", "rowley", "-", "-", "-");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0x5bBB6c7DC510e01fE41959dD52769B02a92930b2", "marco", "-", "-", "-");
    await agentOwnerRegistry.whitelistAndDescribeAgent("0xfF0396De97d3C0435dFc8cA0701a6378B0F34366", "3appes", "3appes", "none", "none")    ;
});
