import { expectEvent, expectRevert, time } from "@openzeppelin/test-helpers";
import BN from "bn.js";
import { eventArgs } from "../../../lib/utils/events/truffle";
import { MAX_BIPS, ZERO_ADDRESS, erc165InterfaceId, toBN, toBNExp, toWei } from "../../../lib/utils/helpers";

import {
    AgentVaultMockInstance,
    AssetManagerMockInstance,
    CollateralPoolInstance, CollateralPoolTokenInstance,
    DistributionToDelegatorsMockInstance,
    ERC20MockInstance,
    FAssetInstance,
    IERC165Contract
} from "../../../typechain-truffle";
import { impersonateContract, transferWithSuicide } from "../../../lib/test-utils/contract-test-helpers";
import { calcGasCost, calculateReceivedNat } from "../../../lib/test-utils/eth";
import { deterministicTimeIncrease, getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestContracts } from "../../../lib/test-utils/test-settings";
import { assertApproximatelyEqual } from "../../../lib/test-utils/approximation";

function assertEqualBN(a: BN, b: BN, message?: string) {
    assert.equal(a.toString(), b.toString(), message);
}

function assertEqualBNWithError(a: BN, b: BN, err: BN, message?: string) {
    assertApproximatelyEqual(a, b, 'absolute', err, message);
}

function maxBN(x: BN, y: BN) {
    return x.gt(y) ? x : y;
}

function mulBips(x: BN, bips: number) {
    return x.muln(Math.floor(MAX_BIPS * bips)).divn(MAX_BIPS);
}

const BN_ZERO = new BN(0);
const BN_ONE = new BN(1);

enum TokenExitType { MAXIMIZE_FEE_WITHDRAWAL, MINIMIZE_FEE_DEBT, KEEP_RATIO };
const ONE_ETH = new BN("1000000000000000000");
const ETH = (x: number | BN | string) => ONE_ETH.mul(new BN(x));

const ERC20Mock = artifacts.require("ERC20Mock");
const AgentVaultMock = artifacts.require("AgentVaultMock");
const AssetManager = artifacts.require("AssetManagerMock")
const CollateralPool = artifacts.require("CollateralPool");
const CollateralPoolToken = artifacts.require("CollateralPoolToken");
const DistributionToDelegatorsMock = artifacts.require("DistributionToDelegatorsMock");
const MockContract = artifacts.require('MockContract');
const FAsset = artifacts.require('FAsset');
const FAssetProxy = artifacts.require('FAssetProxy');
const RewardManager = artifacts.require("RewardManagerMock");
const IRewardManager = artifacts.require("IRewardManager");

