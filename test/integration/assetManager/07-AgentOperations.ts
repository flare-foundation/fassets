import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { Challenger } from "../../../lib/test-utils/actors/Challenger";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { ether, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { DAYS, MAX_BIPS, toBN, toBNExp, toWei } from "../../../lib/utils/helpers";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests`, accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const minterAddress1 = accounts[30];
    const minterAddress2 = accounts[31];
    const redeemerAddress1 = accounts[40];
    const redeemerAddress2 = accounts[41];
    const challengerAddress1 = accounts[50];
    const challengerAddress2 = accounts[51];
    const liquidatorAddress1 = accounts[60];
    const liquidatorAddress2 = accounts[61];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingAgent2 = "Agent2";
    const underlyingMinter1 = "Minter1";
    const underlyingMinter2 = "Minter2";
    const underlyingRedeemer1 = "Redeemer1";
    const underlyingRedeemer2 = "Redeemer2";

    let commonContext: CommonContext;
    let context: AssetContext;
    let mockChain: MockChain;
    let mockFlareDataConnectorClient: MockFlareDataConnectorClient;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.eth);
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
        mockChain = context.chain as MockChain;
        mockFlareDataConnectorClient = context.flareDataConnectorClient as MockFlareDataConnectorClient;
    });

    describe("simple scenarios - agent manipulating collateral and underlying address", () => {
        it("collateral withdrawal", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            const agentInfo = await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA) });
            // should not withdraw all but only free collateral
            await expectRevert.custom(agent.announceVaultCollateralWithdrawal(fullAgentCollateral), "WithdrawalValueTooHigh", []);
            const minVaultCollateralRatio = agentInfo.mintingVaultCollateralRatioBIPS; // > agent.vaultCollateral().minCollateralRatioBIPS
            const vaultCollateralPrice = await context.getCollateralPrice(agent.vaultCollateral());
            const lockedCollateral = vaultCollateralPrice.convertUBAToTokenWei(agentInfo.mintedUBA).mul(toBN(minVaultCollateralRatio)).divn(MAX_BIPS);
            const withdrawalAmount = fullAgentCollateral.sub(lockedCollateral);
            await agent.announceVaultCollateralWithdrawal(withdrawalAmount);
            await agent.checkAgentInfo({ reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: withdrawalAmount });
            await expectRevert.custom(agent.withdrawVaultCollateral(withdrawalAmount), "WithdrawalNotAllowedYet", []);
            await time.deterministicIncrease(context.settings.withdrawalWaitMinSeconds);
            const startVaultCollateralBalance = toBN(await agent.vaultCollateralToken().balanceOf(agent.ownerWorkAddress));
            await agent.withdrawVaultCollateral(withdrawalAmount);
            await agent.checkAgentInfo({ totalVaultCollateralWei: lockedCollateral, announcedVaultCollateralWithdrawalWei: 0 });
            const endVaultCollateralBalance = toBN(await agent.vaultCollateralToken().balanceOf(agent.ownerWorkAddress));
            assertWeb3Equal(endVaultCollateralBalance.sub(startVaultCollateralBalance), withdrawalAmount);
            await expectRevert.custom(agent.announceVaultCollateralWithdrawal(1), "WithdrawalValueTooHigh", []);
        });

        it("changing collaterals", async () => {
            const currentSettings = await context.assetManager.getSettings();
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 100;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            const agentInfo = await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA) });
            //Deprecate collateral token
            await context.assetManagerController.deprecateCollateralType([context.assetManager.address], 2, context.usdc.address,
                currentSettings.tokenInvalidationTimeMinSeconds, { from: governance });
            await time.deterministicIncrease(context.settings.tokenInvalidationTimeMinSeconds);
            //Owner can't switch collateral if there is not enough collateral of the new token
            const res = context.assetManager.switchVaultCollateral(agent.agentVault.address, context.usdt.address, { from: agent.ownerWorkAddress });
            await expectRevert.custom(res, "NotEnoughCollateral", []);
            // Agent deposits new collateral
            await context.usdt.mintAmount(agent.ownerWorkAddress, fullAgentCollateral);
            await context.usdt.approve(agent.agentVault.address, fullAgentCollateral, { from: agent.ownerWorkAddress });
            await agent.agentVault.depositCollateral(context.usdt.address, fullAgentCollateral, { from: agent.ownerWorkAddress });
            // Agent switches vault collateral and withdraws previous collateral
            await context.assetManager.switchVaultCollateral(agent.agentVault.address, context.usdt.address, { from: agent.ownerWorkAddress });
            await agent.agentVault.transferExternalToken(context.usdc.address, fullAgentCollateral, { from: agent.ownerWorkAddress });
            //Minter mints again
            const crt2 = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash2 = await minter.performMintingPayment(crt2);
            const minted2 = await minter.executeMinting(crt2, txHash2);
            assertWeb3Equal(minted2.mintedAmountUBA, context.convertLotsToUBA(lots));
            // agent "buys" f-assets
            await context.fAsset.transfer(agent.ownerWorkAddress, minted.mintedAmountUBA.add(minted2.mintedAmountUBA), { from: minter.address });
            // perform self close
            const [dustChanges, selfClosedUBA] = await agent.selfClose(minted.mintedAmountUBA.add(minted2.mintedAmountUBA));
            await agent.checkAgentInfo({
                freeUnderlyingBalanceUBA:
                    minted.mintedAmountUBA.add(minted2.mintedAmountUBA).add(crt.feeUBA.sub(minted.poolFeeUBA).add(crt2.feeUBA.sub(minted2.poolFeeUBA)))
                , mintedUBA: minted.poolFeeUBA.add(minted.poolFeeUBA)
            });
            assertWeb3Equal(selfClosedUBA, minted.mintedAmountUBA.add(minted2.mintedAmountUBA));
        });

        it("topup payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: 0, mintedUBA: 0 });
            // topup payment
            const amount = 100;
            const txHash = await agent.performTopupPayment(amount);
            await agent.confirmTopupPayment(txHash);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: amount });
            // check that confirming the same topup payment reverts
            await expectRevert.custom(agent.confirmTopupPayment(txHash), "PaymentAlreadyConfirmed", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("underlying withdrawal", async () => {
            const fullAgentCollateral = toWei(3e8);
            const agent1 = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            // make agents available
            await agent1.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            await agent2.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // topup payment
            const amount = 100;
            const tx1Hash = await agent1.performTopupPayment(amount);
            await agent1.confirmTopupPayment(tx1Hash);
            await agent1.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: amount, mintedUBA: 0 });
            const tx2Hash = await agent2.performTopupPayment(amount);
            await agent2.confirmTopupPayment(tx2Hash);
            await agent2.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: amount, mintedUBA: 0 });
            // underlying withdrawal
            const underlyingWithdrawal1 = await agent1.announceUnderlyingWithdrawal();
            await agent1.checkAgentInfo({ announcedUnderlyingWithdrawalId: underlyingWithdrawal1.announcementId });
            assert.isAbove(Number(underlyingWithdrawal1.announcementId), 0);
            const underlyingWithdrawal2 = await agent2.announceUnderlyingWithdrawal();
            await agent2.checkAgentInfo({ announcedUnderlyingWithdrawalId: underlyingWithdrawal2.announcementId });
            assert.isAbove(Number(underlyingWithdrawal2.announcementId), Number(underlyingWithdrawal1.announcementId));
            const tx3Hash = await agent1.performUnderlyingWithdrawal(underlyingWithdrawal1, amount);
            const res1 = await agent1.confirmUnderlyingWithdrawal(underlyingWithdrawal1, tx3Hash);
            await agent1.checkAgentInfo({ freeUnderlyingBalanceUBA: 0, announcedUnderlyingWithdrawalId: 0 });
            assertWeb3Equal(res1.spentUBA, amount);
            const tx4Hash = await agent2.performUnderlyingWithdrawal(underlyingWithdrawal2, amount);
            const res2 = await agent2.confirmUnderlyingWithdrawal(underlyingWithdrawal2, tx4Hash);
            await agent2.checkAgentInfo({ freeUnderlyingBalanceUBA: 0, announcedUnderlyingWithdrawalId: 0 });
            assertWeb3Equal(res2.spentUBA, amount);
            // agent can exit now
            await agent1.exitAndDestroy(fullAgentCollateral);
            await agent2.exitAndDestroy(fullAgentCollateral);
        });

        it("cancel underlying withdrawal", async () => {
            const fullAgentCollateral = toWei(3e8);
            const agent1 = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            // make agents available
            await agent1.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // topup payment
            const amount = 100;
            const tx1Hash = await agent1.performTopupPayment(amount);
            await agent1.confirmTopupPayment(tx1Hash);
            await agent1.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: amount, mintedUBA: 0 });
            // underlying withdrawal
            const underlyingWithdrawal1 = await agent1.announceUnderlyingWithdrawal();
            await agent1.checkAgentInfo({ announcedUnderlyingWithdrawalId: underlyingWithdrawal1.announcementId });
            assert.isAbove(Number(underlyingWithdrawal1.announcementId), 0);
            await time.deterministicIncrease(context.settings.confirmationByOthersAfterSeconds);
            await agent1.cancelUnderlyingWithdrawal(underlyingWithdrawal1);
            // agent can exit now
            await agent1.exitAndDestroy(fullAgentCollateral);
        });

        it("underlying withdrawal (others can confirm underlying withdrawal after some time)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const challenger = await Challenger.create(context, challengerAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // topup payment
            const amount = 100;
            const txHash = await agent.performTopupPayment(amount);
            await agent.confirmTopupPayment(txHash);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: amount, mintedUBA: 0 });
            // underlying withdrawal
            const underlyingWithdrawal = await agent.announceUnderlyingWithdrawal();
            const tx1Hash = await agent.performUnderlyingWithdrawal(underlyingWithdrawal, amount);
            await agent.checkAgentInfo({ announcedUnderlyingWithdrawalId: underlyingWithdrawal.announcementId });
            assert.isAbove(Number(underlyingWithdrawal.announcementId), 0);
            // others cannot confirm underlying withdrawal immediatelly or challenge it as illegal payment
            await expectRevert.custom(challenger.confirmUnderlyingWithdrawal(underlyingWithdrawal, tx1Hash, agent), "OnlyAgentVaultOwner", []);
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "MatchingAnnouncedPaymentActive", []);
            // others can confirm underlying withdrawal after some time
            await time.deterministicIncrease(context.settings.confirmationByOthersAfterSeconds);
            const startVaultCollateralBalance = await agent.vaultCollateralToken().balanceOf(challenger.address);
            const res = await challenger.confirmUnderlyingWithdrawal(underlyingWithdrawal, tx1Hash, agent);
            const challengerVaultCollateralReward = await agent.usd5ToVaultCollateralWei(toBN(context.settings.confirmationByOthersRewardUSD5));
            assert.approximately(Number(challengerVaultCollateralReward) / 1e18, 100, 10);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral.sub(challengerVaultCollateralReward), freeUnderlyingBalanceUBA: 0, announcedUnderlyingWithdrawalId: 0 });
            await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "ChallengeTransactionAlreadyConfirmed", []);
            assertWeb3Equal(res.spentUBA, amount);
            const endVaultCollateralBalance = await agent.vaultCollateralToken().balanceOf(challenger.address);
            // test rewarding
            assertWeb3Equal(endVaultCollateralBalance.sub(startVaultCollateralBalance), challengerVaultCollateralReward);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(challengerVaultCollateralReward));
        });

        it("try to redeem after pause", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter1 = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const minter2 = await Minter.createTest(context, minterAddress2, underlyingMinter2, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots1 = 3;
            const crt1 = await minter1.reserveCollateral(agent.vaultAddress, lots1);
            const tx1Hash = await minter1.performMintingPayment(crt1);
            const minted1 = await agent.executeMinting(crt1, tx1Hash);
            assertWeb3Equal(minted1.mintedAmountUBA, context.convertLotsToUBA(lots1));
            const lots2 = 6;
            const crt2 = await minter2.reserveCollateral(agent.vaultAddress, lots2);
            const tx2Hash = await minter2.performMintingPayment(crt2);
            // pause asset manager
            await context.assetManagerController.pauseMinting([context.assetManager.address], { from: governance });
            assert.isTrue(await context.assetManager.mintingPaused());
            // existing minting can be executed, new minting is not possible
            const minted2 = await agent.executeMinting(crt2, tx2Hash, minter2);
            await expectRevert.custom(minter1.reserveCollateral(agent.vaultAddress, lots1), "MintingPaused", []);
            await expectRevert.custom(agent.selfMint(context.convertLotsToUBA(lots1), lots1), "MintingPaused", []);
            // agent and redeemer "buys" f-assets
            await context.fAsset.transfer(agent.ownerWorkAddress, minted1.mintedAmountUBA, { from: minter1.address });
            await context.fAsset.transfer(redeemer.address, minted2.mintedAmountUBA, { from: minter2.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots2 / 2);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            const txHash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, txHash);
            // perform self close
            const [dustChanges1, selfClosedUBA] = await agent.selfClose(minted1.mintedAmountUBA);
            assertWeb3Equal(selfClosedUBA, minted1.mintedAmountUBA);
            assert.equal(dustChanges1.length, 0); // pool fees
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted1.agentFeeUBA.add(minted2.agentFeeUBA).add(request.feeUBA).add(selfClosedUBA),
                mintedUBA: minted1.poolFeeUBA.add(minted2.mintedAmountUBA).add(minted2.poolFeeUBA).sub(request.valueUBA)
            });
            await time.deterministicIncrease(30 * DAYS);
            mockChain.skipTime(30 * DAYS);
            const [redemptionRequests2, remainingLots2, dustChanges2] = await redeemer.requestRedemption(1);
            assertWeb3Equal(remainingLots2, 0);
            assert.equal(dustChanges2.length, 0);
            assert.equal(redemptionRequests2.length, 1);
            const request2 = redemptionRequests2[0];
            assert.equal(request2.agentVault, agent.vaultAddress);
            const tx3Hash = await agent.performRedemptionPayment(request2);
            await agent.confirmActiveRedemptionPayment(request2, tx3Hash);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted1.agentFeeUBA.add(minted2.agentFeeUBA).add(request.feeUBA).add(selfClosedUBA).add(request2.feeUBA),
                mintedUBA: minted1.poolFeeUBA.add(minted2.mintedAmountUBA).add(minted2.poolFeeUBA).sub(request.valueUBA).sub(request2.valueUBA)
            });
        });

        it("agent shouldn't be able to withdraw collateral if it makes CR fall too low", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(5e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            //Agent announces vault collateral withdrawal
            const agentInfo = await agent.getAgentInfo();
            const lockedCollateral = toBN(agentInfo.totalVaultCollateralWei).sub(toBN(agentInfo.freeVaultCollateralWei));
            const withdrawalAmount = toBN(agentInfo.totalVaultCollateralWei).sub(lockedCollateral);
            //Test withdrawal
            //Announce vault collateral withdrawal
            await agent.announceVaultCollateralWithdrawal(withdrawalAmount);
            await time.deterministicIncrease(context.settings.withdrawalWaitMinSeconds);
            await agent.withdrawVaultCollateral(withdrawalAmount);
            //Check that CR is safe
            const vaultCollateralRatioBIPS = toBN((await agent.getAgentInfo()).vaultCollateralRatioBIPS);
            const vaultCollateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(vaultCollateralRatioBIPS.gte(toBN(vaultCollateralTypes.safetyMinCollateralRatioBIPS)));
            //Agent deposits vault collateral back
            await agent.depositVaultCollateral(withdrawalAmount);
            //Try to withdraw after price swing
            //Announce vault collateral withdrawal
            await agent.announceVaultCollateralWithdrawal(withdrawalAmount);
            await time.deterministicIncrease(context.settings.withdrawalWaitMinSeconds);
            //Price changes vault CR
            await agent.setVaultCollateralRatioByChangingAssetPrice(1000000);
            //Agent shouldn't be able to withdraw if it would make CR too low
            const res = agent.withdrawVaultCollateral(withdrawalAmount);
            await expectRevert.custom(res, "WithdrawalCRTooLow", []);
        });

        it("read operations and withdrawing tokens after destroy", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullCollateral = await agent.requiredCollateralForLots(10);
            await agent.depositCollateralsAndMakeAvailable(fullCollateral.vault, fullCollateral.pool);
            // mine some blocks to skip the agent creation time
            mockChain.mine(5);
            await context.updateUnderlyingBlock();
            // perform minting
            await minter.performMinting(agent.vaultAddress, 3);
            // transfer minted fassets
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(3));
            // perform redemption
            const [rrqs] = await redeemer.requestRedemption(3);
            await agent.performRedemptions(rrqs);
            // agent can exit now
            await agent.exitAndDestroy();
            // can still read status
            const info2 = await agent.getAgentInfo();
            assertWeb3Equal(info2.status, AgentStatus.DESTROYED);
            assertWeb3Equal(info2.publiclyAvailable, false);
            assertWeb3Equal(info2.mintedUBA, 0);
            assertWeb3Equal(info2.totalPoolCollateralNATWei, 0);
            assertWeb3Equal(info2.totalVaultCollateralWei, 0);
            // can withdraw from the vault (by owner)
            await context.usdc.transfer(agent.vaultAddress, 2e6, { from: agent.ownerWorkAddress });
            await expectRevert.custom(agent.agentVault.withdrawCollateral(context.usdc.address, 1e6, agent.ownerWorkAddress, { from: accounts[0] }), "OnlyOwner", []);
            await agent.agentVault.withdrawCollateral(context.usdc.address, 1e6, agent.ownerWorkAddress, { from: agent.ownerWorkAddress });
            await expectRevert.custom(agent.agentVault.transferExternalToken(context.usdc.address, 1e6, { from: accounts[0] }), "OnlyOwner", []);
            await agent.agentVault.transferExternalToken(context.usdc.address, 1e6, { from: agent.ownerWorkAddress });
            // cannot reuse vault by depositing collateral and entering
            await context.usdc.approve(agent.vaultAddress, 1e6, { from: agent.ownerWorkAddress });
            await expectRevert.custom(agent.agentVault.depositCollateral(context.usdc.address, 1e6, { from: agent.ownerWorkAddress }), "InvalidAgentVaultAddress", []);
            await expectRevert.custom(agent.makeAvailable(), "InvalidAgentVaultAddress", []);
            // cannot enter pool after destroy
            await expectRevert.custom(agent.collateralPool.enter({ from: accounts[0], value: ether(2) }), "InvalidAgentVaultAddress", []);
        });
    });
});
