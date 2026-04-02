import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";
import { IBlockChainWallet } from "../../../lib/underlying-chain/interfaces/IBlockChainWallet";
import { EventScope } from "../../../lib/utils/events/ScopedEvents";
import { BN_ZERO, errorIncluded, minBN, sumBN, toBN, toNumber } from "../../../lib/utils/helpers";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { MockChain, MockChainWallet } from "../../../lib/test-utils/fasset/MockChain";
import { foreachAsyncParallel, randomBN, randomChoice, randomInt } from "../../../lib/test-utils/simulation-utils";
import { FAssetSeller } from "./FAssetMarketplace";
import { SimulationActor } from "./SimulationActor";
import { SimulationRunner } from "./SimulationRunner";
import { RedemptionPaymentReceiver } from "./RedemptionPaymentReceiver";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { findEvent } from "../../../lib/utils/events/truffle";

// debug state
let mintedLots = 0;

export class SimulationCustomer extends SimulationActor implements FAssetSeller {
    minter: Minter;
    redeemer: Redeemer;

    constructor(
        runner: SimulationRunner,
        public address: string,
        public underlyingAddress: string,
        public wallet: IBlockChainWallet,
    ) {
        super(runner);
        this.minter = new Minter(runner.context, address, underlyingAddress, wallet);
        this.redeemer = new Redeemer(runner.context, address, underlyingAddress);
    }

    static async createTest(runner: SimulationRunner, address: string, underlyingAddress: string, underlyingBalance: BN) {
        const chain = runner.context.chain;
        if (!(chain instanceof MockChain)) assert.fail("only for mock chains");
        chain.mint(underlyingAddress, underlyingBalance);
        const wallet = new MockChainWallet(chain);
        return new SimulationCustomer(runner, address, underlyingAddress, wallet);
    }

    get name() {
        return this.formatAddress(this.address);
    }

    async fAssetBalance() {
        return await this.context.fAsset.balanceOf(this.address);
    }

    async minting(scope: EventScope) {
        await this.context.updateUnderlyingBlock();
        // create CR
        const agent = randomChoice(this.runner.availableAgents);
        const lots = randomInt(Number(agent.freeCollateralLots));
        if (this.avoidErrors && lots === 0) return;
        const crt = await this.minter.reserveCollateral(agent.agentVault, lots)
            .catch(e => scope.exitOnExpectedError(e, [
                "CannotMintZeroLots", "NotEnoughFreeCollateral", "InappropriateFeeAmount",
                "InvalidAgentStatus", "AgentNotInMintQueue", "InvalidAgentVaultAddress"    // errors when agent changed status or was destroyed since last check
            ]));
        // pay
        const txHash = await this.minter.performMintingPayment(crt);
        // wait for finalization
        await this.context.waitForUnderlyingTransactionFinalization(scope, txHash);
        // execute
        await this.minter.executeMinting(crt, txHash)
            .catch(e => scope.exitOnExpectedError(e, ["PaymentFailed"]));  // 'payment failed' can happen if there are several simultaneous payments and this one makes balance negative
        mintedLots += lots;
    }

    async directMinting(scope: EventScope) {
        await this.context.updateUnderlyingBlock();
        // create CR
        const lotSize = Number(this.context.lotSize());
        const amount = randomInt(100 * lotSize);
        if (this.avoidErrors && amount === 0) return;
        const paymentAddress = await this.context.assetManager.directMintingPaymentAddress();
        const memoData = PaymentReference.directMinting(this.address);
        const txHash = await this.minter.performPayment(paymentAddress, amount, memoData);
        // wait for finalization
        await this.context.waitForUnderlyingTransactionFinalization(scope, txHash);
        // prove and execute
        const proof = await this.context.attestationProvider.proveXRPPayment(txHash, null);
        let res = await this.context.assetManager.executeDirectMinting(proof, { from: this.address });
        // if minting is delayed, wait and try again
        const delayed = findEvent(res, "DirectMintingDelayed") ?? findEvent(res, "LargeDirectMintingDelayed");
        if (delayed) {
            this.comment(`Direct minting delayed until ${delayed.args.executionAllowedAt}, waiting for delay and trying again`);
            await this.timeline.flareTimestamp(delayed.args.executionAllowedAt).wait(scope);
            res = await this.context.assetManager.executeDirectMinting(proof, { from: this.address });
        }
        // check that minting was executed
        const executed = findEvent(res, "DirectMintingExecuted") ?? findEvent(res, "DirectMintingPaymentTooSmallForFee");
        if (!executed) {
            throw new Error("Missing event DirectMintingExecuted or DirectMintingPaymentTooSmallForFee");
        }
    }

