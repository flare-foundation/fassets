import { AgentStatus } from "../../../lib/fasset/AssetManagerTypes";
import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Liquidator } from "../../../lib/test-utils/actors/Liquidator";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Compare, assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { BN_ZERO, deepFormat, toBN, toBNExp, toWei, trace } from "../../../lib/utils/helpers";

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

    describe("simple scenarios - price change liquidation", () => {
        it("liquidation due to price change (agent can be safe again) (pool CR too low)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await context.priceStore.setCurrentPrice("NAT", 10, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 10, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 6), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 6), 0);
            // start liquidation
            const liquidationStartTs = await liquidator.startLiquidation(agent);   // should put agent to liquidation mode
            const info1 = await agent.checkAgentInfo({
                status: AgentStatus.LIQUIDATION,
                liquidationPaymentFactorVaultBIPS: 10000,
                liquidationPaymentFactorPoolBIPS: 2000,
            });
            assertWeb3Compare(info1.maxLiquidationAmountUBA, ">", context.convertLotsToUBA(1));
            assertWeb3Compare(info1.maxLiquidationAmountUBA, "<", context.convertLotsToUBA(2));
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = context.convertLotsToUBA(1);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.isUndefined(liquidationStarted1);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding from pool and agent

            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationStartTs, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationStartTs, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);

            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                liquidationPaymentFactorVaultBIPS: 10000,
                liquidationPaymentFactorPoolBIPS: 2000,
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0,
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, liquidationStartTs);
            assertWeb3Compare(info2.maxLiquidationAmountUBA, ">", 0);
            assertWeb3Compare(info2.maxLiquidationAmountUBA, "<", context.convertLotsToUBA(1));
            // liquidation cannot be stopped if agent not safe
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            const info3 = await agent.getAgentInfo();
            assertWeb3Compare(info3.maxLiquidationAmountUBA, '>', info2.maxLiquidationAmountUBA);
            // liquidate agent (second part)
            const toLiquidateUBA2 = context.convertLotsToUBA(1);
            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, toLiquidateUBA2);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA2, info3.maxLiquidationAmountUBA);
            assert.isUndefined(liquidationStarted2);
            assert.isDefined(liquidationCancelled2);
            assert.equal(liquidationCancelled2.agentVault, agent.agentVault.address);

            // test rewarding
            const info4 = await agent.getAgentInfo();
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(info4.poolCollateralRatioBIPS, liquidationStartTs, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA2, poolLiquidationFactorBIPS2);
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(info4.vaultCollateralRatioBIPS, liquidationStartTs, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);

            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            const info5 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).add(minted.poolFeeUBA),
                maxLiquidationAmountUBA: 0,
                liquidationPaymentFactorVaultBIPS: 0,
                liquidationPaymentFactorPoolBIPS: 0,
                status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info5.liquidationStartTimestamp, 0);
            // final tests
            const { 0: poolCollateralTypes, 1: vaultCollateralTypes } = await context.assetManager.getCollateralTypes();
            assert(poolLiquidationFactorBIPS1.lt(poolLiquidationFactorBIPS2));
            assert(collateralVaultLiquidationFactorBIPS1.lte(collateralVaultLiquidationFactorBIPS2));
            const poolCollateralRatioBIPS3 = toBN(info5.poolCollateralRatioBIPS);
            assert(poolCollateralRatioBIPS3.gte(toBN(poolCollateralTypes.safetyMinCollateralRatioBIPS)));
            const vaultCollateralRatioBIPS3 = toBN(info5.vaultCollateralRatioBIPS);
            assert(vaultCollateralRatioBIPS3.gte(toBN(vaultCollateralTypes.safetyMinCollateralRatioBIPS)));
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2));
        });


        it("liquidation due to price change (agent can be safe again) (vault CR too low)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(3e9);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(12000);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding from pool and agent

            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);

            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0,
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // liquidation cannot be stopped if agent not safe
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (second part)
            const liquidateMaxUBA2 = minted.mintedAmountUBA.sub(liquidatedUBA1);
            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA2);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assert(liquidatedUBA2.lt(liquidateMaxUBA2)); // agent is safe again
            assert.isUndefined(liquidationStarted2);
            assert.isDefined(liquidationCancelled2);
            assert.equal(liquidationCancelled2.agentVault, agent.agentVault.address);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA2, poolLiquidationFactorBIPS2);
            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);
            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).add(minted.poolFeeUBA),
                status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            // final tests
            assert(poolLiquidationFactorBIPS1.lt(poolLiquidationFactorBIPS2));
            assert(collateralVaultLiquidationFactorBIPS1.lte(collateralVaultLiquidationFactorBIPS2));
            const poolCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).poolCollateralRatioBIPS);
            const poolCollateralTypes = (await context.assetManager.getCollateralTypes())[0];
            assert(poolCollateralRatioBIPS3.gte(toBN(poolCollateralTypes.safetyMinCollateralRatioBIPS)));
            const vaultCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).vaultCollateralRatioBIPS);
            const vaultCollateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(vaultCollateralRatioBIPS3.gte(toBN(vaultCollateralTypes.safetyMinCollateralRatioBIPS)));
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2));
        });

        it("liquidation due to price change (pool CR unsafe) (agent cannot be safe again)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
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
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await context.priceStore.setCurrentPrice("NAT", 50, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 50, 0);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);
            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);

            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0,
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (second part)

            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA2, liquidateMaxUBA);
            assert.isUndefined(liquidationStarted2);
            assert.isUndefined(liquidationCancelled2);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS2);
            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);

            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).add(minted.poolFeeUBA),
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, liquidationTimestamp1);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (last part)
            const startBalanceLiquidator3NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator3VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA3, liquidationTimestamp3, liquidationStarted3, liquidationCancelled3] = await liquidator.liquidate(agent, liquidateMaxUBA);
            const endBalanceLiquidator3NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator3VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assert(liquidatedUBA3.gt(BN_ZERO));
            assert.isUndefined(liquidationStarted3);
            assert.isDefined(liquidationCancelled3);
            assert.equal(liquidationCancelled3.agentVault, agent.agentVault.address);
            // test rewarding
            const poolCollateralRatioBIPS3 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS3 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS3, liquidationTimestamp1, liquidationTimestamp3);
            const poolLiquidationReward3 = await liquidator.getLiquidationRewardPool(liquidatedUBA3, poolLiquidationFactorBIPS3);
            const vaultCollateralRatioBIPS3 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS3 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS3, liquidationTimestamp1, liquidationTimestamp3);
            const vaultCollateralLiquidationReward3 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA3, collateralVaultLiquidationFactorBIPS3);
            assertWeb3Equal(endBalanceLiquidator3NAT.sub(startBalanceLiquidator3NAT), poolLiquidationReward3);
            assertWeb3Equal(endBalanceLiquidator3VaultCollateral.sub(startBalanceLiquidator3VaultCollateral), vaultCollateralLiquidationReward3);
            const info3 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2).sub(vaultCollateralLiquidationReward3),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2).sub(poolLiquidationReward3),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2).add(liquidatedUBA3),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).sub(liquidatedUBA3).add(minted.poolFeeUBA),
                status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info3.liquidationStartTimestamp, 0);
            // final tests
            assertWeb3Compare(poolLiquidationFactorBIPS1, '<=', poolLiquidationFactorBIPS2);
            assertWeb3Compare(poolLiquidationFactorBIPS2, '<=', poolLiquidationFactorBIPS3);
            assertWeb3Compare(poolLiquidationReward1, '<=', poolLiquidationReward2);
            assertWeb3Compare(poolLiquidationReward2, '>=', poolLiquidationReward3);    // due to smaller liquidation amount

            assertWeb3Compare(collateralVaultLiquidationFactorBIPS1, '<=', collateralVaultLiquidationFactorBIPS2);
            assertWeb3Compare(collateralVaultLiquidationFactorBIPS2, '<=', collateralVaultLiquidationFactorBIPS3);
            assertWeb3Compare(vaultCollateralLiquidationReward1, '<=', vaultCollateralLiquidationReward2);
            assertWeb3Compare(vaultCollateralLiquidationReward2, '>=', vaultCollateralLiquidationReward3);  // due to smaller liquidation amount
        });

        it("liquidation due to price change (vault CR unsafe) (agent cannot be safe again)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
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
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(10100);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);
            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);

            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0,
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (second part)

            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA2, liquidateMaxUBA);
            assert.isUndefined(liquidationStarted2);
            assert.isUndefined(liquidationCancelled2);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS2);
            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);

            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).add(minted.poolFeeUBA),
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, liquidationTimestamp1);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (last part)
            const startBalanceLiquidator3NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator3VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA3, liquidationTimestamp3, liquidationStarted3, liquidationCancelled3] = await liquidator.liquidate(agent, liquidateMaxUBA);
            const endBalanceLiquidator3NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator3VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA3, liquidateMaxUBA);
            assert.isUndefined(liquidationStarted3);
            assert.isUndefined(liquidationCancelled3);
            // test rewarding
            const poolCollateralRatioBIPS3 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS3 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS3, liquidationTimestamp1, liquidationTimestamp3);
            const poolLiquidationReward3 = await liquidator.getLiquidationRewardPool(liquidatedUBA3, poolLiquidationFactorBIPS3);
            const vaultCollateralRatioBIPS3 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS3 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS3, liquidationTimestamp1, liquidationTimestamp3);
            const vaultCollateralLiquidationReward3 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA3, collateralVaultLiquidationFactorBIPS3);
            assertWeb3Equal(endBalanceLiquidator3NAT.sub(startBalanceLiquidator3NAT), poolLiquidationReward3);
            assertWeb3Equal(endBalanceLiquidator3VaultCollateral.sub(startBalanceLiquidator3VaultCollateral), vaultCollateralLiquidationReward3);
            const info3 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2).sub(vaultCollateralLiquidationReward3),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2).sub(poolLiquidationReward3),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2).add(liquidatedUBA3),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).sub(liquidatedUBA3).add(minted.poolFeeUBA),
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info3.liquidationStartTimestamp, info.liquidationStartTimestamp);
            // final tests
            assertWeb3Equal(liquidatedUBA1, liquidatedUBA2);
            assertWeb3Equal(liquidatedUBA2, liquidatedUBA3);
            assertWeb3Compare(poolLiquidationFactorBIPS1, '<=', poolLiquidationFactorBIPS2);
            assertWeb3Compare(poolLiquidationFactorBIPS2, '<=', poolLiquidationFactorBIPS3);
            assertWeb3Compare(poolLiquidationReward1, '<=', poolLiquidationReward2);
            assertWeb3Compare(poolLiquidationReward2, '<=', poolLiquidationReward3);

            assertWeb3Compare(collateralVaultLiquidationFactorBIPS1, '<=', collateralVaultLiquidationFactorBIPS2);
            assertWeb3Compare(collateralVaultLiquidationFactorBIPS2, '<=', collateralVaultLiquidationFactorBIPS3);
            assertWeb3Compare(vaultCollateralLiquidationReward1, '<=', vaultCollateralLiquidationReward2);
            assertWeb3Compare(vaultCollateralLiquidationReward2, '<=', vaultCollateralLiquidationReward3);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2).sub(vaultCollateralLiquidationReward3));
        });

        it("liquidation due to price change (pool CR unsafe) (agent can end liquidation after new price change)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await context.priceStore.setCurrentPrice("NAT", 10, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 10, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 6), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 6), 0);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);


            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // price change after some time
            await time.deterministicIncrease(90);
            await context.priceStore.setCurrentPrice("NAT", 100, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 100, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 5), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 5), 0);
            // agent still in liquidation status
            const info1 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info1.liquidationStartTimestamp, liquidationTimestamp1);
            // agent can end liquidation
            await agent.endLiquidation();
            // final tests
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            const collateralRatioBIPS2 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(poolLiquidationReward1), minted.mintedAmountUBA.sub(liquidatedUBA1));
            const collateralTypes = (await context.assetManager.getCollateralTypes())[0];
            assert(collateralRatioBIPS2.gte(toBN(collateralTypes.safetyMinCollateralRatioBIPS)))
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1));
        });

        it("liquidation due to price change (vault CR unsafe) (agent can end liquidation after new price change)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(3e9);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(11000);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);


            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // price change after some time
            await time.deterministicIncrease(90);
            await agent.setVaultCollateralRatioByChangingAssetPrice(20000);
            // agent still in liquidation status
            const info1 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info1.liquidationStartTimestamp, liquidationTimestamp1);
            // agent can end liquidation
            await agent.endLiquidation();
            // final tests
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            const collateralRatioBIPS2 = await agent.getCollateralRatioBIPS(fullPoolCollateral.sub(vaultCollateralLiquidationReward1), minted.mintedAmountUBA.sub(liquidatedUBA1));
            const collateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(collateralRatioBIPS2.gte(toBN(collateralTypes.safetyMinCollateralRatioBIPS)))
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1));
        });

        it("liquidation due to price change (pool CR unsafe) (others can end liquidation after new price change)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await context.priceStore.setCurrentPrice("NAT", 10, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 10, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 6), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 6), 0);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);

            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // price change after some time
            await time.deterministicIncrease(90);
            await context.priceStore.setCurrentPrice("NAT", 100, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 100, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 5), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 5), 0);
            // agent still in liquidation status
            const info1 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info1.liquidationStartTimestamp, liquidationTimestamp1);
            // others can end liquidation
            await liquidator.endLiquidation(agent);
            // final tests
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            const collateralRatioBIPS2 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(poolLiquidationReward1), minted.mintedAmountUBA.sub(liquidatedUBA1));
            const collateralTypes = (await context.assetManager.getCollateralTypes())[0];
            assert(collateralRatioBIPS2.gte(toBN(collateralTypes.safetyMinCollateralRatioBIPS)))
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1));
        });

        it("liquidation due to price change (vault CR unsafe) (others can end liquidation after new price change)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(3e9);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(12000);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);

            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // price change after some time
            await time.deterministicIncrease(90);
            await context.priceStore.setCurrentPrice("NAT", 100, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 100, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 5), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 5), 0);
            // agent still in liquidation status
            const info1 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info1.liquidationStartTimestamp, liquidationTimestamp1);
            // others can end liquidation
            await liquidator.endLiquidation(agent);
            // final tests
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            const collateralRatioBIPS2 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(vaultCollateralLiquidationReward1), minted.mintedAmountUBA.sub(liquidatedUBA1));
            const collateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(collateralRatioBIPS2.gte(toBN(collateralTypes.safetyMinCollateralRatioBIPS)))
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1));
        });

        it("liquidation due to price change (pool CR unsafe) (cannot liquidate anything after new price change if agent is safe again)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await context.priceStore.setCurrentPrice("NAT", 10, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 10, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 6), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 6), 0);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);
            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // price change after some time
            await time.deterministicIncrease(90);
            await context.priceStore.setCurrentPrice("NAT", 100, 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders("NAT", 100, 0);
            await context.priceStore.setCurrentPrice(context.chainInfo.symbol, toBNExp(10, 5), 0);
            await context.priceStore.setCurrentPriceFromTrustedProviders(context.chainInfo.symbol, toBNExp(10, 5), 0);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // agent still in liquidation status
            const info1 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info1.liquidationStartTimestamp, liquidationTimestamp1);
            // liquidate agent (second part) - cannot liquidate anything as agent is safe again due to price change
            const liquidateMaxUBA2 = minted.mintedAmountUBA.sub(liquidatedUBA1);
            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA2);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA2, 0);
            assert.isUndefined(liquidationStarted2);
            assert.isDefined(liquidationCancelled2);
            assert.equal(liquidationCancelled2.agentVault, agent.agentVault.address);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA2, poolLiquidationFactorBIPS2);

            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(vaultCollateralLiquidationReward2, 0);
            assertWeb3Equal(poolLiquidationReward2, 0);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullAgentCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            // final tests
            assert(poolLiquidationFactorBIPS1.lt(poolLiquidationFactorBIPS2));
            assert(collateralVaultLiquidationFactorBIPS1.lte(collateralVaultLiquidationFactorBIPS2));
            const collateralRatioBIPS3 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(poolLiquidationReward1).sub(vaultCollateralLiquidationReward2), minted.mintedAmountUBA.sub(liquidatedUBA1));
            const collateralTypes = (await context.assetManager.getCollateralTypes())[0];
            assert(collateralRatioBIPS3.gte(toBN(collateralTypes.safetyMinCollateralRatioBIPS)))
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2));
        });

        it("liquidation due to price change (vault CR unsafe) (cannot liquidate anything after new price change if agent is safe again)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(3e9);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA), reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(12000);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);
            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // price change after some time
            await time.deterministicIncrease(90);
            await agent.setVaultCollateralRatioByChangingAssetPrice(30000);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // agent still in liquidation status
            const info1 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info1.liquidationStartTimestamp, liquidationTimestamp1);
            // liquidate agent (second part) - cannot liquidate anything as agent is safe again due to price change
            const liquidateMaxUBA2 = minted.mintedAmountUBA.sub(liquidatedUBA1);
            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA2);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA2, 0);
            assert.isUndefined(liquidationStarted2);
            assert.isDefined(liquidationCancelled2);
            assert.equal(liquidationCancelled2.agentVault, agent.agentVault.address);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA2, poolLiquidationFactorBIPS2);

            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(vaultCollateralLiquidationReward2, 0);
            assertWeb3Equal(poolLiquidationReward2, 0);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0, status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            // final tests
            assert(poolLiquidationFactorBIPS1.lt(poolLiquidationFactorBIPS2));
            assert(collateralVaultLiquidationFactorBIPS1.lte(collateralVaultLiquidationFactorBIPS2));
            const collateralRatioBIPS3 = await agent.getCollateralRatioBIPS(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2), minted.mintedAmountUBA.sub(liquidatedUBA1));
            const collateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(collateralRatioBIPS3.gte(toBN(collateralTypes.safetyMinCollateralRatioBIPS)))
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2));
        });

        it("liquidation due to price change (agent can be safe again) (vault + pool CR little both too low)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(5e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(18000);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding from pool and agent
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);

            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0,
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // liquidation cannot be stopped if agent not safe
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (second part)
            const liquidateMaxUBA2 = minted.mintedAmountUBA.sub(liquidatedUBA1);
            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA2);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assert(liquidatedUBA2.lt(liquidateMaxUBA2)); // agent is safe again
            assert.isUndefined(liquidationStarted2);
            assert.isDefined(liquidationCancelled2);
            assert.equal(liquidationCancelled2.agentVault, agent.agentVault.address);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA2, poolLiquidationFactorBIPS2);
            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);
            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).add(minted.poolFeeUBA),
                status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            // final tests
            assert(poolLiquidationFactorBIPS1.lt(poolLiquidationFactorBIPS2));
            assert(collateralVaultLiquidationFactorBIPS1.lte(collateralVaultLiquidationFactorBIPS2));
            const poolCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).poolCollateralRatioBIPS);
            const poolCollateralTypes = (await context.assetManager.getCollateralTypes())[0];
            assert(poolCollateralRatioBIPS3.gte(toBN(poolCollateralTypes.safetyMinCollateralRatioBIPS)));
            const vaultCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).vaultCollateralRatioBIPS);
            const vaultCollateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(vaultCollateralRatioBIPS3.gte(toBN(vaultCollateralTypes.safetyMinCollateralRatioBIPS)));
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2));
        });

        it("liquidation due to price change (agent can be safe again) (vault + pool CR both very low)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(9e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(11000);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding from pool and agent
            const poolCollateralRatioBIPS1 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);

            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0,
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // liquidation cannot be stopped if agent not safe
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (second part)
            const liquidateMaxUBA2 = minted.mintedAmountUBA.sub(liquidatedUBA1);
            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA2);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assert(liquidatedUBA2.lt(liquidateMaxUBA2)); // agent is safe again
            assert.isUndefined(liquidationStarted2);
            assert.isDefined(liquidationCancelled2);
            assert.equal(liquidationCancelled2.agentVault, agent.agentVault.address);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA2, poolLiquidationFactorBIPS2);
            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);
            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).add(minted.poolFeeUBA),
                status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            // final tests
            assert(poolLiquidationFactorBIPS1.lt(poolLiquidationFactorBIPS2));
            assert(collateralVaultLiquidationFactorBIPS1.lte(collateralVaultLiquidationFactorBIPS2));
            const poolCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).poolCollateralRatioBIPS);
            const poolCollateralTypes = (await context.assetManager.getCollateralTypes())[0];
            assert(poolCollateralRatioBIPS3.gte(toBN(poolCollateralTypes.safetyMinCollateralRatioBIPS)));
            const vaultCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).vaultCollateralRatioBIPS);
            const vaultCollateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(vaultCollateralRatioBIPS3.gte(toBN(vaultCollateralTypes.safetyMinCollateralRatioBIPS)));
            // agent "buys" f-assets
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            assert(remainingUBA.gt(BN_ZERO));
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2));
        });

        it("liquidation due to price change (agent can be safe again) (vault + pool CR both very low, pool CR lower than vault CR)", async () => {
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(10000));
            const liquidator = await Liquidator.create(context, liquidatorAddress1);
            // make agent available
            const fullAgentCollateral = toWei(3e8);
            const fullPoolCollateral = toWei(5e8);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullPoolCollateral);
            // update block
            await context.updateUnderlyingBlock();
            // perform minting
            const lots = 6;
            const crt = await minter.reserveCollateral(agent.vaultAddress, lots);
            const txHash = await minter.performMintingPayment(crt);
            const minted = await minter.executeMinting(crt, txHash);
            const poolCRFee = await agent.poolCRFee(lots);
            assertWeb3Equal(minted.mintedAmountUBA, context.convertLotsToUBA(lots));
            await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral,
                freeUnderlyingBalanceUBA: minted.agentFeeUBA,
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0
            });
            // price change
            await agent.setVaultCollateralRatioByChangingAssetPrice(11000);
            // liquidator "buys" f-assets
            await context.fAsset.transfer(liquidator.address, minted.mintedAmountUBA, { from: minter.address });
            // liquidate agent (partially)
            const liquidateMaxUBA1 = minted.mintedAmountUBA.divn(lots);
            const startBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA1, liquidationTimestamp1, liquidationStarted1, liquidationCancelled1] = await liquidator.liquidate(agent, liquidateMaxUBA1);
            assert.isDefined(liquidationStarted1);
            const endBalanceLiquidator1NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator1VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assertWeb3Equal(liquidatedUBA1, liquidateMaxUBA1);
            assert.equal(liquidationStarted1.agentVault, agent.agentVault.address);
            assert.isUndefined(liquidationCancelled1);
            // test rewarding from pool and agent

            const vaultCollateralRatioBIPS1 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const vaultCollateralLiquidationReward1 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA1, collateralVaultLiquidationFactorBIPS1);

            //Pool reward calculation is a little different when pool CR lower than vault CR
            const poolLiquidationFactorBIPS1 = await liquidator.getLiquidationFactorBIPSPool(vaultCollateralRatioBIPS1, liquidationTimestamp1, liquidationTimestamp1);
            const poolLiquidationReward1 = await liquidator.getLiquidationRewardPool(liquidatedUBA1, poolLiquidationFactorBIPS1);
            assertWeb3Equal(endBalanceLiquidator1NAT.sub(startBalanceLiquidator1NAT), poolLiquidationReward1);
            assertWeb3Equal(endBalanceLiquidator1VaultCollateral.sub(startBalanceLiquidator1VaultCollateral), vaultCollateralLiquidationReward1);
            const info = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).add(minted.poolFeeUBA),
                reservedUBA: 0, redeemingUBA: 0, announcedVaultCollateralWithdrawalWei: 0,
                status: AgentStatus.LIQUIDATION
            });
            assertWeb3Equal(info.liquidationStartTimestamp, liquidationTimestamp1);
            // liquidation cannot be stopped if agent not safe
            await expectRevert.custom(agent.endLiquidation(), "CannotStopLiquidation", []);
            await expectRevert.custom(liquidator.endLiquidation(agent), "CannotStopLiquidation", []);
            // wait some time to get next premium
            await time.deterministicIncrease(90);
            // liquidate agent (second part)
            const liquidateMaxUBA2 = minted.mintedAmountUBA.sub(liquidatedUBA1);
            const startBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const startBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            const [liquidatedUBA2, liquidationTimestamp2, liquidationStarted2, liquidationCancelled2] = await liquidator.liquidate(agent, liquidateMaxUBA2);
            const endBalanceLiquidator2NAT = await context.wNat.balanceOf(liquidator.address);
            const endBalanceLiquidator2VaultCollateral = await agent.vaultCollateralToken().balanceOf(liquidator.address);
            assert(liquidatedUBA2.lte(liquidateMaxUBA2)); // agent is safe again
            assert.isUndefined(liquidationStarted2);
            assert.isDefined(liquidationCancelled2);
            assert.equal(liquidationCancelled2.agentVault, agent.agentVault.address);
            // test rewarding
            const poolCollateralRatioBIPS2 = (await agent.getAgentInfo()).poolCollateralRatioBIPS;
            const poolLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSPool(poolCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const poolLiquidationReward2 = await liquidator.getLiquidationRewardPool(liquidatedUBA2, poolLiquidationFactorBIPS2);
            const vaultCollateralRatioBIPS2 = (await agent.getAgentInfo()).vaultCollateralRatioBIPS;
            const collateralVaultLiquidationFactorBIPS2 = await liquidator.getLiquidationFactorBIPSVaultCollateral(vaultCollateralRatioBIPS2, liquidationTimestamp1, liquidationTimestamp2);
            const vaultCollateralLiquidationReward2 = await liquidator.getLiquidationRewardVaultCollateral(liquidatedUBA2, collateralVaultLiquidationFactorBIPS2);
            assertWeb3Equal(endBalanceLiquidator2VaultCollateral.sub(startBalanceLiquidator2VaultCollateral), vaultCollateralLiquidationReward2);
            assertWeb3Equal(endBalanceLiquidator2NAT.sub(startBalanceLiquidator2NAT), poolLiquidationReward2);
            const info2 = await agent.checkAgentInfo({
                totalVaultCollateralWei: fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2),
                totalPoolCollateralNATWei: fullPoolCollateral.add(poolCRFee).sub(poolLiquidationReward1).sub(poolLiquidationReward2),
                freeUnderlyingBalanceUBA: minted.agentFeeUBA.add(liquidatedUBA1).add(liquidatedUBA2),
                mintedUBA: minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2).add(minted.poolFeeUBA),
                status: AgentStatus.NORMAL
            });
            assertWeb3Equal(info2.liquidationStartTimestamp, 0);
            // final tests
            assert(poolLiquidationFactorBIPS1.lt(poolLiquidationFactorBIPS2));
            assert(collateralVaultLiquidationFactorBIPS1.lte(collateralVaultLiquidationFactorBIPS2));
            const poolCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).poolCollateralRatioBIPS);
            const poolCollateralTypes = (await context.assetManager.getCollateralTypes())[0];
            assert(poolCollateralRatioBIPS3.gte(toBN(poolCollateralTypes.safetyMinCollateralRatioBIPS)));
            const vaultCollateralRatioBIPS3 = toBN((await agent.getAgentInfo()).vaultCollateralRatioBIPS);
            const vaultCollateralTypes = (await context.assetManager.getCollateralTypes())[1];
            assert(vaultCollateralRatioBIPS3.gte(toBN(vaultCollateralTypes.safetyMinCollateralRatioBIPS)));
            // agent "buys" f-assets and self-closes
            const remainingUBA = minted.mintedAmountUBA.sub(liquidatedUBA1).sub(liquidatedUBA2);
            await context.fAsset.transfer(agent.ownerWorkAddress, remainingUBA, { from: liquidator.address });
            await agent.selfClose(remainingUBA);
            // agent can exit now
            await agent.exitAndDestroy(fullAgentCollateral.sub(vaultCollateralLiquidationReward1).sub(vaultCollateralLiquidationReward2));
        });
    });
});
