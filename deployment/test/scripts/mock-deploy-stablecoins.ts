import hre from "hardhat";
import { FAssetContractStore } from "../../lib/contracts";
import { loadCurrentDeployContracts, loadDeployAccounts, runAsyncMain } from "../../lib/deploy-utils";

const FakeERC20 = artifacts.require('FakeERC20');

// only use when deploying on full flare deploy on hardhat local network (i.e. `deploy_local_hardhat_commands` was run in flare-smart-contracts project)
runAsyncMain(async () => {
    const contracts = loadCurrentDeployContracts(true);
    await deployStablecoin(contracts, "Test USDCoin", "testUSDC", 6);
    await deployStablecoin(contracts, "Test Tether", "testUSDT", 6);
    await deployStablecoin(contracts, "Test Ether", "testETH", 18);
    await deployStablecoin(contracts, "Test USDT0", "testUSDT0", 6);
});

async function deployStablecoin(contracts: FAssetContractStore, name: string, symbol: string, decimals: number) {
    // create token
    const { deployer } = loadDeployAccounts(hre);
    const token = await FakeERC20.new(contracts.GovernanceSettings.address, deployer, name, symbol, decimals);
    contracts.add(symbol, 'FakeERC20.sol', token.address, { mustSwitchToProduction: true });
}
