import { runDeployScript } from "../../lib/deploy-scripts";
import { abiEncodeCall } from "../../lib/deploy-utils";
import { upgradeGovernedProxyAndCall } from "../../lib/upgrade-contracts";

runDeployScript(async (deployScriptEnvironment) => {
    const execute = false;
    const { contracts, artifacts } = deployScriptEnvironment;
    const MintingTagManager = artifacts.require("MintingTagManager");
    const mintingTagManager = await MintingTagManager.at(contracts.getAddress("MintingTagManager"));
    const calldata = abiEncodeCall(mintingTagManager, (inst) => inst.initializeV2(600));
    await upgradeGovernedProxyAndCall(deployScriptEnvironment, "MintingTagManager", "MintingTagManagerImplementation", "MintingTagManager", calldata, execute);
});
