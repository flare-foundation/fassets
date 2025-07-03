import { AgentStatus, AssetManagerSettings, CollateralType } from "../fasset/AssetManagerTypes";
import { AssetManagerEvents, IAssetContext } from "../fasset/IAssetContext";
import { UnderlyingChainEvents } from "../underlying-chain/UnderlyingChainEvents";
import { EventFormatter } from "../utils/events/EventFormatter";
import { IEvmEvents } from "../utils/events/IEvmEvents";
import { EventExecutionQueue, TriggerableEvent } from "../utils/events/ScopedEvents";
import { EvmEvent, ExtractedEventArgs } from "../utils/events/common";
import { BN_ZERO, sumBN, toBN } from "../utils/helpers";
import { stringifyJson } from "../utils/json-bn";
import { ILogger } from "../utils/logging";
import { web3DeepNormalize, web3Normalize } from "../utils/web3normalize";
import { CollateralList, isPoolCollateral } from "./CollateralIndexedList";
import { Prices } from "./Prices";
import { tokenContract } from "./TokenPrice";
import { InitialAgentData, TrackedAgentState } from "./TrackedAgentState";

export class TrackedCoreVaultState {
    // confirmed balance by CoreVaultManager
    balance = BN_ZERO;

    // tracked transfers from/to asset manager
    transferringTo = BN_ZERO;
    transferredTo = BN_ZERO;
    returned = BN_ZERO;
    redemptionRequested = BN_ZERO;

    backedFAssetSupply() {
        return this.transferringTo.add(this.transferredTo).sub(this.returned).sub(this.redemptionRequested);
    }
}

export class TrackedState {
    constructor(
        public context: IAssetContext,
        public truffleEvents: IEvmEvents,
        public chainEvents: UnderlyingChainEvents,
        public eventFormatter: EventFormatter,
        public eventQueue: EventExecutionQueue,
    ) {
    }

    // state
    agentBackedFAssetSupply = BN_ZERO;
    coreVault = new TrackedCoreVaultState();

    // must call initialize to init prices and settings
    prices!: Prices;
    trustedPrices!: Prices;

    // settings
    settings!: AssetManagerSettings;
    collaterals = new CollateralList();
    poolWNatColateral!: CollateralType;

    // agent state
    agents: Map<string, TrackedAgentState> = new Map();                // map agent_address => agent state
    agentsByUnderlying: Map<string, TrackedAgentState> = new Map();    // map underlying_address => agent state
    agentsByPool: Map<string, TrackedAgentState> = new Map();          // map pool_address => agent state

    // settings
    logger?: ILogger;
    deleteDestroyedAgents = true;

    // synthetic events
    pricesUpdated = new TriggerableEvent<void>(this.eventQueue);

    // async initialization part
    async initialize() {
        this.settings = { ...await this.context.assetManager.getSettings() };
        const collateralTypes = await this.context.assetManager.getCollateralTypes();
        for (const collateralToken of collateralTypes) {
            const collateral = await this.addCollateralType(collateralToken);
            // poolColateral will be the last active collateral of class pool
            if (isPoolCollateral(collateral)) {
                this.poolWNatColateral = collateral;
            }
        }
        [this.prices, this.trustedPrices] = await this.getPrices();
        this.agentBackedFAssetSupply = await this.measureAgentBackedFAssetSupply();
        this.registerHandlers();
    }

    async getPrices(): Promise<[Prices, Prices]> {
        return await Prices.getPrices(this.context, this.settings, this.collaterals);
    }

