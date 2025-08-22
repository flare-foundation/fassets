import {
    AddressUpdaterMockInstance,
    AgentOwnerRegistryInstance,
    AgentVaultFactoryInstance,
    CollateralPoolFactoryInstance,
    CollateralPoolTokenFactoryInstance,
    ERC20MockInstance,
    FdcHubMockInstance,
    FtsoV2PriceStoreMockInstance,
    GovernanceSettingsMockInstance,
    IFdcVerificationInstance,
    IGovernanceSettingsInstance,
    IIAssetManagerInstance,
    IPriceReaderInstance,
    RelayMockInstance,
    WNatMockInstance
} from "../../typechain-truffle";
import { AgentSettings, AssetManagerSettings, CollateralClass, CollateralType } from "../fasset/AssetManagerTypes";
import { ChainInfo } from "../fasset/ChainInfo";
import { AttestationHelper } from "../underlying-chain/AttestationHelper";
import { findRequiredEvent } from "../utils/events/truffle";
import { BNish, DAYS, HOURS, MINUTES, requireNotNull, toBIPS, toBNExp, WEEKS, ZERO_ADDRESS } from "../utils/helpers";
import { web3DeepNormalize } from "../utils/web3normalize";
import { CoreVaultManagerSettings } from "./actors/MockCoreVaultBot";
import { testChainInfo, TestChainInfo } from "./actors/TestChainInfo";
import { GENESIS_GOVERNANCE_ADDRESS } from "./constants";
import { AssetManagerInitSettings, waitForTimelock } from "./fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "./fasset/MockChain";
import { time } from "./test-helpers";

const AgentVault = artifacts.require("AgentVault");
const WNat = artifacts.require("WNatMock");
const AddressUpdater = artifacts.require('AddressUpdaterMock');
const FdcVerification = artifacts.require('FdcVerificationMock');
const FtsoV2PriceStoreMock = artifacts.require('FtsoV2PriceStoreMock');
const FtsoV2PriceStoreProxy = artifacts.require('FtsoV2PriceStoreProxy');
const FdcHub = artifacts.require('FdcHubMock');
const Relay = artifacts.require('RelayMock');
const GovernanceSettings = artifacts.require('GovernanceSettingsMock');
const AgentVaultFactory = artifacts.require('AgentVaultFactory');
const ERC20Mock = artifacts.require("ERC20Mock");
const CollateralPool = artifacts.require("CollateralPool");
const CollateralPoolToken = artifacts.require("CollateralPoolToken");
const CollateralPoolFactory = artifacts.require("CollateralPoolFactory");
const CollateralPoolTokenFactory = artifacts.require("CollateralPoolTokenFactory");
const AgentOwnerRegistry = artifacts.require("AgentOwnerRegistry");
const AgentOwnerRegistryProxy = artifacts.require("AgentOwnerRegistryProxy");
const CoreVaultManager = artifacts.require('CoreVaultManager');
const CoreVaultManagerProxy = artifacts.require('CoreVaultManagerProxy');

export interface TestSettingsCommonContracts {
    governanceSettings: GovernanceSettingsMockInstance;
    addressUpdater: AddressUpdaterMockInstance;
    agentVaultFactory: AgentVaultFactoryInstance;
    collateralPoolFactory: CollateralPoolFactoryInstance;
    collateralPoolTokenFactory: CollateralPoolTokenFactoryInstance;
    relay: RelayMockInstance;
    fdcHub: FdcHubMockInstance;
    fdcVerification: IFdcVerificationInstance;
    priceReader: IPriceReaderInstance,
    agentOwnerRegistry: AgentOwnerRegistryInstance;
    wNat: WNatMockInstance,
    stablecoins: Record<string, ERC20MockInstance>,
}

export interface CoreVaultManagerInitSettings extends CoreVaultManagerSettings {
    underlyingAddress: string;
    initialNonce: BNish;
    custodianAddress: string;
    triggeringAccounts: string[];
}

export interface TestSettingsContracts extends TestSettingsCommonContracts {
    priceStore: FtsoV2PriceStoreMockInstance;
}

