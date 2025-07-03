import { ZERO_ADDRESS } from "../../../deployment/lib/deploy-utils";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Liquidator } from "../../../lib/test-utils/actors/Liquidator";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { filterEvents, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { deepFormat, toBIPS, toBN, toBNExp, toWei } from "../../../lib/utils/helpers";


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

    it("40199: default reentrancy", async () => {
        // Create all essential actors
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
        const redeemer2 = await Redeemer.create(context, redeemerAddress2, underlyingRedeemer2);

        // Make agent available with collateral
        const fullAgentCollateral = toWei(6e8);
        await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
        // update block
        await context.updateUnderlyingBlock();

        // Perform minting for redeemer1 and redeemer2
        const lots = 3;
        const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
        const txHash = await minter.performMintingPayment(crt);
        const minted = await minter.executeMinting(crt, txHash);
        await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
        await context.updateUnderlyingBlock();

        const crt2 = await minter.reserveCollateral(agent.vaultAddress, lots);
        const txHash2 = await minter.performMintingPayment(crt2);
        const minted2 = await minter.executeMinting(crt2, txHash2);
        await context.fAsset.transfer(redeemer2.address, minted2.mintedAmountUBA, { from: minter.address });
        await context.updateUnderlyingBlock();


        // Deploy malicious executor contract
        const executorFee = toBNExp(1, 9); // set at 1 gwei
        const executorFactory = artifacts.require("MaliciousExecutor");
        const executorInstance = await executorFactory.new(context.assetManager.address);
        const executor = executorInstance.address;

        // Make request for redemptions for both redeemer1 and redeemer2
        const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots, executor, executorFee);
        await redeemer2.requestRedemption(lots, executor, executorFee);

        const request = redemptionRequests[0];

        // mine some blocks to create overflow block
        for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
            await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
        }

        // Generate proof of nonpayment for redeem request of redeemer1
        const proof = await context.attestationProvider.proveReferencedPaymentNonexistence(
            request.paymentAddress,
            request.paymentReference,
            request.valueUBA.sub(request.feeUBA),
            request.firstUnderlyingBlock.toNumber(),
            request.lastUnderlyingBlock.toNumber(),
            request.lastUnderlyingTimestamp.toNumber());

        const beforeBalance = await executorInstance.howMuchIsMyNativeBalance();
        const vaultCollateralBalanceBefore = await agent.vaultCollateralToken().balanceOf(redeemerAddress1);

        await executorInstance.defaulting(proof, request.requestId, 1);
        // no reentrancy attack here, just a simple defaulting
        assertWeb3Equal(await executorInstance.hit(), 0);

        const afterBalance = await executorInstance.howMuchIsMyNativeBalance();
        const vaultCollateralBalanceAfter = await agent.vaultCollateralToken().balanceOf(redeemerAddress1);

        console.log("Executor's native balance (executor fee)");
        console.log("before: ", beforeBalance.toString());
        console.log("after: ", afterBalance.toString());
        console.log("----------");

        console.log("Redeemer1's vault collateral balance");
        console.log("before: ", vaultCollateralBalanceBefore.toString());
        console.log("after: ", vaultCollateralBalanceAfter.toString());

        assertWeb3Equal(afterBalance, 0);
        assert(vaultCollateralBalanceAfter.gtn(0));
    });

    it.skip("40203: force redemption default by redeeming to agent's underlying address - original", async () => {
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

        // perform redemption, the receiveUnderlyingAddress param set to agent.underlyingAddress
        const resD = await context.assetManager.redeem(lots, agent.underlyingAddress, "0x0000000000000000000000000000000000000000",
            { from: redeemer.address, value: undefined });
        const redemptionRequests = filterEvents(resD, 'RedemptionRequested').map(e => e.args);

        const request = redemptionRequests[0];

        // the agent make a payment in underlyingchain, but the souceAddress == spendAddress, so recieveAmount == spentAmount == 0,
        // the recieveAmount < request.underlyingValueUBA - request.underlyingFeeUBA, so _validatePament returns false
        const tx1Hash = await agent.performRedemptionPayment(request);
        // malicious reddemer make the payment field, get the agent's collateral plus a redemption default premium
        await agent.confirmFailedRedemptionPayment(request, tx1Hash);
    });

    it("40203: force redemption default by redeeming to agent's underlying address", async () => {
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

        // perform redemption, the receiveUnderlyingAddress param set to agent.underlyingAddress
        await expectRevert.custom(context.assetManager.redeem(lots, agent.underlyingAddress, "0x0000000000000000000000000000000000000000",
            { from: redeemer.address, value: undefined }),
            "CannotRedeemToAgentsAddress", []);
    });

    it.skip("40499: force agent liquidation by reentering `liquidate` from `executeMinting`", async () => {
        // Vault collateral is USDC, 18 decimals
        // USDC price - 1.01
        // NAT price - 0.42
        // BTC price - 25213
        // System CR
        // - minCollateralRatio for vault is 1.4
        // - minCollateralRatio for pool is 2.0
        // Agent CR
        // - mintingVaultCollateralRatioBIPS: toBIPS(2.0)
        // - mintingPoolCollateralRatioBIPS: toBIPS(2.0)
        // To mimic live agent: https://fasset.oracle-daemon.com/sgb/pools/FDOGE/0x2C919bA9a675c213f5e52125933fdD8854714F53

        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1,
            { mintingVaultCollateralRatioBIPS: 20_000, mintingPoolCollateralRatioBIPS: 20_000 });
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        let agentInfo;

        // [1] Make agent available and deposits some collateral
        await agent.depositCollateralsAndMakeAvailable(toBNExp(400000, 18), toBNExp(1000000, 18));
        // mine some blocks to skip the agent creation time
        mockChain.mine(5);
        // update block
        await context.updateUnderlyingBlock();
        await context.assetManager.currentUnderlyingBlock();

        // [2] Set up executor exploit contract
        const executorFee = toBN(1000000000);
        const executorFactory = artifacts.require("MaliciousMintExecutor");
        const executorInstance = await executorFactory.new(context.assetManager.address, agent.agentVault.address, minter.address, context.fAsset.address);
        const executor = executorInstance.address;
        // [3] Minter approves explolit contract to spend minted FAsset
        await context.fAsset.approve(executor, toBNExp(10000000, 18), { from: minter.address });

        // [4] Perform minting
        // lotSize = 2
        // underlying chain = BTC
        agentInfo = await agent.getAgentInfo();
        const lots = agentInfo.freeCollateralLots; // mint at maximum available
        console.log(">> reserve collateral, lots=", lots);
        const crt = await minter.reserveCollateral(agent.vaultAddress, lots, executor, executorFee);
        console.log(">> perform payment to agent underlying address");
        const txHash = await minter.performMintingPayment(crt);

        agentInfo = await agent.getAgentInfo();
        console.log("free lots: ", agentInfo.freeCollateralLots.toString());
        console.log("vaultCR after reservation: ", agentInfo.vaultCollateralRatioBIPS);
        console.log("poolCR after reservation: ", agentInfo.poolCollateralRatioBIPS);

        // [5] Exploit
        agentInfo = await agent.getAgentInfo();
        console.log("agent vault collateral in wei before exploit: ", agentInfo.totalVaultCollateralWei);
        console.log(">>> executor call executeMinting");
        const proof = await context.attestationProvider.provePayment(txHash, minter.underlyingAddress, crt.paymentAddress);
        await executorInstance.mint(proof, crt.collateralReservationId);

        // [6] Post-expolitation, observe that vault collateral is reduced due to liquidation
        // Also, observe that vaultCR and poolCR is reduced due to double counting while it should be the same as in after reservation
        agentInfo = await agent.getAgentInfo();
        console.log("agent vault collateral in wei after exploit: ", agentInfo.totalVaultCollateralWei);
        console.log("vaultCR while in executor call: ", (await executorInstance.vaultCR()).toString());
        console.log("poolCR while in executor call: ", (await executorInstance.poolCR()).toString());

        agentInfo = await agent.getAgentInfo();
        console.log("free lots: ", agentInfo.freeCollateralLots.toString());
        console.log("vaultCR after exploit: ", agentInfo.vaultCollateralRatioBIPS);
        console.log("poolCR after exploit: ", agentInfo.poolCollateralRatioBIPS);
    });

    it("40760: agent frees collateral by double processing one redemption - original", async () => {
        // prepare an agent with collateral
        console.log(">> Prepare an agent with collateral");
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
        const innocentBystander = redeemerAddress2;

        const fullAgentCollateral = toWei(3e8);
        await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
        mockChain.mine(5);

        // mint 4 lots of f-asset (1 lot = 2 BTC)
        await context.updateUnderlyingBlock();
        const lots = 4;
        const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
        const txHash = await minter.performMintingPayment(crt);
        const minted = await minter.executeMinting(crt, txHash);

        // agent info after minting
        console.log(">> Simulate minting with agent (4 lots occupied)");
        let agentInfo = await agent.getAgentInfo();
        console.log("AgentInfo after minting");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> Distribute f-asset to agent's redeemer and innocent bystander");
        // agent controlled redeemer gets some f-asset
        await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA.divRound(toBN(2)), { from: minter.address });
        // innocent bystander gets some f-asset
        await context.fAsset.transfer(innocentBystander, minted.mintedAmountUBA.divRound(toBN(2)), { from: minter.address });

        // agent prepares the exploit
        // create a redemption with invalid receiver address
        console.log(">> Agent creates a redemption request with invalid receiver address");
        const res = await context.assetManager.redeem(1, "MY_INVALID_ADDRESS", "0x0000000000000000000000000000000000000000", { from: redeemer.address });
        agentInfo = await agent.getAgentInfo();
        console.log("AgentInfo after redemption request");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        const redemptionRequests = filterEvents(res, 'RedemptionRequested').map(e => e.args);
        const request = redemptionRequests[0];

        console.log(">> Simulate timeskip for 1 day, passing attestation window");
        // time skip for about one day for both underlying chain and this chain
        // attestation window seconds: 86400
        mockChain.mine(144);
        mockChain.skipTime(87000);
        await time.deterministicIncrease(87000);
        await context.updateUnderlyingBlock();

        console.log(">> Agent invokes finishRedemptionWithoutPayment on their own redemption");
        // finish redemption without payment
        // mark first redemption as DEFAULTED and payout via vault/pool collateral
        // because agent is in control of redeemer address, we can just deposit those funds back to the vault and pool
        await agent.finishRedemptionWithoutPayment(request);

        agentInfo = await agent.getAgentInfo();
        console.log("AgenInfo after finishRedemptionWithoutPayment");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> innocentBystander tries to redeem 1 lot of f-asset");
        // innocentBystander happens to redeem
        const res2 = await context.assetManager.redeem(1, underlyingRedeemer2, "0x0000000000000000000000000000000000000000", { from: innocentBystander });
        const redemptionRequests2 = filterEvents(res2, 'RedemptionRequested').map(e => e.args);
        const request2 = redemptionRequests2[0];

        console.log("AgentInfo after innocentBystander redemption request");
        agentInfo = await agent.getAgentInfo();
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> Agent invokes rejectInvalidRedemption again on their own previous redemption request");
        console.log(">> before prove on non-existence is available");
        // agent invokes `rejectInvalidRedemption` on his own DEFAULTED redemption since it has not been deleted to reduce backing redeeming amount
        const proof = await context.attestationProvider.proveAddressValidity(request.paymentAddress);
        await expectRevert.custom(context.assetManager.rejectInvalidRedemption(proof, request.requestId, { from: agentOwner1 }),
            "InvalidRedemptionStatus", []);

        agentInfo = await agent.getAgentInfo();
        console.log("AgentInfo after agent rejecting their own redemption");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> Simluate timeskip to payment expiration");
        // skip to payment expiration
        context.skipToExpiration(request2.lastUnderlyingBlock, request2.lastUnderlyingTimestamp);

        console.log(">> innocentBystander tries to claim collateral with prove of non-existence payment... but fail terribly");
        // since there is no payment from agent, innocentBystander has to invoke redemptionPaymentDefault to claim agent's collateral
        const proof2 = await context.attestationProvider.proveReferencedPaymentNonexistence(
            request2.paymentAddress,
            request2.paymentReference,
            request2.valueUBA.sub(request.feeUBA),
            request2.firstUnderlyingBlock.toNumber(),
            request2.lastUnderlyingBlock.toNumber(),
            request2.lastUnderlyingTimestamp.toNumber());

        // This will revert due to assertion failure while calculating maxRedemptionCollateral in `executeDefaultPayment`
        // because agent.redeemingAMG is less than request.valueAMG
        await context.assetManager.redemptionPaymentDefault(proof2, request2.requestId, { from: innocentBystander });

    });

    it("40760: agent frees collateral by double processing one redemption", async () => {
        // prepare an agent with collateral
        console.log(">> Prepare an agent with collateral");
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
        const innocentBystander = redeemerAddress2;

        const fullAgentCollateral = toWei(3e8);
        await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
        mockChain.mine(5);

        // mint 4 lots of f-asset (1 lot = 2 BTC)
        await context.updateUnderlyingBlock();
        const lots = 4;
        const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
        const txHash = await minter.performMintingPayment(crt);
        const minted = await minter.executeMinting(crt, txHash);

        // agent info after minting
        console.log(">> Simulate minting with agent (4 lots occupied)");
        let agentInfo = await agent.getAgentInfo();
        console.log("AgentInfo after minting");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> Distribute f-asset to agent's redeemer and innocent bystander");
        // agent controlled redeemer gets some f-asset
        await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA.divRound(toBN(2)), { from: minter.address });
        // innocent bystander gets some f-asset
        await context.fAsset.transfer(innocentBystander, minted.mintedAmountUBA.divRound(toBN(2)), { from: minter.address });

        // agent prepares the exploit
        // create a redemption with invalid receiver address
        console.log(">> Agent creates a redemption request with invalid receiver address");
        const res = await context.assetManager.redeem(1, "MY_INVALID_ADDRESS", "0x0000000000000000000000000000000000000000", { from: redeemer.address });
        agentInfo = await agent.getAgentInfo();
        console.log("AgentInfo after redemption request");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        const redemptionRequests = filterEvents(res, 'RedemptionRequested').map(e => e.args);
        const request = redemptionRequests[0];

        // pay for redemption
        const rpTx = await agent.performRedemptionPayment(request);

        console.log(">> Simulate timeskip for 1 day, passing attestation window");
        // time skip for about one day for both underlying chain and this chain
        // attestation window seconds: 86400
        mockChain.mine(144);
        mockChain.skipTime(87000);
        await time.deterministicIncrease(87000);
        await context.updateUnderlyingBlock();

        console.log(">> Agent invokes finishRedemptionWithoutPayment on their own redemption");
        // finish redemption without payment
        // mark first redemption as DEFAULTED and payout via vault/pool collateral
        // because agent is in control of redeemer address, we can just deposit those funds back to the vault and pool
        await agent.finishRedemptionWithoutPayment(request);

        agentInfo = await agent.getAgentInfo();
        console.log("AgenInfo after finishRedemptionWithoutPayment");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> innocentBystander tries to redeem 1 lot of f-asset");
        // innocentBystander happens to redeem
        const res2 = await context.assetManager.redeem(1, underlyingRedeemer2, "0x0000000000000000000000000000000000000000", { from: innocentBystander });
        const redemptionRequests2 = filterEvents(res2, 'RedemptionRequested').map(e => e.args);
        const request2 = redemptionRequests2[0];

        console.log("AgentInfo after innocentBystander redemption request");
        agentInfo = await agent.getAgentInfo();
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> Agent invokes rejectInvalidRedemption again on their own previous redemption request");
        console.log(">> before prove on non-existence is available");
        // agent invokes `confirmActiveRedemptionPayment` on his own expired redemption since it has not been deleted to reduce backing redeeming amount
        const proof1 = await context.attestationProvider.provePayment(rpTx, agent.underlyingAddress, request.paymentAddress);
        const res1 = await context.assetManager.confirmRedemptionPayment(proof1, request.requestId, { from: agent.ownerWorkAddress });
        expectEvent.notEmitted(res1, "RedemptionPerformed");
        expectEvent(res1, "RedemptionPaymentFailed", { failureReason: "redemption already defaulted" });

        agentInfo = await agent.getAgentInfo();
        console.log("AgentInfo after agent rejecting their own redemption");
        console.log("minted | redeeming | reserved");
        console.log(agentInfo.mintedUBA, agentInfo.redeemingUBA, agentInfo.reservedUBA);

        console.log(">> Simluate timeskip to payment expiration");
        // skip to payment expiration
        context.skipToExpiration(request2.lastUnderlyingBlock, request2.lastUnderlyingTimestamp);

        console.log(">> innocentBystander tries to claim collateral with prove of non-existence payment... but fail terribly");
        // since there is no payment from agent, innocentBystander has to invoke redemptionPaymentDefault to claim agent's collateral
        const proof2 = await context.attestationProvider.proveReferencedPaymentNonexistence(
            request2.paymentAddress,
            request2.paymentReference,
            request2.valueUBA.sub(request.feeUBA),
            request2.firstUnderlyingBlock.toNumber(),
            request2.lastUnderlyingBlock.toNumber(),
            request2.lastUnderlyingTimestamp.toNumber());

        // This will revert due to assertion failure while calculating maxRedemptionCollateral in `executeDefaultPayment`
        // because agent.redeemingAMG is less than request.valueAMG
        await context.assetManager.redemptionPaymentDefault(proof2, request2.requestId, { from: innocentBystander });

    });

    it("41079: agent can increase underlying balance by constructing a negative-value redemption payment UTXO", async () => {

        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        const minter2 = await Minter.createTest(context, minterAddress2, underlyingMinter2, context.underlyingAmount(10000));
        const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);

        // prepare an agent with collateral
        console.log(">> Prepare an agent with collateral");
        const fullAgentCollateral = toWei(3e8);
        await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
        mockChain.mine(5);

        console.log(">> Minting 3 lots of FAsset");
        await context.updateUnderlyingBlock();
        const lots = 3;
        const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
        const txHash = await minter.performMintingPayment(crt);
        const minted = await minter.executeMinting(crt, txHash);

        await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });

        console.log(">> Make a redemption request on self");
        const [redemptionRequests, remainingLots, dustChanges] = await redeemer.requestRedemption(lots);
        const request = redemptionRequests[0];

        console.log(">> Perform payment that results in negative spentAmont of source");
        const paymentAmount = request.valueUBA.sub(request.feeUBA);
        /**
        inUTXO
        underlyingMinter1 : 1
        underlyingMinter2: 1000+redemptionAmount

        outUTXO
        underlyingMinter1: 1000
        redeemer: redemptionAmount
        */
        const redeemPaymentTxHash = await agent.wallet.addMultiTransaction(
            {
                [underlyingMinter1]: context.underlyingAmount(1),
                [underlyingMinter2]: context.underlyingAmount(1000).add(paymentAmount)
            },
            {
                [redeemer.underlyingAddress]: paymentAmount,
                [underlyingMinter1]: context.underlyingAmount(1000)
            },
            PaymentReference.redemption(request.requestId)
        );

        const underlyingBalanceBefore = (await agent.getAgentInfo()).underlyingBalanceUBA;

        console.log(">> Request proof, specifying underlyingMinter1 as source");
        const proof = await context.attestationProvider.provePayment(redeemPaymentTxHash, underlyingMinter1, request.paymentAddress);
        console.log(">> spentAmount: ", proof.data.responseBody.spentAmount);

        console.log(">> Confirm redemption payment");
        // this was successfull before fix
        await expectRevert.custom(context.assetManager.confirmRedemptionPayment(proof, request.requestId, { from: agent.ownerWorkAddress }),
            "SourceNotAgentsUnderlyingAddress", []);

        const underlyingBalanceAfter = (await agent.getAgentInfo()).underlyingBalanceUBA;
        console.log(">> underlyingBalance before: ", underlyingBalanceBefore);
        console.log(">> underlyingBalance after: ", underlyingBalanceAfter);
        console.log(">> underlyingBalance on underlying chain: ", (await context.chain.getBalance(agent.underlyingAddress)).toString());

    });

    it.skip("43711: vault CR too low but cannot liquidate", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        const liquidator = await Liquidator.create(context, liquidatorAddress1);
        const fullAgentCollateral = toWei(3e8);
        const fullPoolCollateral = toWei(3e9);
        await agent.depositVaultCollateral(fullAgentCollateral);
        // Agent deposits 1e18 of wNat via enter method
        await agent.buyCollateralPoolTokens(toBNExp(1, 18));
        // Agent directly transfers wNat to collateral pool (large portion)
        await context.wNat.deposit({ value: fullPoolCollateral.sub(toBNExp(1, 18)), from: agentOwner1 });
        await context.wNat.transfer(agent.collateralPool.address, fullPoolCollateral.sub(toBNExp(1, 18)), { from: agentOwner1 });

        await agent.makeAvailable();
        await context.updateUnderlyingBlock();

        // Perform some minting on phantom collateral (not tracked by totalCollteral)
        const lots = 6;
        const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
        const txHash = await minter.performMintingPayment(crt);
        const minted = await minter.executeMinting(crt, txHash);

        // Simulate price change -> agent becomes liquidatable
        await agent.setVaultCollateralRatioByChangingAssetPrice(12000);
        // Get some f-assets for liquidator to perform liquidation
        await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });

        // Liquidator performs liquidation but fails due to artithmetic overflow
        const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
        await liquidator.liquidate(agent, liquidateMaxUBA1);
    });

    it("43711: solved vault CR too low but cannot liquidate - untracked pool collateral doesn't count for entering", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        const liquidator = await Liquidator.create(context, liquidatorAddress1);
        const fullAgentCollateral = toWei(3e8);
        const fullPoolCollateral = toWei(3e9);
        await agent.depositVaultCollateral(fullAgentCollateral);
        // Agent deposits 1e18 of wNat via enter method
        await agent.buyCollateralPoolTokens(toBNExp(1, 18));
        // Agent directly transfers wNat to collateral pool (large portion)
        await context.wNat.deposit({ value: fullPoolCollateral.sub(toBNExp(1, 18)), from: agentOwner1 });
        await context.wNat.transfer(agent.collateralPool.address, fullPoolCollateral.sub(toBNExp(1, 18)), { from: agentOwner1 });
        await expectRevert.custom(agent.makeAvailable(), "NotEnoughFreeCollateral", []);
    });

    it("43711: solved vault CR too low but cannot liquidate - untracked pool collateral doesn't count for minting", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        const liquidator = await Liquidator.create(context, liquidatorAddress1);
        const requiredCollateral = await agent.requiredCollateralForLots(1);
        await agent.depositVaultCollateral(requiredCollateral.vault.muln(10));
        // Agent correctly deposits enough to cover the pool token requirement, but not for collateral pool requirement
        await agent.buyCollateralPoolTokens(requiredCollateral.pool.muln(3));
        // Agent directly transfers wNat to collateral pool (large portion)
        await context.wNat.deposit({ value: requiredCollateral.pool.muln(10), from: agentOwner1 });
        await context.wNat.transfer(agent.collateralPool.address, requiredCollateral.pool.muln(10), { from: agentOwner1 });
        //
        await agent.makeAvailable();
        await context.updateUnderlyingBlock();
        // Perform some minting on phantom collateral (not tracked by totalCollteral)
        const lots = 6;
        await expectRevert.custom(minter.reserveCollateral(agent.vaultAddress, lots), "NotEnoughFreeCollateral", []);
    });

    it.skip("43753: agent can set very high buyFAssetByAgentFactorBIPS - original", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
        // buy half pool collateral as agent vault and the rest from agent's owner address
        const requiredCollateral = await agent.requiredCollateralForLots(10);
        await agent.depositCollateralsAndMakeAvailable(requiredCollateral.vault, requiredCollateral.pool.divn(2));
        await agent.collateralPool.enter({ from: agent.ownerWorkAddress, value: requiredCollateral.pool.divn(2) });
        //
        await minter.performMinting(agent.vaultAddress, 10);
        // agent buys 5 lots
        await minter.transferFAsset(agent.ownerWorkAddress, context.convertLotsToUBA(5));
        // agent changes buyFAssetByAgentFactorBIPS and poolExitCollateralRatioBIPS (to be able to do selfCloseExit)
        await agent.changeSettings({ buyFAssetByAgentFactorBIPS: toBIPS(6.4), poolExitCollateralRatioBIPS: toBIPS(3.5) });
        console.log(deepFormat(await agent.getAgentInfo()));
        // calculate how much to close
        const agentFAssets = await context.fAsset.balanceOf(agent.ownerWorkAddress);
        const agentPoolTokens = await agent.collateralPoolToken.balanceOf(agent.ownerWorkAddress);
        const requiredFAssets = await agent.collateralPool.fAssetRequiredForSelfCloseExit(agentPoolTokens);
        const toCloseTokens = agentPoolTokens.mul(agentFAssets).div(requiredFAssets)
        console.log(deepFormat({ agentFAssets, requiredFAssets, agentPoolTokens, toCloseTokens }));
        // do self close exit
        await context.fAsset.approve(agent.collateralPool.address, agentFAssets, { from: agent.ownerWorkAddress });
        await agent.collateralPool.selfCloseExit(toCloseTokens, true, "agent_owner_underlying", ZERO_ADDRESS, { from: agent.ownerWorkAddress });
        //context.priceStore.setCurrentPrice("")
        console.log(deepFormat(await agent.getAgentInfo()));
    });

    it("43753: agent can set very high buyFAssetByAgentFactorBIPS - fixed", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1000000));
        // buy half pool collateral as agent vault and the rest from agent's owner address
        const requiredCollateral = await agent.requiredCollateralForLots(10);
        await agent.depositCollateralsAndMakeAvailable(requiredCollateral.vault, requiredCollateral.pool.divn(2));
        await agent.collateralPool.enter({ from: agent.ownerWorkAddress, value: requiredCollateral.pool.divn(2) });
        //
        await minter.performMinting(agent.vaultAddress, 10);
        // agent buys 5 lots
        await minter.transferFAsset(agent.ownerWorkAddress, context.convertLotsToUBA(5));
        // agent changes buyFAssetByAgentFactorBIPS and poolExitCollateralRatioBIPS (to be able to do selfCloseExit)
        await expectRevert.custom(agent.changeSettings({ buyFAssetByAgentFactorBIPS: toBIPS(1.01) }), "ValueTooHigh", []);
    });

    it("43877: mint from free underlying of 0 lots fill redemption queue", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(100));
        const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
        await agent.depositCollateralLotsAndMakeAvailable(100);
        await agent2.depositCollateralLotsAndMakeAvailable(100);
        // mint 0 lots is now forbidden in mintFromFreeUnderlying (it is still allowed in selfMint, but it doesn't create tickets there)
        await expectRevert.custom(agent.mintFromFreeUnderlying(0), "CannotMintZeroLots", []);
        // // fill with empty tickets
        // for (let i = 0; i < 30; i++) {
        //     await agent.mintFromFreeUnderlying(0);
        //     await agent2.mintFromFreeUnderlying(0);
        // }
        // // serious mint
        // const [minted] = await minter.performMinting(agent.vaultAddress, 10);
        // await minter.transferFAsset(redeemer.address, minted.mintedAmountUBA);
        // //
        // // console.log(deepFormat(await context.getRedemptionQueue()));
        // // for (let i = 0; i < 4; i++) {
        // //     const [rdreqs, remaining] = await redeemer.requestRedemption(1);
        // //     console.log(deepFormat({ rdreqs, remaining }));
        // // }
        // const [rdreqs, remaining] = await redeemer.requestRedemption(1);
        // assertWeb3Equal(rdreqs.length, 1);
        // assertWeb3Equal(remaining, 0);
    });

    it("43879: increasing pool fee share during minting can make minter lose deposit", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(100));
        await agent.depositCollateralLotsAndMakeAvailable(100);
        // announce fee change
        const info = await agent.checkAgentInfo({});
        console.log('poolFeeShareBIPS before:', deepFormat(info.poolFeeShareBIPS));
        const newFeeShare = toBN(info.poolFeeShareBIPS).muln(11).divn(10);
        const res = await context.assetManager.announceAgentSettingUpdate(agent.vaultAddress, "poolFeeShareBIPS", newFeeShare, { from: agent.ownerWorkAddress });
        const announcement = requiredEventArgs(res, 'AgentSettingChangeAnnounced');
        await time.increaseTo(announcement.validAt);
        // reserve collateral and pay
        const crt = await minter.reserveCollateral(agent.vaultAddress, 10);
        const txHash = await minter.performMintingPayment(crt);
        // execute fee change
        await context.assetManager.executeAgentSettingUpdate(agent.vaultAddress, "poolFeeShareBIPS", { from: agent.ownerWorkAddress });
        // cannot execute minting
        const info2 = await agent.getAgentInfo();
        console.log('poolFeeShareBIPS after:', deepFormat(info2.poolFeeShareBIPS));
        const minted = await minter.executeMinting(crt, txHash);
        await agent.checkAgentInfo({ mintedUBA: toBN(minted.mintedAmountUBA).add(toBN(minted.poolFeeUBA)), reservedUBA: 0 });
    });

    it("43879: decreasing pool fee share during minting can create stuck reserved amount", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(100));
        await agent.depositCollateralLotsAndMakeAvailable(100);
        // announce fee change
        const info = await agent.checkAgentInfo({});
        console.log('poolFeeShareBIPS before:', deepFormat(info.poolFeeShareBIPS));
        const newFeeShare = toBN(info.poolFeeShareBIPS).muln(9).divn(10);
        const res = await context.assetManager.announceAgentSettingUpdate(agent.vaultAddress, "poolFeeShareBIPS", newFeeShare, { from: agent.ownerWorkAddress });
        const announcement = requiredEventArgs(res, 'AgentSettingChangeAnnounced');
        await time.increaseTo(announcement.validAt);
        // reserve collateral and pay
        const crt = await minter.reserveCollateral(agent.vaultAddress, 10);
        const txHash = await minter.performMintingPayment(crt);
        // execute fee change
        await context.assetManager.executeAgentSettingUpdate(agent.vaultAddress, "poolFeeShareBIPS", { from: agent.ownerWorkAddress });
        // cannot execute minting
        const info2 = await agent.getAgentInfo();
        console.log('poolFeeShareBIPS after:', deepFormat(info2.poolFeeShareBIPS));
        const minted = await minter.executeMinting(crt, txHash);
        await agent.checkAgentInfo({ mintedUBA: toBN(minted.mintedAmountUBA).add(toBN(minted.poolFeeUBA)), reservedUBA: 0 });
    });

    it("43753: agent can mint unbacked fassets by increasing fee and poolFeeShare", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        await agent.depositCollateralLotsAndMakeAvailable(20, 1);
        await agent.changeSettings({ feeBIPS: 10000, poolFeeShareBIPS: 10000 });
        await agent.selfMint(context.convertLotsToUBA(20), 10);
        const info = await agent.getAgentInfo();
        // ATTACK result:
        // assert.isTrue(toBN(info.vaultCollateralRatioBIPS).ltn(MAX_BIPS));
        // assertWeb3Equal(info.vaultCollateralRatioBIPS, toBN(info.mintingVaultCollateralRatioBIPS).divn(2));
        // FIXED:
        assert.isTrue(toBN(info.vaultCollateralRatioBIPS).gte(toBN(info.mintingVaultCollateralRatioBIPS)));
        // console.log(deepFormat(info));
    });

    it("43753: others can mint unbacked fassets if agent increases fee and poolFeeShare", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(100));
        await agent.depositCollateralLotsAndMakeAvailable(20, 1);
        await agent.changeSettings({ feeBIPS: 10000, poolFeeShareBIPS: 10000 });
        await minter.performMinting(agent.vaultAddress, 10);
        const info = await agent.getAgentInfo();
        // ATTACK result:
        // assert.isTrue(toBN(info.vaultCollateralRatioBIPS).ltn(MAX_BIPS));
        // assertWeb3Equal(info.vaultCollateralRatioBIPS, toBN(info.mintingVaultCollateralRatioBIPS).divn(2));
        // FIXED:
        assert.isTrue(toBN(info.vaultCollateralRatioBIPS).gte(toBN(info.mintingVaultCollateralRatioBIPS)));
        // console.log(deepFormat({ balance: await context.chain.getBalance(minter.underlyingAddress) }));
        // console.log(deepFormat(info));
    });

    it("45904: malicious agent can force a default on minter if payment is not proved inside payment window - fixed", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
        // make agent available
        const fullAgentCollateral = toWei(3e8);
        await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
        // update block
        await context.updateUnderlyingBlock();

        // Reserve collateral, non-handshake type
        const lots = 3;
        const crt = await minter.reserveCollateral(agent.vaultAddress, lots);

        // Perform valid payment within time window
        // minter.performMintingPayment always perform a valid payment
        const txHash = await minter.performMintingPayment(crt);
        // Mine some blocks
        for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
            await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
        }

        // Time has now passed beyond payment window
        // Request a proof of non-payment existence, but specify the source as bytes32(0)
        const proof = await context.attestationProvider.proveReferencedPaymentNonexistence(
            agent.underlyingAddress,
            crt.paymentReference,
            crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(),
            crt.lastUnderlyingBlock.toNumber(),
            crt.lastUnderlyingTimestamp.toNumber(),
            "0x0000000000000000000000000000000000000000000000000000000000000000");
        // The proof is generated, and indication that FDC doesn't find matching transaction despite the fact that there is one
        // Malicious agent cannot invoke `mintingPaymentDefault` anymore
        await expectRevert.custom(context.assetManager.mintingPaymentDefault(proof, crt.collateralReservationId, { from: agent.ownerWorkAddress }), "SourceAddressesNotSupported", []);
    });

    it("45893: agent steals collateral pool NAT with malicious distribution to delegators / reward manager", async () => {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(100));
        const victim = accounts[83]

        // make agent available and give some backing
        await agent.depositCollateralLotsAndMakeAvailable(20, 1);
        await minter.performMinting(agent.vaultAddress, 10);

        // enter agent's collateral pool
        await agent.collateralPool.enter({ from: minter.address, value: toBNExp(1, 24) });

        // victim enters the pool
        await agent.collateralPool.enter({ value: toBNExp(1, 21), from: victim });
        const victimNatBefore = await agent.poolNatBalanceOf(victim);
        console.log("victim nat:", victimNatBefore.toString());

        // claim by using mock airdrop
        const maliciousDistributionToDelegatorsMockFactory = artifacts.require('MaliciousDistributionToDelegators');
        const maliciousDistributionToDelegatorsMock = await maliciousDistributionToDelegatorsMockFactory.new(toBNExp(1, 24));
        await agent.collateralPool.claimAirdropDistribution(maliciousDistributionToDelegatorsMock.address, 1,
            { from: agent.ownerWorkAddress });

        // claim using mock delegation
        const maliciousRewardManagerFactory = artifacts.require('MaliciousRewardManager');
        const maliciousRewardManager = await maliciousRewardManagerFactory.new(toBNExp(1, 24));
        await agent.collateralPool.claimDelegationRewards(maliciousRewardManager.address, 0, [],
            { from: agent.ownerWorkAddress});

        // victim exits the pool
        const victimNatAfter = await agent.poolNatBalanceOf(victim);
        console.log("victim nat:", victimNatAfter.toString())
        //await agent.collateralPool.exit(tokens.toString(), 0, { from: victim });

        console.log("victim nat diff:", victimNatAfter.sub(victimNatBefore).toString());
        assertWeb3Equal(victimNatBefore, victimNatAfter)
    });
});
