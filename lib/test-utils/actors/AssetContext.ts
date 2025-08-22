import { AgentOwnerRegistryInstance, CoreVaultManagerInstance, FAssetInstance, IIAssetManagerInstance } from "../../../typechain-truffle";
import { AssetManagerSettings, CollateralType, RedemptionTicketInfo } from "../../fasset/AssetManagerTypes";
import { convertAmgToTokenWei, convertAmgToUBA, convertTokenWeiToAMG, convertUBAToAmg } from "../../fasset/Conversions";
import { AgentOwnerRegistryEvents, AssetManagerEvents, CoreVaultManagerEvents, FAssetEvents, IAssetContext } from "../../fasset/IAssetContext";
import { CollateralPrice } from "../../state/CollateralPrice";
import { Prices } from "../../state/Prices";
import { TokenPriceReader } from "../../state/TokenPrice";
import { AttestationHelper } from "../../underlying-chain/AttestationHelper";
import { UnderlyingChainEvents } from "../../underlying-chain/UnderlyingChainEvents";
import { IBlockChain } from "../../underlying-chain/interfaces/IBlockChain";
import { IFlareDataConnectorClient } from "../../underlying-chain/interfaces/IFlareDataConnectorClient";
import { EventScope } from "../../utils/events/ScopedEvents";
import { ContractWithEvents, requiredEventArgs } from "../../utils/events/truffle";
import { BN_ZERO, BNish, toBN, toBNExp, toNumber } from "../../utils/helpers";
import { AssetManagerInitSettings, newAssetManager, waitForTimelock } from "../fasset/CreateAssetManager";
import { MockChain } from "../fasset/MockChain";
import { MockFlareDataConnectorClient } from "../fasset/MockFlareDataConnectorClient";
import { time } from "../test-helpers";
import { assignCoreVaultManager, CoreVaultManagerInitSettings, createAgentOwnerRegistry, createCoreVaultManager, createTestCollaterals, createTestCoreVaultManagerSettings, createTestSettings, TestSettingOptions } from "../test-settings";
import { CommonContext } from "./CommonContext";
import { TestChainInfo } from "./TestChainInfo";

const MockContract = artifacts.require('MockContract');

export interface SettingsOptions {
    // optional settings
    collaterals?: CollateralType[];
    testSettings?: TestSettingOptions;
    // optional contracts
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

    async setCollateralReservationFeeBips(newCollateralReservationFeeBips: BNish) {
        await waitForTimelock(this.assetManagerController.setCollateralReservationFeeBips([this.assetManager.address], newCollateralReservationFeeBips, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setRedemptionFeeBips(newRedemptionFeeBips: BNish) {
        await waitForTimelock(this.assetManagerController.setRedemptionFeeBips([this.assetManager.address], newRedemptionFeeBips, { from: this.governance }), this.assetManagerController, this.governance);
        await this.refreshSettings();
    }

    async setCollateralRatiosForToken(collateralClass: BNish, token: string, minCollateralRatioBIPS: BNish, safetyMinCollateralRatioBIPS: BNish) {
        await waitForTimelock(this.assetManagerController.setCollateralRatiosForToken([this.assetManager.address], collateralClass, token, minCollateralRatioBIPS,
            safetyMinCollateralRatioBIPS, { from: this.governance }), this.assetManagerController, this.governance);
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

    async createAgentOwnerRegistry() {
        const agentOwnerRegistry = await createAgentOwnerRegistry(this.common.governanceSettings, this.governance);
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

    async transferFAsset(from: string, to: string, amount: BNish) {
        const res = await this.fAsset.transfer(to, amount, { from });
        return requiredEventArgs(res, 'Transfer');
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
        // create agent owner registry
        const agentOwnerRegistry = await createAgentOwnerRegistry(common.governanceSettings, common.governance);
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
            agentOwnerRegistry ?? options.agentOwnerRegistry, assetManager, fAsset, settings, collaterals);
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
