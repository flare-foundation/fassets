import {
    AddressUpdaterMockInstance, AgentVaultFactoryInstance, CollateralPoolFactoryInstance,
    CollateralPoolTokenFactoryInstance, ERC20MockInstance, FdcHubMockInstance, FdcVerificationMockInstance,
    FtsoV2PriceStoreMockInstance, GovernanceSettingsMockInstance,
    IIAssetManagerControllerInstance, IPriceReaderInstance, RelayMockInstance, WNatMockInstance
} from "../../../typechain-truffle";
import {
    AddressUpdaterEvents, AgentVaultFactoryEvents,
    CollateralPoolFactoryEvents, CollateralPoolTokenFactoryEvents, ERC20Events, FdcHubEvents,
    FdcVerificationEvents, FtsoV2PriceStoreEvents,
    IIAssetManagerControllerEvents, PriceReaderEvents, RelayEvents, WNatEvents
} from "../../fasset/IAssetContext";
import { ContractWithEvents } from "../../utils/events/truffle";
import { ZERO_ADDRESS } from "../../utils/helpers";
import { GENESIS_GOVERNANCE_ADDRESS } from "../constants";
import { newAssetManagerController } from "../fasset/CreateAssetManager";
import { createMockFtsoV2PriceStore } from "../test-settings";
import { testChainInfo, TestNatInfo, testNatInfo } from "./TestChainInfo";

const AgentVault = artifacts.require("AgentVault");
const AgentVaultFactory = artifacts.require('AgentVaultFactory');
const CollateralPool = artifacts.require("CollateralPool");
const CollateralPoolFactory = artifacts.require("CollateralPoolFactory");
const CollateralPoolToken = artifacts.require("CollateralPoolToken");
const CollateralPoolTokenFactory = artifacts.require("CollateralPoolTokenFactory");
const FdcVerification = artifacts.require('FdcVerificationMock');
const AddressUpdater = artifacts.require('AddressUpdaterMock');
const WNat = artifacts.require('WNatMock');
const ERC20Mock = artifacts.require("ERC20Mock");
const Relay = artifacts.require('RelayMock');
const FdcHub = artifacts.require('FdcHubMock');
const GovernanceSettings = artifacts.require('GovernanceSettingsMock');

// common context shared between several asset managers

export class CommonContext {
    static deepCopyWithObjectCreate = true;

    constructor(
        public governance: string,
        public governanceSettings: GovernanceSettingsMockInstance,
        public addressUpdater: ContractWithEvents<AddressUpdaterMockInstance, AddressUpdaterEvents>,
        public assetManagerController: ContractWithEvents<IIAssetManagerControllerInstance, IIAssetManagerControllerEvents>,
        public relay: ContractWithEvents<RelayMockInstance, RelayEvents>,
        public fdcHub: ContractWithEvents<FdcHubMockInstance, FdcHubEvents>,
        public agentVaultFactory: ContractWithEvents<AgentVaultFactoryInstance, AgentVaultFactoryEvents>,
        public collateralPoolFactory: ContractWithEvents<CollateralPoolFactoryInstance, CollateralPoolFactoryEvents>,
        public collateralPoolTokenFactory: ContractWithEvents<CollateralPoolTokenFactoryInstance, CollateralPoolTokenFactoryEvents>,
        public fdcVerification: ContractWithEvents<FdcVerificationMockInstance, FdcVerificationEvents>,
        public priceReader: ContractWithEvents<IPriceReaderInstance, PriceReaderEvents>,
        public priceStore: ContractWithEvents<FtsoV2PriceStoreMockInstance, FtsoV2PriceStoreEvents>,
        public natInfo: TestNatInfo,
        public wNat: ContractWithEvents<WNatMockInstance, WNatEvents>,
        public stablecoins: Record<string, ContractWithEvents<ERC20MockInstance, ERC20Events>>,
    ) { }

    static async createTest(governance: string): Promise<CommonContext> {
        // create governance settings
        const governanceSettings = await GovernanceSettings.new();
        await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
        // create FdcHub
        const fdcHub = await FdcHub.new();
        // create Relay
        const relay = await Relay.new();
        // create attestation client
        const fdcVerification = await FdcVerification.new(relay.address, 200);
        // create address updater
        const addressUpdater = await AddressUpdater.new(governanceSettings.address, governance); // don't switch to production
        // create WNat token
        const wNat = await WNat.new(governance, testNatInfo.name, testNatInfo.symbol);
        // create stablecoins
        const stablecoins = {
            USDC: await ERC20Mock.new("USDCoin", "USDC"),
            USDT: await ERC20Mock.new("Tether", "USDT"),
        };
        // create price reader
        const priceStore = await createMockFtsoV2PriceStore(governanceSettings.address, governance, addressUpdater.address, testChainInfo);
        // add some addresses to address updater
        await addressUpdater.addOrUpdateContractNamesAndAddresses(
            ["GovernanceSettings", "AddressUpdater", "FdcHub", "Relay", "FdcVerification", "FtsoV2PriceStore", "WNat"],
            [governanceSettings.address, addressUpdater.address, fdcHub.address, relay.address, fdcVerification.address, priceStore.address, wNat.address],
            { from: governance });
        // create agent vault factory
        const agentVaultImplementation = await AgentVault.new(ZERO_ADDRESS);
        const agentVaultFactory = await AgentVaultFactory.new(agentVaultImplementation.address);
        // create collateral pool factory
        const collateralPoolImplementation = await CollateralPool.new(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, 0);
        const collateralPoolFactory = await CollateralPoolFactory.new(collateralPoolImplementation.address);
        // create collateral pool token factory
        const collateralPoolTokenImplementation = await CollateralPoolToken.new(ZERO_ADDRESS, "", "");
        const collateralPoolTokenFactory = await CollateralPoolTokenFactory.new(collateralPoolTokenImplementation.address);
        // create asset manager controller
        const assetManagerController = await newAssetManagerController(governanceSettings.address, governance, addressUpdater.address);
        await assetManagerController.switchToProductionMode({ from: governance });
        // collect
        return new CommonContext(governance, governanceSettings, addressUpdater, assetManagerController, relay, fdcHub,
            agentVaultFactory, collateralPoolFactory, collateralPoolTokenFactory,
            fdcVerification, priceStore, priceStore, testNatInfo, wNat, stablecoins);
    }
}
