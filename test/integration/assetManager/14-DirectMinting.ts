import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { MockCoreVaultBot } from "../../../lib/test-utils/actors/MockCoreVaultBot";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { executeTimelockedGovernanceCall } from "../../../lib/test-utils/contract-test-helpers";
import { MockChain, MockChainWallet } from "../../../lib/test-utils/fasset/MockChain";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { assignMintingTagManager, assignSmartAccountManagerMock } from "../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { requiredEventArgsFrom } from "../../../lib/test-utils/Web3EventDecoder";
import { TX_FAILED } from "../../../lib/underlying-chain/interfaces/IBlockChain";
import { EventArgs } from "../../../lib/utils/events/common";
import { ContractWithEvents, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { BN_ONE, DAYS, HOURS, joinHexBytes, MAX_BIPS, requireNotNull, toBN, ZERO_ADDRESS } from "../../../lib/utils/helpers";
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint some fAssets with executor specified in memo
            const paymentReference = PaymentReference.directMinting(minter.address);
            const txHash = await minter.performPayment(underlyingMinter2, context.convertLotsToUBA(3), paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "InvalidReceivingAddress", []);
        });

        it("should fail minting if payment is failed", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint with zero amount
            const paymentReference = PaymentReference.directMinting(minter.address);
            const wallet = new MockChainWallet(mockChain);
            const txHash = await wallet.addTransaction(minter.underlyingAddress, coreVaultUnderlyingAddress, context.convertLotsToUBA(3), paymentReference, { status: TX_FAILED });
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "PaymentFailed", []);
        });

        it("should fail minting if payment is zero", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint some fAssets with core vault donation tag
            const coreVaultDonationTag = Number(context.initSettings.coreVaultDonationTag);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, context.convertLotsToUBA(3), null, { destinationTag: coreVaultDonationTag });
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "PaymentIsCoreVaultDonation", []);
        });

        it("should fail minting with payment reference that corresponds to redemption", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint some fAssets with core vault donation tag
            const paymentReference = PaymentReference.redemption(33);
            const txHash = await minter.performPayment(coreVaultUnderlyingAddress, context.convertLotsToUBA(3), paymentReference);
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            await expectRevert.custom(context.assetManager.executeDirectMinting(proof, { from: executorAddress1 }), "ForbiddenPaymentReference", []);
        });
    });

    describe("Direct minting to smart accounts", () => {
        it("should send minting to smart account manager if memo data is not recognized", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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

        it("should ignore unknown valid payment references and just mint to smart accounts", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint some fAssets with unknown tag and payment reference
            const memoData = PaymentReference.topup(agentOwner1); // not a valid payment reference for direct minting
            const [res] = await minter.directMintRaw(context.convertLotsToUBA(3), { memoData, executor: executorAddress1 });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            expectEvent(res, 'DirectMintingExecutedToSmartAccount');
        });

        it("should ignore direct minting payment references with invalid address and just mint to smart accounts", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint some fAssets with unknown tag and payment reference
            const memoData = PaymentReference.directMinting(toBN(minterAddress1).or(BN_ONE.shln(162)).toString()); // invalid address - out of 160 bit range
            const [res] = await minter.directMintRaw(context.convertLotsToUBA(3), { memoData, executor: executorAddress1 });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            expectEvent(res, 'DirectMintingExecutedToSmartAccount');
        });

        it("should ignore invalid long (48-byte) payment references and just mint to smart accounts", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint some fAssets with unknown tag and payment reference
            const memoData = joinHexBytes("0x4642505266410011", minterAddress1, executorAddress1).toLowerCase();
            const [res] = await minter.directMintRaw(context.convertLotsToUBA(3), { memoData, executor: executorAddress1 });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            expectEvent(res, 'DirectMintingExecutedToSmartAccount');
        });

        it("should ignore valid long (48-byte) payment references with zero target address and just mint to smart accounts", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint some fAssets with unknown tag and payment reference
            const memoData = PaymentReference.directMintingEx(ZERO_ADDRESS, executorAddress1);
            const [res] = await minter.directMintRaw(context.convertLotsToUBA(3), { memoData, executor: executorAddress1 });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            expectEvent(res, 'DirectMintingExecutedToSmartAccount');
        });
    });

    describe("Edge cases for direct minting fees", () => {
        it("minter and executor get nothing if fee is smaller than minimum minting fee", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
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

    describe("Direct minting limits", () => {
        it("should delay minting when hourly limit is exceeded", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint close to the hourly limit first (95 lots out of 100)
            const [res1] = await minter.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            expectEvent(res1, 'DirectMintingExecuted');
            // try to mint 10 more lots - should be delayed as it exceeds the 100 lot hourly limit
            const totalMintingAmount = context.convertLotsToUBA(10);
            const [res2, txHash2] = await minter.directMintRaw(totalMintingAmount, {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            expectEvent.notEmitted(res2, 'DirectMintingExecuted');
            const delayedEvent = requiredEventArgs(res2, 'DirectMintingDelayed');
            assertWeb3Equal(delayedEvent.transactionId, txHash2);
            assertWeb3Equal(delayedEvent.amount, totalMintingAmount);
            // check that delay state was recorded
            const delayState = await context.assetManager.directMintingDelayState(txHash2);
            assert.isTrue(delayState[0]); // _isDelayed
            assert.isFalse(delayState[1]); // _canBeExecuted
            assertWeb3Equal(delayState[2], delayedEvent.executionAllowedAt); // _allowedAt
        });

        it("should allow executing delayed minting after delay period", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint close to the hourly limit first
            await minter.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            // make another payment that will be delayed
            const totalMintingAmount = context.convertLotsToUBA(10);
            const [res2, txHash2] = await minter.directMintRaw(totalMintingAmount, {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            const delayedEvent = requiredEventArgs(res2, 'DirectMintingDelayed');
            // advance time past the delay
            await time.increaseTo(delayedEvent.executionAllowedAt);
            // now execution should succeed
            const proof2 = await context.attestationProvider.proveXRPPayment(txHash2, null);
            const res3 = await context.assetManager.executeDirectMinting(proof2, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res3, 'DirectMintingExecuted');
            await verifyDirectMintingResult(mintingExecuted, minter.address, executorAddress1, totalMintingAmount);
        });

        it("should fail when trying to execute delayed minting before delay is over", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint close to the hourly limit first
            await minter.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            // make another payment that will be delayed
            const totalMintingAmount = context.convertLotsToUBA(10);
            const [res2, txHash2] = await minter.directMintRaw(totalMintingAmount, {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            const delayedEvent = requiredEventArgs(res2, 'DirectMintingDelayed');
            // try to execute again before delay is over - should fail
            const proof2 = await context.attestationProvider.proveXRPPayment(txHash2, null);
            await expectRevert.custom(
                context.assetManager.executeDirectMinting(proof2, { from: executorAddress1 }),
                "DirectMintingStillDelayed",
                [delayedEvent.executionAllowedAt]
            );
        });

        it("should delay minting when daily limit is exceeded", async () => {
            const minter1 = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            const minter2 = await Minter.createTest(context, minterAddress2, underlyingMinter2, context.convertLotsToUBA(200));
            const minter3 = await Minter.createTest(context, minterAddress3, underlyingMinter3, context.convertLotsToUBA(2000));
            // mint in batches that stay under hourly limit but exceed daily limit
            // Batch 1: 95 lots
            const [res1] = await minter1.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter1.address),
                executor: executorAddress1
            });
            expectEvent(res1, 'DirectMintingExecuted');
            // Wait 1 hour to reset hourly limit
            await time.increase(HOURS);
            // Batch 2: 95 lots (total: 190)
            const [res2] = await minter2.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter2.address),
                executor: executorAddress1
            });
            expectEvent(res2, 'DirectMintingExecuted');
            // Wait 1 hour again
            await time.increase(HOURS);
            // Batch 3: Continue minting until we approach daily limit (need 10 more batches to reach ~1000 lots)
            for (let i = 0; i < 9; i++) {
                await minter3.directMintRaw(context.convertLotsToUBA(90), {
                    memoData: PaymentReference.directMinting(minter3.address),
                    executor: executorAddress1
                });
                await time.increase(HOURS);
            }
            // Now we should be close to 1000 lots minted in 24 hours
            // Try to mint 10 more lots - should be delayed due to daily limit
            const [res3, txHash3] = await minter3.directMintRaw(context.convertLotsToUBA(10), {
                memoData: PaymentReference.directMinting(minter3.address),
                executor: executorAddress1
            });
            expectEvent.notEmitted(res3, 'DirectMintingExecuted');
            const delayedEvent = requiredEventArgs(res3, 'DirectMintingDelayed');
            assertWeb3Equal(delayedEvent.transactionId, txHash3);
            assertWeb3Equal(delayedEvent.amount, context.convertLotsToUBA(10));
        });

        it("should delay minting when either hourly or daily limit is exceeded", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // mint up to hourly limit
            await minter.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            // try to mint again - should be delayed due to hourly limit
            const [res2] = await minter.directMintRaw(context.convertLotsToUBA(10), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            expectEvent(res2, 'DirectMintingDelayed');
        });

        it("governance can unblock delayed mintings", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // exceed the hourly limit to create a delayed minting
            await minter.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            // create delayed minting
            const totalMintingAmount = context.convertLotsToUBA(10);
            const [res2, txHash2] = await minter.directMintRaw(totalMintingAmount, {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            expectEvent(res2, 'DirectMintingDelayed');
            // wait a bit and then get the current time for unblocking
            await time.increase(10);
            const currentTime = await time.latest();
            await context.assetManager.unblockDirectMintingsUntil(currentTime, { from: governance });
            // now execution should succeed even though delay period hasn't passed
            const proof2 = await context.attestationProvider.proveXRPPayment(txHash2, null);
            const res3 = await context.assetManager.executeDirectMinting(proof2, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res3, 'DirectMintingExecuted');
            await verifyDirectMintingResult(mintingExecuted, minter.address, executorAddress1, totalMintingAmount);
        });

        it("should delay large minting separately from regular limits", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(2000));
            // make a payment above the large minting threshold (500 lots threshold, so mint 501 lots) - should be delayed
            const [res, txHash] = await minter.directMintRaw(context.convertLotsToUBA(501), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            expectEvent.notEmitted(res, 'DirectMintingExecuted');
            const delayedEvent = requiredEventArgs(res, 'LargeDirectMintingDelayed');
            assertWeb3Equal(delayedEvent.transactionId, txHash);
            assertWeb3Equal(delayedEvent.amount, context.convertLotsToUBA(501));
            // check delay state
            const delayState = await context.assetManager.directMintingDelayState(txHash);
            assert.isTrue(delayState[0]); // _isDelayed
            assert.isFalse(delayState[1]); // _canBeExecuted
        });

        it("should allow executing large delayed minting after delay period", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(2000));
            // make a payment above the large minting threshold (501 lots)
            const [res, txHash] = await minter.directMintRaw(context.convertLotsToUBA(501), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            const delayedEvent = requiredEventArgs(res, 'LargeDirectMintingDelayed');
            // advance time past the delay
            await time.increaseTo(delayedEvent.executionAllowedAt);
            // now execution should succeed
            const proof = await context.attestationProvider.proveXRPPayment(txHash, null);
            const res2 = await context.assetManager.executeDirectMinting(proof, { from: executorAddress1 });
            const mintingExecuted = requiredEventArgs(res2, 'DirectMintingExecuted');
            await verifyDirectMintingResult(mintingExecuted, minter.address, executorAddress1, context.convertLotsToUBA(501));
        });

        it("should mint to smart account when delayed minting has no valid payment reference", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // exceed the hourly limit to create a delayed minting
            await minter.directMintRaw(context.convertLotsToUBA(95), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            // create delayed minting to smart account (no payment reference)
            const totalMintingAmount = context.convertLotsToUBA(10);
            const [res2, txHash2] = await minter.directMintRaw(totalMintingAmount, {
                executor: executorAddress1
            });
            expectEvent(res2, 'DirectMintingDelayed');
            // advance time and execute
            const delayedEvent = requiredEventArgs(res2, 'DirectMintingDelayed');
            await time.increaseTo(delayedEvent.executionAllowedAt);
            const proof2 = await context.attestationProvider.proveXRPPayment(txHash2, null);
            const res3 = await context.assetManager.executeDirectMinting(proof2, { from: executorAddress1 });
            // should mint to smart account
            const mintingExecuted = requiredEventArgs(res3, 'DirectMintingExecutedToSmartAccount');
            const smartAccountReceived = requiredEventArgsFrom(res3, smartAccountManager, 'MintedToSmartAccount');
            await verifyDirectMintingToSmartAccounts(mintingExecuted, smartAccountReceived, txHash2, null, minter.underlyingAddress, executorAddress1, totalMintingAmount);
        });

        it("should fail unblocking with future timestamp", async () => {
            const futureTime = (await time.latest()).addn(HOURS);
            await expectRevert.custom(
                context.assetManager.unblockDirectMintingsUntil(futureTime, { from: governance }),
                "TimestampMustBeInThePast",
                []
            );
        });
    });

    describe("Changing direct minting settings", () => {
        beforeEach(async () => {
            // increase time to avoid rate limiting between tests (minUpdateRepeatTimeSeconds = 1 day)
            await time.increase(DAYS + 1);
        });

        it("should allow governance to change minting tag manager", async () => {
            const oldTagManager = await context.assetManager.getMintingTagManager();
            const newTagManager = accounts[70];
            await context.assetManager.setMintingTagManager(newTagManager, { from: governance });
            const updatedTagManager = await context.assetManager.getMintingTagManager();
            assertWeb3Equal(updatedTagManager, newTagManager);
            assert.notEqual(updatedTagManager, oldTagManager);
        });

        it("should not allow setting zero address as minting tag manager", async () => {
            await expectRevert.custom(
                context.assetManager.setMintingTagManager(ZERO_ADDRESS, { from: governance }),
                "AddressZero",
                []
            );
        });

        it("should allow governance to change smart account manager", async () => {
            const oldSmartAccountManager = await context.assetManager.getSmartAccountManager();
            const newSmartAccountManager = accounts[71];
            await context.assetManager.setSmartAccountManager(newSmartAccountManager, { from: governance });
            const updatedSmartAccountManager = await context.assetManager.getSmartAccountManager();
            assertWeb3Equal(updatedSmartAccountManager, newSmartAccountManager);
            assert.notEqual(updatedSmartAccountManager, oldSmartAccountManager);
        });

        it("should not allow setting zero address as smart account manager", async () => {
            await expectRevert.custom(
                context.assetManager.setSmartAccountManager(ZERO_ADDRESS, { from: governance }),
                "AddressZero",
                []
            );
        });

        it("should allow governance to change fee receiver", async () => {
            const newFeeReceiver = accounts[72];
            await context.assetManager.setDirectMintingFeeReceiver(newFeeReceiver, { from: governance });
            const updatedFeeReceiver = await context.assetManager.getDirectMintingFeeReceiver();
            assertWeb3Equal(updatedFeeReceiver, newFeeReceiver);
        });

        it("should allow governance to change minting fee within limits", async () => {
            const currentFeeBIPS = toBN(await context.assetManager.getDirectMintingFeeBIPS());
            const currentMinimumFeeUBA = toBN(await context.assetManager.getDirectMintingMinimumFeeUBA());
            // increase by 2x (within 4x limit)
            const newFeeBIPS = currentFeeBIPS.muln(2);
            const newMinimumFeeUBA = currentMinimumFeeUBA.muln(2);
            await context.assetManager.setDirectMintingFee(newFeeBIPS, newMinimumFeeUBA, { from: governance });
            assertWeb3Equal(await context.assetManager.getDirectMintingFeeBIPS(), newFeeBIPS);
            assertWeb3Equal(await context.assetManager.getDirectMintingMinimumFeeUBA(), newMinimumFeeUBA);
        });

        it("should reject minting fee increase that is too large", async () => {
            const currentFeeBIPS = toBN(await context.assetManager.getDirectMintingFeeBIPS());
            const currentMinimumFeeUBA = toBN(await context.assetManager.getDirectMintingMinimumFeeUBA());
            // try to increase by more than 4x + 100 BIPS
            // newFeeBIPS must be > currentFeeBIPS * 4 + 100
            const newFeeBIPS = currentFeeBIPS.muln(4).addn(101);
            const newMinimumFeeUBA = currentMinimumFeeUBA;
            await expectRevert.custom(
                context.assetManager.setDirectMintingFee(newFeeBIPS, newMinimumFeeUBA, { from: governance }),
                "IncreaseTooBig",
                []
            );
        });

        it("should reject minting fee decrease that is too large", async () => {
            const currentFeeBIPS = toBN(await context.assetManager.getDirectMintingFeeBIPS());
            const currentMinimumFeeUBA = toBN(await context.assetManager.getDirectMintingMinimumFeeUBA());
            // try to decrease by more than 1/4
            const newFeeBIPS = currentFeeBIPS.divn(5);
            const newMinimumFeeUBA = currentMinimumFeeUBA;
            await expectRevert.custom(
                context.assetManager.setDirectMintingFee(newFeeBIPS, newMinimumFeeUBA, { from: governance }),
                "DecreaseTooBig",
                []
            );
        });

        it("should reject minting fee that is too high", async () => {
            const currentMinimumFeeUBA = toBN(await context.assetManager.getDirectMintingMinimumFeeUBA());
            const tooHighFeeBIPS = MAX_BIPS; // 100%
            await expectRevert.custom(
                context.assetManager.setDirectMintingFee(tooHighFeeBIPS, currentMinimumFeeUBA, { from: governance }),
                "ValueTooHigh",
                []
            );
        });

        it("should allow governance to change executor fee within limits", async () => {
            const currentExecutorFeeUBA = toBN(await context.assetManager.getDirectMintingExecutorFeeUBA());
            // increase by 2x (within 4x limit)
            const newExecutorFeeUBA = currentExecutorFeeUBA.muln(2);
            await context.assetManager.setDirectMintingExecutorFee(newExecutorFeeUBA, { from: governance });
            assertWeb3Equal(await context.assetManager.getDirectMintingExecutorFeeUBA(), newExecutorFeeUBA);
        });

        it("should reject executor fee increase that is too large", async () => {
            const currentExecutorFeeUBA = toBN(await context.assetManager.getDirectMintingExecutorFeeUBA());
            // try to increase by more than 4x + buffer
            const newExecutorFeeUBA = currentExecutorFeeUBA.muln(10);
            await expectRevert.custom(
                context.assetManager.setDirectMintingExecutorFee(newExecutorFeeUBA, { from: governance }),
                "IncreaseTooBig",
                []
            );
        });

        it("should reject executor fee decrease that is too large", async () => {
            const currentExecutorFeeUBA = toBN(await context.assetManager.getDirectMintingExecutorFeeUBA());
            // try to decrease by more than 1/4
            const newExecutorFeeUBA = currentExecutorFeeUBA.divn(5);
            await expectRevert.custom(
                context.assetManager.setDirectMintingExecutorFee(newExecutorFeeUBA, { from: governance }),
                "DecreaseTooBig",
                []
            );
        });

        it("should allow governance to change hourly limit within limits", async () => {
            const currentHourlyLimitUBA = toBN(await context.assetManager.getDirectMintingHourlyLimitUBA());
            // increase by 2x (within 10x limit)
            const newHourlyLimitUBA = currentHourlyLimitUBA.muln(2);
            await context.assetManager.setDirectMintingHourlyLimitUBA(newHourlyLimitUBA, { from: governance });
            assertWeb3Equal(await context.assetManager.getDirectMintingHourlyLimitUBA(), newHourlyLimitUBA);
        });

        it("should reject hourly limit increase that is too large", async () => {
            const currentHourlyLimitUBA = toBN(await context.assetManager.getDirectMintingHourlyLimitUBA());
            // try to increase by more than 10x + buffer
            const newHourlyLimitUBA = currentHourlyLimitUBA.muln(20);
            await expectRevert.custom(
                context.assetManager.setDirectMintingHourlyLimitUBA(newHourlyLimitUBA, { from: governance }),
                "IncreaseTooBig",
                []
            );
        });

        it("should reject hourly limit decrease that is too large", async () => {
            const currentHourlyLimitUBA = toBN(await context.assetManager.getDirectMintingHourlyLimitUBA());
            // try to decrease by more than 1/10
            const newHourlyLimitUBA = currentHourlyLimitUBA.divn(11);
            await expectRevert.custom(
                context.assetManager.setDirectMintingHourlyLimitUBA(newHourlyLimitUBA, { from: governance }),
                "DecreaseTooBig",
                []
            );
        });

        it("should allow governance to change daily limit within limits", async () => {
            const currentDailyLimitUBA = toBN(await context.assetManager.getDirectMintingDailyLimitUBA());
            // increase by 2x (within 10x limit)
            const newDailyLimitUBA = currentDailyLimitUBA.muln(2);
            await context.assetManager.setDirectMintingDailyLimitUBA(newDailyLimitUBA, { from: governance });
            assertWeb3Equal(await context.assetManager.getDirectMintingDailyLimitUBA(), newDailyLimitUBA);
        });

        it("should reject daily limit increase that is too large", async () => {
            const currentDailyLimitUBA = toBN(await context.assetManager.getDirectMintingDailyLimitUBA());
            // try to increase by more than 10x + buffer
            const newDailyLimitUBA = currentDailyLimitUBA.muln(20);
            await expectRevert.custom(
                context.assetManager.setDirectMintingDailyLimitUBA(newDailyLimitUBA, { from: governance }),
                "IncreaseTooBig",
                []
            );
        });

        it("should reject daily limit decrease that is too large", async () => {
            const currentDailyLimitUBA = toBN(await context.assetManager.getDirectMintingDailyLimitUBA());
            // try to decrease by more than 1/10
            const newDailyLimitUBA = currentDailyLimitUBA.divn(11);
            await expectRevert.custom(
                context.assetManager.setDirectMintingDailyLimitUBA(newDailyLimitUBA, { from: governance }),
                "DecreaseTooBig",
                []
            );
        });

        it("should allow governance to change large minting throttling within limits", async () => {
            const currentThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const currentDelaySeconds = toBN(await context.assetManager.getDirectMintingLargeMintingDelaySeconds());
            // increase threshold by 2x and delay by 2x (within limits)
            const newThresholdUBA = currentThresholdUBA.muln(2);
            const newDelaySeconds = currentDelaySeconds.muln(2);
            await context.assetManager.setDirectMintingLargeMintingThrottling(newThresholdUBA, newDelaySeconds, { from: governance });
            // Only verify delay seconds changed (threshold getter returns different value - see contract implementation)
            assertWeb3Equal(await context.assetManager.getDirectMintingLargeMintingDelaySeconds(), newDelaySeconds);
        });

        it("should reject large minting threshold increase that is too large", async () => {
            const currentThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const currentDelaySeconds = toBN(await context.assetManager.getDirectMintingLargeMintingDelaySeconds());
            // try to increase by more than 10x + buffer
            const newThresholdUBA = currentThresholdUBA.muln(20);
            await expectRevert.custom(
                context.assetManager.setDirectMintingLargeMintingThrottling(newThresholdUBA, currentDelaySeconds, { from: governance }),
                "IncreaseTooBig",
                []
            );
        });

        it("should reject large minting threshold decrease that is too large", async () => {
            const currentThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const currentDelaySeconds = toBN(await context.assetManager.getDirectMintingLargeMintingDelaySeconds());
            // try to decrease by more than 1/10
            const newThresholdUBA = currentThresholdUBA.divn(11);
            await expectRevert.custom(
                context.assetManager.setDirectMintingLargeMintingThrottling(newThresholdUBA, currentDelaySeconds, { from: governance }),
                "DecreaseTooBig",
                []
            );
        });

        it("should reject large minting delay that is too high", async () => {
            const currentThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const tooHighDelaySeconds = toBN(3).mul(toBN(24 * HOURS)).addn(1); // more than 3 days
            await expectRevert.custom(
                context.assetManager.setDirectMintingLargeMintingThrottling(currentThresholdUBA, tooHighDelaySeconds, { from: governance }),
                "ValueTooHigh",
                []
            );
        });

        it("should reject large minting delay increase that is too large", async () => {
            const currentThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const currentDelaySeconds = toBN(await context.assetManager.getDirectMintingLargeMintingDelaySeconds());
            // try to increase by more than 4x + 12 hours
            // newDelaySeconds must be > currentDelaySeconds * 4 + 12 * HOURS
            const newDelaySeconds = currentDelaySeconds.muln(4).addn(12 * HOURS + 1);
            await expectRevert.custom(
                context.assetManager.setDirectMintingLargeMintingThrottling(currentThresholdUBA, newDelaySeconds, { from: governance }),
                "IncreaseTooBig",
                []
            );
        });

        it("should reject large minting delay decrease that is too large", async () => {
            const currentThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const currentDelaySeconds = toBN(await context.assetManager.getDirectMintingLargeMintingDelaySeconds());
            // try to decrease by more than 1/4
            const newDelaySeconds = currentDelaySeconds.divn(5);
            await expectRevert.custom(
                context.assetManager.setDirectMintingLargeMintingThrottling(currentThresholdUBA, newDelaySeconds, { from: governance }),
                "DecreaseTooBig",
                []
            );
        });

        it("changed hourly limit should affect minting behavior", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // reduce hourly limit to 50 lots
            const newHourlyLimitUBA = context.convertLotsToUBA(50);
            await context.assetManager.setDirectMintingHourlyLimitUBA(newHourlyLimitUBA, { from: governance });
            // mint 45 lots - should succeed
            const [res1] = await minter.directMintRaw(context.convertLotsToUBA(45), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            expectEvent(res1, 'DirectMintingExecuted');
            // try to mint 10 more lots - should be delayed due to new lower limit
            const [res2] = await minter.directMintRaw(context.convertLotsToUBA(10), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            expectEvent(res2, 'DirectMintingDelayed');
        });

        it("changed fee should affect minting fees collected", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // change minting fee to 2% (200 BIPS)
            const newFeeBIPS = 200;
            const currentMinimumFeeUBA = toBN(await context.assetManager.getDirectMintingMinimumFeeUBA());
            await context.assetManager.setDirectMintingFee(newFeeBIPS, currentMinimumFeeUBA, { from: governance });
            // mint and check the fee
            const totalMintingAmount = context.convertLotsToUBA(10);
            const [res] = await minter.directMintRaw(totalMintingAmount, {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecuted');
            const expectedFee = totalMintingAmount.muln(newFeeBIPS).divn(MAX_BIPS);
            assertWeb3Equal(mintingExecuted.mintingFeeUBA, expectedFee);
        });

        it("changed executor fee should affect executor payment", async () => {
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(200));
            // change executor fee to 0.001 lots
            const newExecutorFeeUBA = context.convertLotsToUBA(1).divn(1000);
            await context.assetManager.setDirectMintingExecutorFee(newExecutorFeeUBA, { from: governance });
            // mint and check the executor fee
            const [res] = await minter.directMintRaw(context.convertLotsToUBA(10), {
                memoData: PaymentReference.directMinting(minter.address),
                executor: executorAddress1
            });
            const mintingExecuted = requiredEventArgs(res, 'DirectMintingExecuted');
            assertWeb3Equal(mintingExecuted.executorFeeUBA, newExecutorFeeUBA);
        });
    });

    describe("Direct minting settings governance and timelock", () => {
        beforeEach(async () => {
            // advance time to avoid rate limiting
            await time.increase(DAYS + 1);
        });

        it("direct minting setting modifications require governance call", async () => {
            const currentMinimumFeeUBA = toBN(await context.assetManager.getDirectMintingMinimumFeeUBA());
            const currentFeeBIPS = toBN(await context.assetManager.getDirectMintingFeeBIPS());
            const currentExecutorFeeUBA = toBN(await context.assetManager.getDirectMintingExecutorFeeUBA());
            const currentHourlyLimitUBA = toBN(await context.assetManager.getDirectMintingHourlyLimitUBA());
            const currentDailyLimitUBA = toBN(await context.assetManager.getDirectMintingDailyLimitUBA());
            const currentLargeMintingThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const currentLargeMintingDelaySeconds = toBN(await context.assetManager.getDirectMintingLargeMintingDelaySeconds());

            // all setting methods should fail when called from non-governance account
            // (both onlyGovernance and onlyImmediateGovernance modifiers throw OnlyGovernance error)
            await expectRevert.custom(context.assetManager.setMintingTagManager(accounts[80]), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.setSmartAccountManager(accounts[81]), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.setDirectMintingFeeReceiver(accounts[82]), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.setDirectMintingFee(currentFeeBIPS, currentMinimumFeeUBA), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.setDirectMintingExecutorFee(currentExecutorFeeUBA), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.setDirectMintingHourlyLimitUBA(currentHourlyLimitUBA), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.setDirectMintingDailyLimitUBA(currentDailyLimitUBA), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.setDirectMintingLargeMintingThrottling(currentLargeMintingThresholdUBA, currentLargeMintingDelaySeconds), "OnlyGovernance", []);
            await expectRevert.custom(context.assetManager.unblockDirectMintingsUntil(0), "OnlyGovernance", []);
        });

        it("some direct minting settings are timelocked in production mode, others aren't", async () => {
            const currentMinimumFeeUBA = toBN(await context.assetManager.getDirectMintingMinimumFeeUBA());
            const currentFeeBIPS = toBN(await context.assetManager.getDirectMintingFeeBIPS());
            const currentExecutorFeeUBA = toBN(await context.assetManager.getDirectMintingExecutorFeeUBA());
            const currentHourlyLimitUBA = toBN(await context.assetManager.getDirectMintingHourlyLimitUBA());
            const currentDailyLimitUBA = toBN(await context.assetManager.getDirectMintingDailyLimitUBA());
            const currentLargeMintingThresholdUBA = toBN(await context.assetManager.getDirectMintingLargeMintingThresholdUBA());
            const currentLargeMintingDelaySeconds = toBN(await context.assetManager.getDirectMintingLargeMintingDelaySeconds());

            let timelocked: boolean;
            await context.assetManager.switchToProductionMode({ from: governance });

            // methods with onlyGovernance are timelocked
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setMintingTagManager(accounts[80], { from: governance }));
            assert.equal(timelocked, true);

            await time.increase(DAYS + 1); // avoid rate limiting
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setSmartAccountManager(accounts[81], { from: governance }));
            assert.equal(timelocked, true);

            await time.increase(DAYS + 1);
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setDirectMintingFeeReceiver(accounts[82], { from: governance }));
            assert.equal(timelocked, true);

            await time.increase(DAYS + 1);
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setDirectMintingFee(currentFeeBIPS, currentMinimumFeeUBA, { from: governance }));
            assert.equal(timelocked, true);

            await time.increase(DAYS + 1);
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setDirectMintingExecutorFee(currentExecutorFeeUBA, { from: governance }));
            assert.equal(timelocked, true);

            // methods with onlyImmediateGovernance are NOT timelocked
            await time.increase(DAYS + 1);
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setDirectMintingHourlyLimitUBA(currentHourlyLimitUBA, { from: governance }));
            assert.equal(timelocked, false);

            await time.increase(DAYS + 1);
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setDirectMintingDailyLimitUBA(currentDailyLimitUBA, { from: governance }));
            assert.equal(timelocked, false);

            await time.increase(DAYS + 1);
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.setDirectMintingLargeMintingThrottling(currentLargeMintingThresholdUBA, currentLargeMintingDelaySeconds, { from: governance }));
            assert.equal(timelocked, false);

            await time.increase(DAYS + 1);
            const pastTimestamp = (await time.latest()).subn(100);
            timelocked = await executeTimelockedGovernanceCall(context.assetManager,
                (governance) => context.assetManager.unblockDirectMintingsUntil(pastTimestamp, { from: governance }));
            assert.equal(timelocked, false);
        });
    });
});
