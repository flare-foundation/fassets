import { MintingExecuted, SelfMint } from "../../typechain-truffle/IIAssetManager";
import { TrackedAgentState } from "../state/TrackedAgentState";
import { TrackedState } from "../state/TrackedState";
import { EvmEventArgs } from "../utils/events/IEvmEvents";
import { ScopedRunner } from "../utils/events/ScopedRunner";
import { expectErrors, latestBlockTimestamp, toBN } from "../utils/helpers";
import { ActorBase } from "./ActorBase";

export class LiquidationTrigger extends ActorBase {
    constructor(
        runner: ScopedRunner,
        state: TrackedState,
        public address: string,
    ) {
        super(runner, state);
        this.registerForEvents();
    }

    registerForEvents() {
        // check for liquidations when prices change
        this.state.pricesUpdated.subscribe(() => this.checkAllAgentsForLiquidation());
        // also check for liquidation after every minting
        this.assetManagerEvent('MintingExecuted').subscribe(args => this.handleMintingExecuted(args));
        this.assetManagerEvent('SelfMint').subscribe(args => this.handleMintingExecuted(args));
    }

    checkAllAgentsForLiquidation() {
        this.runner.startThread(async (scope) => {
            for (const agent of this.state.agents.values()) {
                await this.checkAgentForLiquidation(agent)
                    .catch(e => expectErrors(e, ["CannotStopLiquidation"]));
            }
        });
    }

    handleMintingExecuted(args: EvmEventArgs<MintingExecuted> | EvmEventArgs<SelfMint>) {
        const agent = this.state.getAgent(args.agentVault);
        if (!agent) return;
        this.runner.startThread(async (scope) => {
            await this.checkAgentForLiquidation(agent)
                .catch(e => scope.exitOnExpectedError(e, ["CannotStopLiquidation"]));
        })
    }

    private async checkAgentForLiquidation(agent: TrackedAgentState) {
        const newStatus = agent.possibleLiquidationTransition();
        if (newStatus > agent.status) {
            await this.context.assetManager.startLiquidation(agent.address, { from: this.address });
        } else if (newStatus < agent.status) {
            await this.context.assetManager.endLiquidation(agent.address, { from: this.address });
        }
    }
}
