import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { MockCoreVaultBot } from "../../../lib/test-utils/actors/MockCoreVaultBot";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain, MockChainWallet } from "../../../lib/test-utils/fasset/MockChain";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { assignMintingTagManager, assignSmartAccountManagerMock } from "../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { requiredEventArgsFrom } from "../../../lib/test-utils/Web3EventDecoder";
import { TX_FAILED } from "../../../lib/underlying-chain/interfaces/IBlockChain";
import { EventArgs } from "../../../lib/utils/events/common";
import { ContractWithEvents, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { HOURS, MAX_BIPS, requireNotNull, toBN } from "../../../lib/utils/helpers";
import { CoreVaultManagerInstance, MintingTagManagerInstance, SmartAccountManagerMockInstance } from "../../../typechain-truffle";
import { DirectMintingExecutedToSmartAccount } from "../../../typechain-truffle/DirectMintingFacet";
import { DirectMintingExecuted } from "../../../typechain-truffle/IIAssetManager";
import { MintedToSmartAccount } from "../../../typechain-truffle/SmartAccountManagerMock";

export type SmartAccountManagerMockEvents = import('../../../typechain-truffle/SmartAccountManagerMock').AllEvents;

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests`, accounts => {
    const governance = accounts[10];
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const agentOwner3 = accounts[22];
    const minterAddress1 = accounts[30];
    const minterAddress2 = accounts[31];
    const minterAddress3 = accounts[32];
    const executorAddress1 = accounts[35];
    const executorAddress2 = accounts[36];
    const redeemerAddress1 = accounts[40];
    const redeemerAddress2 = accounts[41];
    const redeemerAddress3 = accounts[42];
    const challengerAddress1 = accounts[50];
    const challengerAddress2 = accounts[51];
    const liquidatorAddress1 = accounts[60];
    const liquidatorAddress2 = accounts[61];
    const triggeringAccount = accounts[5];
    const tagManagerFeeReceiver = accounts[11];
    const mintingFeeReceiver = accounts[12];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingAgent2 = "Agent2";
    const underlyingAgent3 = "Agent3";
    const underlyingMinter1 = "Minter1";
    const underlyingMinter2 = "Minter2";
    const underlyingMinter3 = "Minter3";
    const underlyingRedeemer1 = "Redeemer1";
    const underlyingRedeemer2 = "Redeemer2";
    const underlyingRedeemer3 = "Redeemer3";
    const coreVaultUnderlyingAddress = "CORE_VAULT_UNDERLYING";
    const coreVaultCustodianAddress = "CORE_VAULT_CUSTODIAN";

    let commonContext: CommonContext;
    let context: AssetContext;
    let mockChain: MockChain;
    let coreVaultManager: CoreVaultManagerInstance;
    let mintingTagManager: MintingTagManagerInstance;
    let smartAccountManager: ContractWithEvents<SmartAccountManagerMockInstance, SmartAccountManagerMockEvents>;
    let coreVaultBot: MockCoreVaultBot;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.xrp, {
            testSettings: {
                directMintingFeeReceiver: mintingFeeReceiver,
            }
        });
        // enable core vault
        await context.assignCoreVaultManager({
            underlyingAddress: coreVaultUnderlyingAddress,
            custodianAddress: coreVaultCustodianAddress,
            triggeringAccounts: [triggeringAccount],
        });
        // enable direct minting
        mintingTagManager = await assignMintingTagManager(context.assetManager, { fee: toBN(100), feeReceiver: tagManagerFeeReceiver });
        smartAccountManager = await assignSmartAccountManagerMock(context.assetManager);
        //
        return { commonContext, context, mintingTagManager, smartAccountManager };
    }

    async function verifyDirectMintingToSmartAccounts(
        mintingExecuted: EventArgs<DirectMintingExecutedToSmartAccount>, smartAccontReceived: EventArgs<MintedToSmartAccount>,
        txHash: string, memoData: string | null, minterUnderlyingAddress: string, executorAddress: string, totalMintingAmount: BN
    ) {
        // check that asset manager emitted correct event
        const { expectedMintingFee } = await calculateMintingFees(totalMintingAmount);
        assertWeb3Equal(mintingExecuted.transactionId, txHash);
        assertWeb3Equal(mintingExecuted.sourceAddress, minterUnderlyingAddress);
        assertWeb3Equal(mintingExecuted.executor, executorAddress);
        assertWeb3Equal(mintingExecuted.mintedAmountUBA, totalMintingAmount.sub(expectedMintingFee));
        assertWeb3Equal(mintingExecuted.mintingFeeUBA, expectedMintingFee);
        assertWeb3Equal(mintingExecuted.memoData, memoData);
        // check that smart account manager received the minted amount with correct parameters
        assertWeb3Equal(smartAccontReceived.transactionId, txHash);
        assertWeb3Equal(smartAccontReceived.sourceAddress, minterUnderlyingAddress);
        assertWeb3Equal(smartAccontReceived.amount, totalMintingAmount.sub(mintingExecuted.mintingFeeUBA));
        assertWeb3Equal(smartAccontReceived.underlyingTimestamp, await getTransactionTimestamp(txHash));
        assertWeb3Equal(smartAccontReceived.memoData, memoData);
    }

    beforeEach(async () => {
        ({ commonContext, context, mintingTagManager, smartAccountManager } = await loadFixtureCopyVars(initialize));
        mockChain = context.chain as MockChain;
        coreVaultBot = new MockCoreVaultBot(context, triggeringAccount);
        coreVaultManager = requireNotNull(context.coreVaultManager);
    });

    async function calculateMintingFees(totalMintingAmount: BN) {
        const feeBIPS = await context.assetManager.getDirectMintingFeeBIPS();
        const minimumFeeUBA = await context.assetManager.getDirectMintingMinimumFeeUBA();
        // calculate expected fees
        const totalFeeUBA = totalMintingAmount.mul(toBN(feeBIPS)).divn(MAX_BIPS);
        const expectedMintingFee = totalFeeUBA.gte(minimumFeeUBA) ? totalFeeUBA : minimumFeeUBA;
        const expectedExecutorFee = await context.assetManager.getDirectMintingExecutorFeeUBA();
        return { expectedMintingFee, expectedExecutorFee };
    }

    async function verifyDirectMintingResult(mintingExecuted: EventArgs<DirectMintingExecuted>, minterAddress: string, executorAddress: string, totalMintingAmount: BN) {
        const { expectedMintingFee, expectedExecutorFee } = await calculateMintingFees(totalMintingAmount);
        assertWeb3Equal(mintingExecuted.targetAddress, minterAddress);
        assertWeb3Equal(mintingExecuted.executor, executorAddress);
        assertWeb3Equal(mintingExecuted.mintedAmountUBA, totalMintingAmount.sub(expectedMintingFee).sub(expectedExecutorFee));
        assertWeb3Equal(mintingExecuted.mintingFeeUBA, expectedMintingFee);
        assertWeb3Equal(mintingExecuted.executorFeeUBA, expectedExecutorFee);
    }

    async function getTransactionTimestamp(txHash: string) {
        const txBlockId = await mockChain.getTransactionBlock(txHash);
        const txBlock = await mockChain.getBlockAt(txBlockId!.number);
        return txBlock!.timestamp;
    }

    describe("Direct minting by payment reference or tag", () => {
        it("direct mint (with payment reference) and check fees", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            const { expectedMintingFee, expectedExecutorFee } = await calculateMintingFees(totalMintingAmount);
            // mint some fAssets
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecuted');
            assertWeb3Equal(mintingExecuted.mintedAmountUBA, totalMintingAmount.sub(expectedMintingFee).sub(expectedExecutorFee));
            assertWeb3Equal(mintingExecuted.mintingFeeUBA, expectedMintingFee);
            assertWeb3Equal(mintingExecuted.executorFeeUBA, expectedExecutorFee);
            // check fee receiver got the fee
            const finalFeeReceiverBalance = toBN(await context.fAsset.balanceOf(mintingFeeReceiver));
            assertWeb3Equal(finalFeeReceiverBalance, expectedMintingFee);
            // check executor got the fee
            const finalExecutorBalance = toBN(await context.fAsset.balanceOf(executorAddress1));
            assertWeb3Equal(finalExecutorBalance, expectedExecutorFee);
            // check the minter received amount minus fees
            const finalMinterBalance = toBN(await context.fAsset.balanceOf(minter.address));
            assertWeb3Equal(finalMinterBalance, mintingExecuted.mintedAmountUBA);
        });

        it("direct mint and then redeem through agent", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            // add agent collateral and allow return from core vault - we don't need available agents
            await agent.depositCollateralLots(100);
            await coreVaultManager.addAllowedDestinationAddresses([agent.underlyingAddress], { from: governance });
            await minter.donateToCoreVault(1e6);
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // mint some fAssets
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            // transfer everything to the minter so they can redeem through agent
            const finalFeeReceiverBalance = toBN(await context.fAsset.balanceOf(mintingFeeReceiver));
            await context.fAsset.transfer(minter.address, finalFeeReceiverBalance, { from: mintingFeeReceiver });
            const finalExecutorBalance = toBN(await context.fAsset.balanceOf(executorAddress1));
            await context.fAsset.transfer(minter.address, finalExecutorBalance, { from: executorAddress1 });
            const finalMinterBalance = toBN(await context.fAsset.balanceOf(minter.address));
            assertWeb3Equal(finalMinterBalance, totalMintingAmount);
            // agent must request underlying from core vault
            await agent.requestReturnFromCoreVault(3);
            const cvBotHandled = await coreVaultBot.triggerAndPerformActions();
            await agent.confirmReturnFromCoreVault(cvBotHandled.payments[0].txHash);
            // now the minter can redeem everything
            const startMinterUnderlying = await mockChain.getBalance(minter.underlyingAddress);
            const [rdrqs] = await redeemer.requestRedemption(3);
            await agent.performRedemptions(rdrqs);
            assertWeb3Equal(await context.chain.getBalance(underlyingMinter1),
                startMinterUnderlying.add(rdrqs[0].valueUBA).sub(rdrqs[0].feeUBA));
        });

        it("direct mint by reserving tag and setting recipient", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // reserve minting tag and set recipient
            const tagPrice = await mintingTagManager.reservationFee();
            const tagRes = await mintingTagManager.reserve({ from: minter.address, value: tagPrice });
            const tagId = requiredEventArgs(tagRes, 'MintingTagReserved').tag;
            await mintingTagManager.setMintingRecipient(tagId, minter.address, { from: minter.address });
            // mint some fAssets
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, null, { destinationTag: Number(tagId) });
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecuted');
            await verifyDirectMintingResult(mintingExecuted, minter.address, executorAddress1, totalMintingAmount);
            // check the minter received amount minus fees
            const finalMinterBalance = toBN(await context.fAsset.balanceOf(minter.address));
            assertWeb3Equal(finalMinterBalance, mintingExecuted.mintedAmountUBA);
        });
    });

    describe("Restrictions on allowed executors for direct minting", () => {
        it("set the executor in tag manager and it should be the only one allowed for minting", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // reserve minting tag and set recipient
            const tagPrice = await mintingTagManager.reservationFee();
            const tagRes = await mintingTagManager.reserve({ from: minter.address, value: tagPrice });
            const tagId = requiredEventArgs(tagRes, 'MintingTagReserved').tag;
            await mintingTagManager.setMintingRecipient(tagId, minter.address, { from: minter.address });
            // set allowed executor for the tag and wait for it to be active
            const resEx = await mintingTagManager.setAllowedExecutor(tagId, executorAddress1, { from: minter.address });
            const argsEx = requiredEventArgs(resEx, "AllowedExecutorChangePending");
            await time.increaseTo(argsEx.activeAfterTs);
            // try to execute direct minting with different executor - should fail
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, paymentReference, { destinationTag: Number(tagId) });
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress2 }), "InvalidExecutor", []);
            // execute with correct executor should succeed
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecuted');
            await verifyDirectMintingResult(mintingExecuted, minter.address, executorAddress1, totalMintingAmount);
        });

        it("set the allowed executor in memo data and it should be the only one allowed for minting", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // mint some fAssets with executor specified in memo
            const memoData = PaymentReference.directMintingEx(minter.address, executorAddress1);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, memoData);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            // try to execute direct minting with different executor - should fail
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress2 }), "InvalidExecutor", []);
            // execute with correct executor should succeed
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecuted');
            await verifyDirectMintingResult(mintingExecuted, minter.address, executorAddress1, totalMintingAmount);
        });

        it("proof requester can set the allowed executor in proof request and it should be the only one allowed to present proof", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // mint some fAssets with executor specified in memo
            const memoData = PaymentReference.directMintingEx(minter.address, executorAddress1);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, memoData);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, executorAddress1);
            // try to execute direct minting with different executor - should fail
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress2 }), "InvalidExecutor", []);
            // execute with correct executor should succeed
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecuted');
            await verifyDirectMintingResult(mintingExecuted, minter.address, executorAddress1, totalMintingAmount);
        });
    });

    describe("Invalid direct minting attempts", () => {
        it("should fail minting if payment is to invalid address", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            // mint some fAssets with executor specified in memo
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(underlyingMinter2, context.convertLotsToUBA(3), paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "InvalidReceivingAddress", []);
        });

        it("should fail minting if payment is failed", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            // mint with zero amount
            const paymentReference = PaymentReference.directMinting(minter.address);
            const wallet = new MockChainWallet(mockChain);
            const txHash = await wallet.addTransaction(minter.underlyingAddress, coreVaultUnderlyingAddress, context.convertLotsToUBA(3), paymentReference, { status: TX_FAILED });
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "PaymentFailed", []);
        });

        it("should fail minting if payment is zero", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            // mint with zero amount
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, 0, paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "AmountNotPositive", []);
        });

        it("should fail minting if tag manager or smart account manager aren't set", async () => {
            // deploy new asset manager without setting tag manager and smart account manager
            const context = await AssetContext.createTest(commonContext, testChainInfo.xrp);
            await context.assignCoreVaultManager({
                underlyingAddress: coreVaultUnderlyingAddress,
                custodianAddress: coreVaultCustodianAddress,
                triggeringAccounts: [triggeringAccount],
            });
            // mint some fAssets
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, context.convertLotsToUBA(3), paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            // revert without tag manager
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "MissingMintingTagManager", []);
            // add tag manager but not smart account manager
            await assignMintingTagManager(context.assetManager, { fee: toBN(100), feeReceiver: tagManagerFeeReceiver });
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "MissingSmartAccountManager", []);
        });

        it("should fail minting with tag when payment has core vault donation tag", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            // mint some fAssets with core vault donation tag
            const coreVaultDonationTag = Number(context.initSettings.coreVaultDonationTag);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, context.convertLotsToUBA(3), null, { destinationTag: coreVaultDonationTag });
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "PaymentIsCoreVaultDonation", []);
        });

        it("should fail minting with payment reference that corresponds to redemption", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            // mint some fAssets with core vault donation tag
            const paymentReference = PaymentReference.redemption(33);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, context.convertLotsToUBA(3), paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "ForbiddenPaymentReference", []);
        });
    });

    describe("Direct minting to smart accounts", () => {
        it("should send minting to smart account manager if memo data is not recognized", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // mint some fAssets with unrecognized memo data
            const memoData = "0x12345678"; // not a valid payment reference
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, memoData);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecutedToSmartAccount');
            const smartAccontReceived = requiredEventArgsFrom(res, smartAccountManager, 'MintedToSmartAccount');
            await verifyDirectMintingToSmartAccounts(mintingExecuted, smartAccontReceived, txHash, memoData, minter.underlyingAddress, executorAddress1, totalMintingAmount);
        });

        it("should send minting to smart account manager if there is no memo data or tag", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // mint some fAssets with unrecognized memo data
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, null);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecutedToSmartAccount');
            const smartAccontReceived = requiredEventArgsFrom(res, smartAccountManager, 'MintedToSmartAccount');
            await verifyDirectMintingToSmartAccounts(mintingExecuted, smartAccontReceived, txHash, null, minter.underlyingAddress, executorAddress1, totalMintingAmount);
        });

        it("should send minting to smart account manager if the tag is invalid", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            //
            const totalMintingAmount = context.convertLotsToUBA(3);
            // mint some fAssets with unrecognized memo data
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, null, { destinationTag: 9999 });
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecutedToSmartAccount');
            const smartAccontReceived = requiredEventArgsFrom(res, smartAccountManager, 'MintedToSmartAccount');
            await verifyDirectMintingToSmartAccounts(mintingExecuted, smartAccontReceived, txHash, null, minter.underlyingAddress, executorAddress1, totalMintingAmount);
        });
    });

    describe("Edge cases for direct minting fees", () => {
        it("minter and executor get nothing if fee is smaller than minimum minting fee", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const totalMintingAmount = toBN(context.initSettings.directMintingMinimumFeeUBA).subn(1); // set amount just below minimum fee
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            expectEvent.notEmitted(res, 'DirectMintingExecutedToSmartAccount');
            expectEvent(res, 'DirectMintingPaymentTooSmallForFee', {
                transactionId: txHash,
                receivedAmount: totalMintingAmount,
                mintingFeeUBA: context.initSettings.directMintingMinimumFeeUBA,
            });
            assertWeb3Equal(await context.fAsset.balanceOf(minter.address), 0);
            assertWeb3Equal(await context.fAsset.balanceOf(executorAddress1), 0);
        });

        it("smart account manager does not get called when fee is smaller than minimum minting fee", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const totalMintingAmount = toBN(context.initSettings.directMintingMinimumFeeUBA).subn(1); // set amount just below minimum fee
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, null);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            expectEvent.notEmitted(res, 'DirectMintingExecutedToSmartAccount');
            expectEvent(res, 'DirectMintingPaymentTooSmallForFee', {
                transactionId: txHash,
                receivedAmount: totalMintingAmount,
                mintingFeeUBA: context.initSettings.directMintingMinimumFeeUBA,
            });
            assertWeb3Equal(await context.fAsset.balanceOf(executorAddress1), 0);
        });

        it("smart account manager should be called when fee equal to minimum minting fee", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
            const totalMintingAmount = toBN(context.initSettings.directMintingMinimumFeeUBA); // set amount just below minimum fee
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, totalMintingAmount, null);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            expectEvent.notEmitted(res, 'DirectMintingPaymentTooSmallForFee');
            await verifyDirectMintingToSmartAccounts(
                requiredEventArgs(res, 'DirectMintingExecutedToSmartAccount'),
                requiredEventArgsFrom(res, smartAccountManager, 'MintedToSmartAccount'),
                txHash, null, minter.underlyingAddress, executorAddress1, totalMintingAmount
            );
            assertWeb3Equal(await context.fAsset.balanceOf(executorAddress1), 0);   // executor still gets 0
        });
    });
});
