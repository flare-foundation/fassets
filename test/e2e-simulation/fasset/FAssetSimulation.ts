import { Challenger } from "../../../lib/actors/Challenger";
import { isPoolCollateral, isVaultCollateral } from "../../../lib/state/CollateralIndexedList";
import { Agent, AgentCreateOptions } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { TestChainInfo, testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { InclusionIterable, coinFlip, currentRealTime, getEnv, randomChoice, randomNum, weightedRandomChoice } from "../../../lib/test-utils/simulation-utils";
import { time } from "../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../lib/test-utils/test-suite-helpers";
import { Web3EventDecoder } from "../../../lib/test-utils/Web3EventDecoder";
import { UnderlyingChainEvents } from "../../../lib/underlying-chain/UnderlyingChainEvents";
import { EventExecutionQueue } from "../../../lib/utils/events/ScopedEvents";
import { expectErrors, formatBN, latestBlockTimestamp, mulDecimal, sleep, systemTimestamp, toBIPS, toBN, toWei } from "../../../lib/utils/helpers";
import { LogFile } from "../../../lib/utils/logging";
import { InterceptorEvmEvents } from "./InterceptorEvmEvents";
import { MultiStateLock } from "./MultiStateLock";
import { SimulationAgent } from "./SimulationAgent";
import { SimulationCoreVault } from "./SimulationCoreVault";
import { SimulationCustomer } from "./SimulationCustomer";
import { SimulationKeeper } from "./SimulationKeeper";
import { SimulationPoolTokenHolder } from "./SimulationPoolTokenHolder";
import { SimulationRunner } from "./SimulationRunner";
import { SimulationState } from "./SimulationState";
import { SimulationTimeline } from "./SimulationTimeline";
import { TruffleTransactionInterceptor } from "./TransactionInterceptor";

contract(`FAssetSimulation.sol; ${getTestFile(__filename)}; End to end simulation tests`, accounts => {
    const startTimestamp = systemTimestamp();
    const governance = accounts[1];

    const CHAIN = getEnv('CHAIN', 'string', 'xrp');
    const LOOPS = getEnv('LOOPS', 'number', 100);
    const AUTOMINE = getEnv('AUTOMINE', 'boolean', true);
    const STRICT = getEnv('STRICT', 'boolean', false);
    const N_AGENTS = getEnv('N_AGENTS', 'number', 10);
    const N_CUSTOMERS = getEnv('N_CUSTOMERS', 'number', 10);     // minters and redeemers
    const N_KEEPERS = getEnv('N_KEEPERS', 'number', 1);
    const N_POOL_TOKEN_HOLDERS = getEnv('N_POOL_TOKEN_HOLDERS', 'number', 20);
    const CUSTOMER_BALANCE = toWei(getEnv('CUSTOMER_BALANCE', 'number', 10_000));  // initial underlying balance
    const AVOID_ERRORS = getEnv('AVOID_ERRORS', 'boolean', true);
    const CHANGE_LOT_SIZE_AT = getEnv('CHANGE_LOT_SIZE_AT', 'range', null);
    const CHANGE_LOT_SIZE_FACTOR = getEnv('CHANGE_LOT_SIZE_FACTOR', 'number[]', []);
    const CHANGE_PRICE_AT = getEnv('CHANGE_PRICE_AT', 'range', null);
    const CHANGE_PRICE_FACTOR = getEnv('CHANGE_PRICE_FACTOR', 'json', null) as { [key: string]: [number, number] };
    const ILLEGAL_PROB = getEnv('ILLEGAL_PROB', 'number', 1);     // likelihood of illegal operations (not normalized)

    let commonContext: CommonContext;
    let context: AssetContext;
    let timeline: SimulationTimeline;
    const agents: SimulationAgent[] = [];
    const customers: SimulationCustomer[] = [];
    const keepers: SimulationKeeper[] = [];
    const poolTokenHolders: SimulationPoolTokenHolder[] = [];
    let challenger: Challenger;
    let coreVault: SimulationCoreVault;
    let chainInfo: TestChainInfo;
    let chain: MockChain;
    let eventDecoder: Web3EventDecoder;
    let runnerLock: MultiStateLock;
    let interceptor: TruffleTransactionInterceptor;
    let truffleEvents: InterceptorEvmEvents;
    let eventQueue: EventExecutionQueue;
    let chainEvents: UnderlyingChainEvents;
    let simulationState: SimulationState;
    let logger: LogFile;
    let runner: SimulationRunner;
    let checkedInvariants = false;

    before(async () => {
        // create context
        commonContext = await CommonContext.createTest(governance);
        chainInfo = testChainInfo[CHAIN as keyof typeof testChainInfo] ?? assert.fail(`Invalid chain ${CHAIN}`);
        context = await AssetContext.createTest(commonContext, chainInfo);
        chain = context.chain as MockChain;
        // create interceptor
        runnerLock = new MultiStateLock();
        eventDecoder = new Web3EventDecoder({});
        interceptor = new TruffleTransactionInterceptor(eventDecoder, accounts[0]);
        interceptor.lock = runnerLock;
        interceptor.captureEvents({
            assetManager: context.assetManager,
            assetManagerController: context.assetManagerController,
            fAsset: context.fAsset,
            wnat: context.wNat,
            priceStore: context.priceStore,
        });
        for (const [key, token] of Object.entries(context.stablecoins)) {
            interceptor.captureEventsFrom(key, token, "ERC20");
        }
        // uniform event handlers
        eventQueue = new EventExecutionQueue();
        context.chainEvents.executionQueue = eventQueue;
        truffleEvents = new InterceptorEvmEvents(interceptor, eventQueue);
        chainEvents = context.chainEvents;
        timeline = new SimulationTimeline(chain, eventQueue);
        // state checker
        simulationState = new SimulationState(context, truffleEvents, chainEvents, eventDecoder, eventQueue);
        simulationState.deleteDestroyedAgents = false;
        await simulationState.initialize();
        // runner
        runner = new SimulationRunner(context, eventDecoder, interceptor, timeline, truffleEvents, chainEvents, simulationState, AVOID_ERRORS);
        // logging
        logger = new LogFile("test_logs/fasset-simulation.log");
        interceptor.logger = logger;
        chain.logger = logger;
        timeline.logger = logger;
        (context.flareDataConnectorClient as MockFlareDataConnectorClient).logger = logger;
        simulationState.logger = logger;
    });

    after(async () => {
        // simulationState.logAllAgentActions();
        if (!checkedInvariants) {
            await checkInvariants(false).catch(e => {});
        }
        simulationState.logProblemTotals();
        simulationState.logAllAgentSummaries();
        simulationState.logAllPoolSummaries();
        simulationState.logExpectationFailures();
        interceptor.logGasUsage();
        logger.close();
        simulationState.withLogFile("test_logs/fasset-simulation-actions.log", () => simulationState.logAllAgentActions());
        simulationState.writeBalanceTrackingList("test_logs/agents-csv");
    });

    it("f-asset simulation test", async () => {
        // create agents
        const firstAgentAddress = 10;
        runner.comment(`Initializing ${N_AGENTS} agents`);
        for (let i = 0; i < N_AGENTS; i++) {
            const underlyingAddress = "underlying_agent_" + i;
            const ownerUnderlyingAddress = "underlying_owner_agent_" + i;
            const ownerManagementAddress = accounts[firstAgentAddress + i];
            const ownerWorkAddress = accounts[firstAgentAddress + N_AGENTS + i];
            eventDecoder.addAddress(`OWNER_WORK_${i}`, ownerWorkAddress);
            eventDecoder.addAddress(`OWNER_MANAGEMENT_${i}`, ownerManagementAddress);
            await Agent.changeWorkAddress(context, ownerManagementAddress, ownerWorkAddress);
            const options = createAgentVaultOptions();
            const ownerAddress = coinFlip() ? ownerWorkAddress : ownerManagementAddress;
            const simulationAgent = await SimulationAgent.createTest(runner, ownerAddress, underlyingAddress, ownerUnderlyingAddress, options);
            simulationAgent.capturePerAgentContractEvents(`AGENT_${i}`);
            await simulationAgent.agent.depositCollateralsAndMakeAvailable(toWei(10_000_000), toWei(10_000_000));
            agents.push(simulationAgent);
        }
        // create customers
        runner.comment(`Initializing ${N_CUSTOMERS} customers`);
        const firstCustomerAddress = firstAgentAddress + 3 * N_AGENTS;
        for (let i = 0; i < N_CUSTOMERS; i++) {
            const underlyingAddress = "underlying_customer_" + i;
            const customer = await SimulationCustomer.createTest(runner, accounts[firstCustomerAddress + i], underlyingAddress, CUSTOMER_BALANCE);
            chain.mint(underlyingAddress, 1_000_000);
            customers.push(customer);
            eventDecoder.addAddress(`CUSTOMER_${i}`, customer.address);
            // customers can "sell" minted fassets on the mock marketplace
            runner.fAssetMarketplace.addSeller(customer);
        }
        // create liquidators
        runner.comment(`Initializing ${N_KEEPERS} system keepers / liquidators`);
        const firstKeeperAddress = firstCustomerAddress + N_CUSTOMERS;
        for (let i = 0; i < N_KEEPERS; i++) {
            const keeper = new SimulationKeeper(runner, accounts[firstKeeperAddress + i]);
            keepers.push(keeper);
            eventDecoder.addAddress(`KEEPER_${i}`, keeper.address);
        }
        // create challenger
        runner.comment(`Initializing challenger`);
        const challengerAddress = accounts[firstKeeperAddress + N_KEEPERS];
        challenger = new Challenger(runner, simulationState, challengerAddress);
        eventDecoder.addAddress(`CHALLENGER`, challenger.address);
        // create pool token holders
        runner.comment(`Initializing ${N_POOL_TOKEN_HOLDERS} pool token holders`);
        const firstPoolTokenHolderAddress = firstKeeperAddress + N_KEEPERS + 1;
        for (let i = 0; i < N_POOL_TOKEN_HOLDERS; i++) {
            const underlyingAddress = "underlying_pool_token_holder_" + i;
            const tokenHolder = new SimulationPoolTokenHolder(runner, accounts[firstPoolTokenHolderAddress + i], underlyingAddress);
            poolTokenHolders.push(tokenHolder);
            eventDecoder.addAddress(`POOL_TOKEN_HOLDER_${i}`, tokenHolder.address);
        }
        // create core vault
        const coreVaultTriggeringAccountAddress = accounts[firstPoolTokenHolderAddress + N_POOL_TOKEN_HOLDERS];
        await context.assignCoreVaultManager({
            underlyingAddress: "core_vault_underlying",
            custodianAddress: "core_vault_custodian",
            triggeringAccounts: [coreVaultTriggeringAccountAddress],
        });
        await context.coreVaultManager!.addAllowedDestinationAddresses(agents.map(agent => agent.agent.underlyingAddress), { from: governance });
        coreVault = await SimulationCoreVault.create(runner, coreVaultTriggeringAccountAddress);
        // await context.wnat.send("1000", { from: governance });
        await interceptor.allHandled();
        // init some state
        await refreshAvailableAgents();
        // actions
        const actions: Array<[() => Promise<void>, number]> = [
            [testMint, 10],
            [testRedeem, 10],
            [testSelfMint, 10],
            [testSelfClose, 10],
            [testLiquidate, 10],
            [testConvertDustToTicket, 1],
            [testUnderlyingWithdrawal, 5],
            [testTransferToCoreVault, 5],
            [testReturnFromCoreVault, 5],
            [refreshAvailableAgents, 1],
            [updateUnderlyingBlock, 10],
            [testEnterPool, 10],
            [testExitPool, 10],
            [testIllegalTransaction, ILLEGAL_PROB],
            [testDoublePayment, ILLEGAL_PROB],
        ];
        const timedActions: Array<[(index: number) => Promise<void>, InclusionIterable<number> | null]> = [
            [testChangeLotSize, CHANGE_LOT_SIZE_AT],
            [testChangePrices, CHANGE_PRICE_AT],
            // [testExecuteCoreVaultTriggers, range(10, null, 10)],
        ];
        // switch underlying chain to timed mining
        chain.automine = false;
        chain.finalizationBlocks = chainInfo.finalizationBlocks;
        // make sure here are enough blocks in chain for block height proof to succeed
        while (chain.blockHeight() <= chain.finalizationBlocks) chain.mine();
        if (!AUTOMINE) {
            await interceptor.setMiningMode('manual', 1000);
        }
        // perform actions
        for (let loop = 1; loop <= LOOPS; loop++) {
            // run random action
            const action = weightedRandomChoice(actions);
            try {
                await action();
            } catch (e) {
                interceptor.logUnexpectedError(e, '!!! JS ERROR');
                expectErrors(e, []);
            }
            // run actions, triggered at certain loop numbers
            for (const [timedAction, runAt] of timedActions) {
                await interceptor.allHandled();
                if (!runAt?.includes(loop)) continue;
                try {
                    const index = runAt.indexOf(loop);
                    await timedAction(index);
                } catch (e) {
                    interceptor.logUnexpectedError(e, '!!! JS ERROR');
                    expectErrors(e, []);
                }
                await interceptor.allHandled();
            }
            await coreVault.triggerAndPerformActions();
            // fail immediately on unexpected errors from threads
            if (runner.uncaughtErrors.length > 0) {
                throw runner.uncaughtErrors[0];
            }
            // occassionally skip some time
            if (loop % 10 === 0) {
                // run all queued event handlers
                eventQueue.runAll();
                await checkInvariants(STRICT);     // state change may happen during check, so we don't wany failure here by default
                interceptor.comment(`-----  LOOP ${loop}  ${await timeInfo()}  -----`);
                await timeline.skipTime(100);
                await timeline.executeTriggers();
                await interceptor.allHandled();
            }
        }
        // wait for all threads to finish
        interceptor.comment(`Remaining threads: ${runner.runningThreadCount}`);
        runner.waitingToFinish = true;
        let count = 0;
        while (runner.runningThreadCount > 0 && ++count < LOOPS) {
            await sleep(200);
            await timeline.skipTime(100);
            interceptor.comment(`-----  WAITING  ${await timeInfo()}  -----`);
            await timeline.executeTriggers();
            await interceptor.allHandled();
            while (eventQueue.length > 0) {
                eventQueue.runAll();
                await interceptor.allHandled();
            }
        }
        // fail immediately on unexpected errors from threads
        if (runner.uncaughtErrors.length > 0) {
            throw runner.uncaughtErrors[0];
        }
        interceptor.comment(`Remaining threads: ${runner.runningThreadCount}`);
        for (const [id, func] of runner.runningThreads) {
            interceptor.comment(`    thread ${id}: ${func.toString()}`);
        }
        checkedInvariants = true;
        await checkInvariants(true);  // all events are flushed, state must match
        assert.isTrue(simulationState.failedExpectations.length === 0, "simulation state has expectation failures");
    });

    function createAgentVaultOptions(): AgentCreateOptions {
        const vaultCollateral = randomChoice(context.collaterals.filter(isVaultCollateral));
        const poolCollateral = context.collaterals.filter(isPoolCollateral)[0];
        const mintingVaultCollateralRatioBIPS = mulDecimal(toBN(vaultCollateral.minCollateralRatioBIPS), randomNum(1, 1.5));
        const mintingPoolCollateralRatioBIPS = mulDecimal(toBN(poolCollateral.minCollateralRatioBIPS), randomNum(1, 1.5));
        return {
            vaultCollateralToken: vaultCollateral.token,
            feeBIPS: toBIPS("5%"),
            poolFeeShareBIPS: toBIPS("40%"),
            redemptionPoolFeeShareBIPS: toBIPS("30%"),
            mintingVaultCollateralRatioBIPS: mintingVaultCollateralRatioBIPS,
            mintingPoolCollateralRatioBIPS: mintingPoolCollateralRatioBIPS,
            poolExitCollateralRatioBIPS: mulDecimal(mintingPoolCollateralRatioBIPS, randomNum(1, 1.25)),
            buyFAssetByAgentFactorBIPS: toBIPS(0.9),
        };
    }

    async function timeInfo() {
        return `block=${await time.latestBlock()} timestamp=${await latestBlockTimestamp() - startTimestamp}  ` +
               `underlyingBlock=${chain.blockHeight()} underlyingTimestamp=${chain.lastBlockTimestamp() - startTimestamp}  ` +
               `skew=${await latestBlockTimestamp() - chain.lastBlockTimestamp()}  ` +
               `realTime=${(currentRealTime() - startTimestamp).toFixed(3)}`;
    }

    async function refreshAvailableAgents() {
        await runner.refreshAvailableAgents();
    }

    async function updateUnderlyingBlock() {
        await context.updateUnderlyingBlock();
    }

    async function testMint() {
        const customer = randomChoice(customers);
        runner.startThread((scope) => customer.minting(scope));
    }

    async function testSelfMint() {
        const agent = randomChoice(agents);
        runner.startThread((scope) => agent.selfMint(scope));
    }

    async function testRedeem() {
        const customer = randomChoice(customers);
        runner.startThread((scope) => customer.redemption(scope));
    }

    async function testSelfClose() {
        const agent = randomChoice(agents);
        runner.startThread((scope) => agent.selfClose(scope));
    }

    async function testUnderlyingWithdrawal() {
        const agent = randomChoice(agents);
        runner.startThread((scope) => agent.announcedUnderlyingWithdrawal(scope));
    }

    async function testConvertDustToTicket() {
        const agent = randomChoice(agents);
        runner.startThread((scope) => agent.convertDustToTicket(scope));
    }

    async function testIllegalTransaction() {
        const agent = randomChoice(agents);
        runner.startThread((scope) => agent.makeIllegalTransaction(scope));
    }

    async function testDoublePayment() {
        const agentsWithRedemptions = agents.filter(agent => (simulationState.agents.get(agent.agent.vaultAddress)?.redemptionRequests?.size ?? 0) > 0);
        if (agentsWithRedemptions.length === 0) return;
        const agent = randomChoice(agentsWithRedemptions);
        runner.startThread((scope) => agent.makeDoublePayment(scope));
    }

    async function testTransferToCoreVault() {
        const agent = randomChoice(agents);
        runner.startThread((scope) => agent.transferToCoreVault(scope));
    }

    async function testReturnFromCoreVault() {
        const agent = randomChoice(agents);
        runner.startThread((scope) => agent.returnFromCoreVault(scope));
    }

    async function testExecuteCoreVaultTriggers() {
        runner.startThread((scope) => coreVault.triggerAndPerformActions());
    }

    async function testLiquidate() {
        const customer = randomChoice(customers);
        runner.startThread((scope) => customer.liquidate(scope));
    }

    async function testEnterPool() {
        const lpholder = randomChoice(poolTokenHolders);
        runner.startThread((scope) => lpholder.enter(scope));
    }

    async function testExitPool() {
        const lpholder = randomChoice(poolTokenHolders);
        const fullExit = coinFlip();
        runner.startThread((scope) => lpholder.exit(scope, fullExit));
    }

    async function testChangeLotSize(index: number) {
        const lotSizeAMG = toBN(simulationState.settings.lotSizeAMG);
        const factor = CHANGE_LOT_SIZE_FACTOR.length > 0 ? CHANGE_LOT_SIZE_FACTOR[index % CHANGE_LOT_SIZE_FACTOR.length] : randomNum(0.5, 2);
        const newLotSizeAMG = mulDecimal(lotSizeAMG, factor);
        interceptor.comment(`Changing lot size by factor ${factor}, old=${formatBN(lotSizeAMG)}, new=${formatBN(newLotSizeAMG)}`);
        await context.setLotSizeAmg(newLotSizeAMG)
            .catch(e => expectErrors(e, ["TooCloseToPreviousUpdate"]));
    }

    const allFtsoSymbols = ["NAT", "USDC", "USDT", ...Object.values(testChainInfo).map(ci => ci.symbol)];

    async function testChangePrices(index: number) {
        for (const symbol of allFtsoSymbols) {
            const [minFactor, maxFactor] = CHANGE_PRICE_FACTOR?.[symbol] ?? CHANGE_PRICE_FACTOR?.['default'] ?? [0.9, 1.1];
            await _changePriceOnFtso(symbol, randomNum(minFactor, maxFactor));
        }
        await context.priceStore.finalizePrices();
    }

    async function _changePriceOnFtso(symbol: string, factor: number) {
        const { 0: price } = await context.priceStore.getPrice(symbol);
        const newPrice = mulDecimal(price, factor);
        await context.priceStore.setCurrentPrice(symbol, newPrice, 0);
        await context.priceStore.setCurrentPriceFromTrustedProviders(symbol, newPrice, 0);
    }

    async function checkInvariants(failOnProblems: boolean) {
        await runnerLock.runLocked("check", async () => {
            await simulationState.checkInvariants(failOnProblems);
        });
    }
});
