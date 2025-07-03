import { AgentStatus, RedemptionRequestStatus } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { assertApproximatelyEqual } from "../../../lib/test-utils/approximation";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { TX_BLOCKED, TX_FAILED } from "../../../lib/underlying-chain/interfaces/IBlockChain";
import { requiredEventArgs } from "../../../lib/utils/events/truffle";
import { DAYS, MAX_BIPS, toBN, toWei } from "../../../lib/utils/helpers";


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

    describe("simple scenarios - redemption failures", () => {
        it("mint and redeem f-assets - payment blocked", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mine a block to skip the agent creation time
            mockChain.mine();
            // update block
            const blockNumber = await context.updateUnderlyingBlock();
            const currentUnderlyingBlock = await context.assetManager.currentUnderlyingBlock();
            assertWeb3Equal(currentUnderlyingBlock[0], blockNumber);
            assertWeb3Equal(currentUnderlyingBlock[1], (await context.chain.getBlockAt(blockNumber))?.timestamp);
            // perform minting
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const lotsUBA = context.convertLotsToUBA(lots);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: 0,
                mintedUBA: 0,
                reservedUBA: lotsUBA.add(agent.poolFeeShare(crt.feeUBA))
            });
            const burnAddress = (await context.assetManager.getSettings()).burnAddress;
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            const minted = await minter.executeMinting(crt, txHash);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            assertWeb3Equal(minted.mintedAmountUBA, lotsUBA);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: lotsUBA.add(minted.poolFeeUBA), reservedUBA: 0 });
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: lotsUBA });
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            const tx1Hash = await agent.performRedemptionPayment(request, { status: TX_BLOCKED });
            await agent.confirmBlockedRedemptionPayment(request, tx1Hash);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.valueUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0 });
            // redemption request info should show BLOCKED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.BLOCKED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint and redeem defaults (agent) - no underlying payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            assertWeb3Equal(minted.mintedAmountUBA, crt.valueUBA);
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            await context.updateUnderlyingBlock();
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA
            });
            // test rewarding for redemption payment default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            const res = await agent.redemptionPaymentDefault(request);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(res.redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.valueUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            const redDef = await agent.finishRedemptionWithoutPayment(request);
            assert.isUndefined(redDef);
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            assertWeb3Equal(res.redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral);
            assertWeb3Equal(res.redeemedPoolCollateralWei, redemptionDefaultValuePool);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), res.redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), res.redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), res.redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), res.redeemedPoolCollateralWei);
            // redemption request info should show DEFAULTED_UNCONFIRMED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_UNCONFIRMED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(res.redeemedVaultCollateralWei));
        });

        it("mint and redeem defaults (agent) - no underlying payment, vault CR too low, pool must pay extra", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(3e9);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            assertWeb3Equal(minted.mintedAmountUBA, crt.valueUBA);
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            await context.updateUnderlyingBlock();
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA
            });
            // test rewarding for redemption payment default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            await agent.setVaultCollateralRatioByChangingAssetPrice(10000);
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            const res = await agent.redemptionPaymentDefault(request);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(res.redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.valueUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            const redDef = await agent.finishRedemptionWithoutPayment(request);
            assert.isUndefined(redDef);
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            assertApproximatelyEqual(res.redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral, 'relative', 1e-8);
            assertApproximatelyEqual(res.redeemedPoolCollateralWei, redemptionDefaultValuePool, 'relative', 1e-8);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), res.redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), res.redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), res.redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), res.redeemedPoolCollateralWei);
            // redemption request info should show DEFAULTED_UNCONFIRMED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_UNCONFIRMED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(res.redeemedVaultCollateralWei));
        });

        it("mint and redeem defaults (redeemer) - failed underlying payment (failed transaction)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA });
            // perform some (failed) payment with correct redemption reference
            const tx1Hash = await agent.performRedemptionPayment(request, { status: TX_FAILED, gasLimit: 10, gasPrice: 10 });
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            const res = await agent.confirmFailedRedemptionPayment(request, tx1Hash);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling finishRedemptionWithoutPayment after failed redemption payment will revert
            await expectRevert.custom(agent.finishRedemptionWithoutPayment(request), "InvalidRequestId", []);
            // test rewarding for redemption payment default
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(res[1].redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.valueUBA).subn(100), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            //
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            assertWeb3Equal(res[0].failureReason, "transaction failed");
            assertWeb3Equal(res[1].redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), res[1].redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), res[1].redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), res[1].redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), res[1].redeemedPoolCollateralWei);
            assertWeb3Equal(res[1].redeemedPoolCollateralWei, redemptionDefaultValuePool);
            // redemption request info should show DEFAULTED_FAILED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_FAILED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(res[1].redeemedVaultCollateralWei));
        });

        it("mint and redeem defaults (redeemer) - failed underlying payment (not redeemer's address)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA });
            // perform some (failed) payment with correct redemption reference
            const tx1Hash = await agent.performPayment(minter.underlyingAddress, request.valueUBA, request.paymentReference);
            const proof = await context.attestationProvider.provePayment(tx1Hash, agent.underlyingAddress, minter.underlyingAddress);
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            const res = await context.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress })
            const resFailed = requiredEventArgs(res, 'RedemptionPaymentFailed');
            const resDefault = requiredEventArgs(res, 'RedemptionDefault');
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling finishRedemptionWithoutPayment after failed redemption payment will revert
            await expectRevert.custom(agent.finishRedemptionWithoutPayment(request), "InvalidRequestId", []);
            // test rewarding for redemption payment default
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(resDefault.redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            assertWeb3Equal(resFailed.failureReason, "not redeemer's address");
            assertWeb3Equal(resDefault.redeemedPoolCollateralWei, redemptionDefaultValuePool);
            assertWeb3Equal(resDefault.redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), resDefault.redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), resDefault.redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), resDefault.redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), resDefault.redeemedPoolCollateralWei);
            // redemption request info should show DEFAULTED_FAILED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_FAILED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(resDefault.redeemedVaultCollateralWei));
        });

        it("mint and redeem defaults (redeemer) - failed underlying payment (redemption payment too small)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA
            });
            // perform some (failed) payment with correct redemption reference
            const tx1Hash = await agent.performPayment(request.paymentAddress, 100, request.paymentReference);
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            const res = await agent.confirmFailedRedemptionPayment(request, tx1Hash);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling finishRedemptionWithoutPayment after failed redemption payment will revert
            await expectRevert.custom(agent.finishRedemptionWithoutPayment(request), "InvalidRequestId", []);
            // test rewarding for redemption payment default
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(res[1].redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.valueUBA).subn(100), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            assertWeb3Equal(res[0].failureReason, "redemption payment too small");
            assertWeb3Equal(res[1].redeemedPoolCollateralWei, redemptionDefaultValuePool);
            assertWeb3Equal(res[1].redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), res[1].redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), res[1].redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), res[1].redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), res[1].redeemedPoolCollateralWei);
            // redemption request info should show DEFAULTED_FAILED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_FAILED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(res[1].redeemedVaultCollateralWei));
        });

        it("redemption - wrong underlying payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA
            });
            // perform some (failed) payment with correct redemption reference
            const tx1Hash = await agent.wallet.addTransaction(minter.underlyingAddress, request.paymentAddress, 1, request.paymentReference);
            const proof = await context.attestationProvider.provePayment(tx1Hash, minter.underlyingAddress, request.paymentAddress);
            await expectRevert.custom(context.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress }), "SourceNotAgentsUnderlyingAddress", []);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling finishRedemptionWithoutPayment after failed redemption payment will revert
            await expectRevert.custom(agent.finishRedemptionWithoutPayment(request), "ShouldDefaultFirst", []);
            // test rewarding for redemption payment default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            const res = await redeemer.redemptionPaymentDefault(request);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(res.redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.valueUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            assertWeb3Equal(res.redeemedPoolCollateralWei, redemptionDefaultValuePool);
            assertWeb3Equal(res.redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), res.redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), res.redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), res.redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), res.redeemedPoolCollateralWei);
            const redDef = await agent.finishRedemptionWithoutPayment(request);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(res.redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(crt.valueUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            assert.isUndefined(redDef);
            // redemption request info should show DEFAULTED_UNCONFIRMED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_UNCONFIRMED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(res.redeemedVaultCollateralWei));
        });

        it("redemption - no underlying payment (default not needed after a day)", async () => {
            mockFlareDataConnectorClient.queryWindowSeconds = 300;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA
            });
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling finishRedemptionWithoutPayment after no redemption payment will revert if called too soon
            await expectRevert.custom(agent.finishRedemptionWithoutPayment(request), "ShouldDefaultFirst", []);
            await time.deterministicIncrease(DAYS);
            context.skipToProofUnavailability(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // test rewarding for redemption payment default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            const redDef = await agent.finishRedemptionWithoutPayment(request);
            assert.isDefined(redDef);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(redDef.redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.valueUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            assertWeb3Equal(redDef.requestId, request.requestId);
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            assertWeb3Equal(redDef.redeemedPoolCollateralWei, redemptionDefaultValuePool);
            assertWeb3Equal(redDef.redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), redDef.redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), redDef.redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), redDef.redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), redDef.redeemedPoolCollateralWei);
            // finishRedemptionWithoutPayment has effect equal to default - cannot default again
            await expectRevert.custom(agent.redemptionPaymentDefault(request), "InvalidRedemptionStatus", []);
            // finishRedemptionWithoutPayment again is a no-op
            const redDef2 = await agent.finishRedemptionWithoutPayment(request);
            assert.isUndefined(redDef2);
            // redemption request info should show DEFAULTED_UNCONFIRMED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_UNCONFIRMED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(redDef.redeemedVaultCollateralWei));
        });

        it("redemption - too late underlying payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
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
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            await context.updateUnderlyingBlock();
            const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
            assertWeb3Equal(remainingLots, 0);
            assert.equal(dustChanges.length, 0);
            assert.equal(redemptionRequests.length, 1);
            const request = redemptionRequests[0];
            assert.equal(request.agentVault, agent.vaultAddress);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // test rewarding for redemption payment default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const startVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const startPoolBalanceAgent = await agent.poolCollateralBalance();
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: minted.poolFeeUBA, reservedUBA: 0, redeemingUBA: request.valueUBA });
            const res = await redeemer.redemptionPaymentDefault(request);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral.sub(res.redeemedVaultCollateralWei), freeUnderlyingBalanceUBA: request.valueUBA.add(minted.agentFeeUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0 });
            const endVaultCollateralBalanceRedeemer = await vaultCollateralToken.balanceOf(redeemer.address);
            const endVaultCollateralBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const endPoolBalanceAgent = await agent.poolCollateralBalance();
            const [redemptionDefaultValueVaultCollateral, redemptionDefaultValuePool] = await agent.getRedemptionPaymentDefaultValue(lots);
            assertWeb3Equal(res.redeemedPoolCollateralWei, redemptionDefaultValuePool);
            assertWeb3Equal(res.redeemedVaultCollateralWei, redemptionDefaultValueVaultCollateral);
            assertWeb3Equal(endVaultCollateralBalanceRedeemer.sub(startVaultCollateralBalanceRedeemer), res.redeemedVaultCollateralWei);
            assertWeb3Equal(startVaultCollateralBalanceAgent.sub(endVaultCollateralBalanceAgent), res.redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalanceRedeemer.sub(startPoolBalanceRedeemer), res.redeemedPoolCollateralWei);
            assertWeb3Equal(startPoolBalanceAgent.sub(endPoolBalanceAgent), res.redeemedPoolCollateralWei);
            // perform too late redemption payment
            const tx1Hash = await agent.performRedemptionPayment(request);
            const tx = await agent.confirmDefaultedRedemptionPayment(request, tx1Hash);
            assert.equal(requiredEventArgs(tx, "RedemptionPaymentFailed").failureReason, "redemption payment too late");
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(res.redeemedVaultCollateralWei),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(request.feeUBA), mintedUBA: minted.poolFeeUBA, redeemingUBA: 0
            });
            // check that calling finishRedemptionWithoutPayment after confirming redemption payment will revert
            await expectRevert.custom(agent.finishRedemptionWithoutPayment(request), "InvalidRequestId", []);
            // redemption request info should show DEFAULTED_FAILED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_FAILED);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(res.redeemedVaultCollateralWei));
        });

        it("redeemer that is on stablecoin sanction list should be paid from pool in case of default", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1, { poolFeeShareBIPS: 0 });
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            //
            const redemptionDefaultFactorVaultBIPS = toBN(context.settings.redemptionDefaultFactorVaultCollateralBIPS);
            const mintingPoolHoldingsRequiredBIPS = toBN(context.settings.mintingPoolHoldingsRequiredBIPS);
            // add redeemer to usdc sanction list
            await context.usdc.addToSanctionList(redeemer.address);
            // deposit minimum required collateral for agent
            const requiredCollateral = await agent.requiredCollateralForLots(10);
            await agent.depositCollateralsAndMakeAvailable(requiredCollateral.vault, requiredCollateral.agentPoolTokens);
            const poolProvider = accounts[15];
            await agent.collateralPool.enter({ from: poolProvider, value: requiredCollateral.pool.sub(requiredCollateral.agentPoolTokens) });
            // mint
            await minter.performMinting(agent.vaultAddress, 10);
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(10));
            //
            const [[request]] = await redeemer.requestRedemption(10);
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // the default should fail because vault collateral cannot be paid to redeemer and there are not enough agent pool tokens to cover pool payment
            await expectRevert.custom(redeemer.redemptionPaymentDefault(request), "NotEnoughAgentPoolTokensToCoverFailedVaultPayment", []);
            // buy extra pool tokens
            const ac = await agent.getAgentCollateral();
            const poolEquivWei = ac.pool.convertUBAToTokenWei(toBN(request.valueUBA));
            const requiredExtraPoolTokensShareBIPS = redemptionDefaultFactorVaultBIPS.sub(mintingPoolHoldingsRequiredBIPS);
            const requiredExtraPoolTokens = poolEquivWei.mul(requiredExtraPoolTokensShareBIPS).divn(MAX_BIPS);
            await agent.buyCollateralPoolTokens(requiredExtraPoolTokens);
            // now the payment should succeed
            const res = await redeemer.redemptionPaymentDefault(request);
            assertApproximatelyEqual(res.redeemedPoolCollateralWei, poolEquivWei.mul(redemptionDefaultFactorVaultBIPS).divn(MAX_BIPS), "absolute", 10);
            assertWeb3Equal(res.redeemedVaultCollateralWei, 0);
            // redemption request info should show DEFAULTED_UNCONFIRMED state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(request.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.DEFAULTED_UNCONFIRMED);
        });

        it("test sanctioned redemption payment pool token requirements checks", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1, { poolFeeShareBIPS: 0 });
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // add redeemer to usdc sanction list
            await context.usdc.addToSanctionList(redeemer.address);
            // deposit minimum required collateral for agent
            const requiredCollateral = await agent.requiredCollateralForLots(10);
            await agent.depositCollateralsAndMakeAvailable(requiredCollateral.vault, requiredCollateral.agentPoolTokens);
            const poolProvider = accounts[15];
            await agent.collateralPool.enter({ from: poolProvider, value: requiredCollateral.pool.sub(requiredCollateral.agentPoolTokens) });
            // mint
            await minter.performMinting(agent.vaultAddress, 10);
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(10));
            //
            const redemptionDefaultFactorVaultBIPS = toBN(context.settings.redemptionDefaultFactorVaultCollateralBIPS);
            const mintingPoolHoldingsRequiredBIPS = toBN(context.settings.mintingPoolHoldingsRequiredBIPS);
            //
            async function redeemAndDefaultSanctioned(lots: number) {
                const [[request]] = await redeemer.requestRedemption(lots);
                context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
                // the default should fail because vault collateral cannot be paid to redeemer and there are not enough agent pool tokens to cover pool payment
                await expectRevert.custom(redeemer.redemptionPaymentDefault(request), "NotEnoughAgentPoolTokensToCoverFailedVaultPayment", []);
                // agent pool tokens must cover vault share of payment
                const ac = await agent.getAgentCollateral();
                const poolEquivWei = ac.pool.convertUBAToTokenWei(toBN(request.valueUBA));
                // console.log("POOL EQ", deepFormat(poolEquivWei.div(toWei(1))));
                // console.log("C1 EQ", deepFormat(poolEquivWei.mul(redemptionDefaultFactorVaultBIPS).divn(MAX_BIPS).div(toWei(1))));
                // console.log("AC", deepFormat(ac.pool.amgPrice.amgToTokenWei), deepFormat(ac.agentPoolTokens.amgPrice.amgToTokenWei));
                const backedAmountUBA = toBN(ac.agentInfo.reservedUBA).add(toBN(ac.agentInfo.mintedUBA)).add(toBN(ac.agentInfo.redeemingUBA));
                const backedAmountInPoolTokens = ac.agentPoolTokens.convertUBAToTokenWei(backedAmountUBA);
                const currentAgentPoolTokenHoldingBIPS = ac.agentPoolTokens.balance.muln(MAX_BIPS).div(backedAmountInPoolTokens);
                // console.log("currentAgentPoolTokenHoldingBIPS", deepFormat(currentAgentPoolTokenHoldingBIPS));
                const requiredExtraPoolTokensShareBIPS = redemptionDefaultFactorVaultBIPS.sub(mintingPoolHoldingsRequiredBIPS);
                let requiredExtraPoolTokens = poolEquivWei.mul(requiredExtraPoolTokensShareBIPS).divn(MAX_BIPS);
                if (currentAgentPoolTokenHoldingBIPS.lt(mintingPoolHoldingsRequiredBIPS)) {
                    requiredExtraPoolTokens = requiredExtraPoolTokens.add(backedAmountInPoolTokens.mul(mintingPoolHoldingsRequiredBIPS.sub(currentAgentPoolTokenHoldingBIPS)).divn(MAX_BIPS));
                }
                await agent.buyCollateralPoolTokens(requiredExtraPoolTokens.sub(toWei(1)));
                await expectRevert.custom(redeemer.redemptionPaymentDefault(request), "NotEnoughAgentPoolTokensToCoverFailedVaultPayment", []);
                // once enough is added, the payment default should succeed
                await agent.buyCollateralPoolTokens(toWei(1));
                const res = await redeemer.redemptionPaymentDefault(request);
                assertApproximatelyEqual(res.redeemedPoolCollateralWei, poolEquivWei.mul(redemptionDefaultFactorVaultBIPS).divn(MAX_BIPS), "absolute", 10);
                assertWeb3Equal(res.redeemedVaultCollateralWei, 0);
                // pool token price should not change due to agent's token burning
                const ac2 = await agent.getAgentCollateral();
                assertWeb3Equal(ac2.agentPoolTokens.amgPrice.amgToTokenWei, ac.agentPoolTokens.amgPrice.amgToTokenWei);
            }
            // First redeem and default - price ratio pool_token:NAT is still 1.
            await redeemAndDefaultSanctioned(5);
            // Second redeem and default - price ratio pool_token:NAT is still 1 because agent pool tokens were burned.
            // However, agent's pool token holdings will be lower, because of 10% pool participation which is also charged to the agent.
            await redeemAndDefaultSanctioned(3);
        });

        it("redemption - must not select agent's address as receiver in payment proof", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await agent.depositCollateralLotsAndMakeAvailable(1);
            // mint and start redemption
            const [minted] = await minter.performMinting(agent.vaultAddress, 1);
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(1));
            const [[req]] = await redeemer.requestRedemption(1);
            // pay as on utxo chain - required amount to redeemer, the rest back to self
            const txHash = await agent.wallet.addMultiTransaction(
                { [agent.underlyingAddress]: req.valueUBA },
                {
                    [req.paymentAddress]: req.valueUBA.sub(req.feeUBA),
                    [agent.underlyingAddress]: req.feeUBA
                },
                req.paymentReference
            );
            // try to prove with agent's underlying address as receiver
            const proof1 = await context.attestationProvider.provePayment(txHash, agent.underlyingAddress, agent.underlyingAddress);
            await expectRevert.custom(context.assetManager.confirmRedemptionPayment(proof1, req.requestId, { from: agent.ownerWorkAddress }),
                "InvalidReceivingAddressSelected", []);
            // proving with redeemer's address works
            const proof2 = await context.attestationProvider.provePayment(txHash, agent.underlyingAddress, redeemer.underlyingAddress);
            const res = await context.assetManager.confirmRedemptionPayment(proof2, req.requestId, { from: agent.ownerWorkAddress });
            expectEvent(res, "RedemptionPerformed", { requestId: req.requestId });
            // redemption request info should show SUCCESSFUL state
            const redeemInfo = await context.assetManager.redemptionRequestInfo(req.requestId);
            assertWeb3Equal(redeemInfo.status, RedemptionRequestStatus.SUCCESSFUL);
            // agent should be ok
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL, redeemingUBA: 0, freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(req.feeUBA) }, 'reset');
        });
    });
});
