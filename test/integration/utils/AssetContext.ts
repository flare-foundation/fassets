import { time } from "@openzeppelin/test-helpers";
import { AssetManagerSettings, CollateralType, RedemptionTicketInfo } from "../../../lib/fasset/AssetManagerTypes";
import { convertAmgToTokenWei, convertAmgToUBA, convertTokenWeiToAMG, convertUBAToAmg } from "../../../lib/fasset/Conversions";
import { AgentOwnerRegistryEvents, AssetManagerEvents, CoreVaultManagerEvents, FAssetEvents, IAssetContext, WhitelistEvents } from "../../../lib/fasset/IAssetContext";
import { CollateralPrice } from "../../../lib/state/CollateralPrice";
import { Prices } from "../../../lib/state/Prices";
import { TokenPriceReader } from "../../../lib/state/TokenPrice";
import { AttestationHelper } from "../../../lib/underlying-chain/AttestationHelper";
import { UnderlyingChainEvents } from "../../../lib/underlying-chain/UnderlyingChainEvents";
import { IBlockChain } from "../../../lib/underlying-chain/interfaces/IBlockChain";
import { IFlareDataConnectorClient } from "../../../lib/underlying-chain/interfaces/IFlareDataConnectorClient";
import { EventScope } from "../../../lib/utils/events/ScopedEvents";
import { ContractWithEvents, filterEvents } from "../../../lib/utils/events/truffle";
import { BN_ZERO, BNish, sorted, toBN, toBNExp, toNumber } from "../../../lib/utils/helpers";
import { AgentOwnerRegistryInstance, CoreVaultManagerInstance, FAssetInstance, IIAssetManagerInstance, WhitelistInstance } from "../../../typechain-truffle";
import { AssetManagerInitSettings, newAssetManager, waitForTimelock } from "../../utils/fasset/CreateAssetManager";
import { MockChain } from "../../utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../utils/fasset/MockFlareDataConnectorClient";
import { assignCoreVaultManager, CoreVaultManagerInitSettings, createCoreVaultManager, createTestCollaterals, createTestCoreVaultManagerSettings, createTestSettings, TestSettingOptions } from "../../utils/test-settings";
import { CommonContext } from "./CommonContext";
import { TestChainInfo } from "./TestChainInfo";

const AgentOwnerRegistry = artifacts.require("AgentOwnerRegistry");
const MockContract = artifacts.require('MockContract');
const Whitelist = artifacts.require('Whitelist');

export interface SettingsOptions {
    // optional settings
    collaterals?: CollateralType[];
    testSettings?: TestSettingOptions;
    // optional contracts
    whitelist?: ContractWithEvents<WhitelistInstance, WhitelistEvents>;
    agentOwnerRegistry?: ContractWithEvents<AgentOwnerRegistryInstance, AgentOwnerRegistryEvents>;
}

// context, specific for each asset manager (includes common context vars)
export class AssetContext implements IAssetContext {
    static deepCopyWithObjectCreate = true;

    constructor(
        public common: CommonContext,
        public chainInfo: TestChainInfo,
        public chain: IBlockChain,
        public chainEvents: UnderlyingChainEvents,
        public flareDataConnectorClient: IFlareDataConnectorClient,
        public attestationProvider: AttestationHelper,
        public whitelist: ContractWithEvents<WhitelistInstance, WhitelistEvents> | undefined,
        public agentOwnerRegistry: ContractWithEvents<AgentOwnerRegistryInstance, AgentOwnerRegistryEvents>,
        public assetManager: ContractWithEvents<IIAssetManagerInstance, AssetManagerEvents>,
        public fAsset: ContractWithEvents<FAssetInstance, FAssetEvents>,
        // following three settings are initial and may not be fresh
        public initSettings: AssetManagerInitSettings,
        public collaterals: CollateralType[],
    ) {
    }

    settings: AssetManagerSettings = this.initSettings;

