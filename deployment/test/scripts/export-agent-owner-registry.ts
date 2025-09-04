import { runDeployScript } from "../../lib/deploy-scripts";

runDeployScript(async ({ hre, artifacts, contracts }) => {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const IIAssetManager = artifacts.require("IIAssetManager");
    const AgentOwnerRegistry = artifacts.require("AgentOwnerRegistry");

    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const agentOwnerRegistry = await AgentOwnerRegistry.at(contracts.getAddress("AgentOwnerRegistry"));

    // gather agent addresses
    const agentMgmtAddrs = new Set<string>();
    for (const assetManagerAddress of await assetManagerController.getAssetManagers()) {
        const assetManager = await IIAssetManager.at(assetManagerAddress);
        const allAgents = await assetManager.getAllAgents(0, 100);
        console.log(`allAgents: ${allAgents[1]}`);
        for (const vaultAddr of allAgents[0]) {
            const info = await assetManager.getAgentInfo(vaultAddr);
            agentMgmtAddrs.add(info.ownerManagementAddress);
        }
    }

    for (const mgmtAddr of agentMgmtAddrs) {
        const name = await agentOwnerRegistry.getAgentName(mgmtAddr);
        const description = await agentOwnerRegistry.getAgentDescription(mgmtAddr);
        const iconUrl = await agentOwnerRegistry.getAgentIconUrl(mgmtAddr);
        const touUrl = await agentOwnerRegistry.getAgentTermsOfUseUrl(mgmtAddr);
        console.log(`await agentOwnerRegistry.whitelistAndDescribeAgent("${mgmtAddr}", "${name}", "${description}", "${iconUrl}", "${touUrl}")`);
    }
});
