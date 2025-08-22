import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Liquidator } from "../../../lib/test-utils/actors/Liquidator";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { formatBN, HOURS, toWei } from "../../../lib/utils/helpers";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests - emergency pause`, accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const userAddress1 = accounts[30];
    const userAddress2 = accounts[31];
    const challengerAddress1 = accounts[50];
    const challengerAddress2 = accounts[51];
    const liquidatorAddress1 = accounts[60];
    const liquidatorAddress2 = accounts[61];
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
    let mockFlareDataConnectorClient: MockFlareDataConnectorClient;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.eth);
        await context.assetManagerController.addEmergencyPauseSender(emergencyAddress1, { from: governance });
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
        mockChain = context.chain as MockChain;
        mockFlareDataConnectorClient = context.flareDataConnectorClient as MockFlareDataConnectorClient;
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
            await context.assetManagerController.emergencyPause([context.assetManager.address], 1 * HOURS, { from: emergencyAddress1 });
            await expectRevert.custom(minter.reserveCollateral(agent.vaultAddress, lots), "EmergencyPauseActive", []);
            // after one hour, collateral reservations should work again
            await time.deterministicIncrease(1 * HOURS);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // minting can be finished after pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], 1 * HOURS, { from: emergencyAddress1 });
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            // but transfers work
            await minter.transferFAsset(redeemer.address, minted.mintedAmountUBA);
            // pause stops redeem too
            await expectRevert.custom(redeemer.requestRedemption(lots), "EmergencyPauseActive", []);
            // manual unpause by setting duration to 0
            await context.assetManagerController.emergencyPause([context.assetManager.address], 0, { from: emergencyAddress1 });
            const [requests] = await redeemer.requestRedemption(lots);
            // redemption payments can be performed and confirmed in pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], 1 * HOURS, { from: emergencyAddress1 });
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
            await context.assetManagerController.emergencyPause([context.assetManager.address], 1 * HOURS, { from: emergencyAddress1 });
            await expectRevert.custom(liquidator.startLiquidation(agent), "EmergencyPauseActive", []);
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL }, "reset");
            // can start liquidation after unpause
            await context.assetManagerController.emergencyPause([context.assetManager.address], 0, { from: emergencyAddress1 });
            await liquidator.startLiquidation(agent);
            await agent.checkAgentInfo({ status: AgentStatus.LIQUIDATION });
            // cannot perform liquidation after pause
            await context.assetManagerController.emergencyPause([context.assetManager.address], 1 * HOURS, { from: emergencyAddress1 });
            await expectRevert.custom(liquidator.liquidate(agent, context.convertLotsToUBA(1)), "EmergencyPauseActive", []);
            // can liquidate when pause expires
            await time.deterministicIncrease(1 * HOURS);
            const [liq] = await liquidator.liquidate(agent, context.convertLotsToUBA(3));
            console.log(formatBN(liq), formatBN(context.convertLotsToUBA(3)));
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL });
        });

        it("pause transfers", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, userAddress1, underlyingUser1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, userAddress2, underlyingUser2);
            await agent.depositCollateralsAndMakeAvailable(toWei(1e8), toWei(1e8));
            mockChain.mine(10);
            await context.updateUnderlyingBlock();
            // trigger pause
            await context.assetManagerController.emergencyPauseTransfers([context.assetManager.address], 1 * HOURS, { from: emergencyAddress1 });
            // minting works, but transfers don't
            const lots = 3;
            const lotSize = context.lotSize();
            const [minted] = await minter.performMinting(agent.vaultAddress, lots);
            await expectRevert.custom(minter.transferFAsset(redeemer.address, lotSize), "EmergencyPauseOfTransfersActive", []);
            // after one hour, collateral reservations should work again
            await time.deterministicIncrease(1 * HOURS);
            await minter.transferFAsset(redeemer.address, lotSize);
            // another pause
            await context.assetManagerController.emergencyPauseTransfers([context.assetManager.address], 1 * HOURS, { from: emergencyAddress1 });
            // redemption works
            const [requests] = await redeemer.requestRedemption(1);
            await Agent.performRedemptions([agent], requests);
            await expectRevert.custom(minter.transferFAsset(redeemer.address, lotSize), "EmergencyPauseOfTransfersActive", []);
            // manual unpause by setting duration to 0
            await context.assetManagerController.emergencyPauseTransfers([context.assetManager.address], 0, { from: emergencyAddress1 });
            await minter.transferFAsset(redeemer.address, 1000);
        });
    });
});
