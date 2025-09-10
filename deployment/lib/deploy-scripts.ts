import hre from "hardhat";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { FAssetContractStore } from "./contracts";
import { loadCurrentDeployContracts, loadDeployAccounts, runAsyncMain } from "./deploy-utils";

export interface DeployScriptEnvironment {
    hre: HardhatRuntimeEnvironment;
    artifacts: Truffle.Artifacts;
    contracts: FAssetContractStore;
    deployer: string;
}

export function deployScriptEnvironment(): DeployScriptEnvironment {
    const artifacts = hre.artifacts as Truffle.Artifacts;
    const contracts = loadCurrentDeployContracts(true);
    const { deployer } = loadDeployAccounts(hre);
    return { hre, artifacts, contracts, deployer };
}

export function runDeployScript(script: (environment: DeployScriptEnvironment) => Promise<void>) {
    runAsyncMain(async () => {
        await script(deployScriptEnvironment());
    });
}
