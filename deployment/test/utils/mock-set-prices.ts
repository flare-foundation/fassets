import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { toBNExp } from "../../../lib/utils/helpers";
import { FAssetContractStore } from "../../lib/contracts";
import { loadDeployAccounts } from "../../lib/deploy-utils";

/**
 * Test prices by symbol: [decimals, price].
 */
export const testPrices: Record<string, [number, number]> = {
    'CFLR': [5, 0.20],
    'testUSDC': [5, 1.01],
    'testUSDT': [5, 0.99],
    'testETH': [3, 3000],
    'testBTC': [2, 20_000],
    'testDOGE': [5, 0.05],
    'testXRP': [5, 0.50],
    'SGB': [5, 0.20],
    'USDX': [5, 0.99],
    'XRP': [5, 0.50],
    'BTC': [2, 20_000],
    'DOGE': [5, 0.05],
};

/**
 * Set the current prices for all the symbols supported by the price store.
 * Only works with `FtsoV2PriceStoreMock`, which is deployed on local networks instead of
 * `FtsoV2PriceStore` - see the `contractName` parameter in `deployment/config/hardhat/ftsov2.json`.
 * The prices have to be set before the asset managers are deployed, since adding a collateral type
 * requires the price of the asset and of the collateral token to be initialized.
 */
export async function mockSetPrices(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    const artifacts = hre.artifacts as Truffle.Artifacts;
    const { deployer } = loadDeployAccounts(hre);
    const priceStore = await artifacts.require('FtsoV2PriceStoreMock').at(contracts.FtsoV2PriceStore!.address);
    for (const symbol of await priceStore.getSymbols()) {
        const price = testPrices[symbol];
        if (price == null) {
            throw new Error(`Missing test price for symbol ${symbol}`);
        }
        const [decimals, value] = price;
        await priceStore.setCurrentPrice(symbol, toBNExp(value, decimals), 0, { from: deployer });
        await priceStore.setCurrentPriceFromTrustedProviders(symbol, toBNExp(value, decimals), 0, { from: deployer });
    }
}
