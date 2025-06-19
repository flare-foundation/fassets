import { AvailableAgentInfo } from "../../../lib/fasset/AssetManagerTypes";
import { AssetManagerEvents } from "../../../lib/fasset/IAssetContext";
import { UnderlyingChainEvents } from "../../../lib/underlying-chain/UnderlyingChainEvents";
import { ExtractedEventArgs } from "../../../lib/utils/events/common";
import { IEvmEvents } from "../../../lib/utils/events/IEvmEvents";
import { EventScope } from "../../../lib/utils/events/ScopedEvents";
import { ScopedRunner } from "../../../lib/utils/events/ScopedRunner";
import { sleep } from "../../../lib/utils/helpers";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { Web3EventDecoder } from "../../../lib/test-utils/Web3EventDecoder";
import { FAssetMarketplace } from "./FAssetMarketplace";
import { SimulationAgent } from "./SimulationAgent";
import { SimulationCustomer } from "./SimulationCustomer";
import { SimulationState } from "./SimulationState";
import { SimulationTimeline } from "./SimulationTimeline";
import { TruffleTransactionInterceptor } from "./TransactionInterceptor";

export class SimulationRunner extends ScopedRunner {
    constructor(
        public context: AssetContext,
        public eventDecoder: Web3EventDecoder,
        public interceptor: TruffleTransactionInterceptor,
        public timeline: SimulationTimeline,
        public truffleEvents: IEvmEvents,
        public chainEvents: UnderlyingChainEvents,
        public state: SimulationState,
        public avoidErrors: boolean,
    ) {
        super();
        this.logError = (e) => this.interceptor.logUnexpectedError(e, "!!! THREAD ERROR");
    }

    waitingToFinish: boolean = false;

    agents: SimulationAgent[] = [];
    customers: SimulationCustomer[] = [];
    availableAgents: AvailableAgentInfo[] = [];
    fAssetMarketplace = new FAssetMarketplace();

    async refreshAvailableAgents() {
        const { 0: _availableAgents } = await this.context.assetManager.getAvailableAgentsDetailedList(0, 1000);
        this.availableAgents = _availableAgents;
    }

    checkForBreak(scope: EventScope, message: string = "Waiting for finish") {
        if (this.waitingToFinish) {
            scope.exit(message);
        }
    }

    assetManagerEvent<N extends AssetManagerEvents['name']>(event: N, filter?: Partial<ExtractedEventArgs<AssetManagerEvents, N>>) {
        return this.truffleEvents.event(this.context.assetManager, event, filter);
    }

    log(text: string) {
        this.interceptor.log(text);
    }

    comment(text: string) {
        this.interceptor.comment(text);
    }

    async waitForThreadsToFinish(threadIds: number[], skipSeconds: number, skipUnderlyingBlocks: boolean = false, sleepMs = 20) {
        while (threadIds.some(id => this.runningThreads.has(id))) {
            await this.timeline.skipTime(skipSeconds, skipUnderlyingBlocks);
            await this.timeline.executeTriggers();
            this.timeline.eventQueue.runAll();
            await sleep(sleepMs);
            await this.interceptor.allHandled();
        }
    }
}
