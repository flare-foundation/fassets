import { deployAgentVaultFactory, deployCollateralPoolFactory, deployCollateralPoolTokenFactory } from "./deploy-asset-manager-dependencies";
import { deployFacet } from "./deploy-asset-manager-facets";
import { DeployScriptEnvironment } from "./deploy-scripts";
import { getProxyImplementationAddress } from "./deploy-utils";

export async function upgradeAssetManagerController({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));

    const newAssetManagerControllerImplAddress = await deployFacet(hre, "AssetManagerControllerImplementation", contracts, deployer, "AssetManagerController");

    if (execute && !(await assetManagerController.productionMode())) {
        await assetManagerController.upgradeTo(newAssetManagerControllerImplAddress, { from: deployer });
        console.log(`AssetManagerController upgraded to ${await getProxyImplementationAddress(hre, assetManagerController.address)}`);
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).upgradeTo(${newAssetManagerControllerImplAddress})`);
    }
}

export async function upgradeAgentVaultFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const IIAssetManager = artifacts.require("IIAssetManager");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newAgentVaultFactoryAddress = await deployAgentVaultFactory(hre, contracts);

    if (execute && !(await assetManagerController.productionMode())) {
        await assetManagerController.setAgentVaultFactory(assetManagers, newAgentVaultFactoryAddress, { from: deployer });
        for (const addr of assetManagers) {
            const am = await IIAssetManager.at(addr);
            console.log(`AgentVaultFactory on ${contracts.findByAddress(addr)?.name ?? addr} upgraded to ${await am.getSettings().then(s => s.agentVaultFactory)}`);
        }
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setAgentVaultFactory([${assetManagers.join(", ")}], ${newAgentVaultFactoryAddress})`);
    }
}

export async function upgradeCollateralPoolFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const IIAssetManager = artifacts.require("IIAssetManager");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newCollateralPoolFactoryAddress = await deployCollateralPoolFactory(hre, contracts);

    if (execute && !(await assetManagerController.productionMode())) {
        await assetManagerController.setCollateralPoolFactory(assetManagers, newCollateralPoolFactoryAddress, { from: deployer });
        for (const addr of assetManagers) {
            const am = await IIAssetManager.at(addr);
            console.log(`CollateralPoolFactory on ${contracts.findByAddress(addr)?.name ?? addr} upgraded to ${await am.getSettings().then(s => s.collateralPoolFactory)}`);
        }
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setCollateralPoolFactory([${assetManagers.join(", ")}], ${newCollateralPoolFactoryAddress})`);
    }
}

export async function upgradeCollateralPoolTokenFactory({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const IIAssetManager = artifacts.require("IIAssetManager");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newCollateralPoolTokenFactoryAddress = await deployCollateralPoolTokenFactory(hre, contracts);

    if (execute && !(await assetManagerController.productionMode())) {
        await assetManagerController.setCollateralPoolTokenFactory(assetManagers, newCollateralPoolTokenFactoryAddress, { from: deployer });
        for (const addr of assetManagers) {
            const am = await IIAssetManager.at(addr);
            console.log(`CollateralPoolTokenFactory on ${contracts.findByAddress(addr)?.name ?? addr} upgraded to ${await am.getSettings().then(s => s.collateralPoolTokenFactory)}`);
        }
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).setCollateralPoolTokenFactory([${assetManagers.join(", ")}], ${newCollateralPoolTokenFactoryAddress})`);
    }
}

export async function upgradeFAsset({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, execute: boolean) {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const IIAssetManager = artifacts.require("IIAssetManager");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await assetManagerController.getAssetManagers();

    const newFAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");

    if (execute && !(await assetManagerController.productionMode())) {
        await assetManagerController.upgradeFAssetImplementation(assetManagers, newFAssetImplAddress, "0x");
        for (const addr of assetManagers) {
            const am = await IIAssetManager.at(addr);
            console.log(`FAsset on ${contracts.findByAddress(addr)?.name ?? addr} upgraded to ${await getProxyImplementationAddress(hre, await am.getSettings().then(s => s.fAsset))}`);
        }
    } else {
        console.log(`EXECUTE: AssetManagerController(${assetManagerController.address}).upgradeFAssetImplementation([${assetManagers.join(", ")}], ${newFAssetImplAddress}, "0x")`);
    }
}
