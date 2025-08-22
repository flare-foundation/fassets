import { HardhatRuntimeEnvironment } from "hardhat/types";
import { FAssetContractStore } from "./contracts";
import { loadDeployAccounts, waitFinalize, ZERO_ADDRESS } from "./deploy-utils";


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
