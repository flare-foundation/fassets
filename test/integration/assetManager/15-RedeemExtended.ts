import { RedemptionRequestStatus } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { waitForTimelock } from "../../../lib/test-utils/fasset/CreateAssetManager";
import { expectEvent, expectRevert } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { EventArgs } from "../../../lib/utils/events/common";
import { filterEvents, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { BN_ZERO, toBN, toWei, ZERO_ADDRESS } from "../../../lib/utils/helpers";
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

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.xrp);
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
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
        return await agent.confirmXRPRedemptionPayment(txHash, request);
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
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
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
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with the correct destination tag and confirms
            const confirmRes = await performAndConfirmXRPRedemptionWithTag(agent, request);
            requiredEventArgs(confirmRes, 'RedemptionPerformed');
        });

        it("redeemWithTag works with non-whole-lot amounts", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            // redeem 1.5 lots — not a whole-lot amount
            const redeemAmountUBA = context.convertLotsToUBA(3).divn(2); // 1.5 lots
            const res = await context.assetManager.redeemWithTag(redeemAmountUBA, redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            assertWeb3Equal(request.valueUBA, redeemAmountUBA);
            assertWeb3Equal(request.destinationTag, destinationTag);
            // agent pays with the correct destination tag and confirms
            const confirmRes = await performAndConfirmXRPRedemptionWithTag(agent, request);
            requiredEventArgs(confirmRes, 'RedemptionPerformed');
            await agent.checkAgentInfo({
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA).sub(redeemAmountUBA)
            });
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
                context.convertLotsToUBA(3), redeemer.underlyingAddress, redeemerAddress2, destinationTag,
                { from: redeemer.address, value: String(executorFeeNatWei) }
            );
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            assertWeb3Equal(request.destinationTag, destinationTag);
            assertWeb3Equal(request.executor, redeemerAddress2);
            assertWeb3Equal(request.executorFeeNatWei, executorFeeNatWei);
        });

        it("redeemWithTag emits RedemptionAmountIncomplete when too many tickets", async () => {
            const N = 25;
            const MT = 20;  // maxRedeemedTickets from test settings
            const fullAgentCollateral = toWei(3e8);
            const agents: Agent[] = [];
            const underlyingAddress = (i: number) => `${underlyingAgent1}_vault_${i}`;
            for (let i = 0; i < N; i++) {
                const agent = await Agent.createTest(context, agentOwner1, underlyingAddress(i));
                await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
                agents.push(agent);
            }
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(N * 3));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // perform minting — 1 lot from each agent creates 25 separate tickets
            let totalMinted = BN_ZERO;
            for (const agent of agents) {
                await context.updateUnderlyingBlock();
                const crt = await minter.reserveCollateral(agent.vaultAddress, 1);
                const txHash = await minter.performMintingPayment(crt);
                const minted = await minter.executeMinting(crt, txHash);
                totalMinted = totalMinted.add(toBN(minted.mintedAmountUBA));
            }
            // redeemer gets all f-assets
            await context.fAsset.transfer(redeemer.address, totalMinted, { from: minter.address });
            // try to redeem all N lots via redeemWithTag — only MT tickets can be processed
            const destinationTag = 42;
            await context.updateUnderlyingBlock();
            const res = await context.assetManager.redeemWithTag(totalMinted, redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            // should have created MT redemption requests
            const requests = filterEvents(res, 'RedemptionWithTagRequested').map(e => e.args);
            assert.equal(requests.length, MT);
            // should emit RedemptionAmountIncomplete with remaining amount in UBA
            // note: each ticket redeems slightly more than 1 lot due to dust (pool fee)
            const redeemedUBA = requests.reduce((sum, r) => sum.add(toBN(r.valueUBA)), BN_ZERO);
            const incomplete = requiredEventArgs(res, 'RedemptionAmountIncomplete');
            assertWeb3Equal(incomplete.redeemer, redeemer.address);
            assertWeb3Equal(incomplete.remainingAmountUBA, totalMinted.sub(redeemedUBA));
            // must NOT emit the lots-based RedemptionRequestIncomplete event
            expectEvent.notEmitted(res, 'RedemptionRequestIncomplete');
        });
    });

    describe("Failed payment for redemption with tag", () => {
        it("agent pays without destination tag → payment fails with 'destination tag required but not present'", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 12345;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
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
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
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
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, 99,
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
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, 99,
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
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
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

    describe("Redemption default with tag (xrpRedemptionPaymentDefault)", () => {
        it("agent doesn't pay for redeemWithTag → xrpRedemptionPaymentDefault emits RedemptionDefault", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 12345;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // verify collateral before default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const startVaultCollateralBalance = await vaultCollateralToken.balanceOf(redeemer.address);
            const startPoolBalance = await context.wNat.balanceOf(redeemer.address);
            // skip to expiration and call default
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            const defaultEvent = await redeemer.xrpRedemptionPaymentDefault(request);
            assertWeb3Equal(defaultEvent.agentVault, agent.vaultAddress);
            assertWeb3Equal(defaultEvent.redeemer, redeemer.address);
            assertWeb3Equal(defaultEvent.requestId, request.requestId);
            // verify redeemer received collateral
            const endVaultCollateralBalance = await vaultCollateralToken.balanceOf(redeemer.address);
            const endPoolBalance = await context.wNat.balanceOf(redeemer.address);
            assertWeb3Equal(endVaultCollateralBalance.sub(startVaultCollateralBalance), defaultEvent.redeemedVaultCollateralWei);
            assertWeb3Equal(endPoolBalance.sub(startPoolBalance), defaultEvent.redeemedPoolCollateralWei);
        });

        it("xrpRedemptionPaymentDefault works for normal redemption (no tag)", async () => {
            await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            const [requests] = await redeemer.requestRedemption(3);
            const request = requests[0];
            // skip to expiration and call xrpRedemptionPaymentDefault with no tag
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                null,   // no destination tag
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            const defaultRes = await context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId,
                { from: redeemer.address });
            requiredEventArgs(defaultRes, 'RedemptionDefault');
        });

        it("cannot use regular redemptionPaymentDefault for redeemWithTag request", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // skip to expiration and try to call regular redemptionPaymentDefault
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            const proof = await context.attestationProvider.proveReferencedPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.redemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "DestinationTagNotSupported",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts when called too early (RedemptionDefaultTooEarly)", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 99;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // mine enough blocks so proof can be generated, but use shortened deadline
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment * 25; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber() - 1,
                request.lastUnderlyingTimestamp.toNumber() - context.chainInfo.blockTime
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "RedemptionDefaultTooEarly",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts for already-defaulted redemption (InvalidRedemptionStatus)", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // default once successfully
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            await redeemer.xrpRedemptionPaymentDefault(request);
            // try to default again — generate a new proof (chain has already advanced)
            const proof2 = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof2, request.requestId, { from: redeemer.address }),
                "InvalidRedemptionStatus",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts for already-confirmed redemption (InvalidRequestId)", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays and confirms successfully — request is finished and deleted
            await performAndConfirmXRPRedemptionWithTag(agent, request);
            // try to default after confirmation — use a different address so the mock prover
            // doesn't find the actual payment
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                "NonExistentAddress",
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "InvalidRequestId",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts with RedemptionNonPaymentMismatch for wrong payment reference", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // generate proof with a wrong payment reference
            const wrongReference = "0x" + "ab".repeat(32);
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                wrongReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "RedemptionNonPaymentMismatch",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts with RedemptionNonPaymentMismatch for wrong destination tag", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // generate proof with wrong destination tag
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                destinationTag + 1,
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "RedemptionNonPaymentMismatch",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts with RedemptionNonPaymentMismatch for wrong destination address", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // generate proof with a wrong destination address
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                "WrongAddress",
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "RedemptionNonPaymentMismatch",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts with RedemptionNonPaymentMismatch for wrong amount", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // generate proof with wrong amount (1 less than expected)
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA).subn(1),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "RedemptionNonPaymentMismatch",
                []
            );
        });

        it("xrpRedemptionPaymentDefault reverts with RedemptionNonPaymentProofWindowTooShort", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // generate proof with startBlock after request.firstUnderlyingBlock
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber() + 1,
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber()
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "RedemptionNonPaymentProofWindowTooShort",
                []
            );
        });
    });

    describe("proofOwner for XRP proofs", () => {
        it("confirmXRPRedemptionPayment succeeds when proofOwner matches sender", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with correct tag
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(
                request.paymentAddress, paymentAmount, request.paymentReference,
                { destinationTag: Number(request.destinationTag) }
            );
            // generate proof with proofOwner set to agent owner
            const proof = await context.attestationProvider.proveXRPPayment(txHash, agent.ownerWorkAddress);
            const confirmRes = await context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId,
                { from: agent.ownerWorkAddress });
            requiredEventArgs(confirmRes, 'RedemptionPerformed');
        });

        it("confirmXRPRedemptionPayment reverts with OnlyProofOwner when sender doesn't match", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // agent pays with correct tag
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(
                request.paymentAddress, paymentAmount, request.paymentReference,
                { destinationTag: Number(request.destinationTag) }
            );
            // generate proof with proofOwner set to a different address
            const proof = await context.attestationProvider.proveXRPPayment(txHash, redeemerAddress2);
            await expectRevert.custom(
                context.assetManager.confirmXRPRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress }),
                "OnlyProofOwner",
                []
            );
        });

        it("xrpRedemptionPaymentDefault succeeds when proofOwner matches sender", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // generate proof with proofOwner set to redeemer
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber(),
                redeemer.address
            );
            const defaultRes = await context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId,
                { from: redeemer.address });
            requiredEventArgs(defaultRes, 'RedemptionDefault');
        });

        it("xrpRedemptionPaymentDefault reverts with OnlyProofOwner when sender doesn't match", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const destinationTag = 42;
            const res = await context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            // generate proof with proofOwner set to a different address
            const proof = await context.attestationProvider.proveXRPPaymentNonexistence(
                request.paymentAddress,
                request.paymentReference,
                Number(request.destinationTag),
                request.valueUBA.sub(request.feeUBA),
                request.firstUnderlyingBlock.toNumber(),
                request.lastUnderlyingBlock.toNumber(),
                request.lastUnderlyingTimestamp.toNumber(),
                redeemerAddress2
            );
            await expectRevert.custom(
                context.assetManager.xrpRedemptionPaymentDefault(proof, request.requestId, { from: redeemer.address }),
                "OnlyProofOwner",
                []
            );
        });
    });

    describe("Minimum redeem with tag amount", () => {
        it("should set minimum redeem with tag amount UBA", async () => {
            const currentMinimum = await context.assetManager.minimumRedeemAmountUBA();
            const newMinimum = currentMinimum.muln(2);
            const res = await waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(newMinimum, { from: governance }), context.assetManager, governance);
            expectEvent(res, "SettingChanged", { name: "minimumRedeemAmountUBA", value: newMinimum });
            assertWeb3Equal(await context.assetManager.minimumRedeemAmountUBA(), newMinimum);
        });

        it("should set minimum redeem with tag amount UBA to zero", async () => {
            const res = await waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(0, { from: governance }), context.assetManager, governance);
            expectEvent(res, "SettingChanged", { name: "minimumRedeemAmountUBA", value: toBN(0) });
            assertWeb3Equal(await context.assetManager.minimumRedeemAmountUBA(), 0);
        });

        it("should revert setting minimum redeem with tag amount UBA when value too big", async () => {
            const tooBig = context.convertLotsToUBA(11);
            await expectRevert.custom(
                waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(tooBig, { from: governance }), context.assetManager, governance),
                "ValueTooBig", []);
        });

        it("should revert setting minimum redeem with tag amount UBA when increase too big", async () => {
            const currentMinimum = await context.assetManager.minimumRedeemAmountUBA();
            const tooBig = currentMinimum.muln(6);
            await expectRevert.custom(
                waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(tooBig, { from: governance }), context.assetManager, governance),
                "IncreaseTooBig", []);
        });

        it("should revert setting minimum redeem with tag amount UBA if not from governance", async () => {
            const currentMinimum = await context.assetManager.minimumRedeemAmountUBA();
            await expectRevert.custom(
                context.assetManager.setMinimumRedeemAmountUBA(currentMinimum, { from: redeemerAddress1 }),
                "OnlyGovernance", []);
        });

        it("redeemWithTag reverts with RedemptionTooSmall when amount is below minimum", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const minimumUBA = await context.assetManager.minimumRedeemAmountUBA();
            const tooSmall = minimumUBA.subn(1);
            await expectRevert.custom(
                context.assetManager.redeemWithTag(tooSmall, redeemer.underlyingAddress, ZERO_ADDRESS, 42,
                    { from: redeemer.address }),
                "RedemptionTooSmall",
                []
            );
        });

        it("redeemWithTag reverts with DestinationTagTooBig when tag >= 2**32", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const tagTooLarge = toBN(2).pow(toBN(32));  // exactly 2**32
            await expectRevert.custom(
                context.assetManager.redeemWithTag(context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, tagTooLarge,
                    { from: redeemer.address }),
                "DestinationTagTooBig",
                []
            );
        });

        it("ordinary redeem is not limited by minimumRedeemAmountUBA", async () => {
            const { minter } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            // increase minimum to 2 lots
            const twoLotsUBA = context.convertLotsToUBA(2);
            await waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(twoLotsUBA, { from: governance }), context.assetManager, governance);
            // redeem 1 lot should still succeed (ordinary redeem is not limited)
            const [requests] = await redeemer.requestRedemption(1);
            assert.equal(requests.length, 1);
        });

        it("redeemWithTag succeeds at exactly the minimum amount", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const minimumUBA = await context.assetManager.minimumRedeemAmountUBA();
            const res = await context.assetManager.redeemWithTag(minimumUBA, redeemer.underlyingAddress, ZERO_ADDRESS, 42,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            assertWeb3Equal(request.valueUBA, minimumUBA);
        });

        it("redeemWithTag respects updated minimum", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // increase minimum to 2 lots
            const twoLotsUBA = context.convertLotsToUBA(2);
            await waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(twoLotsUBA, { from: governance }), context.assetManager, governance);
            // try to redeem 1.5 lots — was above old minimum (1 lot) but below new minimum (2 lots)
            const oneAndHalfLotsUBA = context.convertLotsToUBA(3).divn(2);
            await expectRevert.custom(
                context.assetManager.redeemWithTag(oneAndHalfLotsUBA, redeemer.underlyingAddress, ZERO_ADDRESS, 42,
                    { from: redeemer.address }),
                "RedemptionTooSmall",
                []
            );
            // redeem 2 lots should succeed
            const res = await context.assetManager.redeemWithTag(twoLotsUBA, redeemer.underlyingAddress, ZERO_ADDRESS, 42,
                { from: redeemer.address });
            requiredEventArgs(res, 'RedemptionWithTagRequested');
        });
    });

    describe("redeemAmount (UBA-based redeem without tag)", () => {
        it("redeemAmount emits RedemptionRequested event (not RedemptionWithTagRequested)", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const redeemAmountUBA = context.convertLotsToUBA(2);
            const res = await context.assetManager.redeemAmount(redeemAmountUBA, redeemer.underlyingAddress, ZERO_ADDRESS,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            assertWeb3Equal(request.agentVault, agent.vaultAddress);
            assertWeb3Equal(request.redeemer, redeemer.address);
            assertWeb3Equal(request.valueUBA, redeemAmountUBA);
            // must NOT emit the tag-based event
            expectEvent.notEmitted(res, 'RedemptionWithTagRequested');
        });

        it("redeemAmount works with non-whole-lot amounts", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const redeemAmountUBA = context.convertLotsToUBA(3).divn(2); // 1.5 lots
            const res = await context.assetManager.redeemAmount(redeemAmountUBA, redeemer.underlyingAddress, ZERO_ADDRESS,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            assertWeb3Equal(request.valueUBA, redeemAmountUBA);
            // confirm with regular confirmRedemptionPayment (no tag)
            const paymentAmount = request.valueUBA.sub(request.feeUBA);
            const txHash = await agent.performPayment(request.paymentAddress, paymentAmount, request.paymentReference);
            const proof = await context.attestationProvider.provePayment(txHash, agent.underlyingAddress, request.paymentAddress);
            const confirmRes = await context.assetManager.confirmRedemptionPayment(proof, request.requestId,
                { from: agent.ownerWorkAddress });
            requiredEventArgs(confirmRes, 'RedemptionPerformed');
            await agent.checkAgentInfo({
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA).sub(redeemAmountUBA)
            });
        });

        it("redeemAmount emits RedemptionAmountIncomplete when too many tickets", async () => {
            const N = 25;
            const MT = 20;  // maxRedeemedTickets from test settings
            const fullAgentCollateral = toWei(3e8);
            const agents: Agent[] = [];
            const underlyingAddress = (i: number) => `${underlyingAgent1}_vault_${i}`;
            for (let i = 0; i < N; i++) {
                const agent = await Agent.createTest(context, agentOwner1, underlyingAddress(i));
                await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
                agents.push(agent);
            }
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(N * 3));
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            // perform minting — 1 lot from each agent creates 25 separate tickets
            let totalMinted = BN_ZERO;
            for (const agent of agents) {
                await context.updateUnderlyingBlock();
                const crt = await minter.reserveCollateral(agent.vaultAddress, 1);
                const txHash = await minter.performMintingPayment(crt);
                const minted = await minter.executeMinting(crt, txHash);
                totalMinted = totalMinted.add(toBN(minted.mintedAmountUBA));
            }
            // redeemer gets all f-assets
            await context.fAsset.transfer(redeemer.address, totalMinted, { from: minter.address });
            // try to redeem all N lots via redeemAmount — only MT tickets can be processed
            await context.updateUnderlyingBlock();
            const res = await context.assetManager.redeemAmount(totalMinted, redeemer.underlyingAddress, ZERO_ADDRESS,
                { from: redeemer.address });
            // should have created MT redemption requests (regular, not tag)
            const requests = filterEvents(res, 'RedemptionRequested').map(e => e.args);
            assert.equal(requests.length, MT);
            // should emit RedemptionAmountIncomplete with remaining amount in UBA
            const redeemedUBA = requests.reduce((sum, r) => sum.add(toBN(r.valueUBA)), BN_ZERO);
            const incomplete = requiredEventArgs(res, 'RedemptionAmountIncomplete');
            assertWeb3Equal(incomplete.redeemer, redeemer.address);
            assertWeb3Equal(incomplete.remainingAmountUBA, totalMinted.sub(redeemedUBA));
            // must NOT emit the lots-based RedemptionRequestIncomplete event
            expectEvent.notEmitted(res, 'RedemptionRequestIncomplete');
        });

        it("redeemAmount reverts if below minimumRedeemAmountUBA", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // increase minimum to 2 lots
            const twoLotsUBA = context.convertLotsToUBA(2);
            await waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(twoLotsUBA, { from: governance }), context.assetManager, governance);
            // redeemAmount with 1 lot should revert
            const oneLotUBA = context.convertLotsToUBA(1);
            await expectRevert(context.assetManager.redeemAmount(oneLotUBA, redeemer.underlyingAddress, ZERO_ADDRESS,
                { from: redeemer.address }), "RedemptionTooSmall");
        });

        it("redeemAmount succeeds at exactly minimumRedeemAmountUBA", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // increase minimum to 2 lots
            const twoLotsUBA = context.convertLotsToUBA(2);
            await waitForTimelock(context.assetManager.setMinimumRedeemAmountUBA(twoLotsUBA, { from: governance }), context.assetManager, governance);
            // redeemAmount with exactly 2 lots should succeed
            const res = await context.assetManager.redeemAmount(twoLotsUBA, redeemer.underlyingAddress, ZERO_ADDRESS,
                { from: redeemer.address });
            requiredEventArgs(res, 'RedemptionRequested');
        });

        it("redeemAmount works on non-XRP chain (no tag support needed)", async () => {
            const btcContext = await AssetContext.createTest(commonContext, testChainInfo.btc);
            const agent = await Agent.createTest(btcContext, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(btcContext, minterAddress1, underlyingMinter1, btcContext.convertLotsToUBA(9));
            await agent.depositCollateralLotsAndMakeAvailable(6);
            const [minted] = await minter.performMinting(agent.vaultAddress, 3);
            const redeemer = await Redeemer.create(btcContext, redeemerAddress1, underlyingRedeemer1);
            await btcContext.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const redeemAmountUBA = btcContext.convertLotsToUBA(3).divn(2); // 1.5 lots
            const res = await btcContext.assetManager.redeemAmount(redeemAmountUBA, redeemer.underlyingAddress, ZERO_ADDRESS,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            assertWeb3Equal(request.valueUBA, redeemAmountUBA);
        });
    });

    describe("redemptionRequestInfoExt", () => {
        it("should return correct extended info for redeemWithTag redemption", async () => {
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // redeem with tag
            const destinationTag = 42;
            const executorFee = toWei("0.01");
            const res = await context.assetManager.redeemWithTag(
                context.convertLotsToUBA(3), redeemer.underlyingAddress, redeemerAddress2, destinationTag,
                { from: redeemer.address, value: executorFee }
            );
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // get extended info
            const info = await context.assetManager.redemptionRequestInfoExt(request.requestId);
            // verify all fields
            assertWeb3Equal(info.redemptionRequestId, request.requestId);
            assertWeb3Equal(info.status, RedemptionRequestStatus.ACTIVE);
            assertWeb3Equal(info.agentVault, request.agentVault);
            assertWeb3Equal(info.redeemer, request.redeemer);
            assertWeb3Equal(info.paymentAddress, request.paymentAddress);
            assertWeb3Equal(info.paymentReference, request.paymentReference);
            assertWeb3Equal(info.valueUBA, request.valueUBA);
            assertWeb3Equal(info.feeUBA, request.feeUBA);
            assertWeb3Equal(info.firstUnderlyingBlock, request.firstUnderlyingBlock);
            assertWeb3Equal(info.lastUnderlyingBlock, request.lastUnderlyingBlock);
            assertWeb3Equal(info.lastUnderlyingTimestamp, request.lastUnderlyingTimestamp);
            assertWeb3Equal(info.executor, request.executor);
            assertWeb3Equal(info.executorFeeNatWei, request.executorFeeNatWei);
            assertWeb3Equal(info.poolSelfClose, false);
            assertWeb3Equal(info.transferToCoreVault, false);
            // extended fields
            assertWeb3Equal(info.requiresDestinationTag, true);
            assertWeb3Equal(info.destinationTag, destinationTag);
        });

        it("should return requiresDestinationTag=false for normal redemption", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // normal redeem (no tag)
            const [requests] = await redeemer.requestRedemption(3);
            const request = requests[0];
            // get extended info
            const info = await context.assetManager.redemptionRequestInfoExt(request.requestId);
            assertWeb3Equal(info.redemptionRequestId, request.requestId);
            assertWeb3Equal(info.status, RedemptionRequestStatus.ACTIVE);
            assertWeb3Equal(info.requiresDestinationTag, false);
            assertWeb3Equal(info.destinationTag, 0);
        });

        it("should reflect status changes after default", async () => {
            const { agent, minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            // redeem with tag
            const destinationTag = 99;
            const res = await context.assetManager.redeemWithTag(
                context.convertLotsToUBA(3), redeemer.underlyingAddress, ZERO_ADDRESS, destinationTag,
                { from: redeemer.address }
            );
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            // initially active
            const info1 = await context.assetManager.redemptionRequestInfoExt(request.requestId);
            assertWeb3Equal(info1.status, RedemptionRequestStatus.ACTIVE);
            // default (must use xrpRedemptionPaymentDefault for tagged redemptions)
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            await redeemer.xrpRedemptionPaymentDefault(request);
            // should be defaulted
            const info2 = await context.assetManager.redemptionRequestInfoExt(request.requestId);
            assertWeb3Equal(info2.status, RedemptionRequestStatus.DEFAULTED_UNCONFIRMED);
            // extended fields remain correct
            assertWeb3Equal(info2.requiresDestinationTag, true);
            assertWeb3Equal(info2.destinationTag, destinationTag);
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
                btcContext.assetManager.redeemWithTag(context.convertLotsToUBA(3), underlyingRedeemer1, ZERO_ADDRESS, 42, { from: redeemerAddress1 }),
                "RedeemWithTagNotSupported",
                []
            );
        });
    });
});
