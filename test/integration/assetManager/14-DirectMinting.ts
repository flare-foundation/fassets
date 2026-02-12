import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { Challenger } from "../../../lib/test-utils/actors/Challenger";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { MockCoreVaultBot } from "../../../lib/test-utils/actors/MockCoreVaultBot";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { assertApproximatelyEqual } from "../../../lib/test-utils/approximation";
import { executeTimelockedGovernanceCall } from "../../../lib/test-utils/contract-test-helpers";
import { newAssetManager } from "../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../lib/test-utils/fasset/MockChain";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { assignMintingTagManager, assignSmartAccountManagerMock } from "../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { requiredEventArgsFrom } from "../../../lib/test-utils/Web3EventDecoder";
import { filterEvents, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { BNish, DAYS, deepFormat, HOURS, MAX_BIPS, requireNotNull, toBN, toWei, ZERO_ADDRESS } from "../../../lib/utils/helpers";
import { CoreVaultManagerInstance, MintingTagManagerInstance, SmartAccountManagerMockInstance } from "../../../typechain-truffle";

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
    let smartAccountManager: SmartAccountManagerMockInstance;
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
});