    governance = this.common.governance;
    addressUpdater = this.common.addressUpdater;
    assetManagerController = this.common.assetManagerController;
    relay = this.common.relay;
    fdcHub = this.common.fdcHub;
    agentVaultFactory = this.common.agentVaultFactory;
    collateralPoolFactory = this.common.collateralPoolFactory;
    collateralPoolTokenFactory = this.common.collateralPoolTokenFactory;
    fdcVerification = this.common.fdcVerification;
    priceReader = this.common.priceReader;
    priceStore = this.common.priceStore;
    natInfo = this.common.natInfo;
    wNat = this.common.wNat;
    stablecoins = this.common.stablecoins;

    usdc = this.stablecoins.USDC;
    usdt = this.stablecoins.USDT;

    chainId = this.chainInfo.chainId;

    coreVaultManager: ContractWithEvents<CoreVaultManagerInstance, CoreVaultManagerEvents> | undefined;

    /**
     * Convert underlying amount to base units (e.g. eth to wei)
     */
    underlyingAmount(value: number) {
        return toBNExp(value, this.chainInfo.decimals);
    }

    async refreshSettings() {
        this.settings = await this.assetManager.getSettings();
    }

    lotSize() {
        return toBN(this.settings.lotSizeAMG).mul(toBN(this.settings.assetMintingGranularityUBA));
    }