export type TestSettingOptions = Partial<AssetManagerInitSettings>;

export function createTestSettings(contracts: TestSettingsCommonContracts, ci: TestChainInfo, options?: TestSettingOptions): AssetManagerInitSettings {
    const result: AssetManagerInitSettings = {
        assetManagerController: ZERO_ADDRESS,     // replaced in newAssetManager(...)
        fAsset: ZERO_ADDRESS,                     // replaced in newAssetManager(...)
        agentVaultFactory: contracts.agentVaultFactory.address,
        collateralPoolFactory: contracts.collateralPoolFactory.address,
        collateralPoolTokenFactory: contracts.collateralPoolTokenFactory.address,
        fdcVerification: contracts.fdcVerification.address,
        priceReader: contracts.priceReader.address,
        __whitelist: ZERO_ADDRESS,
        agentOwnerRegistry: contracts.agentOwnerRegistry?.address ?? ZERO_ADDRESS,
        burnAddress: ZERO_ADDRESS,
        chainId: ci.chainId,
        poolTokenSuffix: ci.assetSymbol,
        collateralReservationFeeBIPS: toBIPS("1%"),
        assetDecimals: ci.decimals,
        assetUnitUBA: toBNExp(1, ci.decimals),
        assetMintingDecimals: ci.amgDecimals,
        assetMintingGranularityUBA: toBNExp(1, ci.decimals - ci.amgDecimals),
        __minUnderlyingBackingBIPS: 0,
        mintingCapAMG: 0,                                   // minting cap disabled
        lotSizeAMG: toBNExp(ci.lotSize, ci.amgDecimals),
        __requireEOAAddressProof: false, // no longer used, always false
        underlyingBlocksForPayment: ci.underlyingBlocksForPayment,
        underlyingSecondsForPayment: ci.underlyingBlocksForPayment * ci.blockTime,
        redemptionFeeBIPS: toBIPS("2%"),
        maxRedeemedTickets: 20,
        redemptionDefaultFactorVaultCollateralBIPS: toBIPS(1.1),
        __redemptionDefaultFactorPoolBIPS: 0,
        confirmationByOthersAfterSeconds: 6 * HOURS,            // 6 hours
        confirmationByOthersRewardUSD5: toBNExp(100, 5),        // 100 USD
        paymentChallengeRewardUSD5: toBNExp(300, 5),            // 300 USD
        paymentChallengeRewardBIPS: 0,
        withdrawalWaitMinSeconds: 300,
        __ccbTimeSeconds: 0,
        maxTrustedPriceAgeSeconds: 8 * MINUTES,
        minUpdateRepeatTimeSeconds: 1 * DAYS,
        attestationWindowSeconds: 1 * DAYS,
        averageBlockTimeMS: Math.round(ci.blockTime * 1000),
        __buybackCollateralFactorBIPS: 0,
        __announcedUnderlyingConfirmationMinSeconds: 0,
        agentFeeChangeTimelockSeconds: 6 * HOURS,
        agentMintingCRChangeTimelockSeconds: 1 * HOURS,
        poolExitCRChangeTimelockSeconds: 2 * HOURS,
        agentTimelockedOperationWindowSeconds: 1 * HOURS,
        agentExitAvailableTimelockSeconds: 10 * MINUTES,
        vaultCollateralBuyForFlareFactorBIPS: toBIPS(1.05),
        mintingPoolHoldingsRequiredBIPS: toBIPS("50%"),
        tokenInvalidationTimeMinSeconds: 1 * DAYS,
        collateralPoolTokenTimelockSeconds: 1 * HOURS,
        liquidationStepSeconds: 90,
        liquidationCollateralFactorBIPS: [toBIPS(1.2), toBIPS(1.6), toBIPS(2.0)],
        liquidationFactorVaultCollateralBIPS: [toBIPS(1), toBIPS(1), toBIPS(1)],
        diamondCutMinTimelockSeconds: 1 * HOURS,
        maxEmergencyPauseDurationSeconds: 1 * DAYS,
        emergencyPauseDurationResetAfterSeconds: 7 * DAYS,
        redemptionPaymentExtensionSeconds: 10,
        __cancelCollateralReservationAfterSeconds: 0,
        __rejectOrCancelCollateralReservationReturnFactorBIPS: 0,
        __rejectRedemptionRequestWindowSeconds: 0,
        __takeOverRedemptionRequestWindowSeconds: 0,
        __rejectedRedemptionDefaultFactorVaultCollateralBIPS: 0,
        __rejectedRedemptionDefaultFactorPoolBIPS: 0,
        coreVaultNativeAddress: "0xfa3BdC8709226Da0dA13A4d904c8b66f16c3c8BA",     // one of test accounts [9]
        coreVaultTransferTimeExtensionSeconds: 2 * HOURS,
        coreVaultRedemptionFeeBIPS: toBIPS("1%"),
        coreVaultMinimumAmountLeftBIPS: 0,
        coreVaultMinimumRedeemLots: 10,
    };
    return Object.assign(result, options ?? {});
}

