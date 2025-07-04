import { AssetManagerSettings } from "../../lib/fasset/AssetManagerTypes";
import { AssetManagerControllerInstance } from "../../typechain-truffle";
import { FAssetContractStore } from "./contracts";
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

export async function upgradeAgentVaultFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newAgentVaultFactoryAddress = await deployAgentVaultFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setAgentVaultFactory(assetManagers, newAgentVaultFactoryAddress, { from: deployer });
        printUpgradedContracts(contracts, "AgentVaultFactory", assetManagers, s => s.agentVaultFactory);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setAgentVaultFactory([${assetManagers.join(", ")}], ${newAgentVaultFactoryAddress})`);
    }
}

export async function upgradeCollateralPoolFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newCollateralPoolFactoryAddress = await deployCollateralPoolFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setCollateralPoolFactory(assetManagers, newCollateralPoolFactoryAddress, { from: deployer });
        printUpgradedContracts(contracts, "CollateralPoolFactory", assetManagers, s => s.collateralPoolFactory);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setCollateralPoolFactory([${assetManagers.join(", ")}], ${newCollateralPoolFactoryAddress})`);
    }
}

export async function upgradeCollateralPoolTokenFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newCollateralPoolTokenFactoryAddress = await deployCollateralPoolTokenFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setCollateralPoolTokenFactory(assetManagers, newCollateralPoolTokenFactoryAddress, { from: deployer });
        printUpgradedContracts(contracts, "CollateralPoolTokenFactory", assetManagers, s => s.collateralPoolTokenFactory);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setCollateralPoolTokenFactory([${assetManagers.join(", ")}], ${newCollateralPoolTokenFactoryAddress})`);
    }
}

export async function upgradeFAsset({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newFAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeFAssetImplementation(assetManagers, newFAssetImplAddress, "0x");
        printUpgradedContracts(contracts, "FAsset", assetManagers, async s => await getProxyImplementationAddress(hre, s.fAsset));
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).upgradeFAssetImplementation([${assetManagers.join(", ")}], ${newFAssetImplAddress}, "0x")`);
    }
}

async function shouldExecute(execute: boolean, assetManagerController: AssetManagerControllerInstance) {
    const productionMode = await assetManagerController.productionMode();
    return execute && !productionMode;
}

async function printUpgradedContracts(contracts: FAssetContractStore, name: string, assetManagers: string[], field: (s: AssetManagerSettings) => any) {
    const IIAssetManager = artifacts.require("IIAssetManager");
    for (const addr of assetManagers) {
        const am = await IIAssetManager.at(addr);
        const assetManagerName = contracts.findByAddress(addr)?.name ?? addr;
        const settings = await am.getSettings();
        console.log(`${name} on ${assetManagerName} upgraded to ${await field(settings)}`);
    }
}
