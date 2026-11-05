import { AssetManagerSettings } from "../../lib/fasset/AssetManagerTypes";
import { web3DeepNormalize } from "../../lib/utils/web3normalize";
import { AssetManagerControllerInstance } from "../../typechain-truffle";
import { ContractStore, FAssetContractStore } from "./contracts";
import { deployAgentVaultFactory, deployCollateralPoolFactory, deployCollateralPoolTokenFactory } from "./deploy-asset-manager-dependencies";
import { deployFacet } from "./deploy-asset-manager-facets";
import { DeployScriptEnvironment } from "./deploy-scripts";
import { getProxyImplementationAddress } from "./deploy-utils";
import { ExecuteOption, GovernanceNonce, writeGovernanceTransaction } from "./governance-transaction";

export { Nonce, type ExecuteOption } from "./governance-transaction";

export async function upgradeAssetManagerController(
    env: DeployScriptEnvironment,
    execute: ExecuteOption,
    description: string = "upgrade AssetManagerController"
) {
    const { hre, artifacts, contracts, deployer } = env;
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));

    const newAssetManagerControllerImplAddress = await deployFacet(hre, "AssetManagerControllerImplementation", contracts, deployer, "AssetManagerController");

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeTo(newAssetManagerControllerImplAddress, { from: deployer });
        console.log(`AssetManagerController upgraded to ${await getProxyImplementationAddress(hre, assetManagerController.address)}`);
    } else {
        await outputGovernanceCall(env, "AssetManagerController", assetManagerController, "upgradeTo", [newAssetManagerControllerImplAddress], execute, description);
    }
}

export async function upgradeAgentVaultFactory(
    env: DeployScriptEnvironment,
    assetSymbols: string[] | "all",
    execute: ExecuteOption,
    description: string = "upgrade AgentVaultFactory"
) {
    const { hre, artifacts, contracts, deployer } = env;
    const { assetManagers, assetManagerController } = await getAssetManagersAndController(artifacts, contracts, assetSymbols);

    const newAgentVaultFactoryAddress = await deployAgentVaultFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setAgentVaultFactory(assetManagers, newAgentVaultFactoryAddress, { from: deployer });
        await printUpgradedContracts(contracts, "AgentVaultFactory", assetManagers, s => s.agentVaultFactory);
    } else {
        await outputGovernanceCall(env, "AssetManagerController", assetManagerController, "setAgentVaultFactory", [assetManagers, newAgentVaultFactoryAddress], execute, description);
    }
}

export async function upgradeCollateralPoolFactory(
    env: DeployScriptEnvironment,
    assetSymbols: string[] | "all",
    execute: ExecuteOption,
    description: string = "upgrade CollateralPoolFactory"
) {
    const { hre, artifacts, contracts, deployer } = env;
    const { assetManagers, assetManagerController } = await getAssetManagersAndController(artifacts, contracts, assetSymbols);

    const newCollateralPoolFactoryAddress = await deployCollateralPoolFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setCollateralPoolFactory(assetManagers, newCollateralPoolFactoryAddress, { from: deployer });
        await printUpgradedContracts(contracts, "CollateralPoolFactory", assetManagers, s => s.collateralPoolFactory);
    } else {
        await outputGovernanceCall(env, "AssetManagerController", assetManagerController, "setCollateralPoolFactory", [assetManagers, newCollateralPoolFactoryAddress], execute, description);
    }
}

export async function upgradeCollateralPoolTokenFactory(
    env: DeployScriptEnvironment,
    assetSymbols: string[] | "all",
    execute: ExecuteOption,
    description: string = "upgrade CollateralPoolTokenFactory"
) {
    const { hre, artifacts, contracts, deployer } = env;
    const { assetManagers, assetManagerController } = await getAssetManagersAndController(artifacts, contracts, assetSymbols);

    const newCollateralPoolTokenFactoryAddress = await deployCollateralPoolTokenFactory(hre, contracts);

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.setCollateralPoolTokenFactory(assetManagers, newCollateralPoolTokenFactoryAddress, { from: deployer });
        await printUpgradedContracts(contracts, "CollateralPoolTokenFactory", assetManagers, s => s.collateralPoolTokenFactory);
    } else {
        await outputGovernanceCall(env, "AssetManagerController", assetManagerController, "setCollateralPoolTokenFactory", [assetManagers, newCollateralPoolTokenFactoryAddress], execute, description);
    }
}