    registerHandlers() {
        // track total supply of fAsset
        this.assetManagerEvent('MintingExecuted').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.add(toBN(args.mintedAmountUBA).add(toBN(args.poolFeeUBA)));
        });
        this.assetManagerEvent('SelfMint').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.add(toBN(args.mintedAmountUBA).add(toBN(args.poolFeeUBA)));
        });
        this.assetManagerEvent('RedemptionRequested').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.sub(toBN(args.valueUBA));
        });
        this.assetManagerEvent('RedemptionPoolFeeMinted').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.add(toBN(args.poolFeeUBA));
        });
        this.assetManagerEvent('RedeemedInCollateral').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.sub(toBN(args.redemptionAmountUBA));
        });
        this.assetManagerEvent('SelfClose').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.sub(toBN(args.valueUBA));
        });
        this.assetManagerEvent('LiquidationPerformed').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.sub(toBN(args.valueUBA));
        });
        // track setting changes
        this.assetManagerEvent('SettingChanged').subscribe(args => {
            if (!(args.name in this.settings)) assert.fail(`Invalid setting change ${args.name}`);
            this.logger?.log(`SETTING CHANGED ${args.name} FROM ${(this.settings as Record<string, unknown>)[args.name]} TO ${args.value}`);
            (this.settings as Record<string, unknown>)[args.name] = web3Normalize(args.value);
        });
        this.assetManagerEvent('SettingArrayChanged').subscribe(args => {
            if (!(args.name in this.settings)) assert.fail(`Invalid setting array change ${args.name}`);
            this.logger?.log(`SETTING ARRAY CHANGED ${args.name} FROM ${stringifyJson((this.settings as Record<string, unknown>)[args.name])} TO ${stringifyJson(args.value)}`);
            (this.settings as Record<string, unknown>)[args.name] = web3DeepNormalize(args.value);
        });
        // track collateral token changes
        this.assetManagerEvent('CollateralTypeAdded').subscribe(args => {
            void this.addCollateralType({ ...args, validUntil: BN_ZERO });
        });
        this.assetManagerEvent('CollateralRatiosChanged').subscribe(args => {
            const collateral = this.collaterals.get(args.collateralClass, args.collateralToken);
            collateral.minCollateralRatioBIPS = toBN(args.minCollateralRatioBIPS);
            collateral.safetyMinCollateralRatioBIPS = toBN(args.safetyMinCollateralRatioBIPS);
        });
        this.assetManagerEvent('CollateralTypeDeprecated').subscribe(args => {
            const collateral = this.collaterals.get(args.collateralClass, args.collateralToken);
            collateral.validUntil = toBN(args.validUntil);
        });
        // track price changes
        // eslint-disable-next-line @typescript-eslint/no-misused-promises
        this.truffleEvents.event(this.context.priceStore, 'PricesPublished').immediate().subscribe(async args => {
            const [prices, trustedPrices] = await this.getPrices();
            this.logger?.log(`PRICES CHANGED  ftso=${this.prices}->${prices}  trusted=${this.trustedPrices}->${trustedPrices}`);
            [this.prices, this.trustedPrices] = [prices, trustedPrices];
            // trigger event
            this.pricesUpdated.trigger();
        });
        // core vault
        this.registerCoreVaultHandlers();
        // agents
        this.registerAgentHandlers();
    }

    private registerCoreVaultHandlers() {
        this.assetManagerEvent('TransferToCoreVaultStarted').subscribe(args => {
            this.coreVault.transferringTo = this.coreVault.transferringTo.add(toBN(args.valueUBA));
        });
        this.assetManagerEvent('TransferToCoreVaultDefaulted').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.add(toBN(args.remintedUBA));
            this.coreVault.transferringTo = this.coreVault.transferringTo.sub(toBN(args.remintedUBA));
        });
        this.assetManagerEvent('TransferToCoreVaultSuccessful').subscribe(args => {
            this.coreVault.transferringTo = this.coreVault.transferringTo.sub(toBN(args.valueUBA));
            this.coreVault.transferredTo = this.coreVault.transferredTo.add(toBN(args.valueUBA));
        });
        this.assetManagerEvent('ReturnFromCoreVaultRequested').subscribe(args => {
        });
        this.assetManagerEvent('ReturnFromCoreVaultCancelled').subscribe(args => {
        });
        this.assetManagerEvent('ReturnFromCoreVaultConfirmed').subscribe(args => {
            this.agentBackedFAssetSupply = this.agentBackedFAssetSupply.add(toBN(args.remintedUBA));
            this.coreVault.returned = this.coreVault.returned.add(toBN(args.remintedUBA));
        });
        this.assetManagerEvent('CoreVaultRedemptionRequested').subscribe(args => {
            this.coreVault.redemptionRequested = this.coreVault.redemptionRequested.add(toBN(args.valueUBA));
        });
    }

    private registerAgentHandlers() {
        // agent create / destroy
        this.assetManagerEvent('AgentVaultCreated').subscribe(args => this.createAgentVault(args));
        this.assetManagerEvent('AgentDestroyed').subscribe(args => this.destroyAgent(args.agentVault));
        // status changes
        this.assetManagerEvent('LiquidationStarted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleStatusChange(AgentStatus.LIQUIDATION, args.timestamp));
        this.assetManagerEvent('FullLiquidationStarted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleStatusChange(AgentStatus.FULL_LIQUIDATION, args.timestamp));
        this.assetManagerEvent('LiquidationEnded').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleStatusChange(AgentStatus.NORMAL));
        this.assetManagerEvent('AgentDestroyAnnounced').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleStatusChange(AgentStatus.DESTROYING));
        // enter/exit available agents list
        this.assetManagerEvent('AgentAvailable').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleAgentAvailable(args));
        this.assetManagerEvent('AvailableAgentExited').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleAvailableAgentExited(args));
        // agent settings
        this.assetManagerEvent('AgentSettingChanged').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleSettingChanged(args.name, args.value));
        // minting
        this.assetManagerEvent('CollateralReserved').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleCollateralReserved(args));
        this.assetManagerEvent('MintingExecuted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleMintingExecuted(args));
        this.assetManagerEvent('MintingPaymentDefault').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleMintingPaymentDefault(args));
        this.assetManagerEvent('CollateralReservationDeleted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleCollateralReservationDeleted(args));
        this.assetManagerEvent('SelfMint').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleSelfMint(args));
        // redemption and self-close
        this.assetManagerEvent('RedemptionRequested').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionRequested(args));
        this.assetManagerEvent('RedemptionPerformed').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionPerformed(args));
        this.assetManagerEvent('RedemptionDefault').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionDefault(args));
        this.assetManagerEvent('RedemptionPaymentBlocked').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionPaymentBlocked(args));
        this.assetManagerEvent('RedemptionPaymentFailed').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionPaymentFailed(args));
        this.assetManagerEvent('RedemptionPoolFeeMinted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionPoolFeeMinted(args));
        this.assetManagerEvent('RedeemedInCollateral').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedeemedInCollateral(args));
        this.assetManagerEvent('SelfClose').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleSelfClose(args));
        // underlying topup and withdrawal
        this.assetManagerEvent('UnderlyingBalanceToppedUp').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleUnderlyingBalanceToppedUp(args));
        this.assetManagerEvent('UnderlyingWithdrawalAnnounced').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleUnderlyingWithdrawalAnnounced(args));
        this.assetManagerEvent('UnderlyingWithdrawalConfirmed').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleUnderlyingWithdrawalConfirmed(args));
        this.assetManagerEvent('UnderlyingWithdrawalCancelled').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleUnderlyingWithdrawalCancelled(args));
        // track tickets
        this.assetManagerEvent('RedemptionTicketCreated').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionTicketCreated(args));
        this.assetManagerEvent('RedemptionTicketUpdated').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionTicketUpdated(args));
        this.assetManagerEvent('RedemptionTicketDeleted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleRedemptionTicketDeleted(args));
        // track dust
        this.assetManagerEvent('DustChanged').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleDustChanged(args));
        // liquidation
        this.assetManagerEvent('LiquidationPerformed').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleLiquidationPerformed(args));
        // core vault
        this.assetManagerEvent('TransferToCoreVaultStarted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleTransferToCoreVaultStarted(args));
        this.assetManagerEvent('TransferToCoreVaultSuccessful').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleTransferToCoreVaultSuccessful(args));
        this.assetManagerEvent('TransferToCoreVaultDefaulted').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleTransferToCoreVaultDefaulted(args));
        this.assetManagerEvent('ReturnFromCoreVaultRequested').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleReturnFromCoreVaultRequested(args));
        this.assetManagerEvent('ReturnFromCoreVaultConfirmed').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleReturnFromCoreVaultConfirmed(args));
        this.assetManagerEvent('ReturnFromCoreVaultCancelled').subscribe(args => this.getAgentTriggerAdd(args.agentVault)?.handleReturnFromCoreVaultCancelled(args));
    }

    private async addCollateralType(data: CollateralType) {
        const collateral: CollateralType = {
            collateralClass: toBN(data.collateralClass),
            token: data.token,
            decimals: toBN(data.decimals),
            validUntil: data.validUntil,
            directPricePair: data.directPricePair,
            assetFtsoSymbol: data.assetFtsoSymbol,
            tokenFtsoSymbol: data.tokenFtsoSymbol,
            minCollateralRatioBIPS: toBN(data.minCollateralRatioBIPS),
            safetyMinCollateralRatioBIPS: toBN(data.safetyMinCollateralRatioBIPS),
        };
        this.collaterals.add(collateral);
        await this.registerCollateralHandlers(data.token);
        return collateral;
    }

    private async registerCollateralHandlers(tokenAddress: string) {
        const token = await tokenContract(tokenAddress);
        this.truffleEvents.event(token, 'Transfer').immediate().subscribe(args => {
            this.agents.get(args.from)?.withdrawCollateral(tokenAddress, toBN(args.value));
            this.agents.get(args.to)?.depositCollateral(tokenAddress, toBN(args.value));
            this.agentsByPool.get(args.from)?.withdrawPoolCollateral(tokenAddress, toBN(args.value));
            this.agentsByPool.get(args.to)?.depositPoolCollateral(tokenAddress, toBN(args.value));
        });
    }

    getAgent(address: string): TrackedAgentState | undefined {
        return this.agents.get(address);
    }

    getAgentTriggerAdd(address: string): TrackedAgentState | undefined {
        const agent = this.agents.get(address);
        if (!agent) {
            void this.createAgentVaultWithCurrentState(address); // create in background
        }
        return agent;
    }

    async createAgentVaultWithCurrentState(address: string) {
        const agentInfo = await this.context.assetManager.getAgentInfo(address);
        const agent = this.createAgentVault({
            agentVault: address,
            owner: agentInfo.ownerManagementAddress,
            creationData: {
                collateralPool: agentInfo.collateralPool,
                collateralPoolToken: agentInfo.collateralPoolToken,
                underlyingAddress: agentInfo.underlyingAddressString,
                vaultCollateralToken: agentInfo.vaultCollateralToken,
                poolWNatToken: agentInfo.poolWNatToken,
                feeBIPS: agentInfo.feeBIPS,
                poolFeeShareBIPS: agentInfo.poolFeeShareBIPS,
                mintingVaultCollateralRatioBIPS: agentInfo.mintingVaultCollateralRatioBIPS,
                mintingPoolCollateralRatioBIPS: agentInfo.mintingPoolCollateralRatioBIPS,
                buyFAssetByAgentFactorBIPS: agentInfo.buyFAssetByAgentFactorBIPS,
                poolExitCollateralRatioBIPS: agentInfo.poolExitCollateralRatioBIPS,
                redemptionPoolFeeShareBIPS: agentInfo.redemptionPoolFeeShareBIPS,
            }
        });
        agent.initializeState(agentInfo);
    }

    createAgentVault(data: InitialAgentData) {
        const agent = this.newAgent(data);
        this.agents.set(data.agentVault, agent);
        this.agentsByUnderlying.set(data.creationData.underlyingAddress, agent);
        this.agentsByPool.set(data.creationData.collateralPool, agent);
        return agent;
    }

    protected newAgent(data: InitialAgentData) {
        return new TrackedAgentState(this, data);
    }

    destroyAgent(address: string) {
        const agent = this.getAgent(address);
        if (agent && this.deleteDestroyedAgents) {
            this.agents.delete(address);
            this.agentsByUnderlying.delete(agent.underlyingAddressString);
            this.agentsByPool.delete(agent.collateralPoolAddress);
        }
    }

    // helpers

    assetManagerEvent<N extends AssetManagerEvents['name']>(event: N, filter?: Partial<ExtractedEventArgs<AssetManagerEvents, N>>) {
        const emitter = this.truffleEvents.event(this.context.assetManager, event, filter).immediate();
        emitter.subscribe((args) => this.checkEventOrder(args.$event));
        return emitter;
    }

    lastEventHandled?: EvmEvent;

    checkEventOrder(event: EvmEvent) {
        const last = this.lastEventHandled;
        if (last) {
            if (last.blockNumber > event.blockNumber || (last.blockNumber === event.blockNumber && last.logIndex > event.logIndex)) {
                this.logger?.log(`???? ISSUE Inconsistent event ordering: previous event ${last.event} at ${last.blockNumber}.${last.logIndex}, ` +
                    `current event ${event.event} at ${event.blockNumber}.${event.logIndex}.`);
            }
        }
        this.lastEventHandled = event;
    }

    async measureAgentBackedFAssetSupply() {
        const { 0: agents } = await this.context.assetManager.getAllAgents(0, 1000);
        const infos = await Promise.all(agents.map(agent => this.context.assetManager.getAgentInfo(agent)));
        return sumBN(infos, info => toBN(info.mintedUBA));
    }

    // getters

    lotSize() {
        return toBN(this.settings.lotSizeAMG).mul(toBN(this.settings.assetMintingGranularityUBA));
    }

    // should be equal to the total supply of FAsset tokens, except perhaps for core vault network fees
    totalFAssetSupply() {
        return this.agentBackedFAssetSupply.add(this.coreVault.backedFAssetSupply());
    }

    // logs

    expect(condition: boolean, message: string, event: EvmEvent) {
        if (!condition && this.logger) {
            this.logger.log(`!!! AssetState expectation failed: ${message}  ${this.eventInfo(event)}`)
        }
    }

    eventInfo(event: EvmEvent) {
        return `event=${event.event} at block ${event.blockNumber} (index ${event.logIndex})`;
    }

    logAllAgentSummaries() {
        if (!this.logger) return;
        this.logger.log("\nAGENT SUMMARIES");
        for (const agent of this.agents.values()) {
            agent.writeAgentSummary(this.logger);
        }
    }
}