export function createTestCoreVaultManagerSettings(ci: TestChainInfo, options?: Partial<CoreVaultManagerInitSettings>): CoreVaultManagerInitSettings {
    const lotSize = toBNExp(ci.lotSize, ci.decimals);
    const defaultTestSettings: CoreVaultManagerInitSettings = {
        underlyingAddress: "TEST_CORE_VAULT_UNDERLYING",
        initialNonce: 1,
        custodianAddress: "TEST_CORE_VAULT_CUSTODIAN",
        escrowAmount: lotSize.muln(100),
        escrowEndTimeSeconds: 12 * HOURS,   // 12h noon
        minimalAmountLeft: lotSize.muln(100),
        chainPaymentFee: 50,
        triggeringAccounts: [],
    }
    return { ...defaultTestSettings, ...options };
}

export function createTestCollaterals(contracts: TestSettingsCommonContracts, ci: ChainInfo): CollateralType[] {
    const poolCollateral: CollateralType = {
        collateralClass: CollateralClass.POOL,
        token: contracts.wNat.address,
        decimals: 18,
        validUntil: 0,  // not deprecated
        directPricePair: false,
        assetFtsoSymbol: ci.symbol,
        tokenFtsoSymbol: "NAT",
        minCollateralRatioBIPS: toBIPS(2.0),
        safetyMinCollateralRatioBIPS: toBIPS(2.1),
    };
    const usdcCollateral: CollateralType = {
        collateralClass: CollateralClass.VAULT,
        token: contracts.stablecoins.USDC.address,
        decimals: 18,
        validUntil: 0,  // not deprecated
        directPricePair: false,
        assetFtsoSymbol: ci.symbol,
        tokenFtsoSymbol: "USDC",
        minCollateralRatioBIPS: toBIPS(1.4),
        safetyMinCollateralRatioBIPS: toBIPS(1.5),
    };
    const usdtCollateral: CollateralType = {
        collateralClass: CollateralClass.VAULT,
        token: contracts.stablecoins.USDT.address,
        decimals: 18,
        validUntil: 0,  // not deprecated
        directPricePair: false,
        assetFtsoSymbol: ci.symbol,
        tokenFtsoSymbol: "USDT",
        minCollateralRatioBIPS: toBIPS(1.5),
        safetyMinCollateralRatioBIPS: toBIPS(1.6),
    };
    return [poolCollateral, usdcCollateral, usdtCollateral];
}

let poolTokenSymbolCounter = 0;

export function createTestAgentSettings(vaultCollateralTokenAddress: string, options?: Partial<AgentSettings>): AgentSettings {
    const defaults: AgentSettings = {
        vaultCollateralToken: vaultCollateralTokenAddress,
        poolTokenSuffix: `AGNT${++poolTokenSymbolCounter}`,
        feeBIPS: toBIPS("10%"),
        poolFeeShareBIPS: toBIPS("40%"),
        mintingVaultCollateralRatioBIPS: toBIPS(1.6),
        mintingPoolCollateralRatioBIPS: toBIPS(2.5),
        poolExitCollateralRatioBIPS: toBIPS(2.6),
        buyFAssetByAgentFactorBIPS: toBIPS(0.9),
        redemptionPoolFeeShareBIPS: 0
    };
    return { ...defaults, ...(options ?? {}) };
}

