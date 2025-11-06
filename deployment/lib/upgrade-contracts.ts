import { AssetManagerSettings } from "../../lib/fasset/AssetManagerTypes";
import { web3DeepNormalize } from "../../lib/utils/web3normalize";
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
        printExecuteData("AssetManagerController", assetManagerController, "upgradeTo", [newAssetManagerControllerImplAddress]);
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
        printExecuteData("AssetManagerController", assetManagerController, "setAgentVaultFactory", [assetManagers, newAgentVaultFactoryAddress]);
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
        printExecuteData("AssetManagerController", assetManagerController, "setCollateralPoolFactory", [assetManagers, newCollateralPoolFactoryAddress]);
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
        printExecuteData("AssetManagerController", assetManagerController, "setCollateralPoolTokenFactory", [assetManagers, newCollateralPoolTokenFactoryAddress]);
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
        printExecuteData("AssetManagerController", assetManagerController, "upgradeFAssetImplementation", [assetManagers, newFAssetImplAddress, "0x"]);
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
        const { 1: count } = await am.getAllAgents(0, 0); // just to get the count of agents
        maxAgentsCount = Math.max(maxAgentsCount, count.toNumber());
    }

    if (await shouldExecute(execute, assetManagerController)) {
        await assetManagerController.upgradeAgentVaultsAndPools(assetManagers, 0, maxAgentsCount);
        console.log("AgentVault, CollateralPool and CollateralPoolToken contracts upgraded for all agents on all asset managers.");
    } else {
        printExecuteData("AssetManagerController", assetManagerController, "upgradeAgentVaultsAndPools", [assetManagers, 0, maxAgentsCount]);
    }
}

export async function upgradeGovernedProxy({ hre, artifacts, contracts, deployer }: DeployScriptEnvironment, contractName: string, implementationName: string, implementationContract: string, execute: boolean) {
    const GovernedUUPSProxyImplementation = artifacts.require("GovernedUUPSProxyImplementation");
    const proxy = await GovernedUUPSProxyImplementation.at(contracts.getAddress(contractName));

    const newImplAddress = await deployFacet(hre, implementationName, contracts, deployer, implementationContract);

    if (await shouldExecute(execute, proxy)) {
        await proxy.upgradeTo(newImplAddress, { from: deployer });
        console.log(`${implementationContract} at ${proxy.address} upgraded to ${await getProxyImplementationAddress(hre, proxy.address)}`);
    } else {
        const instance = await requireUnchecked(artifacts, contractName).at(proxy.address);
        printExecuteDataUnchecked(implementationContract, instance, "upgradeTo", [newImplAddress]);
    }
}

interface IGovernedRead {
    governance(): Promise<string>;
    productionMode(): Promise<boolean>;
};

type TruffleResponse = Truffle.TransactionResponse<Truffle.AnyEvent>;

type TruffleMethod<A extends unknown[], R = TruffleResponse> = (...args: [...A, Truffle.TransactionDetails?]) => Promise<R>;

type TruffleMethodParameters<T, R = unknown> = T extends TruffleMethod<infer P, R> ? P : never;

export async function performGovernanceCall<C extends Truffle.ContractInstance & IGovernedRead, M extends keyof C & string>(
    { deployer }: DeployScriptEnvironment, contractName: string, instance: C, method: M, args: TruffleMethodParameters<C[M], TruffleResponse>, execute: boolean
) {
    if (await shouldExecute(execute, instance)) {
        const res = await (instance[method] as TruffleMethod<typeof args>)(...args, { from: deployer });
        console.log(`Transaction ${res.tx} executed on contract ${contractName} at ${instance.address}`);
    } else {
        printExecuteDataUnchecked(contractName, instance, method, args);
    }
}

function printExecuteData<C extends Truffle.ContractInstance, M extends keyof C & string>(contractName: string, instance: C, method: M, args: TruffleMethodParameters<C[M]>) {
    printExecuteDataUnchecked(contractName, instance, method, args);
}

function printExecuteDataUnchecked(contractName: string, instance: Truffle.ContractInstance, method: string, args: unknown[]) {
    const methodAbi = instance.abi.find(it => it.type === "function" && it.name === method)!;
    const formattedParams = methodAbi.inputs!.map((param, index) => `${param.name} = ${JSON.stringify(web3DeepNormalize(args[index]))}`)
    console.log(`EXECUTE: ${contractName}(${instance.address}) ${method}(${formattedParams.join(", ")})`);
    const abidata = web3.eth.abi.encodeFunctionCall(methodAbi, args as string[]);
    console.log(`    abi: ${abidata}`);
}

function requireUnchecked(artifacts: Truffle.Artifacts, contractName: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
    return artifacts.require(contractName as any) as unknown as Truffle.Contract<Truffle.ContractInstance>;
}

async function shouldExecute(execute: boolean, contract: IGovernedRead) {
    const productionMode = await contract.productionMode();
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