export async function upgradeFAsset(
    env: DeployScriptEnvironment,
    assetSymbols: string[] | "all",
    execute: ExecuteOption,
    description: string = "upgrade FAsset"
) {
    const { hre, artifacts, contracts, deployer } = env;
    const { assetManagers, assetManagerController } = await getAssetManagersAndController(artifacts, contracts, assetSymbols);

    const newFAssetImplAddress = await deployFacet(hre, "FAssetImplementation", contracts, deployer, "FAsset");

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeFAssetImplementation(assetManagers, newFAssetImplAddress, "0x");
        await printUpgradedContracts(contracts, "FAsset", assetManagers, async s => await getProxyImplementationAddress(hre, s.fAsset));
    } else {
        await outputGovernanceCall(env, "AssetManagerController", assetManagerController, "upgradeFAssetImplementation", [assetManagers, newFAssetImplAddress, "0x"], execute, description);
    }
}

export async function upgradeAgentVaultsAndPools(
    env: DeployScriptEnvironment,
    assetSymbols: string[] | "all", execute: ExecuteOption,
    description: string = "upgrade agent vaults and pools"
) {
    const { artifacts, contracts } = env;
    const { assetManagers, assetManagerController } = await getAssetManagersAndController(artifacts, contracts, assetSymbols);

    let maxAgentsCount = 0;
    const IIAssetManager = artifacts.require("IIAssetManager");
    for (const addr of assetManagers) {
        const am = await IIAssetManager.at(addr);
        const { 1: count } = await am.getAllAgents(0, 0); // just to get the count of agents
        maxAgentsCount = Math.max(maxAgentsCount, count.toNumber());
    }

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeAgentVaultsAndPools(assetManagers, 0, maxAgentsCount);
        console.log("AgentVault, CollateralPool and CollateralPoolToken contracts upgraded for all agents on all asset managers.");
    } else {
        await outputGovernanceCall(env, "AssetManagerController", assetManagerController, "upgradeAgentVaultsAndPools", [assetManagers, 0, maxAgentsCount], execute, description);
    }
}

/**
 * Upgrade a governed proxy and call a function on the new implementation in the same transaction.
 * @param contractName name of the proxy in the contracts store
 * @param implementationName name of the implementation in the contracts store
 * @param implementationContract Solidity contract name of the implementation
 * @param execute whether to execute the upgrade or just print the data; when nonce counter is given, also write governance transaction JSON
 * @param description short description for the governance transaction JSON (default `upgrade <contractName>`)
 */
export async function upgradeGovernedProxy(
    env: DeployScriptEnvironment,
    contractName: string,               // name of the proxy in the contracts store
    implementationName: string,         // name of the implementation in the contracts store
    implementationContract: string,     // Solidity contract name of the implementation
    execute: ExecuteOption,
    description: string = `upgrade ${contractName}`
) {
    const { hre, artifacts, contracts, deployer } = env;
    const GovernedUUPSProxyImplementation = artifacts.require("GovernedUUPSProxyImplementation");
    const proxy = await GovernedUUPSProxyImplementation.at(contracts.getAddress(contractName));

    const newImplAddress = await deployFacet(hre, implementationName, contracts, deployer, implementationContract);

    if (await shouldExecute(execute, proxy)) {
        await proxy.upgradeTo(newImplAddress, { from: deployer });
        console.log(`${implementationContract} at ${proxy.address} upgraded to ${await getProxyImplementationAddress(hre, proxy.address)}`);
    } else {
        const instance = await artifacts.require("IUUPSUpgradeable").at(proxy.address);
        await outputGovernanceCall(env, contractName, instance, "upgradeTo", [newImplAddress], execute, description, implementationContract);
    }
}

/**
 * Upgrade a governed proxy and call a function on the new implementation in the same transaction. This is useful for initializing new state variables in the implementation.
 * @param contractName name of the proxy in the contracts store
 * @param implementationName name of the implementation in the contracts store
 * @param implementationContract Solidity contract name of the implementation
 * @param calldata calldata to be passed to the implementation contract during the upgrade
 * @param execute whether to execute the upgrade or just print the data; when nonce counter is given, also write governance transaction JSON
 * @param description short description for the governance transaction JSON (default `upgrade <contractName> and call <method in calldata>`)
 */
export async function upgradeGovernedProxyAndCall(
    env: DeployScriptEnvironment,
    contractName: string,               // name of the proxy in the contracts store
    implementationName: string,         // name of the implementation in the contracts store
    implementationContract: string,     // Solidity contract name of the implementation
    calldata: string,
    execute: ExecuteOption,
    description: string = upgradeAndCallDescription(env, contractName, implementationContract, calldata)
) {
    const { hre, artifacts, contracts, deployer } = env;
    const GovernedUUPSProxyImplementation = artifacts.require("GovernedUUPSProxyImplementation");
    const proxy = await GovernedUUPSProxyImplementation.at(contracts.getAddress(contractName));

    const newImplAddress = await deployFacet(hre, implementationName, contracts, deployer, implementationContract);

    if (await shouldExecute(execute, proxy)) {
        await proxy.upgradeToAndCall(newImplAddress, calldata, { from: deployer });
        console.log(`${implementationContract} at ${proxy.address} upgraded to ${await getProxyImplementationAddress(hre, proxy.address)}`);
    } else {
        const instance = await artifacts.require("IUUPSUpgradeable").at(proxy.address);
        await outputGovernanceCall(env, contractName, instance, "upgradeToAndCall", [newImplAddress, calldata], execute, description, implementationContract);
    }
}

