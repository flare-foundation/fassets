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
import { EventArgs } from "../../../lib/utils/events/common";
import { requiredEventArgs } from "../../../lib/utils/events/truffle";
import { DAYS, deepFormat, MAX_BIPS, toBN, toWei } from "../../../lib/utils/helpers";
import { RedemptionRequested } from "../../../typechain-truffle/IIAssetManager";


contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests - redemption failures`, accounts => {
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

        it("mint and redeem f-assets - payment blocked after default", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            await agent.depositCollateralLotsAndMakeAvailable(10);
            // mine a block to skip the agent creation time
            mockChain.mine();
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const lotsUBA = context.convertLotsToUBA(lots);
            const [minted] = await minter.performMinting(agent.vaultAddress, lots);
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: minted.agentFeeUBA, mintedUBA: lotsUBA.add(minted.poolFeeUBA), reservedUBA: 0 });
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // start and default redemption
            const [redemptionRequests] = await redeemer.requestRedemption(lots);
            const request = redemptionRequests[0];
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            await redeemer.redemptionPaymentDefault(request);
            // now agent pays but they're blocked
            const tx1Hash = await agent.performRedemptionPayment(request, { status: TX_BLOCKED });
            // since payment was late, it is considered FAILED even though it is blocked
            const failed = await agent.confirmDefaultedRedemptionPayment(request, tx1Hash);
            assert.equal(failed.failureReason, "redemption payment too late");
        });

        it("mint and redeem f-assets - payment blocked but too small", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // make agent available
            await agent.depositCollateralLotsAndMakeAvailable(10);
            // mine a block to skip the agent creation time
            mockChain.mine();
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 3;
            const [minted] = await minter.performMinting(agent.vaultAddress, lots);
            // redeemer "buys" f-assets
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // perform redemption
            const [redemptionRequests] = await redeemer.requestRedemption(lots);
            const request = redemptionRequests[0];
            // agent performs a blocked payment that is also too small
            const tx1Hash = await agent.performPayment(request.paymentAddress, 100, request.paymentReference, { status: TX_BLOCKED });
            // since payment is too small, it is considered FAILED even though it is blocked
            const [failed] = await agent.confirmFailedRedemptionPayment(request, tx1Hash);
            assert.equal(failed.failureReason, "redemption payment too small");
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
            const rdFailed = await agent.confirmDefaultedRedemptionPayment(request, tx1Hash);
            assert.equal(rdFailed.failureReason, "redemption payment too late");
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

        // Setup for the tests below: the agent has just enough collateral to mint 10 lots, but the vault
        // collateral price then drops, so that a part of the redemption default has to be paid from the pool
        // even before the (blocked) vault payment is replaced by a pool payment.
        async function createSanctionedRedeemerWithLowVaultCR(vaultCRBIPS: number, poolProvider: string) {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1, { poolFeeShareBIPS: 0 });
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // add redeemer to usdc (vault collateral) sanction list, so that vault payments to it will fail
            await context.usdc.addToSanctionList(redeemer.address);
            // deposit minimum required collateral for agent, the rest of the pool collateral is added by a third party
            const requiredCollateral = await agent.requiredCollateralForLots(10);
            await agent.depositCollateralsAndMakeAvailable(requiredCollateral.vault, requiredCollateral.agentPoolTokens);
            const providerNatWei = requiredCollateral.pool.sub(requiredCollateral.agentPoolTokens);
            await agent.collateralPool.enter({ from: poolProvider, value: providerNatWei });
            // mint and transfer f-assets to the redeemer
            await minter.performMinting(agent.vaultAddress, 10);
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(10));
            // lower the vault collateral price, so that the agent's vault collateral cannot cover the whole
            // default payment and a part of it must be paid from the pool
            await agent.setVaultCollateralRatioByChangingVaultTokenPrice(vaultCRBIPS);
            return { agent, minter, redeemer, providerNatWei };
        }

        // Calculate the collaterals paid for the default of `request` and the agent's pool tokens that must
        // cover the payment when the vault payment is replaced by a pool payment.
        async function calculateSanctionedDefaultPayment(agent: Agent, request: EventArgs<RedemptionRequested>) {
            const mintingPoolHoldingsRequiredBIPS = toBN(context.settings.mintingPoolHoldingsRequiredBIPS);
            const ac = await agent.getAgentCollateral();
            const [paidVaultWei, paidPoolWei] = await agent.getRedemptionPaymentDefaultValueForUBA(request.valueUBA);
            // the vault payment fails, so it is replaced by an equivalent pool payment
            const vaultPartInPoolWei = paidVaultWei.mul(ac.pool.amgPrice.amgToTokenWei).div(ac.vault.amgPrice.amgToTokenWei);
            const combinedPoolWei = paidPoolWei.add(vaultPartInPoolWei);
            // conversions between pool collateral (NAT) and pool tokens
            const poolWeiToPoolTokens = (amount: BN) => amount.mul(ac.agentPoolTokens.amgPrice.amgToTokenWei).div(ac.pool.amgPrice.amgToTokenWei);
            const poolTokensToPoolWei = (amount: BN) => amount.mul(ac.pool.amgPrice.amgToTokenWei).div(ac.agentPoolTokens.amgPrice.amgToTokenWei);
            // the agent's pool tokens must cover the whole pool payment, otherwise the burning of the agent's
            // tokens won't compensate the pool for the paid out collateral and pool token value will drop
            const requiredTokensForPayment = poolWeiToPoolTokens(combinedPoolWei);
            // ... only covering the vault part of the payment is not enough
            const requiredTokensForVaultPartOnly = poolWeiToPoolTokens(vaultPartInPoolWei);
            // plus the agent must keep the pool token holdings required for the remaining backing
            const remainingBackedUBA = (await agent.getTotalBackedAssetUBA()).sub(toBN(request.valueUBA));
            const requiredTokensForRemainder = ac.agentPoolTokens.convertUBAToTokenWei(remainingBackedUBA)
                .mul(mintingPoolHoldingsRequiredBIPS).divn(MAX_BIPS);
            return {
                paidVaultWei, paidPoolWei, combinedPoolWei, poolTokensToPoolWei,
                agentPoolTokens: ac.agentPoolTokens.balance,
                requiredTokens: requiredTokensForRemainder.add(requiredTokensForPayment),
                requiredTokensCoveringVaultPartOnly: requiredTokensForRemainder.add(requiredTokensForVaultPartOnly),
                requiredTokensForPayment, requiredTokensForRemainder,
            };
        }

        it("sanctioned redemption - agent pool tokens must cover the whole replaced payment, not just the vault part", async () => {
            const poolProvider = accounts[15];
            const { agent, redeemer } = await createSanctionedRedeemerWithLowVaultCR(0.6 * MAX_BIPS, poolProvider);
            // redeem a part of the minted amount and let the redemption expire
            const [[request]] = await redeemer.requestRedemption(6);
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // the default payment is split between vault collateral and pool
            const payment = await calculateSanctionedDefaultPayment(agent, request);
            assert.isTrue(payment.paidPoolWei.gtn(0), "test misconfigured: no part of the default is paid from the pool");
            assert.isTrue(payment.requiredTokens.gt(payment.requiredTokensCoveringVaultPartOnly));
            // with the minimum pool token holdings, the default is not possible
            await expectRevert.custom(redeemer.redemptionPaymentDefault(request), "NotEnoughAgentPoolTokensToCoverFailedVaultPayment", []);
            // buying pool tokens that only cover the vault part of the payment must not be enough
            const insufficientTokens = payment.requiredTokensCoveringVaultPartOnly.sub(payment.agentPoolTokens);
            assert.isTrue(insufficientTokens.gtn(0), "test misconfigured: agent already holds enough pool tokens");
            await agent.buyCollateralPoolTokens(payment.poolTokensToPoolWei(insufficientTokens));
            await expectRevert.custom(redeemer.redemptionPaymentDefault(request), "NotEnoughAgentPoolTokensToCoverFailedVaultPayment", []);
            // pool tokens must cover the pool part of the payment, too
            const missingTokens = payment.requiredTokens.sub(payment.requiredTokensCoveringVaultPartOnly);
            await agent.buyCollateralPoolTokens(payment.poolTokensToPoolWei(missingTokens).sub(toWei(1)));
            await expectRevert.custom(redeemer.redemptionPaymentDefault(request), "NotEnoughAgentPoolTokensToCoverFailedVaultPayment", []);
            // once the whole payment is covered, the default succeeds
            await agent.buyCollateralPoolTokens(toWei(2));
            const poolCollateralBefore = await agent.collateralPool.totalCollateral();
            const poolTokenSupplyBefore = await agent.collateralPoolToken.totalSupply();
            const agentPoolTokensBefore = await agent.poolTokenBalance();
            const startPoolBalanceRedeemer = await context.wNat.balanceOf(redeemer.address);
            const res = await redeemer.redemptionPaymentDefault(request);
            // everything is paid from the pool
            assertWeb3Equal(res.redeemedVaultCollateralWei, 0);
            assertApproximatelyEqual(res.redeemedPoolCollateralWei, payment.combinedPoolWei, "relative", 1e-9);
            assertWeb3Equal((await context.wNat.balanceOf(redeemer.address)).sub(startPoolBalanceRedeemer), res.redeemedPoolCollateralWei);
            // the whole payment is covered by burning the agent's pool tokens...
            const agentPoolTokensAfter = await agent.poolTokenBalance();
            assertApproximatelyEqual(agentPoolTokensBefore.sub(agentPoolTokensAfter), payment.requiredTokensForPayment, "relative", 1e-9);
            // ... and the agent still holds the pool tokens required for the remaining backing
            assert.isTrue(agentPoolTokensAfter.gte(payment.requiredTokensForRemainder));
            // therefore the pool token value must not drop
            const poolCollateralAfter = await agent.collateralPool.totalCollateral();
            const poolTokenSupplyAfter = await agent.collateralPoolToken.totalSupply();
            const tokenPriceBefore = poolCollateralBefore.mul(toWei(1)).div(poolTokenSupplyBefore);
            const tokenPriceAfter = poolCollateralAfter.mul(toWei(1)).div(poolTokenSupplyAfter);
            assert.isTrue(tokenPriceAfter.gte(tokenPriceBefore), `pool token price dropped from ${tokenPriceBefore} to ${tokenPriceAfter}`);
            assertApproximatelyEqual(tokenPriceAfter, tokenPriceBefore, "relative", 1e-9, "pool token price changed");
        });

        it("sanctioned redemption - other pool token holders must not be at loss when vault payment is replaced by pool payment", async () => {
            const poolProvider = accounts[15];
            const { agent, redeemer, providerNatWei } = await createSanctionedRedeemerWithLowVaultCR(0.6 * MAX_BIPS, poolProvider);
            const providerPoolTokens = await agent.collateralPoolToken.balanceOf(poolProvider);
            // redeem everything and let the redemption expire
            const [[request]] = await redeemer.requestRedemption(10);
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            const payment = await calculateSanctionedDefaultPayment(agent, request);
            assert.isTrue(payment.paidPoolWei.gtn(0), "test misconfigured: no part of the default is paid from the pool");
            // pool tokens covering only the vault part of the payment must not be enough - if the default were
            // allowed here, the pool part would be paid at the expense of the other pool token holders
            await agent.buyCollateralPoolTokens(payment.poolTokensToPoolWei(payment.requiredTokensCoveringVaultPartOnly.sub(payment.agentPoolTokens)));
            await expectRevert.custom(redeemer.redemptionPaymentDefault(request), "NotEnoughAgentPoolTokensToCoverFailedVaultPayment", []);
            // the agent buys the remaining pool tokens, so that the whole (vault + pool) payment is covered
            await agent.buyCollateralPoolTokens(payment.poolTokensToPoolWei(payment.requiredTokens.sub(payment.requiredTokensCoveringVaultPartOnly)).add(toWei(1)));
            // the vault payment is blocked, so the redeemer is paid from the pool
            const res = await redeemer.redemptionPaymentDefault(request);
            assertWeb3Equal(res.redeemedVaultCollateralWei, 0);
            assertApproximatelyEqual(res.redeemedPoolCollateralWei, payment.combinedPoolWei, "relative", 1e-9);
            // the pool provider must be able to withdraw at least as much as was deposited
            await time.deterministicIncrease(await context.assetManager.getCollateralPoolTokenTimelockSeconds());
            const exit = requiredEventArgs(await agent.collateralPool.exit(providerPoolTokens, { from: poolProvider }), "CPExited");
            assert.isTrue(toBN(exit.receivedNatWei).gte(providerNatWei),
                `pool provider lost collateral: deposited ${providerNatWei}, received ${exit.receivedNatWei}`);
            assertApproximatelyEqual(exit.receivedNatWei, providerNatWei, "relative", 1e-9, "pool provider's collateral changed");
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

        it("redemption default can pull the agent out of liquidation (pool price liquidation)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await agent.depositCollateralLotsAndMakeAvailable(2);
            // mint
            const [minted] = await minter.performMinting(agent.vaultAddress, 2);
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(1));
            // change price and start liquidation
            await agent.setPoolCollateralRatioByChangingPoolTokenPrice(1.5 * MAX_BIPS);
            await context.assetManager.startLiquidation(agent.vaultAddress);
            await agent.checkAgentInfo({ status: AgentStatus.LIQUIDATION }, "reset");
            // start redemption
            const [[req]] = await redeemer.requestRedemption(1);
            await agent.checkAgentInfo({ status: AgentStatus.LIQUIDATION });
            // redemption default
            context.skipToExpiration(req.lastUnderlyingBlock, req.lastUnderlyingTimestamp);
            await redeemer.redemptionPaymentDefault(req);
            // agent should be out of liquidation now
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL });
        });

        it("redemption expiration can pull the agent out of liquidation (vault price liquidation)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await agent.depositCollateralLotsAndMakeAvailable(1);
            // mint
            const [minted] = await minter.performMinting(agent.vaultAddress, 1);
            await minter.transferFAsset(redeemer.address, context.convertLotsToUBA(1));
            // change price and start liquidation
            await agent.setVaultCollateralRatioByChangingVaultTokenPrice(1.15 * MAX_BIPS);
            await context.assetManager.startLiquidation(agent.vaultAddress);
            await agent.checkAgentInfo({ status: AgentStatus.LIQUIDATION }, "reset");
            // start redemption
            const [[req]] = await redeemer.requestRedemption(1);
            await agent.checkAgentInfo({ status: AgentStatus.LIQUIDATION });
            // redemption default
            context.skipToProofUnavailability(req.lastUnderlyingBlock, req.lastUnderlyingTimestamp);
            const res = await agent.finishRedemptionWithoutPayment(req);
            assert.isTrue(res != null); // default has happened in expiration
            // console.log(deepFormat(res));
            // agent should be out of liquidation now
            await agent.checkAgentInfo({ status: AgentStatus.NORMAL });
        });
    });
});
