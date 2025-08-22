import { BalanceDecreasingTransaction } from "@flarenetwork/js-flare-common";
import { FullLiquidationStarted, RedemptionDefault, RedemptionPaymentFailed, RedemptionRequested, UnderlyingWithdrawalAnnounced } from "../../../typechain-truffle/IIAssetManager";
import { EventArgs } from "../../utils/events/common";
import { checkEventNotEmited, findRequiredEvent, requiredEventArgs } from "../../utils/events/truffle";
import { BNish, MAX_BIPS, toBN } from "../../utils/helpers";
import { Agent } from "./Agent";
import { AssetContext, AssetContextClient } from "./AssetContext";

export class Challenger extends AssetContextClient {
    static deepCopyWithObjectCreate = true;

    constructor(
        context: AssetContext,
        public address: string
    ) {
        super(context);
    }

    static async create(ctx: AssetContext, address: string) {
        // creater object
        return new Challenger(ctx, address);
    }

    async illegalPaymentChallenge(agent: Agent, txHash: string): Promise<EventArgs<FullLiquidationStarted>> {
        const proof = await this.attestationProvider.proveBalanceDecreasingTransaction(txHash, agent.underlyingAddress);
        const res = await this.assetManager.illegalPaymentChallenge(proof, agent.agentVault.address, { from: this.address });
        findRequiredEvent(res, 'IllegalPaymentConfirmed');
        return requiredEventArgs(res, 'FullLiquidationStarted');
    }

    async doublePaymentChallenge(agent: Agent, txHash1: string, txHash2: string): Promise<EventArgs<FullLiquidationStarted>> {
        const proof1 = await this.attestationProvider.proveBalanceDecreasingTransaction(txHash1, agent.underlyingAddress);
        const proof2 = await this.attestationProvider.proveBalanceDecreasingTransaction(txHash2, agent.underlyingAddress);
        const res = await this.assetManager.doublePaymentChallenge(proof1, proof2, agent.agentVault.address, { from: this.address });
        findRequiredEvent(res, 'DuplicatePaymentConfirmed');
        return requiredEventArgs(res, 'FullLiquidationStarted');
    }

    async freeBalanceNegativeChallenge(agent: Agent, txHashes: string[]): Promise<EventArgs<FullLiquidationStarted>> {
        const proofs: BalanceDecreasingTransaction.Proof[] = [];
        for (const txHash of txHashes) {
            proofs.push(await this.attestationProvider.proveBalanceDecreasingTransaction(txHash, agent.underlyingAddress));
        }
        const res = await this.assetManager.freeBalanceNegativeChallenge(proofs, agent.agentVault.address, { from: this.address });
        findRequiredEvent(res, 'UnderlyingBalanceTooLow');
        return requiredEventArgs(res, 'FullLiquidationStarted');
    }

    async confirmActiveRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        return requiredEventArgs(res, 'RedemptionPerformed');
    }

    async confirmDefaultedRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        checkEventNotEmited(res, 'RedemptionPerformed');
    }

    async confirmFailedRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent): Promise<[redemptionPaymentFailed: EventArgs<RedemptionPaymentFailed>, redemptionDefault: EventArgs<RedemptionDefault>]>  {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        return [requiredEventArgs(res, 'RedemptionPaymentFailed'), requiredEventArgs(res, 'RedemptionDefault')];
    }

    async confirmBlockedRedemptionPayment(request: EventArgs<RedemptionRequested>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, request.paymentAddress);
        const res = await this.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: this.address });
        return requiredEventArgs(res, 'RedemptionPaymentBlocked');
    }

    async confirmUnderlyingWithdrawal(request: EventArgs<UnderlyingWithdrawalAnnounced>, transactionHash: string, agent: Agent) {
        const proof = await this.attestationProvider.provePayment(transactionHash, agent.underlyingAddress, null);
        const res = await this.assetManager.confirmUnderlyingWithdrawal(proof, request.agentVault, { from: this.address });
        return requiredEventArgs(res, 'UnderlyingWithdrawalConfirmed');
    }

    async getChallengerReward(backingAtChallengeUBA: BNish, agent: Agent) {
        const settings = await this.context.assetManager.getSettings();
        const backingAtChallengeAMG = this.context.convertUBAToAmg(backingAtChallengeUBA);
        // assuming vault collateral is usd-pegged
        const rewardAMG = backingAtChallengeAMG.mul(toBN(settings.paymentChallengeRewardBIPS)).divn(MAX_BIPS);
        const rewardVaultCollateral = await agent.usd5ToVaultCollateralWei(toBN(settings.paymentChallengeRewardUSD5));
        const priceVaultCollateral = await this.context.getCollateralPrice(agent.vaultCollateral());
        return priceVaultCollateral.convertAmgToTokenWei(rewardAMG).add(rewardVaultCollateral)
    }
}
