import { CollateralReservationStatus } from "../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { calculateReceivedNat } from "../../../lib/test-utils/eth";
import { MockChain, MockChainWallet } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { BN_ZERO, checkedCast, DAYS, MAX_BIPS, toBN, toWei } from "../../../lib/utils/helpers";

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

    describe("simple scenarios - minting default", () => {
        it("mint defaults - no underlying payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // mine a block to skip the agent creation time
            mockChain.mine();
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // test rewarding for mint default
            const startBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const startBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const startTotalCollateralPool = await agent.collateralPool.totalCollateral();
            await agent.mintingPaymentDefault(crt);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: 0, mintedUBA: 0 });
            const endBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const endBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const endTotalCollateralPool = await agent.collateralPool.totalCollateral();
            const poolFee = crFee.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(endBalanceAgent.sub(startBalanceAgent), crFee.sub(poolFee));
            assertWeb3Equal(endBalancePool.sub(startBalancePool), poolFee);
            assertWeb3Equal(endTotalCollateralPool.sub(startTotalCollateralPool), poolFee);
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.DEFAULTED);
            // check that executing minting after calling mintingPaymentDefault will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });

        it("mint defaults - failed underlying payment", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // perform some payment with correct minting reference and wrong amount
            await minter.performPayment(crt.paymentAddress, 100, crt.paymentReference);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // test rewarding for mint default
            const startBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const startBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const startTotalCollateralPool = await agent.collateralPool.totalCollateral();
            await agent.mintingPaymentDefault(crt);
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral, freeUnderlyingBalanceUBA: 0, mintedUBA: 0 });
            const endBalanceAgent = await context.wNat.balanceOf(agent.ownerWorkAddress);
            const endBalancePool = await context.wNat.balanceOf(agent.collateralPool.address);
            const endTotalCollateralPool = await agent.collateralPool.totalCollateral();
            const poolFee = crFee.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(endBalanceAgent.sub(startBalanceAgent), crFee.sub(poolFee));
            assertWeb3Equal(endBalancePool.sub(startBalancePool), poolFee);
            assertWeb3Equal(endTotalCollateralPool.sub(startTotalCollateralPool), poolFee);
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.DEFAULTED);
            // check that executing minting after calling mintingPaymentDefault will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral);
        });
    });

    describe("simple scenarios - unstick minting", () => {
        it("mint unstick - no underlying payment", async () => {
            mockFlareDataConnectorClient.queryWindowSeconds = 300;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling unstickMinting after no payment will revert if called too soon
            await expectRevert.custom(agent.unstickMinting(crt), "CannotUnstickMintingYet", []);
            await time.deterministicIncrease(DAYS);
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: 0,
                mintedUBA: 0,
                reservedUBA: context.convertLotsToUBA(lots).add(agent.poolFeeShare(crt.feeUBA))
            });
            // test rewarding for unstick default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const burnAddress = (await context.assetManager.getSettings()).burnAddress;
            const startBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            await agent.unstickMinting(crt);
            const endBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            // check that vault collateral was unreserved and given to agent owner
            const vaultCollateralPrice = await context.getCollateralPrice(agent.vaultCollateral());
            const reservedCollateral = vaultCollateralPrice.convertAmgToTokenWei(context.convertLotsToAMG(lots));
            assertWeb3Equal(startBalanceAgent.sub(endBalanceAgent), reservedCollateral);
            assertWeb3Equal(await vaultCollateralToken.balanceOf(agent.ownerWorkAddress), reservedCollateral);
            assert(reservedCollateral.gt(BN_ZERO));
            // check that fee and nat worth of reserved collateral (plus premium) were burned
            const burnedNAT = await agent.vaultCollateralToNatBurned(reservedCollateral);
            assertWeb3Equal(endBalanceBurnAddress.sub(startBalanceBurnAddress), burnedNAT.add(crFee));
            await agent.checkAgentInfo({ totalVaultCollateralWei: fullAgentCollateral.sub(reservedCollateral), freeUnderlyingBalanceUBA: 0, mintedUBA: 0, reservedUBA: 0 });
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.EXPIRED);
            // check that executing minting after calling unstickMinting will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(reservedCollateral));
        });

        it("mint unstick - failed underlying payment", async () => {
            mockFlareDataConnectorClient.queryWindowSeconds = 300;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // perform some payment with correct minting reference and wrong amount
            await minter.performPayment(crt.paymentAddress, 100, crt.paymentReference);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling unstickMinting after failed minting payment will revert if called too soon
            await expectRevert.custom(agent.unstickMinting(crt), "CannotUnstickMintingYet", []);
            await time.deterministicIncrease(DAYS);
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            // test rewarding for unstick default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const burnAddress = (await context.assetManager.getSettings()).burnAddress;
            const startBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            await agent.unstickMinting(crt);
            const endBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            // check that vault collateral was unreserved and given to agent owner
            const vaultCollateralPrice = await context.getCollateralPrice(agent.vaultCollateral());
            const reservedCollateral = vaultCollateralPrice.convertAmgToTokenWei(context.convertLotsToAMG(lots));
            assertWeb3Equal(startBalanceAgent.sub(endBalanceAgent), reservedCollateral);
            assertWeb3Equal(await vaultCollateralToken.balanceOf(agent.ownerWorkAddress), reservedCollateral);
            assert(reservedCollateral.gt(BN_ZERO));
            // check that fee and nat worth of reserved collateral (plus premium) were burned
            const burnedNAT = await agent.vaultCollateralToNatBurned(reservedCollateral);
            assertWeb3Equal(endBalanceBurnAddress.sub(startBalanceBurnAddress), burnedNAT.add(crFee));
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.EXPIRED);
            // check that executing minting after calling unstickMinting will revert
            const txHash = await minter.performMintingPayment(crt);
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(reservedCollateral));
        });

        it("mint unstick - unconfirmed underlying payment", async () => {
            mockFlareDataConnectorClient.queryWindowSeconds = 300;
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform collateral
            const lots = 3;
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            // perform minting payment without sending proof
            const txHash = await minter.performMintingPayment(crt);
            await context.attestationProvider.provePayment(txHash, minter.underlyingAddress, crt.paymentAddress);
            // mine some blocks to create overflow block
            for (let i = 0; i <= context.chainInfo.underlyingBlocksForPayment + 10; i++) {
                await minter.wallet.addTransaction(minter.underlyingAddress, minter.underlyingAddress, 1, null);
            }
            // check that calling unstickMinting after unconfirmed payment will revert if called too soon
            await expectRevert.custom(agent.unstickMinting(crt), "CannotUnstickMintingYet", []);
            await time.deterministicIncrease(DAYS);
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            // test rewarding for unstick default
            const vaultCollateralToken = agent.vaultCollateralToken();
            const burnAddress = (await context.assetManager.getSettings()).burnAddress;
            const startBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const startBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            await agent.unstickMinting(crt);
            const endBalanceAgent = await vaultCollateralToken.balanceOf(agent.agentVault.address);
            const endBalanceBurnAddress = toBN(await web3.eth.getBalance(burnAddress));
            // check that vault collateral was unreserved and given to agent owner
            const vaultCollateralPrice = await context.getCollateralPrice(agent.vaultCollateral());
            const reservedCollateral = vaultCollateralPrice.convertAmgToTokenWei(context.convertLotsToAMG(lots));
            assertWeb3Equal(startBalanceAgent.sub(endBalanceAgent), reservedCollateral);
            assertWeb3Equal(await vaultCollateralToken.balanceOf(agent.ownerWorkAddress), reservedCollateral);
            assert(reservedCollateral.gt(BN_ZERO));
            // check that fee and nat worth of reserved collateral (plus premium) were burned
            const burnedNAT = await agent.vaultCollateralToNatBurned(reservedCollateral);
            assertWeb3Equal(endBalanceBurnAddress.sub(startBalanceBurnAddress), burnedNAT.add(crFee));
            // check the final minting status
            const crinfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crinfo.status, CollateralReservationStatus.EXPIRED);
            // check that executing minting after calling unstickMinting will revert
            await expectRevert.custom(minter.executeMinting(crt, txHash), "InvalidCrtId", []);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(reservedCollateral));
        });

        it("should unstick minting even if price changed so much that there is not enough collateral", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralLotsAndMakeAvailable(2);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            // expire a minting
            const crt = await minter.reserveCollateral(agent.vaultAddress, 1);
            const crt2 = await minter.reserveCollateral(agent.vaultAddress, 1);
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            // descrease vault collateral price by factor 4 - now there won't be enough vault collateral
            const { 0: price } = await context.priceStore.getPrice("USDC");
            await context.priceStore.setCurrentPrice("USDC", price.divn(4), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("USDC", price.divn(4), 0);
            //
            const info0 = await agent.getAgentInfo();
            // prepare for unstick
            const proof = await context.attestationProvider.proveConfirmedBlockHeightExists(Number(context.settings.attestationWindowSeconds));
            const agentCollateral = await agent.getAgentCollateral();
            const burnNats = agentCollateral.pool.convertUBAToTokenWei(crt.valueUBA)
                .mul(toBN(context.settings.vaultCollateralBuyForFlareFactorBIPS)).divn(MAX_BIPS);
            // unstick first minting
            const ownerVaultCBefore = await context.usdc.balanceOf(agent.ownerWorkAddress);
            const res1 = await context.assetManager.unstickMinting(proof, crt.collateralReservationId, { from: agent.ownerWorkAddress, value: burnNats });
            const burnedNats1 = (await calculateReceivedNat(res1, agent.ownerWorkAddress)).neg();
            const ownerVaultCAfter = await context.usdc.balanceOf(agent.ownerWorkAddress);
            // calculate what should be returned and what burned
            const returnedVaultC = ownerVaultCAfter.sub(ownerVaultCBefore);
            const shouldBurnNats1 = returnedVaultC
                .mul(agentCollateral.pool.amgPrice.amgToTokenWei)
                .div(agentCollateral.vault.amgPrice.amgToTokenWei)
                .mul(toBN(context.settings.vaultCollateralBuyForFlareFactorBIPS)).divn(MAX_BIPS);
            // check
            assertWeb3Equal(burnedNats1, shouldBurnNats1);
            assertWeb3Equal(returnedVaultC, toBN(info0.totalVaultCollateralWei).divn(2)); // half is burned on first unstick
            // unstick second minting
            await context.assetManager.unstickMinting(proof, crt2.collateralReservationId, { from: agent.ownerWorkAddress, value: burnNats });
            const info2 = await agent.getAgentInfo();
            assertWeb3Equal(info2.totalVaultCollateralWei, 0);  // now everything is burned
        });
    });

    describe("simple scenarios - confirm closed minting payment", () => {
        let agent: Agent;
        let minter: Minter;

        beforeEach(async () => {
            agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralLotsAndMakeAvailable(10);
            minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmountLots(10));
            mockChain.mine(3);
            await context.updateUnderlyingBlock();
        });

        it("should confirm late payment after minting default and make it free underlying", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // perform late payment
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const tx = await minter.performMintingPayment(crt);
            // cannot confirm closed minting payment when minting is still active (even if the payment time has expired)
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx), "InvalidCollateralReservationStatus", []);
            // payment was too late, so the agent can default
            await agent.mintingPaymentDefault(crt);
            // payment was done, but isn't recorded
            await agent.checkAgentInfo({
                freeUnderlyingBalanceUBA: 0,
                actualUnderlyingBalance: paymentAmount
            });
            // now the agent can confirm late payment and make it free underlying
            const res = await agent.confirmClosedMintingPayment(crt, tx);
            // check
            assertWeb3Equal(res.depositedUBA, paymentAmount);
            await agent.checkAgentInfo({
                freeUnderlyingBalanceUBA: paymentAmount,
                actualUnderlyingBalance: paymentAmount,
            });
        });

        it("should confirm too small payment after minting default and make it free underlying", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // perform too small payment (missing minting fee)
            const paymentAmount = crt.valueUBA;
            const tx = await minter.performPayment(crt.paymentAddress, paymentAmount, crt.paymentReference);
            // cannot confirm closed minting payment when minting is still active
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx), "InvalidCollateralReservationStatus", []);
            // payment was too small, so the agent can default after the time expires
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await agent.mintingPaymentDefault(crt);
            // now the agent can confirm late payment and make it free underlying
            const res = await agent.confirmClosedMintingPayment(crt, tx);
            // check
            assertWeb3Equal(res.depositedUBA, paymentAmount);
            await agent.checkAgentInfo({
                freeUnderlyingBalanceUBA: paymentAmount,
                actualUnderlyingBalance: paymentAmount,
            });
        });

        it("should confirm duplicate payment even if the minting was executed successfuly", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // perform two payments by accident
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const tx1 = await minter.performMintingPayment(crt);
            const tx2 = await minter.performMintingPayment(crt);
            // cannot confirm closed minting payment when minting is still active
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx1), "InvalidCollateralReservationStatus", []);
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx2), "InvalidCollateralReservationStatus", []);
            // any of the payments is ok and it can be executed
            const minted = await minter.executeMinting(crt, tx1);
            // check before confirmong second transaction
            await agent.checkAgentInfo({
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                requiredUnderlyingBalanceUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                actualUnderlyingBalance: paymentAmount.muln(2),
            }, "reset");
            // agent cannot confirm the payment that was used for executing minting
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx1), "PaymentAlreadyConfirmed", []);
            // ... but can confirm the second payment
            const res = await agent.confirmClosedMintingPayment(crt, tx2);
            // check
            assertWeb3Equal(res.depositedUBA, paymentAmount);
            await agent.checkAgentInfo({
                freeUnderlyingBalanceUBA: paymentAmount.add(minted.agentFeeUBA),
                requiredUnderlyingBalanceUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                actualUnderlyingBalance: paymentAmount.muln(2),
            }, "reset");
        });

        it("only agent can confirm closed minting payment", async () => {
            const executor = accounts[35];
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5, executor, 100);
            // perform late payment
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            const tx = await minter.performMintingPayment(crt);
            await agent.mintingPaymentDefault(crt);
            // it fails for minter or executor (or any other address)
            const proof = await context.attestationProvider.provePayment(tx, null, crt.paymentAddress);
            await expectRevert.custom(context.assetManager.confirmClosedMintingPayment(proof, crt.collateralReservationId, { from: minter.address }),
                "OnlyAgentVaultOwner", []);
            await expectRevert.custom(context.assetManager.confirmClosedMintingPayment(proof, crt.collateralReservationId, { from: executor }),
                "OnlyAgentVaultOwner", []);
            // it works for agent
            await agent.confirmClosedMintingPayment(crt, tx);
        });

        it("closed minting payment cannot be confirmed twice", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // perform late payment
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            const tx = await minter.performMintingPayment(crt);
            await agent.mintingPaymentDefault(crt);
            // confirming it first time works
            await agent.confirmClosedMintingPayment(crt, tx);
            // the second time fails
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx), "PaymentAlreadyConfirmed", []);
        });

        it("closed minting payment needs correct payment reference", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // perform payment with wrong reference
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const tx = await minter.performPayment(crt.paymentAddress, paymentAmount, PaymentReference.minting(crt.collateralReservationId.addn(1)));
            // can default, because payment doesn't have correct reference
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await agent.mintingPaymentDefault(crt);
            // but cannot confirm this payment for this closed minting
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx), "InvalidMintingReference", []);
        });

        it("closed minting payment needs to be made to the agent vault's underlying address", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // perform payment with wrong target address
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const tx = await minter.performPayment(underlyingAgent2, paymentAmount, crt.paymentReference);
            // can default, because payment isn;t to the agent's address
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await agent.mintingPaymentDefault(crt);
            // but cannot confirm this payment for this closed minting
            const proof = await context.attestationProvider.provePayment(tx, null, underlyingAgent2);
            await expectRevert.custom(context.assetManager.confirmClosedMintingPayment(proof, crt.collateralReservationId, { from: agent.ownerWorkAddress }),
                "NotMintingAgentsAddress", []);
        });

        it("closed minting payment cannot be too old", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // simulate performing payment before first payment block
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const wallet = checkedCast(minter.wallet, MockChainWallet);
            const tx = wallet.createTransaction(minter.underlyingAddress, crt.paymentAddress, paymentAmount, crt.paymentReference);
            mockChain.modifyMinedBlock(Number(crt.firstUnderlyingBlock) - 1, block => { block.transactions.push(tx); });
            // cannot execute the payment because it is too old
            await expectRevert.custom(minter.executeMinting(crt, tx.hash), "MintingPaymentTooOld", []);
            // can default, because payment is too old
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await agent.mintingPaymentDefault(crt);
            // but cannot confirm this payment for this closed minting
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx.hash), "MintingPaymentTooOld", []);
        });
    });
});