    async setLotSizeAmg(newLotSizeAMG: BNish) {
        await waitForTimelock(this.assetManagerController.setLotSizeAmg([this.assetManager.address], newLotSizeAMG, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setMinUnderlyingBackingBips(newMinUnderlyingBackingBips: BNish) {
        await waitForTimelock(this.assetManagerController.setMinUnderlyingBackingBips([this.assetManager.address], newMinUnderlyingBackingBips, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setCollateralReservationFeeBips(newCollateralReservationFeeBips: BNish) {
        await waitForTimelock(this.assetManagerController.setCollateralReservationFeeBips([this.assetManager.address], newCollateralReservationFeeBips, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setRedemptionFeeBips(newRedemptionFeeBips: BNish) {
        await waitForTimelock(this.assetManagerController.setRedemptionFeeBips([this.assetManager.address], newRedemptionFeeBips, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setCollateralRatiosForToken(collateralClass: BNish, token: string, minCollateralRatioBIPS: BNish, ccbMinCollateralRatioBIPS: BNish, safetyMinCollateralRatioBIPS: BNish) {
        await waitForTimelock(this.assetManagerController.setCollateralRatiosForToken([this.assetManager.address], collateralClass, token, minCollateralRatioBIPS,
            ccbMinCollateralRatioBIPS, safetyMinCollateralRatioBIPS, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setWhitelist(whitelist: WhitelistInstance) {
        this.whitelist = whitelist;
        await waitForTimelock(this.assetManagerController.setWhitelist([this.assetManager.address], whitelist.address, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setCollateralPoolTokenTimelockSeconds(value: BNish) {
        await waitForTimelock(this.assetManagerController.setCollateralPoolTokenTimelockSeconds([this.assetManager.address], value, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setAgentOwnerRegistry(agentOwnerRegistry: AgentOwnerRegistryInstance) {
        this.agentOwnerRegistry = agentOwnerRegistry;
        await waitForTimelock(this.assetManagerController.setAgentOwnerRegistry([this.assetManager.address], agentOwnerRegistry.address, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async createWhitelists() {
        const whitelist = await Whitelist.new(this.common.governanceSettings.address, this.governance, true);
        await whitelist.switchToProductionMode({ from: this.governance });
        await this.setWhitelist(whitelist);
        const agentOwnerRegistry = await AgentOwnerRegistry.new(this.common.governanceSettings.address, this.governance, true);
        await agentOwnerRegistry.switchToProductionMode({ from: this.governance });
        await this.setAgentOwnerRegistry(agentOwnerRegistry);
    }

    async createCoreVaultManager(options?: Partial<CoreVaultManagerInitSettings>) {
        const settings = createTestCoreVaultManagerSettings(this.chainInfo, options);
        return await createCoreVaultManager(this.assetManager, this.addressUpdater, settings);
    }

    async assignCoreVaultManager(options?: Partial<CoreVaultManagerInitSettings>) {
        const settings = createTestCoreVaultManagerSettings(this.chainInfo, options);
        this.coreVaultManager = await assignCoreVaultManager(this.assetManager, this.addressUpdater, settings);
        return this.coreVaultManager;
    }

    async updateUnderlyingBlock() {
        const proof = await this.attestationProvider.proveConfirmedBlockHeightExists(this.attestationWindowSeconds());
        await this.assetManager.updateCurrentBlock(proof);
        return toNumber(proof.data.requestBody.blockNumber) + toNumber(proof.data.responseBody.numberOfConfirmations);
    }

    async transferFAsset(from: string, to: string, amount: BNish, addFee: boolean = false) {
        const res = addFee
            ? await this.fAsset.transferExactDest(to, amount, { from })
            : await this.fAsset.transfer(to, amount, { from });
        const transferEvents = sorted(filterEvents(res, "Transfer"), ev => toBN(ev.args.value), (x, y) => -x.cmp(y));
        assert.isAtLeast(transferEvents.length, 1, "Missing event Transfer");
        return { ...transferEvents[0].args, fee: transferEvents[1]?.args.value };
    }

    attestationWindowSeconds() {
        return Number(this.settings.attestationWindowSeconds);
    }

    convertAmgToUBA(valueAMG: BNish) {
        return convertAmgToUBA(this.settings, valueAMG);
    }

    convertUBAToAmg(valueUBA: BNish) {
        return convertUBAToAmg(this.settings, valueUBA);
    }

    convertUBAToLots(valueUBA: BNish) {
        return toBN(valueUBA).div(this.lotSize());
    }

    convertLotsToUBA(lots: BNish) {
        return toBN(lots).mul(this.lotSize());
    }

    convertLotsToAMG(lots: BNish) {
        return toBN(lots).mul(toBN(this.settings.lotSizeAMG));
    }

    convertAmgToNATWei(valueAMG: BNish, amgToNATWeiPrice: BNish) {
        return convertAmgToTokenWei(valueAMG, amgToNATWeiPrice);
    }

    convertNATWeiToAMG(valueNATWei: BNish, amgToNATWeiPrice: BNish) {
        return convertTokenWeiToAMG(valueNATWei, amgToNATWeiPrice);
    }

    convertUBAToNATWei(valueUBA: BNish, amgToNATWeiPrice: BNish) {
        return this.convertAmgToNATWei(this.convertUBAToAmg(valueUBA), amgToNATWeiPrice);
    }

    tokenName(address: string) {
        if (address === this.wNat.address) {
            return "NAT";
        } else if (address === this.fAsset.address) {
            return 'f' + this.chainInfo.symbol;
        } else {
            for (const [name, token] of Object.entries(this.stablecoins)) {
                if (address === token.address) return name.toUpperCase();
            }
        }
        return '?TOKEN?';
    }

    async waitForUnderlyingTransaction(scope: EventScope | undefined, txHash: string, maxBlocksToWaitForTx?: number) {
        return this.chainEvents.waitForUnderlyingTransaction(scope, txHash, maxBlocksToWaitForTx);
    }

    async waitForUnderlyingTransactionFinalization(scope: EventScope | undefined, txHash: string, maxBlocksToWaitForTx?: number) {
        return this.chainEvents.waitForUnderlyingTransactionFinalization(scope, txHash, maxBlocksToWaitForTx);
    }

    getCollateralPrice(collateral: CollateralType, trusted: boolean = false) {
        const priceReader = new TokenPriceReader(this.priceReader);
        return CollateralPrice.forCollateral(priceReader, this.settings, collateral, trusted);
    }

    getPrices() {
        return Prices.getPrices(this, this.settings, this.collaterals);
    }

    skipToExpiration(lastUnderlyingBlock: BNish, lastUnderlyingTimestamp: BNish) {
        const chain = this.chain as MockChain;
        chain.skipTimeTo(Number(lastUnderlyingTimestamp) + 1);
        chain.mineTo(Number(lastUnderlyingBlock) + 1);
        chain.mine(chain.finalizationBlocks);
    }

    skipToProofUnavailability(lastUnderlyingBlock: BNish, lastUnderlyingTimestamp: BNish) {
        const chain = this.chain as MockChain;
        chain.skipTimeTo(Number(lastUnderlyingTimestamp) + 1);
        chain.mineTo(Number(lastUnderlyingBlock) + 1);
        chain.skipTime(this.attestationWindowSeconds() + 1);
        chain.mine(chain.finalizationBlocks);
    }

    async createGovernanceVP() {
        const governanceVotePower = await MockContract.new();
        const ownerTokenCall = web3.eth.abi.encodeFunctionCall({ type: 'function', name: 'ownerToken', inputs: [] }, []);
        await governanceVotePower.givenMethodReturnAddress(ownerTokenCall, this.wNat.address);
        return governanceVotePower;
    }

    async getRedemptionQueue(pageSize: BNish = 20) {
        const result: RedemptionTicketInfo[] = [];
        let firstTicketId = BN_ZERO;
        do {
            const { 0: chunk, 1: nextId } = await this.assetManager.redemptionQueue(firstTicketId, pageSize);
            result.splice(result.length, 0, ...chunk);
            firstTicketId = nextId;
        } while (!firstTicketId.eqn(0));
        return result;
    }

    static async createTest(common: CommonContext, chainInfo: TestChainInfo, options: SettingsOptions = {}): Promise<AssetContext> {
        // create mock chain
        const chain = new MockChain(await time.latest());
        chain.secondsPerBlock = chainInfo.blockTime;
        // chain event listener
        const chainEvents = new UnderlyingChainEvents(chain, chain /* as IBlockChainEvents */, null);
        // create mock attestation provider
        const flareDataConnectorClient = new MockFlareDataConnectorClient(common.fdcHub, common.relay, { [chainInfo.chainId]: chain }, 'on_wait');
        const attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, chainInfo.chainId);
        // create allow-all agent owner registry
        const agentOwnerRegistry = await AgentOwnerRegistry.new(common.governanceSettings.address, common.governance, true);
        await agentOwnerRegistry.setAllowAll(true, { from: common.governance });
        // create collaterals
        const testSettingsContracts = { ...common, agentOwnerRegistry };
        // create settings
        const settings = createTestSettings(testSettingsContracts, chainInfo, options.testSettings);
        const collaterals = options.collaterals ?? createTestCollaterals(testSettingsContracts, chainInfo);
        // create asset manager
        const [assetManager, fAsset] = await newAssetManager(common.governance, common.assetManagerController,
            chainInfo.name, chainInfo.symbol, chainInfo.decimals, settings, collaterals, chainInfo.assetName, chainInfo.assetSymbol,
            { governanceSettings: common.governanceSettings.address });
        // collect
        return new AssetContext(common, chainInfo, chain, chainEvents, flareDataConnectorClient, attestationProvider,
            options.whitelist, agentOwnerRegistry ?? options.agentOwnerRegistry, assetManager, fAsset, settings, collaterals);
    }
}

export class AssetContextClient {
    constructor(
        public context: AssetContext,
    ) { }

    protected assetManager = this.context.assetManager;
    protected chain = this.context.chain;
    protected attestationProvider = this.context.attestationProvider;
    protected wnat = this.context.wNat;
    protected usdc = this.context.usdc;
    protected fAsset = this.context.fAsset;
}