contract(`CollateralPool.sol; ${getTestFile(__filename)}; Collateral pool basic tests`, accounts => {
    let wNat: ERC20MockInstance;
    let assetManager: AssetManagerMockInstance;
    let fAsset: FAssetInstance;
    let agentVault: AgentVaultMockInstance;
    let collateralPool: CollateralPoolInstance;
    let collateralPoolToken: CollateralPoolTokenInstance;
    let contracts: TestSettingsContracts;

    const agent = accounts[12];
    const governance = accounts[10];

    const exitCR = 1.2;

    let MIN_NAT_TO_ENTER: BN;
    let MIN_TOKEN_SUPPLY_AFTER_EXIT: BN;
    let MIN_NAT_BALANCE_AFTER_EXIT: BN;

    async function initialize() {
        contracts = await createTestContracts(governance);
        wNat = await ERC20Mock.new("wNative", "wNat");
        assetManager = await AssetManager.new(wNat.address);
        await assetManager.setCommonOwner(agent);
        await assetManager.setCheckForValidAgentVaultAddress(false);
        const fAssetImpl = await FAsset.new();
        const fAssetProxy = await FAssetProxy.new(fAssetImpl.address, "fBitcoin", "fBTC", "Bitcoin", "BTC", 18, { from: governance });
        fAsset = await FAsset.at(fAssetProxy.address);
        await fAsset.setAssetManager(assetManager.address, { from: governance });
        await impersonateContract(assetManager.address, toBNExp(1000, 18), accounts[0]);
        agentVault = await AgentVaultMock.new(assetManager.address, agent);
        collateralPool = await CollateralPool.new(
            agentVault.address,
            assetManager.address,
            fAsset.address,
            Math.floor(exitCR * MAX_BIPS)
        );
        collateralPoolToken = await CollateralPoolToken.new(collateralPool.address, "FAsset Collateral Pool Token BTC-AG1", "FCPT-BTC-AG1");
        // set pool token
        const payload = collateralPool.contract.methods.setPoolToken(collateralPoolToken.address).encodeABI();
        await assetManager.callFunctionAt(collateralPool.address, payload);
        // synch collateral pool constants
        MIN_NAT_TO_ENTER = await collateralPool.MIN_NAT_TO_ENTER();
        MIN_TOKEN_SUPPLY_AFTER_EXIT = await collateralPool.MIN_TOKEN_SUPPLY_AFTER_EXIT();
        MIN_NAT_BALANCE_AFTER_EXIT = await collateralPool.MIN_NAT_BALANCE_AFTER_EXIT();
        // temporary fix for testing
        await assetManager.registerFAssetForCollateralPool(fAsset.address);
        return { contracts, wNat, assetManager, fAsset, agentVault, collateralPool, collateralPoolToken, MIN_NAT_TO_ENTER, MIN_TOKEN_SUPPLY_AFTER_EXIT, MIN_NAT_BALANCE_AFTER_EXIT };
    }

    beforeEach(async () => {
        ({ contracts, wNat, assetManager, fAsset, agentVault, collateralPool, collateralPoolToken, MIN_NAT_TO_ENTER, MIN_TOKEN_SUPPLY_AFTER_EXIT, MIN_NAT_BALANCE_AFTER_EXIT } =
            await loadFixtureCopyVars(initialize));
    });

    async function poolFAssetFeeNatValue() {
        const poolFAssetFees = await collateralPool.totalFAssetFees();
        const { 0: assetPriceMul, 1: assetPriceDiv } = await assetManager.assetPriceNatWei();
        return poolFAssetFees.mul(assetPriceMul).div(assetPriceDiv);
    }

    async function givePoolFAssetFees(amount: BN) {
        await fAsset.mint(collateralPool.address, amount, { from: assetManager.address });
        const payload = collateralPool.contract.methods.fAssetFeeDeposited(amount).encodeABI();
        await assetManager.callFunctionAt(collateralPool.address, payload);
    }

    async function getPoolCollaterals() {
        const collateral = await collateralPool.totalCollateral();
        const fassets = await collateralPool.totalFAssetFees();
        return [collateral, fassets];
    }

    async function getPoolCRBIPS() {
        const { 0: priceMul, 1: priceDiv } = await assetManager.assetPriceNatWei();
        const poolNatBalance = await collateralPool.totalCollateral();
        const backedFAsset = await assetManager.getFAssetsBackedByPool(agentVault.address)
        return (backedFAsset.gtn(0)) ?
            poolNatBalance.muln(MAX_BIPS).mul(priceDiv).div(priceMul).div(backedFAsset) :
            new BN(10 * MAX_BIPS);
    }

    async function getPoolVirtualFassets() {
        const poolFassetBalance = await fAsset.balanceOf(collateralPool.address);
        const poolFassetDebt = await collateralPool.totalFAssetFeeDebt();
        return poolFassetBalance.add(poolFassetDebt);
    }

    // n = (r F p / q) - N
    async function getNatRequiredToGetPoolCRAbove(CR: number) {
        const { 0: priceMul, 1: priceDiv } = await assetManager.assetPriceNatWei();
        const poolNatBalance = await collateralPool.totalCollateral();
        const backedFAsset = await assetManager.getFAssetsBackedByPool(agentVault.address)
        const required = mulBips(backedFAsset.mul(priceMul), CR).div(priceDiv).sub(poolNatBalance);
        return required.lt(new BN(0)) ? new BN(0) : required;
    }

    async function fassetsRequiredToKeepCR(tokens: BN) {
        const fassetSupply = await fAsset.totalSupply();
        const tokenSupply = await collateralPoolToken.totalSupply();
        const collateral = await wNat.balanceOf(collateralPool.address);
        const natShare = collateral.mul(tokens).div(tokenSupply);
        return fassetSupply.mul(natShare).div(collateral);
    }

    async function getPoolAboveCR(account: string, cr: number) {
        const natToTopup = await getNatRequiredToGetPoolCRAbove(cr);
        const poolTokenSupply = await collateralPoolToken.totalSupply();
        let collateral = maxBN(natToTopup, MIN_NAT_TO_ENTER);
        if (poolTokenSupply.eqn(0)) {
            const natToCoverFAsset = await poolFAssetFeeNatValue();
            const natToCoverCollateral = await collateralPool.totalCollateral();
            collateral = maxBN(collateral, maxBN(natToCoverCollateral, natToCoverFAsset));
        }
        await collateralPool.enter({ value: collateral, from: account });
    }

    // n = N - r f p / q
    async function getNatRequiredToGetPoolCRBelow(cr: number) {
        const { 0: priceMul, 1: priceDiv } = await assetManager.assetPriceNatWei();
        const poolNatBalance = await collateralPool.totalCollateral();
        const backedFAsset = await assetManager.getFAssetsBackedByPool(agentVault.address);
        const required = poolNatBalance.sub(mulBips(backedFAsset.mul(priceMul), cr).div(priceDiv));
        return required.lt(new BN(0)) ? new BN(0) : required;
    }

    async function natToTokens(nat: BN) {
        const poolTokenSupply = await collateralPoolToken.totalSupply();
        const poolCollateral = await collateralPool.totalCollateral();
        return nat.mul(poolTokenSupply).div(poolCollateral);
    }

    async function tokensToNat(tokens: BN) {
        const poolTokenSupply = await collateralPoolToken.totalSupply();
        const poolCollateral = await collateralPool.totalCollateral();
        return tokens.mul(poolCollateral).div(poolTokenSupply);
    }

    async function getFAssetRequiredToNotSpoilCR(natShare: BN): Promise<BN> {
        const poolCR = await getPoolCRBIPS();
        const backedFAsset = await assetManager.getFAssetsBackedByPool(agentVault.address);
        const poolNatBalance = await collateralPool.totalCollateral();
        if (poolCR.gtn(exitCR)) {
            const { 0: priceMul, 1: priceDiv } = await assetManager.assetPriceNatWei();
            const _aux = priceDiv.mul(poolNatBalance.sub(natShare)).muln(MAX_BIPS).div(priceMul).divn(MAX_BIPS * exitCR);
            return backedFAsset.gt(_aux) ? backedFAsset.sub(_aux) : toBN(0);
        } else {
            return backedFAsset.mul(natShare).div(poolNatBalance);
        }
    }

    async function enterAndPayFeeDebt(collateralPool: CollateralPoolInstance, value: BN, debtPayment: number | BN | 'full', account: string = accounts[0]) {
        const debtBefore = await collateralPool.fAssetFeeDebtOf(account);
        await collateralPool.enter({ value: value, from: account });
        const debtAfter = await collateralPool.fAssetFeeDebtOf(account);
        const debtPayAmount = debtPayment === 'full' ? debtAfter.sub(debtBefore) : toBN(debtPayment);
        if (debtPayAmount.gt(BN_ZERO)) {
            await collateralPool.payFAssetFeeDebt(debtPayAmount, { from: account });
        }
    }

    describe("setting contract variables", () => {

        it("should fail at calling setPoolToken from non asset manager", async () => {
            const prms = collateralPool.setPoolToken(collateralPoolToken.address);
            await expectRevert(prms, "only asset manager");
        });

        it("should fail at resetting pool token", async () => {
            const payload = collateralPool.contract.methods.setPoolToken(collateralPoolToken.address).encodeABI();
            const prms = assetManager.callFunctionAt(collateralPool.address, payload);
            await expectRevert(prms, "pool token already set");
        });

        it("should correctly set exit collateral ratio", async () => {
            const setTo = BN_ONE;
            const payload = collateralPool.contract.methods.setExitCollateralRatioBIPS(setTo).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, payload);
            const newExitCollateralCR = await collateralPool.exitCollateralRatioBIPS();
            assertEqualBN(newExitCollateralCR, setTo);
        });

        it("should upgrade wnat contract", async () => {
            // get some wnat to the collateral pool
            await collateralPool.enter({ value: ETH(100) });
            // upgrade the wnat contract
            const newWNat: ERC20MockInstance = await ERC20Mock.new("new wnat", "WNat");
            const payload = collateralPool.contract.methods.upgradeWNatContract(newWNat.address).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, payload);
            // check that wnat contract was updated
            const wnatFromCollateralPool = await collateralPool.wNat();
            expect(wnatFromCollateralPool).to.equal(newWNat.address);
            // check that funds were transferred correctly
            const fundsOnOldWNat = await wNat.balanceOf(collateralPool.address);
            assertEqualBN(fundsOnOldWNat, BN_ZERO);
            const fundsOnNewWNat = await newWNat.balanceOf(collateralPool.address);
            assertEqualBN(fundsOnNewWNat, ETH(100));
        });

        it("should upgrade wnat contract with old wnat contract", async () => {
            const payload = collateralPool.contract.methods.upgradeWNatContract(wNat.address).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, payload);
            const newWNat = await collateralPool.wNat();
            expect(newWNat).to.equal(wNat.address);
        });

    });

    // to test whether users can send debt tokens
    describe("collateral pool token tests", () => {

        it("should have correct name and symbol", async () => {
            expect(await collateralPoolToken.name()).to.equal("FAsset Collateral Pool Token BTC-AG1");
            expect(await collateralPoolToken.symbol()).to.equal("FCPT-BTC-AG1");
        });

        it("should fetch the pool token", async () => {
            expect(await collateralPool.poolToken()).to.equal(collateralPoolToken.address);
        });

        it("should fetch no tokens of a new account", async () => {
            const tokens = await collateralPoolToken.debtFreeBalanceOf(accounts[0]);
            assertEqualBN(tokens, BN_ZERO);
        });

        it("should not be able to send debt tokens", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(100) });
            // pool gets fees
            await givePoolFAssetFees(ETH(10));
            // account1 enters the pool with some debt
            await fAsset.mint(accounts[1], ETH(1), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(1), { from: accounts[1] });
            await enterAndPayFeeDebt(collateralPool, ETH(100), ETH(1), accounts[1]);
            // account1 tries to send too many tokens to another account
            const tokens = await collateralPoolToken.balanceOf(accounts[1]);
            const prms = collateralPoolToken.transfer(accounts[2], tokens, { from: accounts[1] });
            await expectRevert(prms, "insufficient transferable balance");
        });

        it("should transfer free tokens between users", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(100) });
            // pool gets fees
            await fAsset.mint(collateralPool.address, ETH(10), { from: assetManager.address });
            // account1 enters the pool with some debt
            await fAsset.mint(accounts[1], ETH(1), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(1), { from: accounts[1] });
            await enterAndPayFeeDebt(collateralPool, ETH(100), "full", accounts[1]);
            // account1 sends all his free tokens to another account
            const freeTokensOfUser1 = await collateralPoolToken.debtFreeBalanceOf(accounts[1]);
            await collateralPoolToken.transfer(accounts[2], freeTokensOfUser1, { from: accounts[1] });
            const freeTokensOfUser2 = await collateralPoolToken.debtFreeBalanceOf(accounts[2]);
            assertEqualBN(freeTokensOfUser2, freeTokensOfUser1);
            // account2 sends his tokens back to account1
            await collateralPoolToken.transfer(accounts[1], freeTokensOfUser1, { from: accounts[2] });
            const freeTokensOfUser1AfterTransfer = await collateralPoolToken.debtFreeBalanceOf(accounts[1]);
            assertEqualBN(freeTokensOfUser1AfterTransfer, freeTokensOfUser1);
        });

        describe("timelock", () => {

            it("should not be able to transfer or exit with timelocked tokens", async () => {
                // set timelock to 1 day
                await assetManager.setTimelockDuration(time.duration.days(1));
                // account0 obtains some pool tokens
                await collateralPool.enter({ value: ETH(100) });
                const timelockedTokens1 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens1, ETH(100));
                const transferableTokens1 = await collateralPoolToken.transferableBalanceOf(accounts[0]);
                assertEqualBN(transferableTokens1, BN_ZERO);
                const prms1 = collateralPoolToken.transfer(accounts[1], ETH(1));
                await expectRevert(prms1, "insufficient non-timelocked balance");
                const prms2 = collateralPool.exit(ETH(1));
                await expectRevert(prms2, "insufficient non-timelocked balance");
                // increase time by 1 day
                await deterministicTimeIncrease(time.duration.days(1));
                const timelockedTokens2 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens2, BN_ZERO);
                await collateralPoolToken.transfer(accounts[1], ETH(1));
                const tokenBalanceAcc0 = await collateralPoolToken.balanceOf(accounts[1]);
                assertEqualBN(tokenBalanceAcc0, ETH(1));
                // exit
                const natAcc0Before = toBN(await web3.eth.getBalance(accounts[0]));
                const receipt = await collateralPool.exit(ETH(99));
                const gas = calcGasCost(receipt);
                const natAcc0After = toBN(await web3.eth.getBalance(accounts[0]));
                assertEqualBN(natAcc0After, natAcc0Before.sub(gas).add(ETH(99)));
            });

            it("should be able to transfer and exit with tokens that have expired timelock", async () => {
                // set timelock to 1 day
                await assetManager.setTimelockDuration(time.duration.days(1));
                // account0 obtains some pool tokens
                await collateralPool.enter({ value: ETH(100) });
                // increase time by half a day
                await deterministicTimeIncrease(time.duration.hours(12));
                await collateralPool.enter({ value: ETH(200) });
                const timelockedTokens1 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens1, ETH(300));
                // increase time by half a day
                await deterministicTimeIncrease(time.duration.hours(12));
                const timelockedTokens2 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens2, ETH(200));
                // transfer and exit with available tokens
                await collateralPoolToken.transfer(accounts[1], ETH(10));
                const tokenBalanceAcc01 = await collateralPoolToken.balanceOf(accounts[0]);
                const tokenBalanceAcc11 = await collateralPoolToken.balanceOf(accounts[1]);
                assertEqualBN(tokenBalanceAcc01, ETH(290));
                assertEqualBN(tokenBalanceAcc11, ETH(10));
                const timelockedBalanceAfterTransferAcc01 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedBalanceAfterTransferAcc01, ETH(200));
                const natBalanceAcc00 = toBN(await web3.eth.getBalance(accounts[0]));
                const receipt1 = await collateralPool.exit(ETH(90));
                const gas1 = calcGasCost(receipt1);
                const natBalanceAcc01 = toBN(await web3.eth.getBalance(accounts[0]));
                assertEqualBN(natBalanceAcc01, natBalanceAcc00.sub(gas1).add(ETH(90)));
                // increase time by half a day
                await deterministicTimeIncrease(time.duration.hours(12));
                const timelockedTokens3 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens3, BN_ZERO);
                // transfer and exit with available tokens
                const receipt2 = await collateralPoolToken.transfer(accounts[2], ETH(100));
                const gas2 = calcGasCost(receipt2);
                const tokenBalanceAcc02 = await collateralPoolToken.balanceOf(accounts[0]);
                assertEqualBN(tokenBalanceAcc02, ETH(100));
                const receipt3 = await collateralPool.exit(ETH(100));
                const gas3 = calcGasCost(receipt3)
                const natBalanceAcc02 = toBN(await web3.eth.getBalance(accounts[0]));
                assertEqualBN(natBalanceAcc02, natBalanceAcc01.sub(gas2).sub(gas3).add(ETH(100)));
                // check that user holds no leftover tokens
                const allTokensAcc0 = await collateralPoolToken.balanceOf(accounts[0]);
                assertEqualBN(allTokensAcc0, BN_ZERO);
            });

            it("should test timelock with user manually clearing entries in parts and then exiting", async () => {
                // set timelock to 1 hour
                await assetManager.setTimelockDuration(time.duration.hours(1));
                // account0 obtains some pool tokens
                for (let i = 0; i < 100; i++) {
                    await collateralPool.enter({ value: ETH(1) });
                }
                const timelockedTokens1 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens1, ETH(100));
                // cleanup should have no effect before tokens expire
                await collateralPoolToken.cleanupExpiredTimelocks(accounts[0], 10);
                const timelockedTokens2 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens2, ETH(100));
                // wait for timelocks to expire
                await deterministicTimeIncrease(time.duration.hours(1));
                // now timelocked should be zero
                const timelockedTokens3 = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                assertEqualBN(timelockedTokens3, BN_ZERO);
                // currently there are 100 open timelock entries, pretend it is too much
                // and clear them in batches of 10
                for (let i = 0; i < 10; i++) {
                    // use call to check result (does nothing, but returns correct result)
                    const cleanedAllExpired = await collateralPoolToken.cleanupExpiredTimelocks.call(accounts[0], 10);
                    assert.equal(cleanedAllExpired, i === 9, `all should be cleaned at the last call (i=${i})`);
                    // now execute the actual cleaning
                    await collateralPoolToken.cleanupExpiredTimelocks(accounts[0], 10);
                    // timelocked balance should not change
                    const timelockedTokens = await collateralPoolToken.timelockedBalanceOf(accounts[0]);
                    assertEqualBN(timelockedTokens, BN_ZERO);
                }
                // exit with all tokens
                const natBalanceAcc00 = toBN(await web3.eth.getBalance(accounts[0]));
                const receipt = await collateralPool.exit(ETH(100));
                const gas = calcGasCost(receipt);
                const natBalanceAcc0 = toBN(await web3.eth.getBalance(accounts[0]));
                assertEqualBN(natBalanceAcc0, natBalanceAcc00.sub(gas).add(ETH(100)));
            });

            it("should test timelock in combination with debt tokens", async () => {
                // set timelock to 1 day
                await assetManager.setTimelockDuration(time.duration.hours(1));
                // account0 obtains enters the pool
                await collateralPool.enter({ value: ETH(1000) });
                // pool gets fees
                await givePoolFAssetFees(ETH(10));
                // account1 enters the pool with some debt
                await fAsset.mint(accounts[1], ETH(1000), { from: assetManager.address });
                await fAsset.approve(collateralPool.address, ETH(1000), { from: accounts[1] });
                await enterAndPayFeeDebt(collateralPool, ETH(1000), ETH(1), accounts[1]);
                const transferableTokensAcc11 = await collateralPoolToken.debtFreeBalanceOf(accounts[1]);
                const timelockedTokensAcc11 = await collateralPoolToken.timelockedBalanceOf(accounts[1]);
                // account1 can't send his transferable tokens because of timelock
                const prms1 = collateralPoolToken.transfer(accounts[2], transferableTokensAcc11, { from: accounts[1] });
                await expectRevert(prms1, "insufficient non-timelocked balance");
                // account1 can't send his debt tokens
                const prms2 = collateralPoolToken.transfer(accounts[2], transferableTokensAcc11.addn(1), { from: accounts[1] });
                await expectRevert(prms2, "insufficient transferable balance");
                // account1 can't exit with his timelocked tokens
                const prms3 = collateralPool.exit(transferableTokensAcc11, { from: accounts[1] });
                await expectRevert(prms3, "insufficient non-timelocked balance");
                // account1 gets new timelocked tokens after a while and no new transferable tokens
                await deterministicTimeIncrease(time.duration.minutes(30));
                await collateralPool.enter({ value: ETH(1000), from: accounts[1] });
                const transferableTokensAcc12 = await collateralPoolToken.debtFreeBalanceOf(accounts[1]);
                assertEqualBN(transferableTokensAcc11, transferableTokensAcc12); // just so we are aware of this
                // first enter tokens get unlocked after 30 minutes
                await deterministicTimeIncrease(time.duration.minutes(30));
                // account1's transferable tokens are unlocked
                const nonTimelockedTokensAcc12 = await collateralPoolToken.nonTimelockedBalanceOf(accounts[1]);
                assertEqualBN(nonTimelockedTokensAcc12, timelockedTokensAcc11);
                await collateralPoolToken.transfer(accounts[2], transferableTokensAcc12, { from: accounts[1] });
                const transferableTokensAcc13 = await collateralPoolToken.debtFreeBalanceOf(accounts[1]);
                assertEqualBN(transferableTokensAcc13, BN_ZERO);
                // account1 tries to send non-transferable tokens
                const prms4 = collateralPoolToken.transfer(accounts[2], BN_ONE, { from: accounts[1] });
                await expectRevert(prms4, "insufficient transferable balance");
                await collateralPool.exit(nonTimelockedTokensAcc12.sub(transferableTokensAcc12), { from: accounts[1] });
                const nonTimelockedTokensAcc13 = await collateralPoolToken.nonTimelockedBalanceOf(accounts[1]);
                assertEqualBN(nonTimelockedTokensAcc13, BN_ZERO);
                // after 30 minutes user can exit with the remaining tokens
                await deterministicTimeIncrease(time.duration.minutes(30));
                const remainingTokensAcc11 = await collateralPoolToken.balanceOf(accounts[1]);
                await collateralPool.exit(remainingTokensAcc11, { from: accounts[1] });
                const remainingTokensAcc12 = await collateralPoolToken.balanceOf(accounts[1]);
                assertEqualBN(remainingTokensAcc12, BN_ZERO);
            });

            it("should make the payout from an agent override the timelock", async () => {
                // set timelock to 1 hour
                await assetManager.setTimelockDuration(time.duration.hours(1));
                // agent enters the pool
                const payload1 = collateralPool.contract.methods.enter().encodeABI();
                await agentVault.callFunctionAt(collateralPool.address, payload1, ETH(100), { value: ETH(100) });
                // agent is forced to payout by the asset manager
                const payload2 = collateralPool.contract.methods.payout(accounts[1], ETH(80), ETH(40)).encodeABI();
                const resp = await assetManager.callFunctionAt(collateralPool.address, payload2);
                await expectEvent.inTransaction(resp.tx, collateralPool, "CPPaidOut", {
                    recipient: accounts[1], paidNatWei: ETH(80), burnedTokensWei: ETH(40)
                });
                // check that agent has no tokens left and that wNat was transferred to acc1
                const agentTokens = await collateralPoolToken.balanceOf(agent);
                assertEqualBN(agentTokens, BN_ZERO);
                const wNatBalanceAcc1 = await wNat.balanceOf(accounts[1]);
                assertEqualBN(wNatBalanceAcc1, ETH(80));
                // agent responsibility - amount transferred to acc1 stayed in the pool
                const poolWNatBalance = await collateralPool.totalCollateral();
                assertEqualBN(poolWNatBalance, ETH(20));
            });
        });

    });

    describe("entering collateral pool", () => {

        // collateral pool now tracks its balance, so sending nat directly (without enter) is not allowed,
        // thus this test is deprecated
        it.skip("should lock entering if pool token supply is much larger than pool collateral", async () => {
            // enter the pool
            await collateralPool.enter({ value: ETH(1001) });
            // artificially burn pool collateral
            await wNat.burnAmount(collateralPool.address, ETH(1000));
            // check that entering is disabled
            const prms = collateralPool.enter({ value: MIN_NAT_TO_ENTER, from: accounts[1] });
            await expectRevert(prms, "pool nat balance too small");
        });

        it("should fail entering the pool with too little funds", async () => {
            const prms = collateralPool.enter({ value: MIN_NAT_TO_ENTER.sub(BN_ONE) });
            await expectRevert(prms, "amount of nat sent is too low");
        });

        it("should fail entering with f-assets that don't cover the one in a tokenless pool", async () => {
            await givePoolFAssetFees(ETH(10));
            const prms = collateralPool.enter({ value: MIN_NAT_TO_ENTER });
            await expectRevert(prms,
                "If pool has no tokens, but holds f-asset, you need to send at least f-asset worth of collateral");
        });

        it("should enter tokenless, f-assetless and natless pool", async () => {
            await collateralPool.enter({ value: ETH(10) });
            const tokens = await collateralPoolToken.debtFreeBalanceOf(accounts[0]);
            assertEqualBN(tokens, ETH(10));
            const tokenSupply = await collateralPoolToken.totalSupply();
            assertEqualBN(tokenSupply, ETH(10));
            const collateral = await wNat.balanceOf(collateralPool.address);
            assertEqualBN(collateral, ETH(10));
        });

        it("should enter tokenless and f-assetless pool holding some collateral", async () => {
            // artificially make pool have no tokens but have collateral (this might not be possible with non-mocked asset manager)
            await agentVault.enterPool(collateralPool.address, { value: ETH(10) });
            const assetManagerPayout = collateralPool.contract.methods.payout(accounts[0], 0, ETH(10)).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, assetManagerPayout);
            assertEqualBN(await collateralPoolToken.totalSupply(), BN_ZERO);
            assertEqualBN(await wNat.balanceOf(collateralPool.address), ETH(10));
            await wNat.mintAmount(accounts[0], ETH(10));
            const prms = collateralPool.enter({ value: ETH(10).subn(1) });
            await expectRevert(prms,
                "if pool has no tokens, but holds collateral, you need to send at least that amount of collateral");
            await collateralPool.enter({ value: ETH(10) });
            assertEqualBN(await collateralPoolToken.debtFreeBalanceOf(accounts[0]), ETH(10));
            assertEqualBN(await collateralPoolToken.totalSupply(), ETH(10));
            assertEqualBN(await wNat.balanceOf(collateralPool.address), ETH(20));
            assertEqualBN(await collateralPool.totalCollateral(), ETH(20));
        });

        it("should enter the topuped pool without f-assets, then pay off the debt", async () => {
            // mint required f-assets beforehand
            const initialPoolFassets = ETH(5);
            await givePoolFAssetFees(initialPoolFassets);
            const fassets = initialPoolFassets.muln(2);
            await fAsset.mint(accounts[0], fassets, { from: assetManager.address });
            await fAsset.approve(collateralPool.address, fassets);
            // externally topup the pool
            await getPoolAboveCR(accounts[1], exitCR);
            const initialTokens = await collateralPoolToken.balanceOf(accounts[1]);
            const initialNat = await wNat.balanceOf(collateralPool.address);
            // enter collateral pool without f-assets
            const nat = initialNat.muln(2);
            await collateralPool.enter({ value: nat });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            assertEqualBN(tokens, initialTokens.mul(nat).div(initialNat));
            const liquidTokens = await collateralPoolToken.debtFreeBalanceOf(accounts[0]);
            assertEqualBN(liquidTokens, BN_ZERO);
            const debtFassets = await collateralPool.fAssetFeeDebtOf(accounts[0]);
            assertEqualBN(debtFassets, initialPoolFassets.mul(tokens).div(initialTokens));
            const freeFassets = await collateralPool.fAssetFeesOf(accounts[0]);
            assertEqualBN(freeFassets, BN_ZERO);
            // pay off the f-asset debt
            await collateralPool.payFAssetFeeDebt(debtFassets, { from: accounts[0] });
            const tokensAfter = await collateralPoolToken.balanceOf(accounts[0]);
            assertEqualBN(tokensAfter, tokens);
            const liquidTokensAfter = await collateralPoolToken.debtFreeBalanceOf(accounts[0]);
            assertEqualBN(liquidTokensAfter, tokens);
            const debtFassetsAfter = await collateralPool.fAssetFeeDebtOf(accounts[0]);
            assertEqualBN(debtFassetsAfter, BN_ZERO);
            const freeFassetsAfter = await collateralPool.virtualFAssetOf(accounts[0]);
            assertEqualBN(freeFassetsAfter, debtFassets);
        });

    });

    describe("exiting collateral pool", () => {

        it("should revert on exiting the pool with zero tokens", async () => {
            const prms = collateralPool.exit(0);
            await expectRevert(prms, "token share is zero");
        });

        it("should revert on user not having enough tokens", async () => {
            await collateralPool.enter({ value: ETH(10) });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const prms = collateralPool.exit(tokens.add(BN_ONE));
            await expectRevert(prms, "token balance too low");
        });

        it("should require that amount of tokens left after exit is large enough", async () => {
            await collateralPool.enter({ value: MIN_TOKEN_SUPPLY_AFTER_EXIT });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const prms = collateralPool.exit(tokens.sub(MIN_TOKEN_SUPPLY_AFTER_EXIT).add(BN_ONE));
            await expectRevert(prms, "token supply left after exit is too low and non-zero");
        });

        it("should require nat share to be larger than 0", async () => {
            await fAsset.mint(collateralPool.address, ETH(1), { from: assetManager.address });
            await collateralPool.enter({ value: ETH(10) });
            await collateralPool.payout(accounts[0], ETH(1), 0, { from: assetManager.address });
            const prms = collateralPool.exit(BN_ONE);
            await expectRevert(prms, "amount of sent tokens is too small");
        });

        it("should require nat share to leave enough pool non-zero collateral", async () => {
            await fAsset.mint(collateralPool.address, ETH(10), { from: assetManager.address });
            await collateralPool.enter({ value: MIN_TOKEN_SUPPLY_AFTER_EXIT.addn(2) });
            await collateralPool.payout(accounts[0], MIN_TOKEN_SUPPLY_AFTER_EXIT.divn(2), 0, { from: assetManager.address });
            const prms = collateralPool.exit(new BN(2));
            await expectRevert(prms, "collateral left after exit is too low and non-zero");
        });

        it("should enter the pool and fail to exit due to CR falling below exitCR", async () => {
            const fassets = ETH(10);
            await fAsset.mint(accounts[0], fassets, { from: assetManager.address });
            const natToExit = await getNatRequiredToGetPoolCRAbove(exitCR);
            await collateralPool.enter({ value: natToExit });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            await expectRevert(collateralPool.exit(10), "collateral ratio falls below exitCR");
            await expectRevert(collateralPool.exit(tokens), "collateral ratio falls below exitCR");
        });

        it("should enter and exit correctly when f-asset supply is zero", async () => {
            const collateral = ETH(1);
            await collateralPool.enter({ value: collateral });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            assertEqualBN(tokens, collateral);
            const natAcc0Before = toBN(await web3.eth.getBalance(accounts[0]));
            const receipt = await collateralPool.exit(tokens);
            const gas = calcGasCost(receipt);
            const natAcc0After = toBN(await web3.eth.getBalance(accounts[0]));
            assertEqualBN(natAcc0After, natAcc0Before.sub(gas).add(collateral));
        });

        it("should enter and exit, yielding no profit and no (at most 1wei) loss", async () => {
            const collateral = ETH(100);
            const initialFassets = ETH(1);
            await fAsset.mint(accounts[1], ETH(10), { from: assetManager.address });
            await fAsset.mint(accounts[0], initialFassets, { from: assetManager.address });
            // get f-assets into the pool and get collateral above exitCR
            const natToGetAboveExitCR = maxBN(await getNatRequiredToGetPoolCRAbove(exitCR), ETH(1));
            await collateralPool.enter({ value: natToGetAboveExitCR, from: accounts[1] });
            // user enters the pool
            await collateralPool.enter({ value: collateral });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            // exit
            const natAcc0Before = toBN(await web3.eth.getBalance(accounts[0]));
            const receipt = await collateralPool.exit(tokens);
            const gas = calcGasCost(receipt);
            const natAcc1After = toBN(await web3.eth.getBalance(accounts[0]));
            assertEqualBNWithError(natAcc1After, natAcc0Before.sub(gas).add(collateral), BN_ONE);
        });

        it("should collect all fees after exiting", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(10), from: accounts[0] });
            // collateral pool collects fees
            await givePoolFAssetFees(ETH(10));
            // account1 enters the pool with no f-assets
            await collateralPool.enter({ value: ETH(10), from: accounts[1] });
            // collateral pool collects additional fees
            await givePoolFAssetFees(ETH(10));
            // account1 exits with fees using MAXIMIZE_FEE_WITHDRAWAL token exit type
            const allTokens = await collateralPoolToken.totalSupply();
            const freeTokens = await collateralPoolToken.debtFreeBalanceOf(accounts[1]);
            const virtualFassets = await getPoolVirtualFassets();
            const poolNatBalance = await wNat.balanceOf(collateralPool.address);
            const natAcc1Before = toBN(await web3.eth.getBalance(accounts[1]));
            const receipt = await collateralPool.exit(freeTokens, { from: accounts[1] });
            const gas = calcGasCost(receipt);
            const natAcc1After = toBN(await web3.eth.getBalance(accounts[1]));
            // collect fees
            const remainingFees = await collateralPool.fAssetFeesOf(accounts[1]);
            await collateralPool.withdrawFees(remainingFees, { from: accounts[1] });
            // account1 should have earned nat and all his f-asset fees
            // amount that is transferred when exiting the pool
            // fee is paid from that amount
            const transferredAmount = virtualFassets.mul(freeTokens).div(allTokens)
            const earnedFassets = await fAsset.balanceOf(accounts[1]);
            assertEqualBN(earnedFassets, transferredAmount);
            const earnedNat = natAcc1After.sub(natAcc1Before).add(gas);
            assertEqualBN(earnedNat, poolNatBalance.mul(freeTokens).div(allTokens));
        });

        it("should eliminate all debt tokens after exit", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(10), from: accounts[0] });
            // collateral pool collects fees
            await givePoolFAssetFees(ETH(10));
            // account1 enters the pool with no f-assets
            await collateralPool.enter({ value: ETH(10), from: accounts[1] });
            // collateral pool collects additional fees
            await givePoolFAssetFees(ETH(10));
            // account1 exits with fees using MINIMIZE_FEE_DEBT token exit type
            const allTokens = await collateralPoolToken.totalSupply();
            const debtTokens = await collateralPoolToken.debtLockedBalanceOf(accounts[1]);
            const poolNatBalance = await wNat.balanceOf(collateralPool.address);
            const natAcc1Before = toBN(await web3.eth.getBalance(accounts[1]));
            const receipt = await collateralPool.exit(debtTokens, { from: accounts[1] });
            const gas = calcGasCost(receipt);
            const natAcc1After = toBN(await web3.eth.getBalance(accounts[1]));
            // account1 should have 0 f-asset debt and earn appropriate wnat
            const debtFassets = await collateralPool.fAssetFeeDebtOf(accounts[1]);
            assertEqualBN(debtFassets, BN_ZERO);
            const earnedWnat = natAcc1After.sub(natAcc1Before).add(gas);
            assertEqualBN(earnedWnat, poolNatBalance.mul(debtTokens).div(allTokens));
        });

        it("should exit with recipient", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(20), from: accounts[0] });
            // account1 exits with fees using MAXIMIZE_FEE_WITHDRAWAL token exit type
            const exitTokens = ETH(10);
            const receipt = await collateralPool.exitTo(exitTokens, accounts[2], { from: accounts[0] });
            const holderReceivedNat = await calculateReceivedNat(receipt, accounts[0]);
            const receiverReceivedNat = await calculateReceivedNat(receipt, accounts[2]);
            assertEqualBN(holderReceivedNat, BN_ZERO);
            assertEqualBN(receiverReceivedNat, exitTokens);
        });

        it("should withdraw fees with recipient", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(20), from: accounts[0] });
            // collateral pool collects fees
            await givePoolFAssetFees(ETH(10));
            // account1 exits with fees using MAXIMIZE_FEE_WITHDRAWAL token exit type
            const withdrawFees = ETH(10);
            const poolFees = await collateralPool.totalFAssetFees();
            const receipt = await collateralPool.withdrawFeesTo(withdrawFees, accounts[2], { from: accounts[0] });
            const holderReceivedFAssets = await fAsset.balanceOf(accounts[0]);
            const receiverReceivedFAssets = await fAsset.balanceOf(accounts[2]);
            assertEqualBN(holderReceivedFAssets, BN_ZERO);
            assertEqualBN(receiverReceivedFAssets, withdrawFees);
        });
    });

    describe("self-close exits", () => {

        it("should require token share to be larger than 0", async () => {
            const prms = collateralPool.selfCloseExit(BN_ZERO, true, "", ZERO_ADDRESS);
            await expectRevert(prms, "token share is zero");
        });

        it("should require that the token balance is large enough", async () => {
            await collateralPool.enter({ value: ETH(10) });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const prms = collateralPool.selfCloseExit(tokens.add(BN_ONE), true, "", ZERO_ADDRESS);
            await expectRevert(prms, "token balance too low");
        });

        it("should require that amount of tokens left after exit is large enough", async () => {
            await collateralPool.enter({ value: MIN_TOKEN_SUPPLY_AFTER_EXIT });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            await collateralPool.depositNat({ from: assetManager.address, value: ETH(1) })
            const prms = collateralPool.selfCloseExit(tokens.sub(MIN_TOKEN_SUPPLY_AFTER_EXIT).add(BN_ONE), true, "", ZERO_ADDRESS);
            await expectRevert(prms, "token supply left after exit is too low and non-zero");
        });

        it("should require nat share to be larger than 0", async () => {
            await fAsset.mint(collateralPool.address, ETH(1), { from: assetManager.address });
            await collateralPool.enter({ value: ETH(10) });
            await collateralPool.payout(accounts[0], ETH(1), 0, { from: assetManager.address });
            const prms = collateralPool.selfCloseExit(BN_ONE, true, "", ZERO_ADDRESS);
            await expectRevert(prms, "amount of sent tokens is too small");
        });

        it("should require nat share to leave enough pool non-zero collateral", async () => {
            await fAsset.mint(collateralPool.address, ETH(10), { from: assetManager.address });
            await collateralPool.enter({ value: MIN_NAT_BALANCE_AFTER_EXIT });
            const prms = collateralPool.selfCloseExit(new BN(2), true, "", ZERO_ADDRESS);
            await expectRevert(prms, "collateral left after exit is too low and non-zero");
        });

        it("should do a self-close exit where f-assets are required", async () => {
            await fAsset.mint(accounts[0], ETH(100), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(100));
            await collateralPool.enter({ value: ETH(10) });
            await collateralPool.enter({ value: ETH(1), from: accounts[1] });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const resp = await collateralPool.selfCloseExit(tokens, true, "", ZERO_ADDRESS);
            await expectEvent.inTransaction(resp.tx, assetManager, "AgentRedemptionInCollateral");
        });

        it("should not do a self-close exit where additional f-assets are required and the allowance is not high enough", async () => {
            await fAsset.mint(accounts[0], ETH(100), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(99));
            await collateralPool.enter({ value: ETH(10) });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const prms = collateralPool.selfCloseExit(tokens, true, "", ZERO_ADDRESS);
            await expectRevert(prms, "allowance too small");
        });

        it("should do a self-close exit where there are no f-assets to redeem", async () => {
            await collateralPool.enter({ value: ETH(10) });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const resp = await collateralPool.selfCloseExit(tokens, true, "", ZERO_ADDRESS);
            await expectEvent.notEmitted.inTransaction(resp.tx, assetManager, "AgentRedemptionInCollateral");
            await expectEvent.notEmitted.inTransaction(resp.tx, assetManager, "AgentRedemption");
        });

        it("should do a self-close exit where redemption is done in underlying asset", async () => {
            await givePoolFAssetFees(ETH(100));
            const natToEnter = await poolFAssetFeeNatValue();
            await collateralPool.enter({ value: natToEnter });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            await collateralPool.withdrawFees(ETH(100), { from: accounts[0] });
            await fAsset.approve(collateralPool.address, ETH(100), { from: accounts[0] });
            const resp = await collateralPool.selfCloseExit(tokens, false, "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", ZERO_ADDRESS);
            await expectEvent.inTransaction(resp.tx, assetManager, "AgentRedemption");
            assert((await getPoolCRBIPS()).gten(exitCR * MAX_BIPS))
        });

        it("should do a self-close exit where redemption is done in underlying asset with executor", async () => {
            await givePoolFAssetFees(ETH(100));
            const natToEnter = await poolFAssetFeeNatValue();
            await collateralPool.enter({ value: natToEnter });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            await collateralPool.withdrawFees(ETH(100), { from: accounts[0] });
            await fAsset.approve(collateralPool.address, ETH(100), { from: accounts[0] });
            const resp = await collateralPool.selfCloseExit(tokens, false, "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", accounts[5], { value: ETH(1) });
            await expectEvent.inTransaction(resp.tx, assetManager, "AgentRedemption", { _executor: accounts[5] });
            assert((await getPoolCRBIPS()).gten(exitCR * MAX_BIPS))
        });

        it("should do a self-close exit where redemption fails to be done in underlying asset as it does not exceed one lot", async () => {
            await assetManager.setLotSize(ETH(100));
            await fAsset.mint(accounts[0], ETH(100), { from: assetManager.address });
            await fAsset.increaseAllowance(collateralPool.address, ETH(100));
            await getPoolAboveCR(accounts[0], exitCR);
            const requiredFAssets = await collateralPool.fAssetRequiredForSelfCloseExit(ETH(1));
            const resp = await collateralPool.selfCloseExit(ETH(1), false, "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", ZERO_ADDRESS);
            await expectEvent.inTransaction(resp.tx, assetManager, "AgentRedemptionInCollateral");
            assert((await getPoolCRBIPS()).gten(exitCR * MAX_BIPS))
            const fAssetBalance = await fAsset.balanceOf(accounts[0]);
            assertEqualBN(ETH(100).sub(fAssetBalance), requiredFAssets);
        });

        it("should do a simple self-close exit with one user who has no f-asset debt", async () => {
            const collateral = ETH(100);
            const fassetBalanceBefore = ETH(100);
            await fAsset.mint(accounts[0], fassetBalanceBefore, { from: assetManager.address });
            await fAsset.approve(collateralPool.address, fassetBalanceBefore);
            await collateralPool.enter({ value: collateral });
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const natBefore = toBN(await web3.eth.getBalance(accounts[0]));
            const fAssetRequired = await getFAssetRequiredToNotSpoilCR(ETH(100));
            const receipt = await collateralPool.selfCloseExit(tokens, true, "", ZERO_ADDRESS);
            const gas = calcGasCost(receipt);
            const natAfter = toBN(await web3.eth.getBalance(accounts[0]));
            assertEqualBN(natAfter, natBefore.sub(gas).add(collateral));
            const fassetBalanceAfter = await fAsset.balanceOf(accounts[0]);
            // taking all collateral out of the pool and keeping CR the same
            // means you have to destroy all existing f-assets
            assertEqualBN(fassetBalanceAfter, fassetBalanceBefore.sub(fAssetRequired));
        });

        it("should do a simple self-close exit with one user who has f-asset debt", async () => {
            const collateral = ETH(1);
            // account1 enters the pool
            await collateralPool.enter({ value: ETH(1000), from: accounts[1] });
            // pool gets fees
            await fAsset.mint(collateralPool.address, ETH(1), { from: assetManager.address });
            // account0 enters the pool with f-asset debt
            await collateralPool.enter({ value: collateral });
            await fAsset.mint(accounts[0], ETH(10), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(10));
            // account0 does self-close exit
            const tokens = await collateralPoolToken.balanceOf(accounts[0]);
            const natBefore = toBN(await web3.eth.getBalance(accounts[0]));
            const receipt = await collateralPool.selfCloseExit(tokens, true, "", ZERO_ADDRESS);
            const gas = calcGasCost(receipt);
            const natAfter = toBN(await web3.eth.getBalance(accounts[0]));
            // check that account0's added collateral was repaid
            assertEqualBN(natAfter, natBefore.sub(gas).add(collateral));
        });

        it("should fail self close exit because because agent's max redeeemed f-assets is zero", async () => {
            // mint some f-assets for minter to be able to do redemption
            await fAsset.mint(accounts[0], ETH(100), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(100));
            // user enters the pool
            await collateralPool.enter({ value: ETH(100), from: accounts[0] });
            // agent can only redeem 1 f-asset at a time
            await assetManager.setMaxRedemptionFromAgent(ETH(0));
            // user wants to redeem all tokens, which means he would need to
            // take all 100 f-assets out of circulation
            const exitCRBIPS = await collateralPool.exitCollateralRatioBIPS();
            const exitCR = exitCRBIPS.toNumber() / MAX_BIPS;
            const tokensBefore = await collateralPoolToken.balanceOf(accounts[0]);
            const promise = collateralPool.selfCloseExit(tokensBefore, true, "", ZERO_ADDRESS);
            await expectRevert(promise, "redemption requires closing too many tickets");
        });

        it("should fail self close exit because agent's max redeemed f-assets is non-zero but less than required", async () => {
            // mint some f-assets for minter to be able to do redemption
            await fAsset.mint(accounts[0], ETH(100), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(100));
            // user enters the pool
            await collateralPool.enter({ value: ETH(100), from: accounts[0] });
            // agent can only redeem 1 f-asset at a time
            await assetManager.setMaxRedemptionFromAgent(ETH(1));
            // user wants to redeem all tokens, which means he would need to take all 100 f-assets out of circulation
            const exitCRBIPS = await collateralPool.exitCollateralRatioBIPS();
            const natToGetCRToExitCR = await getNatRequiredToGetPoolCRBelow(exitCRBIPS.toNumber() / MAX_BIPS);
            console.log("natToGetCRToExitCR", natToGetCRToExitCR.toString());
            // try self close exit
            const userTokens = await collateralPoolToken.balanceOf(accounts[0]);
            const promise = collateralPool.selfCloseExit(userTokens, true, "", ZERO_ADDRESS);
            await expectRevert(promise, "redemption requires closing too many tickets");
        });

        it("should self-close exit and collect fees with recipient", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(10), from: accounts[0] });
            // collateral pool collects fees
            await givePoolFAssetFees(ETH(10));
            // someone else add some backing
            await collateralPool.enter({ value: ETH(3), from: accounts[0] });
            // account1 exits with fees using MAXIMIZE_FEE_WITHDRAWAL token exit type
            const exitTokens = ETH(10);
            // const receipt = await collateralPool.exitTo(exitTokens, accounts[2], TokenExitType.MAXIMIZE_FEE_WITHDRAWAL, { from: accounts[0] });
            await collateralPool.withdrawFees(await collateralPool.fAssetFeesOf(accounts[0]), { from: accounts[0] });
            const holderWithdrawnFAssets = await fAsset.balanceOf(accounts[0]);
            //
            await fAsset.approve(collateralPool.address, ETH(10), { from: accounts[0] });
            const receipt = await collateralPool.selfCloseExitTo(exitTokens, true, accounts[2], "underlying_1", ZERO_ADDRESS, { from: accounts[0], value: ETH(1) });
            await expectEvent.inTransaction(receipt.tx, assetManager, "AgentRedemptionInCollateral", { _recipient: accounts[2], _amountUBA: ETH(5) });
            const holderReceivedNat = await calculateReceivedNat(receipt, accounts[0]);
            const receiverReceivedNat = await calculateReceivedNat(receipt, accounts[2]);
            const holderFAssetsLeftAfterSelfClose = await fAsset.balanceOf(accounts[0]);
            const receiverReceivedFAssets = await fAsset.balanceOf(accounts[2]);
            assertEqualBN(holderReceivedNat, BN_ZERO); // msg.value is returned to sender
            assertEqualBN(receiverReceivedNat, exitTokens);
            assertEqualBN(holderWithdrawnFAssets, ETH(10));
            assertEqualBN(holderFAssetsLeftAfterSelfClose, ETH(5));
            assertEqualBN(receiverReceivedFAssets, BN_ZERO);   // half fees get redeemed, so expect half fees to be paid out
            // on half of the fees that were paid out transfer fee is paid
        });

        it("self-close exit recipient should be valid", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(10), from: accounts[0] });
            // collateral pool collects fees
            await givePoolFAssetFees(ETH(10));
            // someone else add some backing
            await collateralPool.enter({ value: ETH(3), from: accounts[0] });
            // account1 exits with fees using MAXIMIZE_FEE_WITHDRAWAL token exit type
            const exitTokens = ETH(10);
            //
            await expectRevert(collateralPool.selfCloseExitTo(exitTokens, true, ZERO_ADDRESS, "underlying_1", ZERO_ADDRESS, { from: accounts[0] }), "invalid recipient address");
            await expectRevert(collateralPool.selfCloseExitTo(exitTokens, true, collateralPool.address, "underlying_1", ZERO_ADDRESS, { from: accounts[0] }), "invalid recipient address");
            const vaultAddress = await collateralPool.agentVault();
            await expectRevert(collateralPool.selfCloseExitTo(exitTokens, true, vaultAddress, "underlying_1", ZERO_ADDRESS, { from: accounts[0] }), "invalid recipient address");
        });
    });

    describe("externally dealing with fasset debt", () => {

        it("should fail at trying to withdraw 0 fees", async () => {
            await expectRevert(collateralPool.withdrawFees(0), "trying to withdraw zero f-assets");
        });

        it("should fail at trying to withdraw too many f-asset fees", async () => {
            await collateralPool.enter({ value: ETH(10), from: accounts[0] });
            await fAsset.mint(collateralPool.address, ETH(10), { from: assetManager.address });
            const prms = collateralPool.withdrawFees(ETH(10).add(BN_ONE));
            await expectRevert(prms, "f-asset balance too small");
        });

        it("should fail at trying to pay too much f-asset debt", async () => {
            await expectRevert(collateralPool.payFAssetFeeDebt(BN_ONE), "payment larger than fee debt");
        });

        it("should fail at trying to pay zero f-asset debt", async () => {
            await expectRevert(collateralPool.payFAssetFeeDebt(BN_ZERO), "zero f-asset debt payment");
        });

        it("should fail at trying to pay f-asset debt with too low f-asset allowance", async () => {
            await givePoolFAssetFees(ETH(10));
            const natToEnterEmptyPool = await poolFAssetFeeNatValue();
            await collateralPool.enter({ value: natToEnterEmptyPool, from: accounts[0] });
            await collateralPool.enter({ value: MIN_NAT_TO_ENTER, from: accounts[1] });
            const debt = await collateralPool.fAssetFeeDebtOf(accounts[1]);
            await fAsset.mint(accounts[1], debt, { from: assetManager.address });
            await fAsset.approve(collateralPool.address, debt.sub(BN_ONE), { from: accounts[1] });
            const prms = collateralPool.payFAssetFeeDebt(debt, { from: accounts[1] });
            await expectRevert(prms, "f-asset allowance too small");
        });

        it("should enter the pool accruing debt, then mint new debt to collect f-asset rewards", async () => {
            // first user enters pool
            await collateralPool.enter({ value: ETH(10), from: accounts[0] });
            // pool gets initial f-asset fees
            await givePoolFAssetFees(ETH(1));
            // second user enters pool
            await collateralPool.enter({ value: ETH(10), from: accounts[1] });
            // pool gets additional f-asset fees
            await givePoolFAssetFees(ETH(1));
            // account1 withdraws his share of fees from the pool
            const freeFassets = await collateralPool.fAssetFeesOf(accounts[1]);
            await collateralPool.withdrawFees(freeFassets, { from: accounts[1] });
            // check that user has collected his rewards
            const fassetReward = await fAsset.balanceOf(accounts[1]);
            assertEqualBN(fassetReward, freeFassets);
            // check that all his tokens are now debt tokens
            const tokens = await collateralPoolToken.debtFreeBalanceOf(accounts[1]);
            assertEqualBN(tokens, BN_ZERO);
        });

        it("should enter the pool accruing debt, then pay them off", async () => {
            // give user some funds to pay off the debt later
            await fAsset.mint(accounts[1], ETH(10), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(10), { from: accounts[1] });
            // first user enters pool
            await collateralPool.enter({ value: ETH(10) });
            // pool gets initial f-asset fees
            await givePoolFAssetFees(ETH(1));
            // second user enters pool
            await collateralPool.enter({ value: ETH(10), from: accounts[1] });
            // accounts[1] pays off the debt
            const debt = await collateralPool.fAssetFeeDebtOf(accounts[1]);
            await collateralPool.payFAssetFeeDebt(debt, { from: accounts[1] });
            // check that the debt is zero
            const newdebt = await collateralPool.fAssetFeeDebtOf(accounts[1]);
            assertEqualBN(newdebt, BN_ZERO);
            // check that all his tokens are now transferable
            const debtTokens = await collateralPool.debtLockedTokensOf(accounts[1]);
            assertEqualBN(debtTokens, BN_ZERO);
        });

    });

    describe("scenarios", () => {

        it("should yield no wei profit and at most 1wei loss to multiple people entering and exiting", async () => {
            const fassets = [ETH(10), ETH(100), ETH(1000)];
            const nats = [ETH(10), ETH(10), ETH(100000)];
            for (let i = 0; i < fassets.length; i++) {
                await fAsset.mint(accounts[i], fassets[i], { from: assetManager.address });
            }
            // get pool above exitCR (by non-included account)
            await getPoolAboveCR(accounts[10], exitCR);
            // users enter the pool
            for (let i = 0; i < fassets.length; i++) {
                await collateralPool.enter({ value: nats[i], from: accounts[i] });
            }
            // users exit the pool (in reverse order)
            for (let i = fassets.length - 1; i >= 0; i--) {
                const tokens = await collateralPoolToken.balanceOf(accounts[i]);
                const natBefore = toBN(await web3.eth.getBalance(accounts[i]));
                const receipt = await collateralPool.exit(tokens, { from: accounts[i] });
                const gas = calcGasCost(receipt);
                const natAfter = toBN(await web3.eth.getBalance(accounts[i]));
                assertEqualBNWithError(natAfter, natBefore.sub(gas).add(nats[i]), BN_ONE);
                const fassetBalance = await fAsset.balanceOf(accounts[i]);
                assertEqualBNWithError(fassetBalance, fassets[i], BN_ONE);
            }
        });

        it("should do a self-close exit with two users", async () => {
            const fassetBalanceOfAccount0 = ETH(2000);
            const fassetBalanceOfAccount1 = ETH(1000);
            await fAsset.mint(accounts[0], fassetBalanceOfAccount0, { from: assetManager.address });
            await fAsset.mint(accounts[1], fassetBalanceOfAccount1, { from: assetManager.address });
            await fAsset.approve(collateralPool.address, fassetBalanceOfAccount0, { from: accounts[0] });
            await fAsset.approve(collateralPool.address, fassetBalanceOfAccount1, { from: accounts[1] });
            // users enter the pool
            await collateralPool.enter({ value: ETH(100), from: accounts[0] });
            await collateralPool.enter({ value: ETH(100), from: accounts[1] });
            // account1 does self-close exit with all his tokens
            const cr0 = await getPoolCollaterals();
            const tokenShareOfAccount0 = await collateralPoolToken.balanceOf(accounts[0]);
            const fassetsRequiredFromAccount0 = await fassetsRequiredToKeepCR(tokenShareOfAccount0);
            let fAssetsBefore = await fAsset.totalSupply();
            const resp0 = await collateralPool.selfCloseExit(tokenShareOfAccount0, true, "", ZERO_ADDRESS, { from: accounts[0] });
            let fAssetsAfter = await fAsset.totalSupply();
            await expectEvent.inTransaction(resp0.tx, assetManager, "AgentRedemptionInCollateral", { _amountUBA: fassetsRequiredFromAccount0 });
            assertEqualBN(fAssetsBefore.sub(fAssetsAfter), fassetsRequiredFromAccount0); // f-assets were burned
            // account0 does self-close exit with one tenth of his tokens
            const cr1 = await getPoolCollaterals();
            const tokenShareOfAccount1 = (await collateralPoolToken.balanceOf(accounts[1])).div(new BN(10));
            const fassetsRequiredFromAccount1 = await fassetsRequiredToKeepCR(tokenShareOfAccount1);
            fAssetsBefore = await fAsset.totalSupply();
            const resp1 = await collateralPool.selfCloseExit(tokenShareOfAccount1, true, "", ZERO_ADDRESS, { from: accounts[1] });
            fAssetsAfter = await fAsset.totalSupply();
            await expectEvent.inTransaction(resp1.tx, assetManager, "AgentRedemptionInCollateral", { _amountUBA: fassetsRequiredFromAccount1 });
            assertEqualBN(fAssetsBefore.sub(fAssetsAfter), fassetsRequiredFromAccount1); // f-assets were burned
            const cr2 = await getPoolCollaterals();
            // check that pool's collateral ratio has stayed the same
            assertEqualBN(cr0[0].mul(cr1[1]), cr1[0].mul(cr0[1]));
            assertEqualBN(cr1[0].mul(cr2[1]), cr2[0].mul(cr1[1]));
            // note that collateral ratio could have increased, but here there were no free f-assets held by users,
            // so redeemed f-assets were exactly those necessary to preserve pool collateral ratio
        });

        it("should show that token value price drop via topup discount does not effect users' free f-assets", async () => {
            // account0 enters the pool
            await collateralPool.enter({ value: ETH(20), from: accounts[0] });
            // pool gets rewards (CR doesn't drop below topupCR)
            await fAsset.mint(collateralPool.address, ETH(10), { from: assetManager.address });
            // account1 enters the pool with ETH(10) f-assets
            await fAsset.mint(accounts[1], ETH(10), { from: assetManager.address });
            await fAsset.approve(collateralPool.address, ETH(10), { from: accounts[1] });
            await enterAndPayFeeDebt(collateralPool, ETH(10), "full", accounts[1]);
            const account1FreeFassetBefore = await collateralPool.fAssetFeesOf(accounts[1]);
            // a lot of f-assets get minted, dropping pool CR well below topupCR
            await fAsset.mint(accounts[2], ETH(10000), { from: assetManager.address });
            // account2 enters the pool buying up many tokens at topup discount (simulate pool token price drop)
            await fAsset.approve(collateralPool.address, ETH(10000), { from: accounts[2] });
            await enterAndPayFeeDebt(collateralPool, ETH(1000), 'full', accounts[2]);
            // check how much (free) f-assets does account1 have
            const account1FreeFassetAfter = await collateralPool.fAssetFeesOf(accounts[1]);
            assertEqualBNWithError(account1FreeFassetAfter, account1FreeFassetBefore, BN_ONE);
        });

        // as we cannot update balance when autoclaiming through executors,
        // this test shows how agent can steal all auto-claimed rewards upon destruction.
        // This is why `setAutoClaiming` was removed from collateral pool.
        it.skip("coinspect - can steal all auto-claimed rewards upon destruction", async () => {
            const contract = await MockContract.new();
            // @ts-ignore (collateral pool does not have auto claiming anymore)
            await collateralPool.setAutoClaiming(contract.address, [accounts[2]], { from: agent });
            let totalCollateral = await collateralPool.totalCollateral();
            let poolwNatBalance = await wNat.balanceOf(collateralPool.address);
            console.log("\n === Initial Pool State ===");
            console.log(`Total Collateral accounted: ${totalCollateral}`);
            console.log(`Pool wNAT balance: ${poolwNatBalance}`);
            // Simulate auto claims with an inlet of WNAT via depositTo (ultimately mints token to the recipient)
            await wNat.mintAmount(collateralPool.address, ETH(10));
            totalCollateral = await collateralPool.totalCollateral();
            poolwNatBalance = await wNat.balanceOf(collateralPool.address);
            console.log("\n === After Auto-Claim ===");
            console.log(`Total Collateral accounted: ${totalCollateral}`);
            console.log(`Pool wNAT balance: ${poolwNatBalance}`);
            let balanceOfAgent = await wNat.balanceOf(agent);
            console.log("\n === Before Pool Destruction ===");
            console.log(`Agent wNAT balance: ${balanceOfAgent}`);
            const payload = collateralPool.contract.methods.destroy(agent).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, payload);
            balanceOfAgent = await wNat.balanceOf(agent);
            console.log("\n === After Pool Destruction ===");
            console.log(`Agent wNAT balance: ${balanceOfAgent}`);
        });

    });

    describe("methods for pool liquidation through asset manager", () => {

        it("should not receive any collateral during internalWithdraw = false", async () => {
            const prms = collateralPool.send(ETH(1));
            await expectRevert(prms, "only internal use");
        });

        it("should fail destroying a pool with issued tokens", async () => {
            await collateralPool.enter({ value: ETH(1) });
            const payload = collateralPool.contract.methods.destroy(agent).encodeABI();
            const prms = assetManager.callFunctionAt(collateralPool.address, payload);
            await expectRevert(prms, "cannot destroy a pool with issued tokens");
        });

        it.skip("should fail destroying a pool with collateral", async () => {
            // give some collateral using mock airdrop
            const mockAirdrop = await MockContract.new();
            await mockAirdrop.givenAnyReturnUint(ETH(1));
            await collateralPool.claimAirdropDistribution(mockAirdrop.address, 1, { from: agent });
            // destroy
            const payload = collateralPool.contract.methods.destroy(agent).encodeABI();
            const prms = assetManager.callFunctionAt(collateralPool.address, payload);
            await expectRevert(prms, "cannot destroy a pool holding collateral");
        });

        it.skip("should fail at destroying a pool holding f-assets", async () => {
            await givePoolFAssetFees(ETH(1));
            const payload = collateralPool.contract.methods.destroy(agent).encodeABI();
            const prms = assetManager.callFunctionAt(collateralPool.address, payload);
            await expectRevert(prms, "cannot destroy a pool holding f-assets");
        });

        it("should destroy the pool (without nat balances)", async () => {
            // mint untracked f-assets, wNat and send nat to pool
            await wNat.mintAmount(collateralPool.address, ETH(1));
            await fAsset.mint(collateralPool.address, ETH(2), { from: assetManager.address });
            // destroy through asset manager
            const payload = collateralPool.contract.methods.destroy(agent).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, payload);
            // check that funds were transacted correctly
            assertEqualBN(await wNat.balanceOf(collateralPool.address), BN_ZERO);
            assertEqualBN(await fAsset.balanceOf(collateralPool.address), BN_ZERO);
            assertEqualBN(await wNat.balanceOf(agent), ETH(1));
            assertEqualBN(await fAsset.balanceOf(agent), ETH(2));
        });

        it("should destroy the pool (with nat balance)", async () => {
            // send nat to contract
            await transferWithSuicide(ETH(3), accounts[0], collateralPool.address);
            // destroy through asset manager
            const wNatBefore = await wNat.balanceOf(agent);
            const payload = collateralPool.contract.methods.destroy(agent).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, payload);
            const wNatAfter = await wNat.balanceOf(agent);
            // check that funds were transacted correctly
            assert.equal(await web3.eth.getBalance(collateralPool.address), "0");
            assertEqualBN(wNatAfter.sub(wNatBefore), ETH(3));
        });

        it("should payout collateral from collateral pool", async () => {
            // agentVault enters the pool
            await agentVault.enterPool(collateralPool.address, { value: ETH(100) });
            const agentVaultTokensBeforePayout = await collateralPoolToken.balanceOf(agentVault.address);
            // force payout from asset manager
            const collateralPayoutPayload = collateralPool.contract.methods.payout(accounts[0], ETH(1), ETH(1)).encodeABI();
            await assetManager.callFunctionAt(collateralPool.address, collateralPayoutPayload);
            // check that account0 has received specified wNat
            const natOfAccount0 = await wNat.balanceOf(accounts[0]);
            assertEqualBN(natOfAccount0, ETH(1));
            // check that tokens were slashed accordingly
            const agentTokensAfterPayout = await collateralPoolToken.balanceOf(agentVault.address);
            assertEqualBN(agentTokensAfterPayout, agentVaultTokensBeforePayout.sub(ETH(1)));
        });
    });

    describe("distribution claiming and wnat delegation", () => {

        it("should fail claiming airdropped distribution from non-agent address", async () => {
            const distributionToDelegators: DistributionToDelegatorsMockInstance = await DistributionToDelegatorsMock.new(wNat.address);
            const prms = collateralPool.claimAirdropDistribution(distributionToDelegators.address, 0, { from: accounts[0] });
            await expectRevert(prms, "only agent");
        });

        it("should claim airdropped distribution", async () => {
            const distributionToDelegators: DistributionToDelegatorsMockInstance = await DistributionToDelegatorsMock.new(wNat.address);
            await wNat.mintAmount(distributionToDelegators.address, ETH(1));
            const resp = await collateralPool.claimAirdropDistribution(distributionToDelegators.address, 0, { from: agent });
            await expectEvent.inTransaction(resp.tx, collateralPool, "CPClaimedReward", { amountNatWei: ETH(1), rewardType: '0' });
            const collateralPoolBalance = await wNat.balanceOf(collateralPool.address);
            assertEqualBN(collateralPoolBalance, ETH(1));
        });

        it("should check actual dropped amount not the claim from untrusted distribution contract", async () => {
            // create fake distribution that will return large claimed amount but actually transfer 0
            const distributionToDelegatorsMock = await MockContract.new();
            await distributionToDelegatorsMock.givenAnyReturn(web3.eth.abi.encodeParameter("uint256", ETH(1)));
            const distributionToDelegators: DistributionToDelegatorsMockInstance = await DistributionToDelegatorsMock.at(distributionToDelegatorsMock.address);
            assertEqualBN(await distributionToDelegators.claim.call(collateralPool.address, collateralPool.address, 5, true), ETH(1));
            // claim
            const resp = await collateralPool.claimAirdropDistribution(distributionToDelegators.address, 5, { from: agent });
            // nothing was transferred
            assertEqualBN(await wNat.balanceOf(collateralPool.address), toBN(0));
            // event and total collateral should reflect the actually transferred amount
            await expectEvent.inTransaction(resp.tx, collateralPool, "CPClaimedReward", { amountNatWei: "0", rewardType: '0' });
            assertEqualBN(await collateralPool.totalCollateral(), toBN(0));
        });

        it("should fail opting out of airdrop from non-agent address", async () => {
            const distributionToDelegators: DistributionToDelegatorsMockInstance = await DistributionToDelegatorsMock.new(wNat.address);
            const prms = collateralPool.optOutOfAirdrop(distributionToDelegators.address, { from: accounts[0] });
            await expectRevert(prms, "only agent");
        });

        it("should opt out of airdrop", async () => {
            const distributionToDelegators: DistributionToDelegatorsMockInstance = await DistributionToDelegatorsMock.new(wNat.address);
            const resp = await collateralPool.optOutOfAirdrop(distributionToDelegators.address, { from: agent });
            await expectEvent.inTransaction(resp.tx, distributionToDelegators, "OptedOutOfAirdrop", { account: collateralPool.address });
        });

        it("should claim rewards from reward manager", async () => {
            const WNat = artifacts.require("WNatMock");
            const wNat = await WNat.new(accounts[0], "WNat", "WNAT");
            // create reward manager
            const rewardManager = await RewardManager.new(wNat.address);
            const claimAmount = toBNExp(1, 18);
            await wNat.depositTo(rewardManager.address, { value: claimAmount });
            // claim
            const startAmount = await wNat.balanceOf(collateralPool.address);
            const resp = await collateralPool.claimDelegationRewards(rewardManager.address, 5, [], { from: agent });
            const endAmount = await wNat.balanceOf(collateralPool.address);
            assertEqualBN(endAmount.sub(startAmount), claimAmount);
            assertEqualBN(await wNat.balanceOf(rewardManager.address), toBN(0)); // should be empty now
        });

        it("should check actual dropped amount not the claim from untrusted distribution contract", async () => {
            // create fake distribution that will return large claimed amount but actually transfer 0
            const rewardManagerMock = await MockContract.new();
            await rewardManagerMock.givenAnyReturn(web3.eth.abi.encodeParameter("uint256", ETH(1)));
            const rewradManager = await IRewardManager.at(rewardManagerMock.address);
            assertEqualBN(await rewradManager.claim.call(collateralPool.address, collateralPool.address, 5, true, []), ETH(1));
            // claim
            const resp = await collateralPool.claimDelegationRewards(rewradManager.address, 5, [], { from: agent });
            // nothing was transferred
            assertEqualBN(await wNat.balanceOf(collateralPool.address), toBN(0));
            // event and total collateral should reflect the actually transferred amount
            await expectEvent.inTransaction(resp.tx, collateralPool, "CPClaimedReward", { amountNatWei: "0", rewardType: '1' });
            assertEqualBN(await collateralPool.totalCollateral(), toBN(0));
        });

    });

    describe("ERC-165 interface identification for Collateral Pool", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as any) as any as IERC165Contract;
            const ICollateralPool = artifacts.require("ICollateralPool");
            const IICollateralPool = artifacts.require("IICollateralPool");
            const iERC165 = await IERC165.at(agentVault.address);
            const iCollateralPool = await ICollateralPool.at(collateralPool.address);
            const iiCollateralPool = await IICollateralPool.at(collateralPool.address);
            assert.isTrue(await collateralPool.supportsInterface(erc165InterfaceId(iERC165.abi)));
            assert.isTrue(await collateralPool.supportsInterface(erc165InterfaceId(iCollateralPool.abi)));
            assert.isTrue(await collateralPool.supportsInterface(erc165InterfaceId(iiCollateralPool.abi, [iCollateralPool.abi])));
            assert.isFalse(await collateralPool.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });

    describe("ERC-165 interface identification for CollateralPoolFactory", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as "IERC165");
            const IICollateralPoolFactory = artifacts.require("IICollateralPoolFactory");
            const IUpgradableContractFactory = artifacts.require("IUpgradableContractFactory");
            assert.isTrue(await contracts.collateralPoolFactory.supportsInterface(erc165InterfaceId(IERC165)));
            assert.isTrue(await contracts.collateralPoolFactory.supportsInterface(erc165InterfaceId(IICollateralPoolFactory, [IUpgradableContractFactory])));
            assert.isFalse(await contracts.collateralPoolFactory.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });

    describe("ERC-165 interface identification for CollateralPoolTokenFactory", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as "IERC165");
            const IICollateralPoolTokenFactory = artifacts.require("IICollateralPoolTokenFactory");
            const IUpgradableContractFactory = artifacts.require("IUpgradableContractFactory");
            assert.isTrue(await contracts.collateralPoolTokenFactory.supportsInterface(erc165InterfaceId(IERC165)));
            assert.isTrue(await contracts.collateralPoolTokenFactory.supportsInterface(erc165InterfaceId(IICollateralPoolTokenFactory, [IUpgradableContractFactory])));
            assert.isFalse(await contracts.collateralPoolTokenFactory.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });

    describe("ERC-165 interface identification for Collateral Pool Token", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as "IERC165");
            const IERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20" as "IERC20");
            const ICollateralPoolToken = artifacts.require("ICollateralPoolToken");
            assert.isTrue(await collateralPoolToken.supportsInterface(erc165InterfaceId(IERC165)));
            assert.isTrue(await collateralPoolToken.supportsInterface(erc165InterfaceId(ICollateralPoolToken, [IERC20])));
            assert.isTrue(await collateralPoolToken.supportsInterface(erc165InterfaceId(IERC20)));
            assert.isFalse(await collateralPoolToken.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });

    describe("branch tests", () => {
        it("random address shouldn't be able to set exit collateral RatioBIPS", async () => {
            const setTo = BN_ONE;
            const res = collateralPool.setExitCollateralRatioBIPS(setTo, { from: accounts[12] });
            await expectRevert(res, "only asset manager");
        });

        it("random address shouldn't be able to mint collateral pool tokens", async () => {
            const res = collateralPoolToken.mint(accounts[12], ETH(10000), { from: accounts[5] });
            await expectRevert(res, "only collateral pool");
        });

        it("random address shouldn't be able to burn collateral pool tokens", async () => {
            const res = collateralPoolToken.burn(accounts[12], ETH(1), false, { from: accounts[5] });
            await expectRevert(res, "only collateral pool");
        });

        it("random address shouldn't be able to destroy collateral pool token", async () => {
            const res = collateralPoolToken.destroy(accounts[12], { from: accounts[5] });
            await expectRevert(res, "only collateral pool");
        });

        it("random address shouldn't be able to deposit fasset fees", async () => {
            const res = collateralPool.fAssetFeeDeposited(ETH(1), { from: accounts[5] });
            await expectRevert(res, "only asset manager");
        });

        it("random address shouldn't be able to destory collateral pool", async () => {
            const res = collateralPool.destroy(accounts[5], { from: accounts[5] });
            await expectRevert(res, "only asset manager");
        });

        it("random address shouldn't be able to payout", async () => {
            const res = collateralPool.payout(accounts[5], toWei(1), toWei(1), { from: accounts[5] });
            await expectRevert(res, "only asset manager");
        });

        it("random address shouldn't be able to upgrade wNat contract", async () => {
            const newWNat: ERC20MockInstance = await ERC20Mock.new("new wnat", "WNat");
            const res = collateralPool.upgradeWNatContract(newWNat.address, { from: accounts[5] });
            await expectRevert(res, "only asset manager");
        });

        it("random address shouldn't be able to claim rewards from reward manager", async () => {
            const distributionToDelegators: DistributionToDelegatorsMockInstance = await DistributionToDelegatorsMock.new(wNat.address);
            await wNat.mintAmount(distributionToDelegators.address, ETH(1));
            const res = collateralPool.claimDelegationRewards(distributionToDelegators.address, 0, [], { from: accounts[5] });
            await expectRevert(res, "only agent");
        });

        it("random addresses shouldn't be able to set delegations", async () => {
            const res = collateralPool.delegate(accounts[2], 5_000, { from: accounts[5] });
            await expectRevert(res, "only agent");
        });

        it("random address shouldn't be able to undelegate all", async () => {
            const res = collateralPool.undelegateAll({ from: accounts[5] });
            await expectRevert(res, "only agent");
        });

        it("random address shouldn't be able to delegate governance", async () => {
            const res = collateralPool.delegateGovernance(accounts[2], { from: accounts[5] });
            await expectRevert(res, "only agent");
        });

        it("random address shouldn't be able to undelegate governance", async () => {
            const res = collateralPool.undelegateGovernance({ from: accounts[5] });
            await expectRevert(res, "only agent");
        });

    });
});
