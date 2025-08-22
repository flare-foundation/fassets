import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { Challenger } from "../../../lib/test-utils/actors/Challenger";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain, MockChainWallet, MockTransactionOptionsWithFee } from "../../../lib/test-utils/fasset/MockChain";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { createTestAgentSettings, whitelistAgentOwner } from "../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { EventArgs } from "../../../lib/utils/events/common";
import { requiredEventArgs } from "../../../lib/utils/events/truffle";
import { toWei } from "../../../lib/utils/helpers";
import { web3DeepNormalize } from "../../../lib/utils/web3normalize";
import { RedemptionRequested } from "../../../typechain-truffle/IIAssetManager";

const AgentVault = artifacts.require('AgentVault');
const CollateralPool = artifacts.require('CollateralPool');
const CollateralPoolToken = artifacts.require('CollateralPoolToken');

contract(`Audit.ts; ${getTestFile(__filename)}; Audit tests`, accounts => {
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
    const underlyingOwner1 = "Owner1";
    const underlyingMinter1 = "Minter1";
    const underlyingMinter2 = "Minter2";
    const underlyingRedeemer1 = "Redeemer1";
    const underlyingRedeemer2 = "Redeemer2";

    let commonContext: CommonContext;
    let context: AssetContext;

    async function initialize() {
        commonContext = await CommonContext.createTest(governance);
        context = await AssetContext.createTest(commonContext, testChainInfo.eth);
        return { commonContext, context };
    }

    beforeEach(async () => {
        ({ commonContext, context } = await loadFixtureCopyVars(initialize));
    });

    it("cannot use invalid payment reference type", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1,
            context.underlyingAmount(10000));
        const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
        const challenger = await Challenger.create(context, challengerAddress1);
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
        const tx1Hash = await agent.performRedemptionPayment(request);
        const fakeTxHash = await performFakeRedemptionPayment(agent, request);
        // others cannot confirm redemption payment immediately or challenge it as illegal payment
        await expectRevert.custom(challenger.confirmActiveRedemptionPayment(request, tx1Hash, agent), "OnlyAgentVaultOwner", []);
        await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "MatchingRedemptionActive", []);
        await challenger.illegalPaymentChallenge(agent, fakeTxHash);
    });

    it("cannot abuse payment reference bits betwwen 64 and 192", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1,
            context.underlyingAmount(10000));
        const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
        const challenger = await Challenger.create(context, challengerAddress1);
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
        const tx1Hash = await agent.performRedemptionPayment(request);
        const fakeTxHash = await performFakeRedemptionPaymentID(agent, request);
        // others cannot confirm redemption payment immediately or challenge it as illegal payment
        await expectRevert.custom(challenger.confirmActiveRedemptionPayment(request, tx1Hash, agent), "OnlyAgentVaultOwner", []);
        await expectRevert.custom(challenger.illegalPaymentChallenge(agent, tx1Hash), "MatchingRedemptionActive", []);
        await challenger.illegalPaymentChallenge(agent, fakeTxHash);
    });

    it("should not be allowed to mint with the payment from before agent creation", async () => {
        if (!(context.chain instanceof MockChain)) assert.fail("only for mock chains");
        // create mock wallet
        const wallet = new MockChainWallet(context.chain);
        // mint some underlying funds for the owner
        const amount = context.underlyingAmount(10000);
        context.chain.mint(underlyingOwner1, context.chain.requiredFee.muln(2).add(amount));
        // whitelist agent management address
        await whitelistAgentOwner(context.agentOwnerRegistry.address, agentOwner1);
        // deposit to underlying address
        const guessBlock = Number(await time.latestBlock()) + 20;
        const guessId = guessBlock % 1000 + 1;
        const depositHash = await wallet.addTransaction(underlyingOwner1, underlyingAgent1, amount, PaymentReference.minting(guessId));
        // increase block number
        context.chain.mine(1);
        // update current block in asset manager
        const blockHeightProof = await context.attestationProvider.proveConfirmedBlockHeightExists(Number(context.settings.attestationWindowSeconds));
        await context.assetManager.updateCurrentBlock(blockHeightProof);
        // create agent
        const agentSettings = createTestAgentSettings(context.usdc.address);
        const addressValidityProof = await context.attestationProvider.proveAddressValidity(underlyingAgent1);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const response = await context.assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: agentOwner1 });
        const created = requiredEventArgs(response, 'AgentVaultCreated');
        const agentVault = await AgentVault.at(created.agentVault);
        const collateralPool = await CollateralPool.at(created.creationData.collateralPool);
        const poolTokenAddress = await collateralPool.poolToken();
        const collateralPoolToken = await CollateralPoolToken.at(poolTokenAddress);
        // create object
        const agent = new Agent(context, agentOwner1, agentVault, collateralPool, collateralPoolToken, wallet, agentSettings,
            addressValidityProof.data.responseBody.standardAddress);
        // make agent available
        const fullAgentCollateral = toWei(3e8);
        await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
        // reserve collateral
        await time.advanceBlockTo(guessBlock - 1);
        const minter = new Minter(context, agentOwner1, underlyingOwner1, wallet);
        const crt = await minter.reserveCollateral(agent.agentVault.address, 1);
        // mint
        const proof = await context.attestationProvider.provePayment(depositHash, underlyingOwner1, crt.paymentAddress);
        await expectRevert.custom(context.assetManager.executeMinting(proof, crt.collateralReservationId, { from: agentOwner1 }),
            "MintingPaymentTooOld", []);
    });

    async function performFakeRedemptionPayment(agent: Agent, request: EventArgs<RedemptionRequested>, options?: MockTransactionOptionsWithFee) {
        const paymentAmount = request.valueUBA.sub(request.feeUBA);
        const ref = request.paymentReference;
        const newRef = "0xffffffffffffffff" + ref.substring(18, ref.length);
        return await agent.performPayment(request.paymentAddress, paymentAmount, newRef, options);
    }

    async function performFakeRedemptionPaymentID(agent: Agent, request: EventArgs<RedemptionRequested>, options?: MockTransactionOptionsWithFee) {
        const paymentAmount = request.valueUBA.sub(request.feeUBA);
        const ref = request.paymentReference;
        const newRef = "0x4642505266410002aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" + ref.substring(50, ref.length);
        return await agent.performPayment(request.paymentAddress, paymentAmount, newRef, options);
    }
});
