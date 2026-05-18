import { runDeployScript } from "../../lib/deploy-scripts";
import { performGovernanceCall, upgradeGovernedProxy } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = true;
    const { contracts, artifacts } = deployScriptEnvironment;
    const MintingTagManager = artifacts.require("MintingTagManager");
    const mintingTagManager = await MintingTagManager.at(contracts.getAddress("MintingTagManager"));
    await upgradeGovernedProxy(deployScriptEnvironment, "MintingTagManager", "MintingTagManagerImplementation", "MintingTagManager", execute);
    await performGovernanceCall(deployScriptEnvironment, "MintingTagManager", mintingTagManager, "setExecutorChangeAfterSeconds", [600], execute);
});
