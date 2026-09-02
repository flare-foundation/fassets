import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { FAssetContractStore } from "./contracts";
import { currentDeployConfigDir, encodeContractNames, loadDeployAccounts, truffleContractMetadata } from './deploy-utils';
import { FtsoV2PriceStoreParameters } from './ftsov2-price-store-parameters';
import { JsonParameterSchema } from './JsonParameterSchema';
import { verifyContract } from './verify-fasset-contracts';

export interface IFeedId {
    category: number;
    name: string;
}

export async function deployPriceReaderV2(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    console.log(`Deploying PriceReaderV2`);

    const artifacts = hre.artifacts as Truffle.Artifacts;

    const { deployer } = loadDeployAccounts(hre);
    const parameters = readFtsoV2Parameters();

    const FtsoV2PriceStore = artifacts.require(parameters.contractName as "FtsoV2PriceStore");
    const FtsoV2PriceStoreProxy = artifacts.require("FtsoV2PriceStoreProxy");

    // deploy via proxy
    const ftsoV2PriceStoreImpl = await FtsoV2PriceStore.new();
    const ftsoV2PriceStoreProxy = await FtsoV2PriceStoreProxy.new(ftsoV2PriceStoreImpl.address,
        contracts.GovernanceSettings.address, deployer, deployer, parameters.firstVotingRoundStartTs, parameters.votingEpochDurationSeconds, 100);
    const ftsoV2PriceStore = await FtsoV2PriceStore.at(ftsoV2PriceStoreProxy.address);

    await ftsoV2PriceStore.updateContractAddresses(
        encodeContractNames(hre, ["AddressUpdater", "Relay", "FtsoV2"]),
        [contracts.AddressUpdater.address, contracts.Relay.address, contracts.FtsoV2.address],
        { from: deployer });

    await ftsoV2PriceStore.setTrustedProviders(parameters.trustedProviders, parameters.trustedProvidersThreshold, { from: deployer });

    const feeds = feedSettings(parameters);
    await ftsoV2PriceStore.updateSettings(
        feeds.scalingFeedIds,
        feeds.fastUpdatesFeedIds,
        feeds.symbols,
        feeds.feedDecimals,
        parameters.maxSpreadBIPS,
        parameters.minTurnoutBIPS,
        { from: deployer });

    contracts.add("PriceReader", "FtsoV2PriceStoreProxy.sol", ftsoV2PriceStore.address);
    contracts.add("FtsoV2PriceStoreImplementation", "FtsoV2PriceStore.sol", ftsoV2PriceStoreImpl.address);
    contracts.add("FtsoV2PriceStore", "FtsoV2PriceStoreProxy.sol", ftsoV2PriceStore.address, { mustSwitchToProduction: true });

    console.log(`    deployed ${truffleContractMetadata(FtsoV2PriceStore).contractName}`);
}

/**
 * Splits the configured feeds into the FTSO scaling and the FTSOv2 fast updates lists and returns
 * the arguments for `FtsoV2PriceStore.updateSettings` - the symbols and the decimals are ordered as
 * the concatenation of the two feed id lists, which is what the contract expects.
 */
export function feedSettings(parameters: FtsoV2PriceStoreParameters) {
    const scalingFeeds = parameters.feeds.filter(feed => (feed.source ?? "scaling") === "scaling");
    const fastUpdatesFeeds = parameters.feeds.filter(feed => feed.source === "fastUpdates");
    const encode = (feeds: FtsoV2PriceStoreParameters["feeds"]) =>
        encodeFeedIds(feeds.map(feed => ({ category: 1, name: feed.feedId })));
    const orderedFeeds = [...scalingFeeds, ...fastUpdatesFeeds];
    return {
        scalingFeedIds: encode(scalingFeeds),
        fastUpdatesFeedIds: encode(fastUpdatesFeeds),
        symbols: orderedFeeds.map(feed => feed.symbol),
        feedDecimals: orderedFeeds.map(feed => feed.feedDecimals),
    };
}

export function encodeFeedIds(feedIds: IFeedId[]): string[] {
    const result = [];
    for (const feedId of feedIds) {
        if (feedId.category < 0 || feedId.category >= 2 ** 8) {
            throw Error(`Invalid feed category: ${feedId.category}`);
        }
        if (feedId.name.length > 20) {
            throw Error(`Invalid feed name: ${feedId.name} - length: ${feedId.name.length}`);
        }
        result.push("0x" + feedId.category.toString(16).padStart(2, "0") + Buffer.from(feedId.name).toString("hex").padEnd(40, "0"));
    }
    return result;
}

export function decodeFeedId(encodedFeedId: string): IFeedId {
    const hex = encodedFeedId.startsWith("0x") ? encodedFeedId.slice(2) : encodedFeedId;
    if (hex.length !== 42) {
        throw Error(`Invalid encoded feed id: ${encodedFeedId}`);
    }
    const category = parseInt(hex.slice(0, 2), 16);
    // the name is zero-padded on the right
    const name = Buffer.from(hex.slice(2), "hex").toString().replace(/\0+$/, "");
    return { category, name };
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ftsoV2PriceStoreParameters = new JsonParameterSchema<FtsoV2PriceStoreParameters>(require('../config/ftsov2-price-store-parameters.json'));

export function readFtsoV2Parameters(): FtsoV2PriceStoreParameters {
    const paramFileName = `${currentDeployConfigDir()}/ftsov2.json`;
    const parameters = ftsoV2PriceStoreParameters.load(paramFileName);
    return parameters;
}

export async function verifyFtsoV2PriceStore(hre: HardhatRuntimeEnvironment, contracts: FAssetContractStore) {
    const parameters = readFtsoV2Parameters();
    const { deployer } = loadDeployAccounts(hre);
    await verifyContract(hre, "FtsoV2PriceStoreImplementation", contracts, []);
    await verifyContract(hre, "FtsoV2PriceStore", contracts,
        [contracts.getAddress("FtsoV2PriceStoreImplementation"), contracts.GovernanceSettings.address, deployer, deployer,
            String(parameters.firstVotingRoundStartTs), String(parameters.votingEpochDurationSeconds), String(100)],
        true);
}
