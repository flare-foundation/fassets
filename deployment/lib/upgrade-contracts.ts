import { AssetManagerSettings } from "../../lib/fasset/AssetManagerTypes";
import { AssetManagerControllerInstance } from "../../typechain-truffle";
import { ContractStore, FAssetContractStore } from "./contracts";
import { deployAgentVaultFactory, deployCollateralPoolFactory, deployCollateralPoolTokenFactory } from "./deploy-asset-manager-dependencies";
import { deployFacet } from "./deploy-asset-manager-facets";
import { DeployScriptEnvironment } from "./deploy-scripts";
import { getProxyImplementationAddress } from "./deploy-utils";

export async function upgradeAssetManagerController({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));

    const newAssetManagerControllerImplAddress = await deployFacet(hre, "AssetManagerControllerImplementation", contracts, deployer, "AssetManagerController");

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeTo(newAssetManagerControllerImplAddress, { from: deployer });
        console.log(`AssetManagerController upgraded to ${await getProxyImplementationAddress(hre, assetManagerController.address)}`);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).upgradeTo(${newAssetManagerControllerImplAddress})`);
    }
}

export async function upgradeAgentVaultFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, assetSymbols: string[] | "all", execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await getAssetManagers(contracts, assetManagerController, assetSymbols);

    const newAgentVaultFactoryAddress = await deployAgentVaultFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setAgentVaultFactory(assetManagers, newAgentVaultFactoryAddress, { from: deployer });
        await printUpgradedContracts(contracts, "AgentVaultFactory", assetManagers, s => s.agentVaultFactory);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setAgentVaultFactory([${assetManagers.join(", ")}], ${newAgentVaultFactoryAddress})`);
    }
}

export async function upgradeCollateralPoolFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, assetSymbols: string[] | "all", execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await getAssetManagers(contracts, assetManagerController, assetSymbols);

    const newCollateralPoolFactoryAddress = await deployCollateralPoolFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setCollateralPoolFactory(assetManagers, newCollateralPoolFactoryAddress, { from: deployer });
        await printUpgradedContracts(contracts, "CollateralPoolFactory", assetManagers, s => s.collateralPoolFactory);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setCollateralPoolFactory([${assetManagers.join(", ")}], ${newCollateralPoolFactoryAddress})`);
    }
}

export async function upgradeCollateralPoolTokenFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, assetSymbols: string[] | "all", execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await getAssetManagers(contracts, assetManagerController, assetSymbols);

    const newCollateralPoolTokenFactoryAddress = await deployCollateralPoolTokenFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setCollateralPoolTokenFactory(assetManagers, newCollateralPoolTokenFactoryAddress, { from: deployer });
        await printUpgradedContracts(contracts, "CollateralPoolTokenFactory", assetManagers, s => s.collateralPoolTokenFactory);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setCollateralPoolTokenFactory([${assetManagers.join(", ")}], ${newCollateralPoolTokenFactoryAddress})`);
    }
}

export async function upgradeFAsset({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, assetSymbols: string[] | "all", execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await getAssetManagers(contracts, assetManagerController, assetSymbols);

    const newFAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeFAssetImplementation(assetManagers, newFAssetImplAddress, "0x");
        await printUpgradedContracts(contracts, "FAsset", assetManagers, async s => await getProxyImplementationAddress(hre, s.fAsset));
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).upgradeFAssetImplementation([${assetManagers.join(", ")}], ${newFAssetImplAddress}, "0x")`);
    }
}

export async function upgradeAgentVaultsAndPools({ artifacts, contracts }: DeployScriptEnvironment, assetSymbols: string[] | "all", execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await getAssetManagers(contracts, assetManagerController, assetSymbols);

    let maxAgentsCount = 0;
    const IIAssetManager = artifacts.require("IIAssetManager");
    for (const addr of assetManagers) {
        const am = await IIAssetManager.at(addr);
        const {1: count} = await am.getAllAgents(0, 0); // just to get the count of agents
        maxAgentsCount = Math.max(maxAgentsCount, count.toNumber());
    }

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeAgentVaultsAndPools(assetManagers, 0, maxAgentsCount);
        console.log("AgentVault, CollateralPool and CollateralPoolToken contracts upgraded for all agents on all asset managers.");
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).upgradeAgentVaultsAndPools([${assetManagers.join(", ")}], 0, ${maxAgentsCount})`);
    }
}

export async function upgradeGovernedProxy({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, contractName: string, implementationName: string, implementationContract: string, execute: boolean) {
    const GovernedUUPSProxyImplementation = artifacts.require("GovernedUUPSProxyImplementation");
    const proxy = await GovernedUUPSProxyImplementation.at(contracts.getAddress(contractName));

    const newImplAddress = await deployFacet(hre, implementationName, contracts, deployer, implementationContract);

    if (execute && !(await proxy.productionMode())) {
        await proxy.upgradeTo(newImplAddress, { from: deployer });
        console.log(`${implementationContract} at ${proxy.address} upgraded to ${await getProxyImplementationAddress(hre, proxy.address)}`);
    } else {
        console.log(`EXECUTE: ${implementationContract}(${proxy.address}).upgradeTo(${newImplAddress})`);
    }
}

async function shouldExecute(execute: boolean, assetManagerController: AssetManagerControllerInstance) {
    const productionMode = await assetManagerController.productionMode();
    return execute && !productionMode;
}

async function printUpgradedContracts(contracts: FAssetContractStore, name: string, assetManagers: string[], field: (s: AssetManagerSettings) => unknown) {
    const IIAssetManager = artifacts.require("IIAssetManager");
    for (const addr of assetManagers) {
        const am = await IIAssetManager.at(addr);
        const assetManagerName = contracts.findByAddress(addr)?.name ?? addr;
        const settings = await am.getSettings();
        console.log(`${name} on ${assetManagerName} upgraded to ${await field(settings)}`);
    }
}

export async function getAssetManagers(contracts: ContractStore, assetManagerController: AssetManagerControllerInstance, assetSymbols: string[] | "all") {
    const allAssetManagers = await assetManagerController.getAssetManagers();
    if (assetSymbols === "all") {
        return allAssetManagers;
    } else {
        const assetManagers: string[] = [];
        for (const symbol of assetSymbols) {
            const am = contracts.getAddress(`AssetManager_${symbol}`);
            if (!allAssetManagers.includes(am)) {
                throw new Error(`Asset manager ${am} not registered in controller`);
            }
            assetManagers.push(am);
        }
        return assetManagers;
    }
}
