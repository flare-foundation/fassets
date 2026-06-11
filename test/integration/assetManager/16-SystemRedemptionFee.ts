import { Agent } from "../../../lib/test-utils/actors/Agent";
import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { Minter } from "../../../lib/test-utils/actors/Minter";
import { Redeemer } from "../../../lib/test-utils/actors/Redeemer";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { requiredEventArgsFrom } from "../../../lib/test-utils/Web3EventDecoder";
import { requiredEventArgs } from "../../../lib/utils/events/truffle";
import { BNish, DAYS, MAX_BIPS, toBN, toWei, ZERO_ADDRESS } from "../../../lib/utils/helpers";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager integration tests - system redemption fee`, accounts => {
    const governance = accounts[10];
    const feeReceiver = accounts[12];
    const agentOwner1 = accounts[20];
    const minterAddress1 = accounts[30];
    const redeemerAddress1 = accounts[40];
    const triggeringAccount = accounts[5];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingMinter1 = "Minter1";
    const underlyingRedeemer1 = "Redeemer1";
    const underlyingFeeReceiver = "FeeReceiver1";
    const coreVaultUnderlyingAddress = "CORE_VAULT_UNDERLYING";
    const coreVaultCustodianAddress = "CORE_VAULT_CUSTODIAN";

    // 1% - exactly at the maximum allowed first increase step (0 * 4 + 100)
    const FEE_BIPS = 100;

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

    // Helper: enable the system redemption fee (by default 1% to feeReceiver).
    async function enableSystemRedemptionFee(feeBIPS: number = FEE_BIPS, receiver: string = feeReceiver) {
        await context.assetManager.setSystemRedemptionFeeReceiver(receiver, { from: governance });
        await context.assetManager.setSystemRedemptionFeeBIPS(feeBIPS, { from: governance });
    }

    // Helper: the expected system fee for the redeemed amount (floor-rounded in AMG, like in the contract).
    function systemFeeUBA(valueUBA: BNish, feeBIPS: number = FEE_BIPS) {
        const feeAMG = context.convertUBAToAmg(valueUBA).muln(feeBIPS).divn(MAX_BIPS);
        return context.convertAmgToUBA(feeAMG);
    }

    // Helper: set up an agent with collateral and mint fAssets to the minter.
    async function setupAgentAndMint(lots: number) {
        const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
        const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.convertLotsToUBA(lots * 3));
        await agent.depositCollateralLotsAndMakeAvailable(lots * 2);
        const [minted] = await minter.performMinting(agent.vaultAddress, lots);
        return { agent, minter, minted };
    }

    describe("system redemption fee settings", () => {
        it("system redemption fee is disabled by default", async () => {
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeBIPS(), 0);
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeReceiver(), ZERO_ADDRESS);
        });

        it("governance can set system redemption fee BIPS and receiver", async () => {
            const res1 = await context.assetManager.setSystemRedemptionFeeReceiver(feeReceiver, { from: governance });
            expectEvent(res1, "ContractChanged", { name: "systemRedemptionFeeReceiver", value: feeReceiver });
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeReceiver(), feeReceiver);
            //
            const res2 = await context.assetManager.setSystemRedemptionFeeBIPS(FEE_BIPS, { from: governance });
            expectEvent(res2, "SettingChanged", { name: "systemRedemptionFeeBIPS", value: toBN(FEE_BIPS) });
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeBIPS(), FEE_BIPS);
        });

        it("system redemption fee receiver can be reset to zero address (disables the fee)", async () => {
            await context.assetManager.setSystemRedemptionFeeReceiver(feeReceiver, { from: governance });
            // wait for the settings rate limit (minUpdateRepeatTimeSeconds)
            await time.increase(DAYS + 1);
            await context.assetManager.setSystemRedemptionFeeReceiver(ZERO_ADDRESS, { from: governance });
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeReceiver(), ZERO_ADDRESS);
        });

        it("system redemption fee BIPS can be reset to zero (disables the fee)", async () => {
            await context.assetManager.setSystemRedemptionFeeBIPS(FEE_BIPS, { from: governance });
            await time.increase(DAYS + 1);
            await context.assetManager.setSystemRedemptionFeeBIPS(0, { from: governance });
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeBIPS(), 0);
        });

        it("setSystemRedemptionFeeBIPS reverts with ValueTooBig when fee >= MAX_BIPS", async () => {
            await expectRevert.custom(
                context.assetManager.setSystemRedemptionFeeBIPS(MAX_BIPS, { from: governance }),
                "ValueTooBig", []);
        });

        it("setSystemRedemptionFeeBIPS reverts with IncreaseTooBig when increasing more than 4x + 100", async () => {
            // from initial 0 the maximum allowed value is 100
            await expectRevert.custom(
                context.assetManager.setSystemRedemptionFeeBIPS(101, { from: governance }),
                "IncreaseTooBig", []);
            // increase to 100 works
            await context.assetManager.setSystemRedemptionFeeBIPS(100, { from: governance });
            await time.increase(DAYS + 1);
            // from 100 the maximum allowed value is 500
            await expectRevert.custom(
                context.assetManager.setSystemRedemptionFeeBIPS(501, { from: governance }),
                "IncreaseTooBig", []);
            await context.assetManager.setSystemRedemptionFeeBIPS(500, { from: governance });
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeBIPS(), 500);
        });

        it("only governance can set system redemption fee settings", async () => {
            await expectRevert.custom(
                context.assetManager.setSystemRedemptionFeeBIPS(FEE_BIPS, { from: redeemerAddress1 }),
                "OnlyGovernance", []);
            await expectRevert.custom(
                context.assetManager.setSystemRedemptionFeeReceiver(feeReceiver, { from: redeemerAddress1 }),
                "OnlyGovernance", []);
        });

        it("system redemption fee setters are rate limited", async () => {
            await context.assetManager.setSystemRedemptionFeeBIPS(FEE_BIPS, { from: governance });
            await expectRevert.custom(
                context.assetManager.setSystemRedemptionFeeBIPS(50, { from: governance }),
                "TooCloseToPreviousUpdate", []);
            await context.assetManager.setSystemRedemptionFeeReceiver(feeReceiver, { from: governance });
            await expectRevert.custom(
                context.assetManager.setSystemRedemptionFeeReceiver(redeemerAddress1, { from: governance }),
                "TooCloseToPreviousUpdate", []);
            // after the rate limit window, the update works
            await time.increase(DAYS + 1);
            await context.assetManager.setSystemRedemptionFeeBIPS(50, { from: governance });
            assertWeb3Equal(await context.assetManager.systemRedemptionFeeBIPS(), 50);
        });
    });

    describe("charging the system redemption fee", () => {
        it("redeem charges the system fee, re-mints it to the receiver and lowers the redemption value", async () => {
            await enableSystemRedemptionFee();
            const { agent, minted } = await setupAgentAndMint(10);
            // minter is the redeemer (same address), no fAsset transfer needed
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            const totalSupplyBefore = await context.fAsset.totalSupply();
            //
            const fullValueUBA = context.convertLotsToUBA(10);
            const res = await context.assetManager.redeem(10, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            const feePaid = requiredEventArgs(res, 'SystemRedemptionFeePaid');
            // check the fee event
            const expectedFeeUBA = systemFeeUBA(fullValueUBA);
            assert.isTrue(expectedFeeUBA.gtn(0));
            assertWeb3Equal(feePaid.agentVault, agent.vaultAddress);
            assertWeb3Equal(feePaid.requestId, request.requestId);
            assertWeb3Equal(feePaid.feeUBA, expectedFeeUBA);
            // the redemption value is lowered by the fee
            assertWeb3Equal(request.valueUBA, fullValueUBA.sub(expectedFeeUBA));
            // the fee was re-minted to the fee receiver
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), expectedFeeUBA);
            // the redeemer burned the full amount
            assertWeb3Equal(await context.fAsset.balanceOf(redeemer.address), minted.mintedAmountUBA.sub(fullValueUBA));
            // the total supply decreased by the burned amount minus the re-minted fee
            const totalSupplyAfter = await context.fAsset.totalSupply();
            assertWeb3Equal(totalSupplyBefore.sub(totalSupplyAfter), fullValueUBA.sub(expectedFeeUBA));
        });

        it("underlying redemption fee is calculated from the lowered redemption value", async () => {
            await enableSystemRedemptionFee();
            await setupAgentAndMint(10);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            const fullValueUBA = context.convertLotsToUBA(10);
            const res = await context.assetManager.redeem(10, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            const loweredValueUBA = fullValueUBA.sub(systemFeeUBA(fullValueUBA));
            assertWeb3Equal(request.valueUBA, loweredValueUBA);
            assertWeb3Equal(request.feeUBA, loweredValueUBA.mul(toBN(context.settings.redemptionFeeBIPS)).divn(MAX_BIPS));
        });

        it("agent's backing stays consistent and the redemption completes normally", async () => {
            await enableSystemRedemptionFee();
            const { agent, minted } = await setupAgentAndMint(10);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            // the total fasset supply is fully backed by the agent's minting (there is only one agent)
            const infoBeforeRequest = await agent.getAgentInfo();
            assertWeb3Equal(await context.fAsset.totalSupply(), infoBeforeRequest.mintedUBA);
            //
            const fullValueUBA = context.convertLotsToUBA(10);
            const res = await context.assetManager.redeem(10, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            const feeUBA = systemFeeUBA(fullValueUBA);
            // the fee part of the value stays minted (it now backs the fee receiver's fassets),
            // only the lowered value is being redeemed
            const infoAfterRequest = await agent.checkAgentInfo({
                mintedUBA: minted.mintedAmountUBA.add(minted.poolFeeUBA).sub(fullValueUBA).add(feeUBA),
                redeemingUBA: fullValueUBA.sub(feeUBA),
            });
            // the supply still matches the agent's minted backing (full value burned, fee re-minted)
            assertWeb3Equal(await context.fAsset.totalSupply(), infoAfterRequest.mintedUBA);
            // agent pays the lowered value minus the underlying redemption fee and confirms
            const txHash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, txHash);
            const infoAfterConfirm = await agent.checkAgentInfo({ redeemingUBA: 0 });
            assertWeb3Equal(await context.fAsset.totalSupply(), infoAfterConfirm.mintedUBA);
        });

        it("re-minted fee remains backed by the agent and the fee receiver can redeem it", async () => {
            await enableSystemRedemptionFee();   // 1%
            const { agent } = await setupAgentAndMint(100);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            await context.assetManager.redeem(100, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            // the fee receiver got exactly 1 lot (1% of 100 lots)
            const oneLotUBA = context.convertLotsToUBA(1);
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), oneLotUBA);
            // the fee receiver redeems the collected fee
            const res = await context.assetManager.redeem(1, underlyingFeeReceiver, ZERO_ADDRESS, { from: feeReceiver });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            assertWeb3Equal(request.agentVault, agent.vaultAddress);
            // the system fee is charged for this redemption too
            assertWeb3Equal(request.valueUBA, oneLotUBA.sub(systemFeeUBA(oneLotUBA)));
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), systemFeeUBA(oneLotUBA));
            // agent pays and the redemption completes
            const txHash = await agent.performRedemptionPayment(request);
            await agent.confirmActiveRedemptionPayment(request, txHash);
        });

        it("redeemWithTag charges the system fee", async () => {
            await enableSystemRedemptionFee();
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const fullValueUBA = context.convertLotsToUBA(3);
            const res = await context.assetManager.redeemWithTag(fullValueUBA, redeemer.underlyingAddress, ZERO_ADDRESS, 42,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionWithTagRequested');
            const feePaid = requiredEventArgs(res, 'SystemRedemptionFeePaid');
            assertWeb3Equal(feePaid.requestId, request.requestId);
            assertWeb3Equal(feePaid.feeUBA, systemFeeUBA(fullValueUBA));
            assertWeb3Equal(request.valueUBA, fullValueUBA.sub(systemFeeUBA(fullValueUBA)));
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), systemFeeUBA(fullValueUBA));
        });

        it("redeemAmount charges the system fee", async () => {
            await enableSystemRedemptionFee();
            const { minter, minted } = await setupAgentAndMint(3);
            const redeemer = await Redeemer.create(context, redeemerAddress1, underlyingRedeemer1);
            await context.fAsset.transfer(redeemer.address, minted.mintedAmountUBA, { from: minter.address });
            //
            const redeemAmountUBA = context.convertLotsToUBA(3).divn(2);    // 1.5 lots
            const res = await context.assetManager.redeemAmount(redeemAmountUBA, redeemer.underlyingAddress, ZERO_ADDRESS,
                { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            const feePaid = requiredEventArgs(res, 'SystemRedemptionFeePaid');
            assertWeb3Equal(feePaid.requestId, request.requestId);
            assertWeb3Equal(feePaid.feeUBA, systemFeeUBA(redeemAmountUBA));
            assertWeb3Equal(request.valueUBA, redeemAmountUBA.sub(systemFeeUBA(redeemAmountUBA)));
        });

        it("self-close exit from collateral pool charges the system fee", async () => {
            await enableSystemRedemptionFee();
            const agent = await Agent.createTest(context, agentOwner1, underlyingAgent1);
            const minter = await Minter.createTest(context, minterAddress1, underlyingMinter1, context.underlyingAmount(1e8));
            const fullAgentCollateral = toWei(1e7);
            await agent.depositCollateralsAndMakeAvailable(fullAgentCollateral, fullAgentCollateral);
            await minter.performMinting(agent.vaultAddress, 300);
            // minter enters the pool
            const minterPoolDeposit = toWei(90000);
            await agent.collateralPool.enter({ from: minter.address, value: minterPoolDeposit });
            const minterPoolTokensWei = await agent.collateralPoolToken.balanceOf(minter.address);
            // approve enough fassets that will be needed in self close exit
            await context.fAsset.approve(agent.collateralPool.address, context.convertLotsToUBA(300), { from: minter.address });
            await time.deterministicIncrease(await context.assetManager.getCollateralPoolTokenTimelockSeconds());  // wait for minted token timelock
            const response = await agent.collateralPool.selfCloseExit(minterPoolTokensWei, false, underlyingMinter1, ZERO_ADDRESS,
                { from: minter.address });
            // the redemption request created in self-close exit was charged the system fee
            const request = requiredEventArgsFrom(response, context.assetManager, 'RedemptionRequested');
            const feePaid = requiredEventArgsFrom(response, context.assetManager, 'SystemRedemptionFeePaid');
            assertWeb3Equal(feePaid.agentVault, agent.vaultAddress);
            assertWeb3Equal(feePaid.requestId, request.requestId);
            // the fee was subtracted from the closed amount: fee = systemFee(value + fee)
            const closedUBA = toBN(request.valueUBA).add(toBN(feePaid.feeUBA));
            assertWeb3Equal(feePaid.feeUBA, systemFeeUBA(closedUBA));
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), feePaid.feeUBA);
        });

        it("redemption default pays out the lowered value and the fee receiver keeps the fee", async () => {
            await enableSystemRedemptionFee();
            await setupAgentAndMint(10);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            const fullValueUBA = context.convertLotsToUBA(10);
            const res = await context.assetManager.redeem(10, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            // agent doesn't pay - the redeemer defaults the redemption
            context.skipToExpiration(request.lastUnderlyingBlock, request.lastUnderlyingTimestamp);
            const defaultEvent = await redeemer.redemptionPaymentDefault(request);
            // the default is paid out for the lowered redemption value
            assertWeb3Equal(defaultEvent.redemptionAmountUBA, fullValueUBA.sub(systemFeeUBA(fullValueUBA)));
            // the fee receiver keeps the collected fee
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), systemFeeUBA(fullValueUBA));
        });
    });

    describe("no system redemption fee cases", () => {
        it("no fee is charged when the system redemption fee is not enabled", async () => {
            await setupAgentAndMint(10);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            const fullValueUBA = context.convertLotsToUBA(10);
            const res = await context.assetManager.redeem(10, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            expectEvent.notEmitted(res, 'SystemRedemptionFeePaid');
            assertWeb3Equal(request.valueUBA, fullValueUBA);
        });

        it("no fee is charged when the fee receiver is zero address", async () => {
            // only set the fee BIPS, the receiver stays at zero address
            await context.assetManager.setSystemRedemptionFeeBIPS(FEE_BIPS, { from: governance });
            await setupAgentAndMint(10);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            const fullValueUBA = context.convertLotsToUBA(10);
            const res = await context.assetManager.redeem(10, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            expectEvent.notEmitted(res, 'SystemRedemptionFeePaid');
            assertWeb3Equal(request.valueUBA, fullValueUBA);
        });

        it("no fee is charged when the fee BIPS is zero", async () => {
            // only set the fee receiver, the fee BIPS stays at zero
            await context.assetManager.setSystemRedemptionFeeReceiver(feeReceiver, { from: governance });
            await setupAgentAndMint(10);
            const redeemer = await Redeemer.create(context, minterAddress1, underlyingMinter1);
            //
            const fullValueUBA = context.convertLotsToUBA(10);
            const res = await context.assetManager.redeem(10, redeemer.underlyingAddress, ZERO_ADDRESS, { from: redeemer.address });
            const request = requiredEventArgs(res, 'RedemptionRequested');
            expectEvent.notEmitted(res, 'SystemRedemptionFeePaid');
            assertWeb3Equal(request.valueUBA, fullValueUBA);
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), 0);
        });

        it("no fee is charged on transfer to core vault", async () => {
            // enable core vault
            await context.assignCoreVaultManager({
                underlyingAddress: coreVaultUnderlyingAddress,
                custodianAddress: coreVaultCustodianAddress,
                triggeringAccounts: [triggeringAccount],
            });
            await enableSystemRedemptionFee();
            const { agent } = await setupAgentAndMint(10);
            // agent requests transfer of all backing to the core vault
            await context.updateUnderlyingBlock();
            const info = await agent.getAgentInfo();
            const res = await context.assetManager.transferToCoreVault(agent.vaultAddress, info.mintedUBA, { from: agent.ownerWorkAddress });
            expectEvent(res, "TransferToCoreVaultStarted");
            // the underlying transfer is a redemption request, but no system fee is charged
            const request = requiredEventArgs(res, 'RedemptionRequested');
            expectEvent.notEmitted(res, 'SystemRedemptionFeePaid');
            assertWeb3Equal(request.valueUBA, info.mintedUBA);
            assertWeb3Equal(await context.fAsset.balanceOf(feeReceiver), 0);
        });
    });
});
