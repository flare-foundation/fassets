import { HardhatRuntimeEnvironment } from "hardhat/types";
import { FAssetContractStore } from "./contracts";
import { loadDeployAccounts, waitFinalize, ZERO_ADDRESS } from "./deploy-utils";
import { verifyContract } from "./verify-fasset-contracts";


export async function deployAgentOwnerRegistry(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    console.log(`Deploying AgentOwnerRegistry`);

    const artifacts = hre.artifacts as Truffle.Artifacts;

    const AgentOwnerRegistry = artifacts.require("AgentOwnerRegistry");
    const AgentOwnerRegistryProxy = artifacts.require("AgentOwnerRegistryProxy");

    const { deployer } = loadDeployAccounts(hre);

    // deploy proxy
    const agentOwnerRegistryImpl = await waitFinalize(hre, deployer,
        () => AgentOwnerRegistry.new({ from: deployer }));
    const agentOwnerRegistryProxy = await waitFinalize(hre, deployer,
        () => AgentOwnerRegistryProxy.new(agentOwnerRegistryImpl.address, contracts.GovernanceSettings.address, deployer, { from: deployer }));
    const agentOwnerRegistry = await AgentOwnerRegistry.at(agentOwnerRegistryProxy.address);

    contracts.add("AgentOwnerRegistryImplementation", "AgentOwnerRegistry.sol", agentOwnerRegistryImpl.address);
    contracts.add("AgentOwnerRegistry", "AgentOwnerRegistryProxy.sol", agentOwnerRegistry.address, { mustSwitchToProduction: true });

    return agentOwnerRegistry.address;
}

export async function deployAgentVaultFactory(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    console.log(`Deploying AgentVaultFactory`);

    const artifacts = hre.artifacts as Truffle.Artifacts;

    const AgentVault = artifacts.require("AgentVault");
    const AgentVaultFactory = artifacts.require("AgentVaultFactory");

    const { deployer } = loadDeployAccounts(hre);

    const agentVaultImplementation = await waitFinalize(hre, deployer, () => AgentVault.new(ZERO_ADDRESS, { from: deployer }));
    const agentVaultFactory = await waitFinalize(hre, deployer, () => AgentVaultFactory.new(agentVaultImplementation.address, { from: deployer }));

    contracts.add("AgentVaultProxyImplementation", "AgentVault.sol", agentVaultImplementation.address);
    contracts.add("AgentVaultFactory", "AgentVaultFactory.sol", agentVaultFactory.address);

    return agentVaultFactory.address;
}

export async function deployCollateralPoolFactory(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    console.log(`Deploying CollateralPoolFactory`);

    const artifacts = hre.artifacts as Truffle.Artifacts;

    const CollateralPool = artifacts.require("CollateralPool");
    const CollateralPoolFactory = artifacts.require("CollateralPoolFactory");

    const { deployer } = loadDeployAccounts(hre);

    const collateralPoolImplementation = await waitFinalize(hre, deployer, () => CollateralPool.new(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, 0, { from: deployer }));
    const collateralPoolFactory = await waitFinalize(hre, deployer, () => CollateralPoolFactory.new(collateralPoolImplementation.address, { from: deployer }));

    contracts.add("CollateralPoolProxyImplementation", "CollateralPool.sol", collateralPoolImplementation.address);
    contracts.add("CollateralPoolFactory", "CollateralPoolFactory.sol", collateralPoolFactory.address);

    return collateralPoolFactory.address;
}

export async function deployCollateralPoolTokenFactory(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    console.log(`Deploying CollateralPoolTokenFactory`);

    const artifacts = hre.artifacts as Truffle.Artifacts;

    const CollateralPoolToken = artifacts.require("CollateralPoolToken");
    const CollateralPoolTokenFactory = artifacts.require("CollateralPoolTokenFactory");

    const { deployer } = loadDeployAccounts(hre);

    const collateralPoolTokenImplementation = await waitFinalize(hre, deployer, () => CollateralPoolToken.new(ZERO_ADDRESS, "", "", { from: deployer }));
    const collateralPoolTokenFactory = await waitFinalize(hre, deployer, () => CollateralPoolTokenFactory.new(collateralPoolTokenImplementation.address, { from: deployer }));

    contracts.add("CollateralPoolTokenProxyImplementation", "CollateralPoolToken.sol", collateralPoolTokenImplementation.address);
    contracts.add("CollateralPoolTokenFactory", "CollateralPoolTokenFactory.sol", collateralPoolTokenFactory.address);

    return collateralPoolTokenFactory.address;
}

export async function verifyAgentOwnerRegistry(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore, force: boolean) {
    const { deployer } = loadDeployAccounts(hre);
    await verifyContract(hre, "AgentOwnerRegistryImplementation", contracts);
    await verifyContract(hre, "AgentOwnerRegistry", contracts, [contracts.getAddress("AgentOwnerRegistryImplementation"), contracts.GovernanceSettings.address, deployer], force);
}

export async function verifyAgentVaultFactory(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore, force: boolean) {
    await verifyContract(hre, "AgentVaultProxyImplementation", contracts, [ZERO_ADDRESS]);
    await verifyContract(hre, "AgentVaultFactory", contracts, [contracts.getAddress("AgentVaultProxyImplementation")], force);
}

export async function verifyCollateralPoolFactory(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore, force: boolean) {
    await verifyContract(hre, "CollateralPoolProxyImplementation", contracts, [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, "0"]);
    await verifyContract(hre, "CollateralPoolFactory", contracts, [contracts.getAddress("CollateralPoolProxyImplementation")], force);
}

export async function verifyCollateralPoolTokenFactory(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore, force: boolean) {
    await verifyContract(hre, "CollateralPoolTokenProxyImplementation", contracts, [ZERO_ADDRESS, "", ""]);
    await verifyContract(hre, "CollateralPoolTokenFactory", contracts, [contracts.getAddress("CollateralPoolTokenProxyImplementation")], force);
}
