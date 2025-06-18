import { MockCoreVaultBot } from "../../../lib/test-utils/actors/MockCoreVaultBot";
import { FuzzingActor } from "./FuzzingActor";
import { FuzzingRunner } from "./FuzzingRunner";

export class FuzzingCoreVault extends FuzzingActor {
    constructor(
        runner: FuzzingRunner,
        public bot: MockCoreVaultBot,

    ) {
        super(runner);
        this.registerForEvents();
    }

    chain = this.context.chain;
    coreVaultManager = this.bot.coreVaultManager;

    static async create(runner: FuzzingRunner, triggerAddress: string) {
        const bot = new MockCoreVaultBot(runner.context, triggerAddress);
        runner.interceptor.captureEvents({ coreVaultManager: bot.coreVaultManager });
        runner.eventDecoder.addAddress(`CORE_VAULT_TRIGGERING_ACCOUNT`, triggerAddress);
        return new FuzzingCoreVault(runner, bot);
    }

    async triggerAndPerformActions() {
        await this.bot.triggerAndPerformActions();
    }

    registerForEvents() {
    }
}