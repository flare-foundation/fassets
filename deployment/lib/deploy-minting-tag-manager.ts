import { HardhatRuntimeEnvironment } from "hardhat/types";
import { readFileSync } from "node:fs";
import { FAssetContractStore } from "./contracts";
import { currentDeployConfigDir, loadDeployAccounts } from "./deploy-utils";
import { verifyContract } from "./verify-fasset-contracts";

export interface MintingTagManagerParameters {
    name: string;
    symbol: string;
    reservationFee: string; // in NAT Wei
    reservationFeeRecipient: string;
    reservedTagCount: number;
}

export async function deployMintingTagManager(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    console.log(`Deploying MintingTagManager`);

    const artifacts = hre.artifacts as Truffle.Artifacts;
    const { deployer } = loadDeployAccounts(hre);
    const parameters = readMintingTagManagerParameters();

    const MintingTagManager = artifacts.require("MintingTagManager");
    const MintingTagManagerProxy = artifacts.require("MintingTagManagerProxy");

    const mintingTagManagerImpl = await MintingTagManager.new();
    const mintingTagManager = await MintingTagManagerProxy.new(mintingTagManagerImpl.address, contracts.GovernanceSettings.address, deployer,
        parameters.name, parameters.symbol, parameters.reservationFee, parameters.reservationFeeRecipient, parameters.reservedTagCount, { from: deployer });

    contracts.add("MintingTagManagerImplementation", "MintingTagManager.sol", mintingTagManagerImpl.address);
    contracts.add("MintingTagManager", "MintingTagManagerProxy.sol", mintingTagManager.address);
}

export async function verifyMintingTagManager(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    const parameters = readMintingTagManagerParameters();
    const { deployer } = loadDeployAccounts(hre);
    await verifyContract(hre, "MintingTagManagerImplementation", contracts, []);
    await verifyContract(hre, "MintingTagManager", contracts,
        [
            contracts.getAddress("MintingTagManager"), contracts.GovernanceSettings.address, deployer,
            parameters.name, parameters.symbol, parameters.reservationFee, parameters.reservationFeeRecipient, String(parameters.reservedTagCount)
        ],
        true);
}


function readMintingTagManagerParameters(): MintingTagManagerParameters {
    const paramFileName = `${currentDeployConfigDir()}/minting-tag-manager.json`;
    const parameters = JSON.parse(readFileSync(paramFileName, { encoding: "ascii" })) as MintingTagManagerParameters;
    return parameters;
}