    async redemption(scope: EventScope) {
        const [tickets, remaining] = await this.requestRedemption(scope)
            .catch(e => scope.exitOnExpectedError(e, ["FAssetBalanceTooLow", "RedeemZeroLots"]));
        mintedLots -= toNumber(sumBN(tickets.map(t => t.valueUBA))) / toNumber(this.context.lotSize());
        this.comment(`${this.name}: Redeeming ${tickets.length} tickets, remaining ${remaining} lots`);
        // wait for all redemption payments or non-payments
        const redemptionPaymentReceiver = new RedemptionPaymentReceiver(this.runner, this.redeemer);
        await foreachAsyncParallel(tickets, async request => {
            await redemptionPaymentReceiver.handleRedemption(scope, request);
        });
    }

    async requestRedemption(scope: EventScope) {
        const lotSize = this.context.lotSize();
        const holdingUBA = await this.fAssetBalance();
        const choice = randomChoice(["lots", "withTag", "amount"]);
        if (choice === "lots") {
            const holdingLots = Number(holdingUBA.div(lotSize));
            const lots = randomInt(this.avoidErrors ? holdingLots : 100);
            this.comment(`${this.name} lots ${lots}   total minted ${mintedLots}   holding ${holdingLots}`);
            if (this.avoidErrors && lots === 0) {
                scope.exit("No lots to redeem, skipping.");
            }
            return await this.redeemer.requestRedemption(lots);
        } else if (choice === "withTag") {
            const amount = randomBN(holdingUBA);
            if (this.avoidErrors && amount.lt(toBN(this.context.initSettings.minimumRedeemAmountUBA))) {
                scope.exit("Amount too low, skipping.");
            }
            const tag = randomInt(1000);
            this.comment(`${this.name} amount ${amount}   total minted ${lotSize.muln(mintedLots)}   holding ${holdingUBA} UBA   tag ${tag}`);
            return await this.redeemer.requestRedemptionWithTag(amount, tag);
        } else {
            const amount = randomBN(holdingUBA);
            if (this.avoidErrors && amount.lt(toBN(this.context.initSettings.minimumRedeemAmountUBA))) {
                scope.exit("Amount too low, skipping.");
            }
            this.comment(`${this.name} amount ${amount}   total minted ${lotSize.muln(mintedLots)}   holding ${holdingUBA} UBA`);
            return await this.redeemer.requestRedemptionAnyAmount(amount);
        }
    }

    async liquidate(scope: EventScope) {
        const agentsInLiquidation = Array.from(this.state.agents.values())
            .filter(agent => agent.status === AgentStatus.LIQUIDATION || agent.status === AgentStatus.FULL_LIQUIDATION)
            .map(agent => agent.address);
        if (agentsInLiquidation.length === 0) return;
        const agentAddress = randomChoice(agentsInLiquidation);
        const holdingUBA = await this.fAssetBalance();
        if (this.avoidErrors && holdingUBA.isZero()) return;
        this.context.assetManager.liquidate(agentAddress, holdingUBA, { from: this.address })
            .catch(e => scope.exitOnExpectedError(e, []));
    }

    async buyFAssetsFrom(scope: EventScope, receiverAddress: string, amount: BN) {
        const transferAmount = minBN(amount, await this.fAssetBalance());
        try {
            await this.context.fAsset.transfer(receiverAddress, transferAmount, { from: this.address });
            return transferAmount;
        } catch (e) {
            if (errorIncluded(e, ["FAssetBalanceTooLow"])) return BN_ZERO;
            throw e;
        }
    }
}