function upgradeAndCallDescription({ hre }: DeployScriptEnvironment, contractName: string, implementationContract: string, calldata: string) {
    if (calldata.length < 10) return `upgrade ${contractName}`;
    const selector = calldata.slice(0, 10).toLowerCase();
    const abi = hre.artifacts.readArtifactSync(implementationContract).abi as AbiItem[];
    const method = abi.find(it => it.type === "function" && web3.eth.abi.encodeFunctionSignature(it) === selector);
    return `upgrade ${contractName} and call ${method?.name ?? selector}`;
}

interface IGovernedRead {
    governance(): Promise<string>;
    productionMode(): Promise<boolean>;
};

type TruffleResponse = Truffle.TransactionResponse<Truffle.AnyEvent>;

type TruffleMethod<A extends unknown[], R = TruffleResponse> = (...args: [...A, Truffle.TransactionDetails?]) => Promise<R>;

type TruffleMethodParameters<T, R = unknown> = T extends TruffleMethod<infer P, R> ? P : never;

export async function performGovernanceCall<C extends Truffle.ContractInstance & IGovernedRead, M extends keyof C & string>(
    env: DeployScriptEnvironment,
    contractName: string,
    instance: C,
    method: M,
    args: TruffleMethodParameters<C[M], TruffleResponse>,
    execute: ExecuteOption,
    description?: string
) {
    const { deployer } = env;
    if (await shouldExecute(execute, instance)) {
        const res = await (instance[method] as TruffleMethod<typeof args>)(...args, { from: deployer });
        console.log(`Transaction ${res.tx} executed on contract ${contractName} at ${instance.address}`);
    } else {
        await outputGovernanceCallUnchecked(env, contractName, instance, method, args, execute, description);
    }
}

export function printExecuteData<C extends Truffle.ContractInstance, M extends keyof C & string>(
    contractName: string,
    instance: C,
    method: M,
    args: TruffleMethodParameters<C[M]>,
    description?: string
) {
    printExecuteDataUnchecked(contractName, instance, method, args, description);
}

export function printExecuteDataUnchecked(
    contractName: string,
    instance: Truffle.ContractInstance,
    method: string,
    args: unknown[],
    description?: string
) {
    const methodAbi = instance.abi.find(it => it.type === "function" && it.name === method)!;
    const formattedParams = methodAbi.inputs!.map((param, index) => `${param.name} = ${JSON.stringify(web3DeepNormalize(args[index]))}`)
    console.log("");    // blank line for readability
    console.log(`EXECUTE: ${contractName}(${instance.address}) ${method}(${formattedParams.join(", ")})`);
    if (description) {
        console.log(`    description: ${description}`);
    }
    const abidata = web3.eth.abi.encodeFunctionCall(methodAbi, args as string[]);
    console.log(`    abi: ${abidata}`);
}

/**
 * Print the governance call data and, if `execute` is a nonce counter, also write governance transaction JSON file.
 * @param implementationContract Solidity contract implementing the method (used for timelock detection); auto-detected if omitted
 */
export async function outputGovernanceCall<C extends Truffle.ContractInstance, M extends keyof C & string>(
    env: DeployScriptEnvironment,
    contractName: string,
    instance: C,
    method: M,
    args: TruffleMethodParameters<C[M]>,
    execute: ExecuteOption,
    description?: string,
    implementationContract?: string
) {
    await outputGovernanceCallUnchecked(env, contractName, instance, method, args, execute, description, implementationContract);
}

export async function outputGovernanceCallUnchecked(
    { hre, contracts }: DeployScriptEnvironment,
    contractName: string,
    instance: Truffle.ContractInstance,
    method: string,
    args: unknown[],
    execute: ExecuteOption,
    description?: string,
    implementationContract?: string
) {
    printExecuteDataUnchecked(contractName, instance, method, args, description);
    if (execute instanceof GovernanceNonce) {
        await writeGovernanceTransaction(hre, contracts, execute, { contractName, instance, method, args, description, implementationContract });
    }
}

async function shouldExecute(execute: ExecuteOption, contract: IGovernedRead) {
    const productionMode = await contract.productionMode();
    return execute === true && !productionMode;
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

export async function getAssetManagersAndController(artifacts: Truffle.Artifacts, contracts: FAssetContractStore, assetSymbols: string[] | "all") {
    const AssetManagerController = artifacts.require("AssetManagerController");
    const assetManagerController = await AssetManagerController.at(contracts.getAddress("AssetManagerController"));
    const assetManagers = await getAssetManagers(contracts, assetManagerController, assetSymbols);
    return { assetManagers, assetManagerController };
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
