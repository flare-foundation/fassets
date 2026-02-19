import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { expectEvent, expectRevert } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { EventArgs } from "../../../lib/utils/events/common";
import { requiredEventArgs } from "../../../lib/utils/events/truffle";
import { ZERO_ADDRESS } from "../../../lib/utils/helpers";
import { RedemptionWithTagRequested } from "../../../typechain-truffle/IIAssetManager";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests`, accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const minterAddress1 = accounts[30];
    const redeemerAddress1 = accounts[40];
    const redeemerAddress2 = accounts[41];
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

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.xrp);
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
        mockChain = context.chain as MockChain;
    });

    // Helper: set up an agent with collateral and mint fAssets to the minter.
    async function setupAgentAndMint(lots: number) {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(lots * 3));
        await agent.depositCollateralLotsAndMakeAvailable(lots * 2);
        const [minted] = await minter.performMinting(agent.vaultAddress, lots);
        return { agent, minter, minted };
    }

    // Helper: agent performs the XRP payment with the required destination tag and confirms it.
    async function performAndConfirmXRPRedemptionWithTag(agent: Agent, request: EventArgs<RedemptionWithTagRequested>) {
        const paymentAmount = request.valueUBA.sub(request.feeUBA);
        const txHash = await agent.performPayment(
            request.paymentAddress,
            paymentAmount,
            request.paymentReference,
            { destinationTag: Number(request.destinationTag) }
        );
        const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
        return await context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress });
    }

    describe("Successful redemption with tag", () => {
        it("redeemWithTagSupported returns true for XRP chain", async () => {
            assert.isTrue(await context.assetManager.redeemWithTagSupported());
        });

        it("redeemWithTag emits RedemptionWithTagRequested event (not RedemptionRequested) with correct fields", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(3, redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            assertWeb3Equal(request.agentVault, agent.vaultAddress);
            assertWeb3Equal(request.redeemer, redeemer.address);
            assertWeb3Equal(request.paymentAddress, redeemer.underlyingAddress);
            assertWeb3Equal(request.destinationTag, destinationTag);
            assertWeb3Equal(request.executor, ZERO_ADDRESS);
            // must NOT emit the regular RedemptionRequested event
            expectEvent.notEmitted(res, 'RedemptionRequested');
        });

        it("agent pays with correct destination tag and confirms with XRP proof → RedemptionPerformed", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 12345;
            const res = await context.assetManager.redeemWithTag(3, redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with the correct destination tag and confirms
            const confirmRes = await performAndConfirmXRPRedemptionWithTag(agent, request);
            requiredEventArgs(confirmRes, 'RedemptionPerformed');
        });

        it("normal redeem (no tag) can be confirmed with confirmXRPRedemptionPayment", async () => {
            const { agent, minter } = await setupAgentAndMint(3);
            // minter IS the redeemer (same address), no fAsset transfer needed
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            const [requests] = await redeemer.requestRedemption(3);
            const request = requests[0];
            // agent pays without any destination tag
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(request.paymentAddress, paymentAmount, request.paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const confirmRes = await context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId,
                { from: agent.ownerWorkAddress });
            requiredEventArgs(confirmRes, 'RedemptionPerformed');
        });

        it("redeemWithTag with executor: executor fee is included in request event", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 77;
            const executorFeeNatWei = 1e9; // 1 gwei (contract stores fee in gwei units)
            const res = await context.assetManager.redeemWithTag(
                3, redeemer.underlyingAddress, redeemerAddress2, destinationTag,
                { from: redeemer.address, value: String(executorFeeNatWei) }
            );
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            assertWeb3Equal(request.destinationTag, destinationTag);
            assertWeb3Equal(request.executor, redeemerAddress2);
            assertWeb3Equal(request.executorFeeNatWei, executorFeeNatWei);
        });
    });

    describe("Failed payment for redemption with tag", () => {
        it("agent pays without destination tag → payment fails with 'destination tag required but not present'", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 12345;
            const res = await context.assetManager.redeemWithTag(3, redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays without any destination tag
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(request.paymentAddress, paymentAmount, request.paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const confirmRes = await context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId,
                { from: agent.ownerWorkAddress });
            const paymentFailed = requiredEventArgs(confirmRes, 'RedemptionPaymentFailed');
            assert.include(paymentFailed.failureReason, "destination tag required but not present");
            requiredEventArgs(confirmRes, 'RedemptionDefault');
        });

        it("agent pays with wrong destination tag → payment fails with 'incorrect destination tag'", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 12345;
            const res = await context.assetManager.redeemWithTag(3, redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with a different destination tag
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(
                request.paymentAddress, paymentAmount, request.paymentReference,
                { destinationTag: destinationTag + 1 }
            );
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const confirmRes = await context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId,
                { from: agent.ownerWorkAddress });
            const paymentFailed = requiredEventArgs(confirmRes, 'RedemptionPaymentFailed');
            assert.include(paymentFailed.failureReason, "incorrect destination tag");
            requiredEventArgs(confirmRes, 'RedemptionDefault');
        });

        it("confirmXRPRedemptionPayment reverts when agent pays with no memo data (no payment reference)", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const res = await context.assetManager.redeemWithTag(3, redeemer.underlyingAddress, ZERO_ADDRESS, 99,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with the correct destination tag but omits the payment reference (no memo)
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(
                request.paymentAddress, paymentAmount, null,   // null reference → hasMemoData = false
                { destinationTag: Number(request.destinationTag) }
            );
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(
                context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress }),
                "InvalidRedemptionReference",
                []
            );
        });

        it("confirmXRPRedemptionPayment reverts when agent pays with memo data that is not 32 bytes long", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const res = await context.assetManager.redeemWithTag(3, redeemer.underlyingAddress, ZERO_ADDRESS, 99,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with correct destination tag but a short (2-byte) memo instead of 32-byte payment reference
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(
                request.paymentAddress, paymentAmount, "0xdead",   // 2-byte memo → hasMemoData = true but length ≠ 32
                { destinationTag: Number(request.destinationTag) }
            );
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(
                context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress }),
                "InvalidRedemptionReference",
                []
            );
        });

        it("cannot confirm redeemWithTag request using confirmRedemptionPayment → reverts DestinationTagNotSupported", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(3, redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with correct tag
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(
                request.paymentAddress, paymentAmount, request.paymentReference,
                { destinationTag }
            );
            // try to confirm with the regular confirmRedemptionPayment (Payment proof, not XRPPayment)
            const proof = await context.attestationProvider.provePayment(txHash, agent.underlyingAddress, request.paymentAddress);
            await expectRevert.custom(
                context.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress }),
                "DestinationTagNotSupported",
                []
            );
        });
    });

    describe("Chain compatibility for redeemWithTag", () => {
        it("redeemWithTagSupported returns false for non-XRP chain", async () => {
            const btcContext = await AssetContext.createTest(commonContext, testChainInfo.btc);
            assert.isFalse(await btcContext.assetManager.redeemWithTagSupported());
        });

        it("redeemWithTag reverts with RedeemWithTagNotSupported on non-XRP chain", async () => {
            const btcContext = await AssetContext.createTest(commonContext, testChainInfo.btc);
            await expectRevert.custom(
                btcContext.assetManager.redeemWithTag(3, underlyingRedeemer1, ZERO_ADDRESS, 42, { from: redeemerAddress1 }),
                "RedeemWithTagNotSupported",
                []
            );
        });
    });
});
