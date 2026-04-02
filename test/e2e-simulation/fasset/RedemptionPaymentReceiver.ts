import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { EventArgs } from "../../../lib/utils/events/common";
import { EventScope, QualifiedEvent, qualifiedEvent } from "../../../lib/utils/events/ScopedEvents";
import { expectErrors, formatBN, promiseValue } from "../../../lib/utils/helpers";
import { RedemptionWithTagRequested } from "../../../typechain-truffle/CoreVaultClientFacet";
import { RedemptionRequested } from "../../../typechain-truffle/IIAssetManager";
import { SimulationActor } from "./SimulationActor";
import { SimulationRunner } from "./SimulationRunner";

export type RedemptionRequestArgs = EventArgs<RedemptionRequested> | EventArgs<RedemptionWithTagRequested>;

export class RedemptionPaymentReceiver extends SimulationActor {
    constructor(
        runner: SimulationRunner,
        public redeemer: Redeemer
    ) {
        super(runner);
    }

    static create(runner: SimulationRunner, address: string, underlyingAddress: string) {
        const redeemer = new Redeemer(runner.context, address, underlyingAddress);
        return new RedemptionPaymentReceiver(runner, redeemer);
    }

    get name() {
        return this.formatAddress(this.redeemer.address);
    }

    get underlyingAddress() {
        return this.redeemer.underlyingAddress;
    }

    async handleRedemption(scope: EventScope, request: RedemptionRequestArgs) {
        // detect if default happened during wait
        const redemptionDefaultPromise = this.assetManagerEvent('RedemptionDefault', { requestId: request.requestId }).immediate().wait(scope);
        const redemptionDefault = promiseValue(redemptionDefaultPromise);
        // wait for payment or timeout
        const event = await Promise.race([
            this.chainEvents.transactionEvent({ reference: request.paymentReference, to: this.underlyingAddress }).qualified('paid').wait(scope),
            this.waitForPaymentTimeout(scope, request),
        ]);
        if (event.name === 'paid') {
            const [targetAddress, amountPaid] = event.args.outputs[0];
            const expectedAmount = request.valueUBA.sub(request.feeUBA);
            if (amountPaid.gte(expectedAmount) && targetAddress === this.underlyingAddress) {
                this.comment(`${this.name}, req=${request.requestId}: Received redemption ${Number(amountPaid)} (= ${Number(amountPaid) / Number(this.context.lotSize())} lots)`);
            } else {
                this.comment(`${this.name}, req=${request.requestId}: Invalid redemption, paid=${formatBN(amountPaid)} expected=${expectedAmount} target=${targetAddress}`);
                await this.waitForPaymentTimeout(scope, request); // still have to wait for timeout to be able to get non payment proof from SC
                if (!redemptionDefault.resolved) { // do this only if the agent has not already submitted failed payment and defaulted
                    await this.redemptionDefault(scope, request);
                }
                const result = await redemptionDefaultPromise; // now it must be fulfilled, by agent or by customer's default call
                this.comment(`${this.name}, req=${request.requestId}: default received vault=${formatBN(result.redeemedVaultCollateralWei)} pool=${formatBN(result.redeemedPoolCollateralWei)}`);
            }
        } else {
            this.comment(`${this.name}, req=${request.requestId}: Missing redemption, reference=${request.paymentReference}`);
            await this.redemptionDefault(scope, request);
        }
    }

    private async waitForPaymentTimeout(scope: EventScope, request: RedemptionRequestArgs): Promise<QualifiedEvent<"timeout", null>> {
        // both block number and timestamp must be large enough
        await Promise.all([
            this.timeline.underlyingBlockNumber(Number(request.lastUnderlyingBlock) + 1).wait(scope),
            this.timeline.underlyingTimestamp(Number(request.lastUnderlyingTimestamp) + 1).wait(scope),
        ]);
        // after that, we have to wait for finalization
        await this.timeline.underlyingBlocks(this.context.chain.finalizationBlocks).wait(scope);
        return qualifiedEvent('timeout', null);
    }

    private async redemptionDefault(scope: EventScope, request: RedemptionRequestArgs) {
        this.comment(`${this.name}, req=${request.requestId}: starting default, block=${(this.context.chain as MockChain).blockHeight()}`);
        const result = await this.redemptionPaymentDefault(request)
            .catch(e => expectErrors(e, ["InvalidRequestId"])) // can happen if agent confirms failed payment
            .catch(e => scope.exitOnExpectedError(e, []));
        return result;
    }

    private async redemptionPaymentDefault(request: RedemptionRequestArgs) {
        return "destinationTag" in request ? await this.redeemer.xrpRedemptionPaymentDefault(request) : await this.redeemer.redemptionPaymentDefault(request);
    }
}
