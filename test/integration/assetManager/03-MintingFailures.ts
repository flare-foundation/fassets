import { CollateralReservationStatus } from "../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { xrplClassicAddress } from "../../../lib/test-utils/canonical-addresses";
import { calculateReceivedNat } from "../../../lib/test-utils/eth";
import { MockChain, MockChainWallet } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { assignForbiddenAddressList, forbidFlareAddresses } from "../../../lib/test-utils/test-settings";
import { requiredEventArgs } from "../../../lib/utils/events/truffle";
import { EventArgs } from "../../../lib/utils/events/common";
import { BN_ZERO, BNish, checkedCast, DAYS, MAX_BIPS, toBN, toWei, ZERO_ADDRESS } from "../../../lib/utils/helpers";
import { ForbiddenAddressListMockInstance } from "../../../typechain-truffle";
import { CollateralReserved } from "../../../typechain-truffle/IIAssetManager";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests - minting failures`, accounts => {
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

        it("should not confirm payment after unstick minting as free underlying", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 5);
            // perform too small payment (missing minting fee)
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const tx = await minter.performPayment(crt.paymentAddress, paymentAmount, crt.paymentReference);
            // cannot confirm closed minting payment when minting is still active
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx), "InvalidCollateralReservationStatus", []);
            // wait for FDC proof expiration and unstick minting
            context.skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await time.deterministicIncrease(DAYS);
            await agent.unstickMinting(crt);
            // make sure status is expired
            const crtInfo = await context.assetManager.collateralReservationInfo(crt.collateralReservationId);
            assertWeb3Equal(crtInfo.status, CollateralReservationStatus.EXPIRED);
            // but still cannot confirm
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, tx), "InvalidCollateralReservationStatus", []);
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
    describe("forbidden addresses - executeMinting refuses, the agent releases", () => {
        // `executeMinting` refuses a payment from a forbidden underlying address, or for a forbidden minter. The agent
        // can then release the reservation with `releaseMintingWithForbiddenPayment`, presenting a genuine, full payment proof, not
        // older than the reservation: nothing is minted, the reservation is released (status FORBIDDEN), the payment is spent but left
        // unaccounted, and the collateral reservation fee and the executor fee go to the agent and the pool, as on a
        // payment default. The release waits until the payment time and `confirmationByOthersAfterSeconds` are over,
        // so that the minter can still execute their own payment; the same wait applies to a forbidden minter.
        // The list keeps string lists only under BTC and XRP source ids (this file's `ETH` chain would revert
        // `UnsupportedSourceId` on every check), so these tests run on an XRP asset manager - the agent-backed chain -
        // and list a real-format XRPL classic address (the only form the real list takes).
        const forbiddenPayer = xrplClassicAddress("ForbiddenPayer");
        const executorAddress = accounts[35];
        let agent: Agent;
        let minter: Minter;
        let forbiddenAddressList: ForbiddenAddressListMockInstance;

        beforeEach(async () => {
            context = await AssetContext.createTest(commonContext, testChainInfo.xrp);
            mockChain = context.chain as MockChain;
            agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            await agent.depositCollateralLotsAndMakeAvailable(10);
            minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmountLots(10));
            mockChain.mint(forbiddenPayer, context.underlyingAmountLots(10));
            mockChain.mine(3);
            await context.updateUnderlyingBlock();
            forbiddenAddressList = await assignForbiddenAddressList(context.assetManager);
            await forbiddenAddressList.addForbiddenAddresses(context.chainInfo.chainId, [forbiddenPayer], { from: governance });
        });

        async function payFrom(source: string, crt: EventArgs<CollateralReserved>, amount: BNish = crt.valueUBA.add(crt.feeUBA),
            reference: string | null = crt.paymentReference) {
            return await minter.wallet.addTransaction(source, crt.paymentAddress, amount, reference);
        }

        async function executeMinting(crt: EventArgs<CollateralReserved>, txHash: string, from: string) {
            const proof = await context.attestationProvider.provePayment(txHash, null, crt.paymentAddress);
            return await context.assetManager.executeMinting(proof, crt.collateralReservationId, { from });
        }

        async function release(txHash: string, from: string = agent.ownerWorkAddress) {
            const proof = await context.attestationProvider.provePayment(txHash, null, agent.underlyingAddress);
            return await context.assetManager.releaseMintingWithForbiddenPayment(proof, { from });
        }

        /** Past the payment time and `confirmationByOthersAfterSeconds`, with the asset manager's underlying block updated. */
        async function skipPastReleaseGate(crt: EventArgs<CollateralReserved>) {
            const margin = Number(context.settings.confirmationByOthersAfterSeconds);
            context.skipToExpiration(crt.lastUnderlyingBlock, toBN(crt.lastUnderlyingTimestamp).addn(margin));
            await context.updateUnderlyingBlock();
        }

        async function fees() {
            return {
                agent: await context.wNat.balanceOf(agent.ownerWorkAddress),
                pool: await context.wNat.balanceOf(agent.collateralPool.address),
                poolTotalCollateral: await agent.collateralPool.totalCollateral(),
            };
        }

        async function checkFeesDistributed(before: Awaited<ReturnType<typeof fees>>, totalFee: BN) {
            const after = await fees();
            const poolFee = totalFee.mul(toBN(agent.settings.poolFeeShareBIPS)).divn(MAX_BIPS);
            assertWeb3Equal(after.agent.sub(before.agent), totalFee.sub(poolFee));
            assertWeb3Equal(after.pool.sub(before.pool), poolFee);
            assertWeb3Equal(after.poolTotalCollateral.sub(before.poolTotalCollateral), poolFee);
        }

        async function crtStatus(crt: EventArgs<CollateralReserved>) {
            return (await context.assetManager.collateralReservationInfo(crt.collateralReservationId)).status;
        }

        it("a full payment from an unlisted source still mints, with the list set; it cannot be released", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const txHash = await minter.performMintingPayment(crt);
            await skipPastReleaseGate(crt);
            await expectRevert.custom(release(txHash), "MintingPaymentNotForbidden", []);
            const minted = await minter.executeMinting(crt, txHash);
            assertWeb3Equal(minted.mintedAmountUBA, crt.valueUBA);
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.SUCCESSFUL);
            // the executed reservation is closed
            await expectRevert.custom(release(txHash), "InvalidCrtId", []);
        });

        it("executeMinting refuses a payment from a forbidden source, for the minter, the executor and the agent alike", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2, executorAddress, toWei(1));
            const txHash = await payFrom(forbiddenPayer, crt);
            for (const caller of [minter.address, executorAddress, agent.ownerWorkAddress]) {
                await expectRevert.custom(executeMinting(crt, txHash, caller), "ForbiddenSourceAddress", []);
            }
            // also after the payment time: it is not released automatically
            await skipPastReleaseGate(crt);
            for (const caller of [minter.address, executorAddress, agent.ownerWorkAddress]) {
                await expectRevert.custom(executeMinting(crt, txHash, caller), "ForbiddenSourceAddress", []);
            }
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.ACTIVE);
            await agent.checkAgentInfo({ reservedUBA: crt.valueUBA.add(agent.poolFeeShare(crt.feeUBA)) });
        });

        it("the agent releases a reservation paid from a forbidden source after the gate: nothing minted, nothing accounted, fees to agent and pool", async () => {
            const lots = 2;
            const freeLotsBefore = toBN((await agent.getAgentInfo()).freeCollateralLots);
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const txHash = await payFrom(forbiddenPayer, crt);
            // the minter is not forbidden, so the release waits for the gate
            await expectRevert.custom(release(txHash), "ForbiddenMintingReleaseTooEarly", []);
            await skipPastReleaseGate(crt);
            // only the agent vault owner releases
            await expectRevert.custom(release(txHash, minter.address), "OnlyAgentVaultOwner", []);
            const before = await fees();
            const res = await release(txHash, agent.ownerManagementAddress);
            const released = requiredEventArgs(res, "MintingPaymentForbidden");
            assertWeb3Equal(released.agentVault, agent.vaultAddress);
            assertWeb3Equal(released.minter, minter.address);
            assertWeb3Equal(released.collateralReservationId, crt.collateralReservationId);
            assertWeb3Equal(released.transactionId, txHash);
            assertWeb3Equal(released.receivedAmountUBA, paymentAmount);
            assertWeb3Equal(released.reservedAmountUBA, crt.valueUBA.add(agent.poolFeeShare(crt.feeUBA)));
            // nothing minted, and the payment is on the agent's address but not in its recorded balance
            assertWeb3Equal(await context.fAsset.balanceOf(minter.address), 0);
            assertWeb3Equal(await context.fAsset.totalSupply(), 0);
            await agent.checkAgentInfo({ mintedUBA: 0, reservedUBA: 0, underlyingBalanceUBA: 0, freeUnderlyingBalanceUBA: 0,
                actualUnderlyingBalance: paymentAmount });
            // the collateral is free again
            assertWeb3Equal((await agent.getAgentInfo()).freeCollateralLots, freeLotsBefore);
            // the collateral reservation fee went to the agent and the pool
            await checkFeesDistributed(before, crFee);
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.FORBIDDEN);
            // the reservation is closed, and the forbidden payment cannot be turned into free underlying: a FORBIDDEN
            // reservation is refused by confirmClosedMintingPayment, as an EXPIRED one is
            await expectRevert.custom(release(txHash), "InvalidCrtId", []);
            await expectRevert.custom(executeMinting(crt, txHash, agent.ownerWorkAddress), "InvalidCrtId", []);
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, txHash), "InvalidCollateralReservationStatus", []);
            // ... not even after the source is removed from the list
            await forbiddenAddressList.removeForbiddenAddresses(context.chainInfo.chainId, [forbiddenPayer], { from: governance });
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, txHash), "InvalidCollateralReservationStatus", []);
            // the agent can exit and destroy its vault
            await agent.exitAndDestroy();
        });

        it("the release gate's timestamp condition: past the last payment block and timestamp, but not the margin", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const txHash = await payFrom(forbiddenPayer, crt);
            const margin = Number(context.settings.confirmationByOthersAfterSeconds);
            // past the payment time (both the block and the timestamp), but not the margin
            context.skipToExpiration(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            await context.updateUnderlyingBlock();
            assert.isTrue(toBN((await context.assetManager.currentUnderlyingBlock())[0]).gt(toBN(crt.lastUnderlyingBlock)));
            await expectRevert.custom(release(txHash), "ForbiddenMintingReleaseTooEarly", []);
            // shortly before the margin passes
            mockChain.skipTimeTo(Number(crt.lastUnderlyingTimestamp) + margin - 20 * mockChain.secondsPerBlock);
            mockChain.mine(mockChain.finalizationBlocks);
            await context.updateUnderlyingBlock();
            assert.isTrue(toBN((await context.assetManager.currentUnderlyingBlock())[1]).lte(toBN(crt.lastUnderlyingTimestamp).addn(margin)));
            await expectRevert.custom(release(txHash), "ForbiddenMintingReleaseTooEarly", []);
            // past it
            await skipPastReleaseGate(crt);
            requiredEventArgs(await release(txHash), "MintingPaymentForbidden");
        });

        it("the release gate's block condition alone: the timestamp margin passed but not the last payment block", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const txHash = await payFrom(forbiddenPayer, crt);
            const margin = Number(context.settings.confirmationByOthersAfterSeconds);
            // the underlying time jumps past the last payment timestamp plus the margin, in a few blocks only
            mockChain.skipTimeTo(Number(crt.lastUnderlyingTimestamp) + margin + 1);
            mockChain.mine(mockChain.finalizationBlocks);
            await context.updateUnderlyingBlock();
            const current = await context.assetManager.currentUnderlyingBlock();
            assert.isTrue(toBN(current[1]).gt(toBN(crt.lastUnderlyingTimestamp).addn(margin)));
            assert.isTrue(toBN(current[0]).lte(toBN(crt.lastUnderlyingBlock)));
            await expectRevert.custom(release(txHash), "ForbiddenMintingReleaseTooEarly", []);
            // past the last payment block too: the release goes through
            mockChain.mineTo(Number(crt.lastUnderlyingBlock) + 1);
            mockChain.mine(mockChain.finalizationBlocks);
            await context.updateUnderlyingBlock();
            assert.isTrue(toBN((await context.assetManager.currentUnderlyingBlock())[0]).gt(toBN(crt.lastUnderlyingBlock)));
            requiredEventArgs(await release(txHash), "MintingPaymentForbidden");
        });

        it("a forbidden minter's payment is refused whoever executes it; the agent releases after the gate, and the executor fee goes to the agent and the pool too", async () => {
            const lots = 2;
            const executorFee = toWei(1);
            const crFee = await minter.getCollateralReservationFee(lots);
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots, executorAddress, executorFee);
            // the minter is forbidden after the reservation; the payment is from a clean address
            await forbidFlareAddresses(context.assetManager, forbiddenAddressList, [minter.address]);
            const txHash = await minter.performMintingPayment(crt);
            for (const caller of [minter.address, executorAddress, agent.ownerWorkAddress]) {
                await expectRevert.custom(executeMinting(crt, txHash, caller), "ForbiddenFlareAddress", [minter.address]);
            }
            // only the agent vault owner releases, not the executor
            await expectRevert.custom(release(txHash, executorAddress), "OnlyAgentVaultOwner", []);
            // the release waits for the gate, although the minter is forbidden
            await expectRevert.custom(release(txHash), "ForbiddenMintingReleaseTooEarly", []);
            await skipPastReleaseGate(crt);
            const before = await fees();
            const executorBefore = await context.wNat.balanceOf(executorAddress);
            const released = await agent.releaseMintingWithForbiddenPayment(txHash);
            assertWeb3Equal(released.minter, minter.address);
            assertWeb3Equal(released.receivedAmountUBA, crt.valueUBA.add(crt.feeUBA));
            assertWeb3Equal(await context.fAsset.totalSupply(), 0);
            await agent.checkAgentInfo({ mintedUBA: 0, reservedUBA: 0, underlyingBalanceUBA: 0, freeUnderlyingBalanceUBA: 0 });
            // the executor gets nothing; its fee is shared like the reservation fee
            assertWeb3Equal(await context.wNat.balanceOf(executorAddress), executorBefore);
            await checkFeesDistributed(before, crFee.add(executorFee));
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.FORBIDDEN);
        });

        it("a forbidden minter paying from a forbidden source is refused as a forbidden minter; the agent releases after the gate", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            await forbidFlareAddresses(context.assetManager, forbiddenAddressList, [minter.address]);
            const txHash = await payFrom(forbiddenPayer, crt);
            await expectRevert.custom(executeMinting(crt, txHash, minter.address), "ForbiddenFlareAddress", [minter.address]);
            await expectRevert.custom(release(txHash), "ForbiddenMintingReleaseTooEarly", []);
            await skipPastReleaseGate(crt);
            const released = await agent.releaseMintingWithForbiddenPayment(txHash);
            assertWeb3Equal(released.collateralReservationId, crt.collateralReservationId);
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.FORBIDDEN);
        });

        it("a source removed from the list before the release: the release is refused and the payment mints", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const txHash = await payFrom(forbiddenPayer, crt);
            await skipPastReleaseGate(crt);
            await forbiddenAddressList.removeForbiddenAddresses(context.chainInfo.chainId, [forbiddenPayer], { from: governance });
            await expectRevert.custom(release(txHash), "MintingPaymentNotForbidden", []);
            // executing has no deadline, so the minter mints with it
            const res = await executeMinting(crt, txHash, minter.address);
            assertWeb3Equal(requiredEventArgs(res, "MintingExecuted").mintedAmountUBA, crt.valueUBA);
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.SUCCESSFUL);
        });

        it("a forbidden minter cannot reserve collateral", async () => {
            await forbidFlareAddresses(context.assetManager, forbiddenAddressList, [minterAddress2]);
            await expectRevert.custom(context.assetManager.reserveCollateral(agent.vaultAddress, 1, agent.settings.feeBIPS, ZERO_ADDRESS,
                { from: minterAddress2, value: await minter.getCollateralReservationFee(1) }), "ForbiddenFlareAddress", [minterAddress2]);
        });

        it("the release takes only a valid proof of a full payment, not older than the reservation, for an active reservation of the caller's agent", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            mockChain.mint(forbiddenPayer, context.underlyingAmountLots(20));
            // no payment reference, or one that is not a minting reference
            const noReferenceTx = await payFrom(forbiddenPayer, crt, paymentAmount, null);
            const topupReferenceTx = await payFrom(forbiddenPayer, crt, paymentAmount, PaymentReference.topup(agent.vaultAddress));
            // a minting reference of no reservation
            const unknownReferenceTx = await payFrom(forbiddenPayer, crt, paymentAmount, PaymentReference.minting(toBN(crt.collateralReservationId).addn(1000)));
            // too small
            const tooSmallTx = await payFrom(forbiddenPayer, crt, crt.valueUBA);
            // older than the reservation
            const wallet = checkedCast(minter.wallet, MockChainWallet);
            const tooOldTx = wallet.createTransaction(forbiddenPayer, crt.paymentAddress, paymentAmount, crt.paymentReference);
            mockChain.modifyMinedBlock(Number(crt.firstUnderlyingBlock) - 1, block => { block.transactions.push(tooOldTx); });
            await skipPastReleaseGate(crt);
            await expectRevert.custom(release(noReferenceTx), "InvalidMintingReference", []);
            await expectRevert.custom(release(topupReferenceTx), "InvalidMintingReference", []);
            await expectRevert.custom(release(unknownReferenceTx), "InvalidCrtId", []);
            await expectRevert.custom(release(tooSmallTx), "MintingPaymentTooSmall", []);
            await expectRevert.custom(release(tooOldTx.hash), "MintingPaymentTooOld", []);
            // another agent's owner cannot release it
            const agent2 = await Agent.createTest(context, agentOwner2, underlyingAgent2);
            const validTx = await payFrom(forbiddenPayer, crt);
            await expectRevert.custom(release(validTx, agent2.ownerWorkAddress), "OnlyAgentVaultOwner", []);
            // a payment to another address with the reservation's reference
            const otherAddressTx = await minter.wallet.addTransaction(forbiddenPayer, underlyingAgent2, paymentAmount, crt.paymentReference);
            const otherAddressProof = await context.attestationProvider.provePayment(otherAddressTx, null, underlyingAgent2);
            await expectRevert.custom(context.assetManager.releaseMintingWithForbiddenPayment(otherAddressProof, { from: agent.ownerWorkAddress }),
                "NotMintingAgentsAddress", []);
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.ACTIVE);
            // the valid proof releases it, once
            requiredEventArgs(await release(validTx), "MintingPaymentForbidden");
            await expectRevert.custom(release(validTx), "InvalidCrtId", []);
        });

        it("a too small payment from a forbidden source releases nothing; the payment default still works", async () => {
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const txHash = await payFrom(forbiddenPayer, crt, crt.valueUBA);
            await skipPastReleaseGate(crt);
            // the proof checks of every minting payment run first
            await expectRevert.custom(executeMinting(crt, txHash, agent.ownerWorkAddress), "MintingPaymentTooSmall", []);
            await expectRevert.custom(release(txHash), "MintingPaymentTooSmall", []);
            // the non-payment proof ignores a too small payment
            await agent.mintingPaymentDefault(crt);
            assertWeb3Equal(await crtStatus(crt), CollateralReservationStatus.DEFAULTED);
            // and the forbidden payment cannot become free underlying
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, txHash), "ForbiddenSourceAddress", []);
        });

        it("after the release, no payment for the reservation becomes free underlying - a clean one stays unaccounted too", async () => {
            // An agent that pays every reference from a listed address must not be able to release the reservation and
            // then claim the slow minter's clean, in-time payment as its own free underlying.
            const crt = await minter.reserveCollateral(agent.vaultAddress, 2);
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            const forbiddenTx = await payFrom(forbiddenPayer, crt);
            const secondForbiddenTx = await payFrom(forbiddenPayer, crt);
            const cleanTx = await minter.performMintingPayment(crt);
            await skipPastReleaseGate(crt);
            requiredEventArgs(await release(forbiddenTx), "MintingPaymentForbidden");
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: 0, actualUnderlyingBalance: paymentAmount.muln(3) });
            // a FORBIDDEN reservation is refused like an EXPIRED one, whatever the payment's source
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, cleanTx), "InvalidCollateralReservationStatus", []);
            await expectRevert.custom(agent.confirmClosedMintingPayment(crt, secondForbiddenTx), "InvalidCollateralReservationStatus", []);
            // the clean payment stays on the agent's address, unaccounted until the vault is closed
            await agent.checkAgentInfo({ freeUnderlyingBalanceUBA: 0, underlyingBalanceUBA: 0, actualUnderlyingBalance: paymentAmount.muln(3) });
        });
    });
});
