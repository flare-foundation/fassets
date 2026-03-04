import { DustChanged, RedemptionRequested, RedemptionWithTagRequested } from "../../../typechain-truffle/IIAssetManager";
import { optionalEventArgs, filterEvents, requiredEventArgs } from "../../utils/events/truffle";
import { EventArgs } from "../../utils/events/common";
import { BN_ZERO, BNish, ZERO_ADDRESS, requireNotNull, toBN } from "../../utils/helpers";
import { Agent } from "./Agent";
import { AssetContext, AssetContextClient } from "./AssetContext";

export class Redeemer extends AssetContextClient {
    static deepCopyWithObjectCreate = true;

    constructor(
        context: AssetContext,
        public address: string,
        public underlyingAddress: string
    ) {
        super(context);
    }

    static async create(ctx: AssetContext, address: string, underlyingAddress: string) {
        return new Redeemer(ctx, address, underlyingAddress);
    }

    async requestRedemption(lots: number, executorAddress?: string, executorFeeNatWei?: BNish): Promise<[requests: EventArgs<RedemptionRequested>[], remainingLots: BN, dustChanges: EventArgs<DustChanged>[]]> {
        const executorFee = executorAddress ? toBN(requireNotNull(executorFeeNatWei, "executor fee required if executor used")) : undefined;
        const res = await this.assetManager.redeem(lots, this.underlyingAddress, executorAddress ?? ZERO_ADDRESS,
            { from: this.address, value: executorFee });
        const redemptionRequests = filterEvents(res, 'RedemptionRequested').map(e => e.args);
        const redemptionIncomplete = optionalEventArgs(res, 'RedemptionRequestIncomplete');
        const dustChangedEvents = filterEvents(res, 'DustChanged').map(e => e.args);
        const remainingLots = redemptionIncomplete?.remainingLots ?? BN_ZERO;
        return [redemptionRequests, remainingLots, dustChangedEvents];
    }

    async requestRedemptionWithTag(amount: BNish, tag: number, executorAddress?: string, executorFeeNatWei?: BNish): Promise<[requests: EventArgs<RedemptionWithTagRequested>[], remainingLots: BN, dustChanges: EventArgs<DustChanged>[]]> {
        const executorFee = executorAddress ? toBN(requireNotNull(executorFeeNatWei, "executor fee required if executor used")) : undefined;
        const res = await this.assetManager.redeemWithTag(amount, this.underlyingAddress, executorAddress ?? ZERO_ADDRESS, tag,
            { from: this.address, value: executorFee });
        const redemptionRequests = filterEvents(res, 'RedemptionWithTagRequested').map(e => e.args);
        const redemptionIncomplete = optionalEventArgs(res, 'RedemptionRequestIncomplete');
        const dustChangedEvents = filterEvents(res, 'DustChanged').map(e => e.args);
        const remainingLots = redemptionIncomplete?.remainingLots ?? BN_ZERO;
        return [redemptionRequests, remainingLots, dustChangedEvents];
    }

    async convertDustToTicket(agent: Agent) {
        const res = await this.assetManager.convertDustToTicket(agent.agentVault.address);
        const dustChangedEvent = requiredEventArgs(res, 'DustChanged');
        assert.equal(dustChangedEvent.agentVault, agent.agentVault.address);
        return dustChangedEvent.dustUBA;
    }

    async redemptionPaymentDefault(request: EventArgs<RedemptionRequested>) {
        const executorAddress = request.executor !== ZERO_ADDRESS ? request.executor : this.address;
        const res = await Agent.executeRedemptionPaymentDefault(this.context, request, executorAddress);
        return requiredEventArgs(res, 'RedemptionDefault');
    }

    async xrpRedemptionPaymentDefault(request: EventArgs<RedemptionWithTagRequested>) {
        const executorAddress = request.executor !== ZERO_ADDRESS ? request.executor : this.address;
        const res = await Agent.executeXRPRedemptionPaymentDefault(this.context, request, executorAddress);
        return requiredEventArgs(res, 'RedemptionDefault');
    }
}
