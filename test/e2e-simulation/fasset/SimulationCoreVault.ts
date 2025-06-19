import { MockCoreVaultBot } from "../../../lib/test-utils/actors/MockCoreVaultBot";
import { SimulationActor } from "./SimulationActor";
import { SimulationRunner } from "./SimulationRunner";

export class SimulationCoreVault extends SimulationActor {
    constructor(
        runner: SimulationRunner,
        public bot: MockCoreVaultBot,

    ) {
        super(runner);
        this.registerForEvents();
    }

    chain = this.context.chain;
    coreVaultManager = this.bot.coreVaultManager;

    static async create(runner: SimulationRunner, triggerAddress: string) {
        const bot = new MockCoreVaultBot(runner.context, triggerAddress);
        runner.interceptor.captureEvents({ coreVaultManager: bot.coreVaultManager });
        runner.eventDecoder.addAddress(`CORE_VAULT_TRIGGERING_ACCOUNT`, triggerAddress);
        return new SimulationCoreVault(runner, bot);
    }

    async triggerAndPerformActions() {
        await this.bot.triggerAndPerformActions();
    }

    registerForEvents() {
    }
}