export async function createTestContracts(governance: string): Promise<TestSettingsContracts> {
    // create governance settings
    const governanceSettings = await GovernanceSettings.new();
    await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
    // create address updater
    const addressUpdater = await AddressUpdater.new(governanceSettings.address, governance);  // don't switch to production
    // create FdcHub
    const fdcHub = await FdcHub.new();
    // create Relay
    const relay = await Relay.new();
    // create attestation client
    const fdcVerification = await FdcVerification.new(relay.address, 200);
    // create WNat token
    const wNat = await WNat.new(governance, "NetworkNative", "NAT");
    // create stablecoins
    const stablecoins = {
        USDC: await ERC20Mock.new("USDCoin", "USDC"),
        USDT: await ERC20Mock.new("Tether", "USDT"),
    };

    // create FTSOv2 price store
    const priceStore = await createMockFtsoV2PriceStore(governanceSettings.address, governance, addressUpdater.address, {...testChainInfo});

    // add some addresses to address updater
    await addressUpdater.addOrUpdateContractNamesAndAddresses(
        ["GovernanceSettings", "AddressUpdater", "FdcHub", "Relay", "FdcVerification", "WNat", "FtsoV2PriceStore"],
        [governanceSettings.address, addressUpdater.address, fdcHub.address, relay.address, fdcVerification.address, wNat.address, priceStore.address],
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
    // create agent owner registry
    const agentOwnerRegistry = await createAgentOwnerRegistry(governanceSettings, governance);
    //
    return {
        governanceSettings, addressUpdater, agentVaultFactory, collateralPoolFactory, collateralPoolTokenFactory, relay, fdcHub, fdcVerification,
        priceStore, priceReader: priceStore, agentOwnerRegistry, wNat, stablecoins };
}

export async function createAgentOwnerRegistry(governanceSettings: IGovernanceSettingsInstance, governance: string) {
    const agentOwnerRegistryImpl = await AgentOwnerRegistry.new();
    const agentOwnerRegistryProxy = await AgentOwnerRegistryProxy.new(agentOwnerRegistryImpl.address, governanceSettings.address, governance);
    return await AgentOwnerRegistry.at(agentOwnerRegistryProxy.address);
}

export async function createCoreVaultManager(assetManager: IIAssetManagerInstance, addressUpdater: AddressUpdaterMockInstance, settings: CoreVaultManagerInitSettings) {
    const coreVaultManagerImpl = await CoreVaultManager.new();
    const assetManagerSettings = await assetManager.getSettings();
    const governanceSettings = await assetManager.governanceSettings();
    const governance = await assetManager.governance();
    const coreVaultManagerProxy = await CoreVaultManagerProxy.new(coreVaultManagerImpl.address, governanceSettings, governance, addressUpdater.address,
        assetManager.address, assetManagerSettings.chainId, settings.custodianAddress, settings.underlyingAddress, settings.initialNonce);
    const coreVaultManager = await CoreVaultManager.at(coreVaultManagerProxy.address);
    await addressUpdater.updateContractAddresses([coreVaultManager.address], { from: governance });
    await coreVaultManager.updateSettings(settings.escrowEndTimeSeconds, settings.escrowAmount, settings.minimalAmountLeft, settings.chainPaymentFee, { from: governance });
    await coreVaultManager.addTriggeringAccounts(settings.triggeringAccounts, { from: governance });
    return coreVaultManager;
}

export async function assignCoreVaultManager(assetManager: IIAssetManagerInstance, addressUpdater: AddressUpdaterMockInstance, settings: CoreVaultManagerInitSettings)
{
    const governance = await assetManager.governance();
    const coreVaultManager = await createCoreVaultManager(assetManager, addressUpdater, settings);
    await waitForTimelock(assetManager.setCoreVaultManager(coreVaultManager.address, { from: governance }), assetManager, governance);
    return coreVaultManager;
}

export interface CreateTestAgentDeps {
    assetManager: IIAssetManagerInstance;
    settings: AssetManagerSettings;
    chain?: MockChain;
    wallet?: MockChainWallet;
    attestationProvider: AttestationHelper;
}

export async function createTestAgent(deps: CreateTestAgentDeps, owner: string, underlyingAddress: string, vaultCollateralTokenAddress: string, options?: Partial<AgentSettings>) {
    // update current block in asset manager
    const blockHeightProof = await deps.attestationProvider.proveConfirmedBlockHeightExists(Number(deps.settings.attestationWindowSeconds));
    await deps.assetManager.updateCurrentBlock(blockHeightProof);
    // whitelist agent management address if not already whitelisted
    await whitelistAgentOwner(deps.settings.agentOwnerRegistry, owner);
    // validate underlying address
    const addressValidityProof = await deps.attestationProvider.proveAddressValidity(underlyingAddress);
    // create agent
    const agentSettings = createTestAgentSettings(vaultCollateralTokenAddress, options);
    const response = await deps.assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: owner });
    // extract agent vault address from AgentVaultCreated event
    const event = findRequiredEvent(response, 'AgentVaultCreated');
    const agentVaultAddress = event.args.agentVault;
    // get vault contract at this address
    return await AgentVault.at(agentVaultAddress);
}

