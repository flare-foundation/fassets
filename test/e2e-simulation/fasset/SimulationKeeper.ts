import { EvmEventArgs } from "../../../lib/utils/events/IEvmEvents";
import { expectErrors } from "../../../lib/utils/helpers";
import { MintingExecuted, SelfMint } from "../../../typechain-truffle/IIAssetManager";
import { SimulationActor } from "./SimulationActor";
import { SimulationRunner } from "./SimulationRunner";
import { SimulationAgentState } from "./SimulationAgentState";
import { time } from "../../../lib/test-utils/test-helpers";

export class SimulationKeeper extends SimulationActor {
    constructor(
        public runner: SimulationRunner,
        public address: string,
    ) {
        super(runner);
        this.registerForEvents();
    }

    get name() {
        return this.formatAddress(this.address);
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
        if (!agent) {
            this.comment(`Invalid agent address ${args.agentVault}`);
            return;
        }
        this.runner.startThread(async (scope) => {
            await this.checkAgentForLiquidation(agent)
                .catch(e => scope.exitOnExpectedError(e, ["CannotStopLiquidation"]));
        })
    }

    private async checkAgentForLiquidation(agent: SimulationAgentState) {
        const newStatus = agent.possibleLiquidationTransition();
        if (newStatus > agent.status) {
            await this.context.assetManager.startLiquidation(agent.address, { from: this.address });
        } else if (newStatus < agent.status) {
            await this.context.assetManager.endLiquidation(agent.address, { from: this.address });
        }
    }
}
