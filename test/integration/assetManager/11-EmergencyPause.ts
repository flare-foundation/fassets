import { ZERO_ADDRESS } from "../../../deployment/lib/deploy-utils";
import { AgentStatus, EmergencyPauseLevel } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { Challenger } from "../../../lib/test-utils/actors/Challenger";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Liquidator } from "../../../lib/test-utils/actors/Liquidator";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { filterEvents } from "../../../lib/utils/events/truffle";
import { HOURS, toBNExp, toWei } from "../../../lib/utils/helpers";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests - emergency pause`, accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const userAddress1 = accounts[30];
    const userAddress2 = accounts[31];
    const emergencyAddress1 = accounts[71];
    const emergencyAddress2 = accounts[72];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingAgent2 = "Agent2";
    const underlyingUser1 = "Minter1";
    const underlyingUser2 = "Minter2";

    let commonContext: CommonContext;
    let context: AssetContext;
    let mockChain: MockChain;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.eth);
        await context.assetManagerController.addEmergencyPauseSender(emergencyAddress1, { from: governance });
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
        mockChain = context.chain as MockChain;
    });

    describe("simple scenarios - emergency pause", () => {
        it("pause mint and redeem", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, userAddress1, underlyingUser1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, userAddress2, underlyingUser2);
            await agent.depositCollateralsAndMakeAvailable(toWei(1e8), toWei(1e8));
            mockChain.mine(10);
            await context.updateUnderlyingBlock();
            // trigger pause
            // try perform minting
            const lots = 3;
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 1 * HOURS, { from: emergencyAddress1 });
            await expectRevert.custom(minter.reserveCollateral(agent.vaultAddress, lots), "EmergencyPauseActive", []);
            // after one hour, collateral reservations should work again
            await time.deterministicIncrease(1 * HOURS);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // minting can be finished after pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 1 * HOURS, { from: emergencyAddress1 });
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            // but transfers work
            await minter.transferFAsset(redeemer.address, minted.mintedAmountUBA);
            // pause stops redeem too
            await expectRevert.custom(redeemer.requestRedemption(lots), "EmergencyPauseActive", []);
            // manual unpause by setting duration to 0
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 0, { from: emergencyAddress1 });
            const [requests] = await redeemer.requestRedemption(lots);
            // redemption payments can be performed and confirmed in pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 1 * HOURS, { from: emergencyAddress1 });
            await agent.performRedemptions(requests);
            // but self close is prevented
            await expectRevert.custom(agent.selfClose(10), "EmergencyPauseActive", []);
        });

        it("pause liquidation", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, userAddress1, underlyingUser1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, userAddress1, underlyingUser1);
            const liquidator = await Liquidator.create(context, userAddress1);
            //
            await agent.depositCollateralsAndMakeAvailable(toWei(1e8), toWei(1e8));
            mockChain.mine(10);
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            await minter.performMinting(agent.vaultAddress, lots);
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL }, "reset");
            // price change
            await context.priceStore.setCurrentPrice("NAT", 200, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 200, 0);
            //  pause stops liquidation
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 1 * HOURS, { from: emergencyAddress1 });
            await expectRevert.custom(liquidator.startLiquidation(agent), "EmergencyPauseActive", []);
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL }, "reset");
            // can start liquidation after unpause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 0, { from: emergencyAddress1 });
            await liquidator.startLiquidation(agent);
            await agent.checkAgentInfo({ status: AgentStatus.LIQUIDATION });
            // cannot perform liquidation after pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 1 * HOURS, { from: emergencyAddress1 });
            await expectRevert.custom(liquidator.liquidate(agent, context.convertLotsToUBA(1)), "EmergencyPauseActive", []);
            // can liquidate when pause expires
            await time.deterministicIncrease(1 * HOURS);
            const [liq] = await liquidator.liquidate(agent, context.convertLotsToUBA(3));
            // console.log(formatBN(liq), formatBN(context.convertLotsToUBA(3)));
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL });
        });

        it("pause everything, including transfers", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, userAddress1, underlyingUser1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, userAddress2, underlyingUser2);
            await agent.depositCollateralsAndMakeAvailable(toWei(1e8), toWei(1e8));
            mockChain.mine(10);
            await context.updateUnderlyingBlock();
            const lotSize = context.lotSize();
            await minter.performMinting(agent.vaultAddress, 3);
            // trigger pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.FULL_AND_TRANSFER, 1 * HOURS, { from: emergencyAddress1 });
            // nothing works, including transfers
            await expectRevert.custom(minter.performMinting(agent.vaultAddress, 1), "EmergencyPauseActive", []);
            await expectRevert.custom(minter.transferFAsset(redeemer.address, lotSize), "EmergencyPauseOfTransfersActive", []);
            // after one hour, transfers should work again
            await time.deterministicIncrease(1 * HOURS);
            await minter.transferFAsset(redeemer.address, lotSize);
            // another pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.FULL_AND_TRANSFER, 1 * HOURS, { from: emergencyAddress1 });
            await expectRevert.custom(minter.transferFAsset(redeemer.address, lotSize), "EmergencyPauseOfTransfersActive", []);
            // manual unpause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.NONE, 0, { from: emergencyAddress1 });
            await minter.transferFAsset(redeemer.address, lotSize);
        });

        it("try all asset manager operations blocked by 'start operations' pause", async () => {
            await context.assignCoreVaultManager();
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralLotsAndMakeAvailable(20);
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            await agent2.depositCollateralLots(20);
            const minter = await Minter.createTest(context, userAddress1, underlyingUser1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, userAddress2, underlyingUser2);
            const liquidator = await Liquidator.create(context, userAddress2);
            const challenger = await Challenger.create(context, userAddress2);
            mockChain.mine(10);
            await context.updateUnderlyingBlock();
            const lotSize = context.lotSize();
            await minter.performMinting(agent.vaultAddress, 5);
            await minter.transferFAsset(redeemer.address, lotSize.muln(2));
            // trigger "start operations" pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 1 * HOURS, { from: emergencyAddress1 });
            // cannot start mint or redeem
            await expectRevert.custom(minter.reserveCollateral(agent.vaultAddress, 1), "EmergencyPauseActive", []);
            await expectRevert.custom(redeemer.requestRedemption(1), "EmergencyPauseActive", []);
            // cannot self close
            await expectRevert.custom(agent.selfClose(lotSize), "EmergencyPauseActive", []);
            // cannot liquidate
            await expectRevert.custom(liquidator.startLiquidation(agent), "EmergencyPauseActive", []);
            await expectRevert.custom(liquidator.liquidate(agent, lotSize), "EmergencyPauseActive", []);
            // cannot challenge
            const tx1 = await agent.performPayment(redeemer.underlyingAddress, lotSize, null);
            const tx2 = await agent.performPayment(redeemer.underlyingAddress, lotSize, null);
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1), "EmergencyPauseActive", []);
            await expectRevert.custom(challenger.doublePaymentChallenge(agent, tx1, tx2), "EmergencyPauseActive", []);
            await expectRevert.custom(challenger.freeBalanceNegativeChallenge(agent, [tx1, tx2]), "EmergencyPauseActive", []);
            // cannot announce enter available
            await expectRevert.custom(agent.announceExitAvailable(), "EmergencyPauseActive", []);
            // cannot exit available
            await expectRevert.custom(agent2.makeAvailable(), "EmergencyPauseActive", []);
            // cannot create new vault
            await expectRevert.custom(Agent.createTest(context, agentOwner1, underlyingAgent1), "EmergencyPauseActive", []);
            // cannot announce destroy
            await expectRevert.custom(agent2.announceDestroy(), "EmergencyPauseActive", []);
            // cannot start collateral withdrawal
            await expectRevert.custom(agent.announceVaultCollateralWithdrawal(1000), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.announcePoolTokenRedemption(1000), "EmergencyPauseActive", []);
            // cannot start transfer from/to core vault
            await expectRevert.custom(agent.transferToCoreVault(1000), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.requestReturnFromCoreVault(1000), "EmergencyPauseActive", []);
            await expectRevert.custom(context.assetManager.redeemFromCoreVault(1, redeemer.underlyingAddress, { from: redeemer.address }), "EmergencyPauseActive", []);
            // cannot redeem from agent
            await expectRevert.custom(
                context.assetManager.redeemFromAgent(agent.vaultAddress, redeemer.address, lotSize, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address }),
                "EmergencyPauseActive", []);
            await expectRevert.custom(
                context.assetManager.redeemFromAgentInCollateral(agent.vaultAddress, redeemer.address, lotSize, { from: redeemer.address }),
                "EmergencyPauseActive", []);
            // cannot confirm topup underlying
            const topupTx = await agent.performTopupPayment(lotSize, true);
            await expectRevert.custom(agent.confirmTopupPayment(topupTx), "EmergencyPauseActive", []);
            // cannot announce underlying withdrawal
            await expectRevert.custom(agent.announceUnderlyingWithdrawal(), "EmergencyPauseActive", []);
        });

        it("try all collateral pool operations blocked by 'start operations' pause", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralLotsAndMakeAvailable(20);
            await agent.collateralPool.enter({ from: userAddress1, value: toBNExp(100, 18) });
            // trigger "start operations" pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.START_OPERATIONS, 1 * HOURS, { from: emergencyAddress1 });
            // cannot enter pool
            await expectRevert.custom(agent.collateralPool.enter({ from: userAddress1 }), "EmergencyPauseActive", []);
            // cannot exit pool
            await expectRevert.custom(agent.collateralPool.exit(1000, { from: userAddress1 }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.exitTo(1000, userAddress2, { from: userAddress1 }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.selfCloseExit(1000, false, underlyingUser1, ZERO_ADDRESS, { from: userAddress1 }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.selfCloseExitTo(1000, false, userAddress2, underlyingUser2, ZERO_ADDRESS, { from: userAddress1 }), "EmergencyPauseActive", []);
            // cannot withdraw fees
            await expectRevert.custom(agent.collateralPool.withdrawFees(1000, { from: userAddress1 }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.withdrawFeesTo(1000, userAddress2, { from: userAddress1 }), "EmergencyPauseActive", []);
            // cannot pay fee debt
            await expectRevert.custom(agent.collateralPool.payFAssetFeeDebt(1000, { from: userAddress1 }), "EmergencyPauseActive", []);
            // cannot manage delegations or claim rewards by the agent
            await expectRevert.custom(agent.collateralPool.delegate(userAddress2, 1000, { from: agent.ownerWorkAddress }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.undelegateAll({ from: agent.ownerWorkAddress }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.delegateGovernance(userAddress2, { from: agent.ownerWorkAddress }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.undelegateGovernance({ from: agent.ownerWorkAddress }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.claimDelegationRewards(accounts[10], 1000, [], { from: agent.ownerWorkAddress }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.claimAirdropDistribution(accounts[10], 1, { from: agent.ownerWorkAddress }), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.collateralPool.optOutOfAirdrop(accounts[10], { from: agent.ownerWorkAddress }), "EmergencyPauseActive", []);
        });

        it("try all asset manager operations blocked by 'full' pause", async () => {
            await context.assignCoreVaultManager();
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralLotsAndMakeAvailable(20);
            const minter = await Minter.createTest(context, userAddress1, underlyingUser1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, userAddress2, underlyingUser2);
            mockChain.mine(10);
            await context.updateUnderlyingBlock();
            const lotSize = context.lotSize();
            await minter.performMinting(agent.vaultAddress, 5);
            await minter.transferFAsset(redeemer.address, lotSize.muln(2));
            // start a minting and a redemption
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const [[rrq]] = await redeemer.requestRedemption(1);
            const invRedRes = await context.assetManager.redeem(1, "MY_INVALID_ADDRESS", ZERO_ADDRESS, { from: redeemer.address });
            const [invalidRrq] = filterEvents(invRedRes, 'RedemptionRequested').map(e => e.args);
            const undWithdr = await agent.announceUnderlyingWithdrawal();
            // make all payments late
            context.skipToExpiration(rrq.lastUnderlyingBlock, rrq.lastUnderlyingTimestamp);
            // create payments (too late)
            const mintTx = await minter.performMintingPayment(crt);
            const redeemTx = await agent.performRedemptionPayment(rrq);
            // trigger "full" pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], EmergencyPauseLevel.FULL, 1 * HOURS, { from: emergencyAddress1 });
            // cannot confirm, default or unstick minting
            await expectRevert.custom(minter.executeMinting(crt, mintTx), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.mintingPaymentDefault(crt), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.unstickMinting(crt), "EmergencyPauseActive", []);
            // cannot confirm, default or reject redemption
            await expectRevert.custom(agent.confirmActiveRedemptionPayment(rrq, redeemTx), "EmergencyPauseActive", []);
            await expectRevert.custom(redeemer.redemptionPaymentDefault(rrq), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.finishRedemptionWithoutPayment(rrq), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.rejectInvalidRedemption(invalidRrq), "EmergencyPauseActive", []);
            // cannot self close
            await expectRevert.custom(agent.selfClose(1000), "EmergencyPauseActive", []);
            // cannot end liquidation
            await expectRevert.custom(agent.endLiquidation(), "EmergencyPauseActive", []);
            // cannot complete collateral withdrawal
            await expectRevert.custom(agent.withdrawVaultCollateral(1000), "EmergencyPauseActive", []);
            // cannot exit avalable
            await expectRevert.custom(agent.exitAvailable(false), "EmergencyPauseActive", []);
            // cannot destroy vault
            await expectRevert.custom(agent.destroy(), "EmergencyPauseActive", []);
            // cannot confirm or cancel return from cv
            await expectRevert.custom(agent.confirmReturnFromCoreVault(mintTx), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.cancelReturnFromCoreVault(), "EmergencyPauseActive", []);
            // cannot confirm or cancel underlying withdrawal
            await expectRevert.custom(agent.confirmUnderlyingWithdrawal(undWithdr, redeemTx), "EmergencyPauseActive", []);
            await expectRevert.custom(agent.cancelUnderlyingWithdrawal(undWithdr), "EmergencyPauseActive", []);
        });
    });
});
