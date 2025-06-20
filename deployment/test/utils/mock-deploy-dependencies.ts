import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { testDeployGovernanceSettings } from "../../../lib/test-utils/contract-test-helpers";
import { FAssetContractStore } from "../../lib/contracts";
import { loadDeployAccounts } from "../../lib/deploy-utils";

const AddressUpdaterMock = artifacts.require('AddressUpdaterMock');
const RelayMock = artifacts.require('RelayMock');
const FdcHubMock = artifacts.require('FdcHubMock');
const WNatMock = artifacts.require('WNatMock');
const FdcVerification = artifacts.require('FdcVerificationMock');

export async function mockDeployDependencies(hre: HardhatRuntimeEnvironment, contractsFile: string) {
    const { deployer } = loadDeployAccounts(hre);

    const accounts = await hre.web3.eth.getAccounts();
    const governance = accounts[99];

    // GovernanceSettings
    const governanceSettings = await testDeployGovernanceSettings(governance, 1, [governance, deployer]);

    // AddressUpdater
    const addressUpdater = await AddressUpdaterMock.new(governanceSettings.address, deployer);
    await addressUpdater.addOrUpdateContractNamesAndAddresses(["AddressUpdater"], [addressUpdater.address], { from: deployer });
    await addressUpdater.addOrUpdateContractNamesAndAddresses(["GovernanceSettings"], [governanceSettings.address], { from: deployer });

    // FdcHub
    const fdcHub = await FdcHubMock.new();
    await addressUpdater.addOrUpdateContractNamesAndAddresses(["FdcHub"], [fdcHub.address], { from: deployer });

    // Relay
    const relay = await RelayMock.new();
    await addressUpdater.addOrUpdateContractNamesAndAddresses(["Relay"], [relay.address], { from: deployer });

    // FDCVerification
    const fdcVerification = await FdcVerification.new(relay.address, 200);
    await addressUpdater.addOrUpdateContractNamesAndAddresses(["FdcVerification"], [fdcVerification.address], { from: deployer });

    // WNat
    const wNat = await WNatMock.new(deployer, "Wrapped Native", "WNAT");
    await addressUpdater.addOrUpdateContractNamesAndAddresses(["WNat"], [wNat.address], { from: deployer });

    // create contracts
    const contracts = new FAssetContractStore(contractsFile, true);
    contracts.add('GovernanceSettings', 'GovernanceSettings.sol', governanceSettings.address);
    contracts.add('AddressUpdater', 'AddressUpdater.sol', addressUpdater.address);
    contracts.add('Relay', 'RelayMock.sol', relay.address);
    contracts.add('FdcHub', 'FdcHubMock.sol', fdcHub.address);
    contracts.add('FdcVerification', 'FdcVerificationMock.sol', fdcVerification.address);
    contracts.add('WNat', 'WNat.sol', wNat.address);

    // switch to production
    await addressUpdater.switchToProductionMode();
}
