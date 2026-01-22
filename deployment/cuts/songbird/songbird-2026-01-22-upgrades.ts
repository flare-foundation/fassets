import { runDeployScript } from "../../lib/deploy-scripts";
import { upgradeAgentVaultFactory, upgradeAgentVaultsAndPools, upgradeAssetManagerController, upgradeCollateralPoolFactory, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;
    await upgradeAssetManagerController(deployScriptEnvironment, execute);
    await upgradeGovernedProxy(deployScriptEnvironment, "FtsoV2PriceStore", "FtsoV2PriceStoreImplementation", "FtsoV2PriceStore", execute);
    await upgradeGovernedProxy(deployScriptEnvironment, "AgentOwnerRegistry", "AgentOwnerRegistryImplementation", "AgentOwnerRegistry", execute);
    await upgradeAgentVaultFactory(deployScriptEnvironment, ["FXRP"], execute);
    await upgradeCollateralPoolFactory(deployScriptEnvironment, ["FXRP"], execute);
    await upgradeAgentVaultsAndPools(deployScriptEnvironment, ["FXRP"], execute);
});