export async function createMockFtsoV2PriceStore(governanceSettingsAddress: string, initialGovernance: string, addressUpdater: string, assetChainInfos: Record<string, TestChainInfo>) {
    const currentTime = await time.latest();
    const votingEpochDurationSeconds = 90;
    const firstVotingRoundStartTs = currentTime.toNumber() - 1 * WEEKS;
    const ftsoScalingProtocolId = 100;
    // create store
    const priceStoreImpl = await FtsoV2PriceStoreMock.new();
    const priceStoreProxy = await FtsoV2PriceStoreProxy.new(priceStoreImpl.address,
        governanceSettingsAddress, initialGovernance, addressUpdater,
        firstVotingRoundStartTs, votingEpochDurationSeconds, ftsoScalingProtocolId);
    const priceStore = await FtsoV2PriceStoreMock.at(priceStoreProxy.address);
    // setup
    const feedIdArr = ["0xc1", "0xc2", "0xc3"];
    const symbolArr = ["NAT", "USDC", "USDT"];
    const decimalsArr = [5, 5, 5];
    for (const [i, ci] of Object.values(assetChainInfos).entries()) {
        feedIdArr.push(`0xa${i + 1}`);
        symbolArr.push(ci.symbol);
        decimalsArr.push(5);
    }
    await priceStore.updateSettings(feedIdArr, symbolArr, decimalsArr, 50, { from: initialGovernance });
    // init prices
    async function setInitPrice(symbol: string, price: number | string) {
        const decimals = requireNotNull(decimalsArr[symbolArr.indexOf(symbol)]);
        await priceStore.setCurrentPrice(symbol, toBNExp(price, decimals), 0);
        await priceStore.setCurrentPriceFromTrustedProviders(symbol, toBNExp(price, decimals), 0);
    }
    await setInitPrice("NAT", 0.42);
    await setInitPrice("USDC", 1.01);
    await setInitPrice("USDT", 0.99);
    for (const ci of Object.values(assetChainInfos)) {
        await setInitPrice(ci.symbol, ci.startPrice);
    }
    //
    return priceStore;
}

export async function whitelistAgentOwner(agentOwnerRegistryAddress: string, owner: string) {
    const agentOwnerRegistry = await AgentOwnerRegistry.at(agentOwnerRegistryAddress);
    if (!(await agentOwnerRegistry.isWhitelisted(owner))) {
        const governance = await agentOwnerRegistry.governance();
        const res = await agentOwnerRegistry.whitelistAndDescribeAgent(owner, "", "", "", "", { from: governance });
        findRequiredEvent(res, 'Whitelisted');
    }
}
