import { expectEvent, expectRevert, time } from "@openzeppelin/test-helpers";
import { AssetManagerSettings, CollateralClass, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { DiamondCut } from "../../../../lib/utils/diamond";
import { findRequiredEvent, requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BN_ZERO, BNish, DAYS, HOURS, MAX_BIPS, WEEKS, ZERO_ADDRESS, abiEncodeCall, erc165InterfaceId, latestBlockTimestamp, toBIPS, toBN, toBNExp, toWei } from "../../../../lib/utils/helpers";
import { web3DeepNormalize } from "../../../../lib/utils/web3normalize";
import { AgentVaultInstance, AssetManagerInitInstance, CollateralPoolInstance, CollateralPoolTokenInstance, ERC20MockInstance, FAssetInstance, FtsoMockInstance, IIAssetManagerInstance, WNatInstance } from "../../../../typechain-truffle";
import { testChainInfo } from "../../../integration/utils/TestChainInfo";
import { GENESIS_GOVERNANCE_ADDRESS } from "../../../utils/constants";
import { AssetManagerInitSettings, deployAssetManagerFacets, newAssetManager, newAssetManagerDiamond } from "../../../utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../utils/fasset/MockFlareDataConnectorClient";
import { deterministicTimeIncrease, getTestFile, loadFixtureCopyVars } from "../../../utils/test-helpers";
import { TestFtsos, TestSettingsContracts, createTestAgentSettings, createTestCollaterals, createTestContracts, createTestFtsos, createTestSettings } from "../../../utils/test-settings";
import { assertWeb3DeepEqual, assertWeb3Equal, web3ResultStruct } from "../../../utils/web3assertions";
import { assertApproximatelyEqual } from "../../../utils/approximation";

const Whitelist = artifacts.require('Whitelist');
const GovernanceSettings = artifacts.require('GovernanceSettings');
const AgentVault = artifacts.require('AgentVault');
const CollateralPool = artifacts.require('CollateralPool');
const CollateralPoolToken = artifacts.require('CollateralPoolToken');
const ERC20Mock = artifacts.require('ERC20Mock');
const AgentOwnerRegistry = artifacts.require('AgentOwnerRegistry');
const AgentVaultFactory = artifacts.require('AgentVaultFactory');
const CollateralPoolFactory = artifacts.require('CollateralPoolFactory');
const CollateralPoolTokenFactory = artifacts.require('CollateralPoolTokenFactory');
const TestUUPSProxyImpl = artifacts.require('TestUUPSProxyImpl');

const mulBIPS = (x: BN, y: BN) => x.mul(y).div(toBN(MAX_BIPS));
const divBIPS = (x: BN, y: BN) => x.mul(toBN(MAX_BIPS)).div(y);

function assertEqualWithNumError(x: BN, y: BN, err: BN) {
    assert.isTrue(x.sub(y).abs().lte(err), `Expected ${x} to be within ${err} of ${y}`);
}

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager basic tests`, async accounts => {
    const governance = accounts[10];
    let assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManagerInit: AssetManagerInitInstance;
    let diamondCuts: DiamondCut[];
    let assetManager: IIAssetManagerInstance;
    let fAsset: FAssetInstance;
    let wNat: WNatInstance;
    let usdc: ERC20MockInstance;
    let ftsos: TestFtsos;
    let settings: AssetManagerInitSettings;
    let collaterals: CollateralType[];
    let chain: MockChain;
    let wallet: MockChainWallet;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;
    let usdt: ERC20MockInstance;

    // addresses
    const underlyingBurnAddr = "Burn";
    const agentOwner1 = accounts[20];
    const underlyingAgent1 = "Agent1";  // addresses on mock underlying chain can be any string, as long as it is unique
    const whitelistedAccount = accounts[1];

    function lotsToUBA(lots: BNish): BN {
        return toBN(lots)
            .mul(toBN(settings.lotSizeAMG))
            .mul(toBN(settings.assetUnitUBA))
            .div(toBN(settings.assetMintingGranularityUBA));
    }

    async function getCollateralPoolToken(agentVault: string) {
        const pool = await CollateralPool.at(await assetManager.getCollateralPool(agentVault));
        return CollateralPoolToken.at(await pool.token());
    }

    // price of ftso-asset in uba/wei/base units
    async function ubaToUSDWei(uba: BN, ftso: FtsoMockInstance) {
        const { 0: assetPrice, 2: decimals } = await ftso.getCurrentPriceWithDecimals();
        return uba.mul(assetPrice).div(toBN(10**decimals.toNumber()));
    }
    async function ubaToC1Wei(uba: BN) {
        const { 0: assetPrice } = await ftsos.asset.getCurrentPrice();
        const { 0: usdcPrice } = await ftsos.usdc.getCurrentPrice();
        return uba.mul(assetPrice).div(usdcPrice);
    }
    async function ubaToPoolWei(uba: BN) {
        const { 0: assetPriceMul, 1: assetPriceDiv } = await assetManager.assetPriceNatWei();
        return uba.mul(assetPriceMul).div(assetPriceDiv);
    }
    async function usd5ToVaultCollateralWei(usd5: BN) {
        const { 0: usdcPrice, 2: usdcDecimals } = await ftsos.usdc.getCurrentPriceWithDecimals();
        return usd5.mul(toWei(10**usdcDecimals.toNumber()).divn(1e5)).div(usdcPrice);
    }

    async function depositUnderlyingAsset(agentVault: AgentVaultInstance, owner: string, underlyingAgent: string, amount: BN) {
        chain.mint("random_address", amount);
        const txHash = await wallet.addTransaction("random_address", underlyingAgent, amount, PaymentReference.topup(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, "random_address", underlyingAgent);
        await assetManager.confirmTopupPayment(proof, agentVault.address, { from: owner });
        return proof;
    }

    async function depositAgentCollaterals(
        agentVault: AgentVaultInstance, owner: string,
        depositVaultCollateral: BN = toWei(3e8), depositPool: BN = toWei(3e8)
    ) {
        await usdc.mintAmount(owner, depositVaultCollateral);
        await usdc.approve(agentVault.address, depositVaultCollateral, { from: owner });
        await agentVault.depositCollateral(usdc.address, depositVaultCollateral, { from: owner });
        await agentVault.buyCollateralPoolTokens({ from: owner, value: depositPool });
    }

    async function createAgentVaultWithEOA(owner: string, underlyingAddress: string): Promise<AgentVaultInstance> {
        chain.mint(underlyingAddress, toBNExp(100, 18));
        const txHash = await wallet.addTransaction(underlyingAddress, underlyingBurnAddr, 1, PaymentReference.addressOwnership(owner));
        const proof = await attestationProvider.provePayment(txHash, underlyingAddress, underlyingBurnAddr);
        await assetManager.proveUnderlyingAddressEOA(proof, { from: owner });
        const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAddress);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const settings = createTestAgentSettings(usdc.address);
        const response = await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(settings), { from: owner });
        return AgentVault.at(findRequiredEvent(response, 'AgentVaultCreated').args.agentVault);
    }

    //For creating agent where vault collateral and pool wnat tokens are the same
    async function depositAgentCollateralsNAT(
        agentVault: AgentVaultInstance, owner: string,
        depositVaultCollateral: BN = toWei(3e8), depositPool: BN = toWei(3e8)
    ) {
        await usdc.mintAmount(owner, depositVaultCollateral);
        await usdc.approve(agentVault.address, depositVaultCollateral, { from: owner });
        await wNat.deposit({ from: owner, value: depositVaultCollateral })
        await wNat.transfer(agentVault.address, depositVaultCollateral, { from: owner })
        await agentVault.depositCollateral(usdc.address, depositVaultCollateral, { from: owner });
        await agentVault.buyCollateralPoolTokens({ from: owner, value: depositPool });
    }

    //For creating agent where vault collateral and pool wnat are the same
    async function createAgentVaultWithEOANatVaultCollateral(owner: string, underlyingAddress: string): Promise<AgentVaultInstance> {
        chain.mint(underlyingAddress, toBNExp(100, 18));
        const txHash = await wallet.addTransaction(underlyingAddress, underlyingBurnAddr, 1, PaymentReference.addressOwnership(owner));
        const proof = await attestationProvider.provePayment(txHash, underlyingAddress, underlyingBurnAddr);
        await assetManager.proveUnderlyingAddressEOA(proof, { from: owner });
        const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAddress);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const settings = createTestAgentSettings(collaterals[0].token);
        const response = await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(settings), { from: owner });
        return AgentVault.at(findRequiredEvent(response, 'AgentVaultCreated').args.agentVault);
    }

    //For creating agent where vault collateral and pool wnat are the same
    async function createAvailableAgentWithEOANAT(
        owner: string, underlyingAddress: string,
        depositVaultCollateral: BN = toWei(3e8), depositPool: BN = toWei(3e8)
    ): Promise<AgentVaultInstance> {
        const agentVault = await createAgentVaultWithEOANatVaultCollateral(owner, underlyingAddress);
        await depositAgentCollateralsNAT(agentVault, owner, depositVaultCollateral, depositPool);
        await assetManager.makeAgentAvailable(agentVault.address, { from: owner });
        return agentVault;
    }

    async function createAvailableAgentWithEOA(
        owner: string, underlyingAddress: string,
        depositVaultCollateral: BN = toWei(3e8), depositPool: BN = toWei(3e8)
    ): Promise<AgentVaultInstance> {
        const agentVault = await createAgentVaultWithEOA(owner, underlyingAddress);
        await depositAgentCollaterals(agentVault, owner, depositVaultCollateral, depositPool);
        await assetManager.makeAgentAvailable(agentVault.address, { from: owner });
        return agentVault;
    }

    // self-mints through an agent and then sends f-assets to the minter
    async function mintFassets(agentVault: AgentVaultInstance, owner: string, underlyingAgent: string, minter: string, lots: BN) {
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        const amountUBA = lotsToUBA(lots);
        const feeUBA = mulBIPS(amountUBA, toBN(agentInfo.feeBIPS));
        const poolFeeShareUBA = mulBIPS(feeUBA, toBN(agentInfo.poolFeeShareBIPS));
        const agentFeeShareUBA = feeUBA.sub(poolFeeShareUBA);
        const paymentAmountUBA = amountUBA.add(feeUBA);
        // make and prove payment transaction
        chain.mint("random_address", paymentAmountUBA);
        const txHash = await wallet.addTransaction("random_address", underlyingAgent, paymentAmountUBA,
            PaymentReference.selfMint(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, "random_address", underlyingAgent);
        // self-mint and send f-assets to minter
        await assetManager.selfMint(proof, agentVault.address, lots, { from: owner });
        if (minter !== owner) await fAsset.transfer(minter, amountUBA, { from: owner });
        return { underlyingPaymentUBA: paymentAmountUBA, underlyingTxHash: txHash, poolFeeShareUBA, agentFeeShareUBA }
    }

    function skipToProofUnavailability(lastUnderlyingBlock: BNish, lastUnderlyingTimestamp: BNish) {
        chain.skipTimeTo(Number(lastUnderlyingTimestamp));
        chain.mine(Number(lastUnderlyingBlock) - chain.blockHeight() + 1);
        chain.skipTime(flareDataConnectorClient.queryWindowSeconds + 1);
        chain.mine(chain.finalizationBlocks);
    }

    async function initialize() {
        const ci = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        [diamondCuts, assetManagerInit] = await deployAssetManagerFacets();
        // save some contracts as globals
        ({ wNat } = contracts);
        usdc = contracts.stablecoins.USDC;
        usdt = contracts.stablecoins.USDT;
        // create FTSOs for nat, stablecoins and asset and set some price
        ftsos = await createTestFtsos(contracts.ftsoRegistry, ci);
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true, announcedUnderlyingConfirmationMinSeconds: 10 });
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        return { contracts, diamondCuts, assetManagerInit, wNat, usdc, ftsos, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, usdt };
    }

    beforeEach(async () => {
        ({ contracts, diamondCuts, assetManagerInit, wNat, usdc, ftsos, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, usdt } = await loadFixtureCopyVars(initialize));
    });

    describe("set and update settings / properties", () => {

        it("should correctly remove asset manager controller", async () => {
            const isAttachedBefore = await assetManager.controllerAttached();
            assert.equal(isAttachedBefore, true);
            await assetManager.attachController(false, { from: assetManagerController });
            const isAttachedAfter = await assetManager.controllerAttached();
            assert.equal(isAttachedAfter, false);
        });

        it("should correctly set asset manager settings", async () => {
            const resFAsset = await assetManager.fAsset();
            assert.notEqual(resFAsset, ZERO_ADDRESS);
            assert.equal(resFAsset, fAsset.address);
            const resSettings = web3ResultStruct(await assetManager.getSettings());
            const resInitSettings = resSettings as AssetManagerInitSettings;
            settings.fAsset = fAsset.address;
            settings.assetManagerController = assetManagerController;
            // add RedemptionTimeExtensionFacet settings
            resInitSettings.redemptionPaymentExtensionSeconds = await assetManager.redemptionPaymentExtensionSeconds();
            // add TransferFeeFacet settings
            const tfSettings = await assetManager.transferFeeSettings();
            resInitSettings.transferFeeMillionths = tfSettings.transferFeeMillionths;
            resInitSettings.transferFeeClaimFirstEpochStartTs = tfSettings.firstEpochStartTs;
            resInitSettings.transferFeeClaimEpochDurationSeconds = tfSettings.epochDuration;
            resInitSettings.transferFeeClaimMaxUnexpiredEpochs = tfSettings.maxUnexpiredEpochs;
            // add CoreVault settings
            resInitSettings.coreVaultNativeAddress = await assetManager.getCoreVaultNativeAddress();
            resInitSettings.coreVaultTransferFeeBIPS = await assetManager.getCoreVaultTransferFeeBIPS();
            resInitSettings.coreVaultTransferTimeExtensionSeconds = await assetManager.getCoreVaultTransferTimeExtensionSeconds();
            resInitSettings.coreVaultRedemptionFeeBIPS = await assetManager.getCoreVaultRedemptionFeeBIPS();
            resInitSettings.coreVaultMinimumAmountLeftBIPS = await assetManager.getCoreVaultMinimumAmountLeftBIPS();
            resInitSettings.coreVaultMinimumRedeemLots = await assetManager.getCoreVaultMinimumRedeemLots();
            //
            assertWeb3DeepEqual(resSettings, settings);
            assert.equal(await assetManager.assetManagerController(), assetManagerController);
        });

        it("should update settings correctly", async () => {
            // act
            const newSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            newSettings.collateralReservationFeeBIPS = 150;
            await assetManager.setCollateralReservationFeeBips(150, { from: assetManagerController });
            // assert
            const res = web3ResultStruct(await assetManager.getSettings());
            assertWeb3DeepEqual(newSettings, res);
        });
    });

    describe("update agent settings", () => {
        it("should fail at announcing agent setting update from non-agent-owner account", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await expectRevert(assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: accounts[80] }),
                "only agent vault owner");
        });

        it("should fail at changing announced agent settings from non-agent-owner account", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentFeeChangeTimelock);
            await expectRevert(assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: accounts[80] }),
                "only agent vault owner");
        });

        it("should correctly update agent settings fee BIPS", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            //Invalid setting name will be reverted
            let res = assetManager.announceAgentSettingUpdate(agentVault.address, "something", 2000, { from: agentOwner1 });
            await expectRevert(res, "invalid setting name");
            //Can't execute update if it is not announced
            res = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert(res, "no pending update");
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: agentOwner1 });
            //Can't execute update if called to early after announcement
            res = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert(res, "update not valid yet");
            await deterministicTimeIncrease(agentFeeChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.feeBIPS.toString(), "2000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "feeBIPS"), agentInfo.feeBIPS);
        });

        it("should fail if the agent setting is executed too early or too late", async () => {
            const settings = await assetManager.getSettings();
            const agentFeeChangeTimelock = settings.agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            // announce
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: agentOwner1 });
            // can't execute update if called to early after announcement
            const res1 = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert(res1, "update not valid yet");
            await deterministicTimeIncrease(agentFeeChangeTimelock);
            await deterministicTimeIncrease(1 * DAYS);  // too late
            const res2 = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert(res2, "update not valid anymore");
        });

        it("should not update agent settings fee BIPS if value too high", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 200000000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentFeeChangeTimelock);
            let res = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert(res, "fee too high");
        });

        it("should correctly update agent setting pool fee share BIPS", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", 2000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentFeeChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolFeeShareBIPS.toString(), "2000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolFeeShareBIPS"), agentInfo.poolFeeShareBIPS);
        });

        it("should not update agent setting pool fee share BIPS if value too high", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", 20000000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentFeeChangeTimelock);
            let res = assetManager.executeAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", { from: agentOwner1 });
            await expectRevert(res, "value too high");
        });

        it("should correctly update agent setting minting VaultCollateral collateral ratio BIPS", async () => {
            const agentCollateralRatioChangeTimelock = (await assetManager.getSettings()).agentMintingCRChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "mintingVaultCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentCollateralRatioChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "mintingVaultCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.mintingVaultCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "mintingVaultCollateralRatioBIPS"), agentInfo.mintingVaultCollateralRatioBIPS);
        });

        it("should correctly update agent setting minting pool collateral ratio BIPS", async () => {
            const agentCollateralRatioChangeTimelock = (await assetManager.getSettings()).agentMintingCRChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentCollateralRatioChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.mintingPoolCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "mintingPoolCollateralRatioBIPS"), agentInfo.mintingPoolCollateralRatioBIPS);
        });

        it("should not update agent setting minting pool collateral ratio BIPS if value too small", async () => {
            const agentCollateralRatioChangeTimelock = (await assetManager.getSettings()).agentMintingCRChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", 10, { from: agentOwner1 });
            await deterministicTimeIncrease(agentCollateralRatioChangeTimelock);
            let res = assetManager.executeAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert(res, "collateral ratio too small");
        });

        it("should correctly update agent setting buy fasset by agent factor BIPS", async () => {
            const agentBuyFactorChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", 9300, { from: agentOwner1 });
            await deterministicTimeIncrease(agentBuyFactorChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.buyFAssetByAgentFactorBIPS.toString(), "9300");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "buyFAssetByAgentFactorBIPS"), agentInfo.buyFAssetByAgentFactorBIPS);
        });

        it("should not update agent setting buy fasset by agent factor BIPS if value is too low or too high", async () => {
            const agentBuyFactorChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", 10100, { from: agentOwner1 });
            await deterministicTimeIncrease(agentBuyFactorChangeTimelock);
            await expectRevert(assetManager.executeAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", { from: agentOwner1 }), "value too high");
            await assetManager.announceAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", 8000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentBuyFactorChangeTimelock);
            await expectRevert(assetManager.executeAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", { from: agentOwner1 }), "value too low");
        });

        it("should correctly update agent setting pool exit collateral ratio BIPS", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolExitCRChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolExitCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolExitCollateralRatioBIPS"), agentInfo.poolExitCollateralRatioBIPS);
        });

        it("should not update agent setting pool exit collateral ratio BIPS if value too low", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", 2, { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolExitCRChangeTimelock);
            let res = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert(res, "value too low")
        });

        it("should not update agent setting pool exit collateral ratio BIPS if increase too big", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const newExitCR = toBN(agentInfo.poolExitCollateralRatioBIPS).muln(2);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newExitCR, { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolExitCRChangeTimelock);
            let res = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert(res, "increase too big")
        });

        it("should always be able to update exitCR to 1.2 minCR (even if minCR grows so fast that the increase is higher that 3/2)", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const ct = await assetManager.getCollateralType(CollateralClass.POOL, wNat.address);
            const newMinCR = toBN(ct.minCollateralRatioBIPS).muln(2);
            // cannot increase before the minCR grows
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newMinCR.muln(119).divn(100), { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolExitCRChangeTimelock);
            let res1 = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert(res1, "increase too big")
            //
            await assetManager.setCollateralRatiosForToken(CollateralClass.POOL, wNat.address,
                newMinCR, toBN(ct.ccbMinCollateralRatioBIPS).muln(2), toBN(ct.safetyMinCollateralRatioBIPS).muln(2),
                { from: assetManagerController });
            // still can't increase too much
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newMinCR.muln(121).divn(100), { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolExitCRChangeTimelock);
            let res2 = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert(res2, "increase too big")
            // but can increase up to 1.2 minCR
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newMinCR.muln(119).divn(100), { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolExitCRChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
        });

        it("should correctly update agent setting pool exit collateral ratio BIPS", async () => {
            const agentPoolTopupCRChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolTopupCRChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolExitCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolExitCollateralRatioBIPS"), agentInfo.poolExitCollateralRatioBIPS);
        });

        it("should correctly update agent setting pool topup collateral ratio BIPS", async () => {
            const agentPoolTopupCRChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolTopupCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolTopupCRChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolTopupCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolTopupCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolTopupCollateralRatioBIPS"), agentInfo.poolTopupCollateralRatioBIPS);
        });

        it("should not update agent setting pool topup collateral ratio BIPS if value too low", async () => {
            const agentPoolTopupCRChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolTopupCollateralRatioBIPS", 2, { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolTopupCRChangeTimelock);
            let res = assetManager.executeAgentSettingUpdate(agentVault.address, "poolTopupCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert(res, "value too low")
        });

        it("should correctly update agent setting pool topup token price factor BIPS", async () => {
            const agentPoolTopupPriceFactorChangeTimelock = (await assetManager.getSettings()).poolExitAndTopupChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolTopupTokenPriceFactorBIPS", 9000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentPoolTopupPriceFactorChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolTopupTokenPriceFactorBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolTopupTokenPriceFactorBIPS.toString(), "9000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolTopupTokenPriceFactorBIPS"), agentInfo.poolTopupTokenPriceFactorBIPS);
        });

        it("should correctly update agent setting handshake type", async () => {
            const agentFeeChangeTimelockSeconds = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "handshakeType", 1, { from: agentOwner1 });
            await deterministicTimeIncrease(agentFeeChangeTimelockSeconds);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "handshakeType", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.handshakeType.toString(), "1");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "handshakeType"), agentInfo.handshakeType);
        });

        it("should correctly update agent setting redemptionPoolFeeShareBIPS", async () => {
            const agentFeeChangeTimelockSeconds = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "redemptionPoolFeeShareBIPS"), 0);   // always 0 initially
            await assetManager.announceAgentSettingUpdate(agentVault.address, "redemptionPoolFeeShareBIPS", 2000, { from: agentOwner1 });
            await deterministicTimeIncrease(agentFeeChangeTimelockSeconds);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "redemptionPoolFeeShareBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "redemptionPoolFeeShareBIPS"), 2000);
        });
    });

    describe("agent vault and pool upgrade", () => {
        it("should upgrade agent vault", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const testProxyImpl = await TestUUPSProxyImpl.new();
            const agentVaultFactory = await AgentVaultFactory.new(testProxyImpl.address);
            await assetManager.setAgentVaultFactory(agentVaultFactory.address, { from: assetManagerController });
            // now the implementation is still old
            const startImplAddress = await agentVault.implementation();
            // test
            await assetManager.upgradeAgentVaultAndPool(agentVault.address, { from: agentOwner1 });
            assert.equal(await agentVault.implementation(), testProxyImpl.address);
            assert.notEqual(await agentVault.implementation(), startImplAddress);
        });

        it("should upgrade agent vault, pool and pool token", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const collateralPool = await CollateralPool.at(await agentVault.collateralPool());
            const collateralPoolToken = await CollateralPoolToken.at(await collateralPool.poolToken());
            const testProxyImpl = await TestUUPSProxyImpl.new();
            const newCollateralPoolImpl = await CollateralPool.new(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, 0, 0, 0);
            //
            const agentVaultFactory = await AgentVaultFactory.new(testProxyImpl.address);
            const collateralPoolFactory = await CollateralPoolFactory.new(newCollateralPoolImpl.address);
            const collateralPoolTokenFactory = await CollateralPoolTokenFactory.new(testProxyImpl.address);
            //
            await assetManager.setAgentVaultFactory(agentVaultFactory.address, { from: assetManagerController });
            await assetManager.setCollateralPoolFactory(collateralPoolFactory.address, { from: assetManagerController });
            await assetManager.setCollateralPoolTokenFactory(collateralPoolTokenFactory.address, { from: assetManagerController });
            // test
            await assetManager.upgradeAgentVaultAndPool(agentVault.address, { from: agentOwner1 });
            assert.equal(await agentVault.implementation(), testProxyImpl.address);
            assert.equal(await collateralPool.implementation(), newCollateralPoolImpl.address);
            assert.equal(await collateralPoolToken.implementation(), testProxyImpl.address);
        });

        it("should batch upgrade agent vaults, pools and pool tokens", async () => {
            // create some agents
            const agentVaults: AgentVaultInstance[] = [];
            for (let i = 0; i < 10; i++) {
                const agentVault = await createAgentVaultWithEOA(accounts[20 + i], `underlying_agent_${i}`);
                agentVaults.push(agentVault);
            }
            // create new implementations
            const newAgentVaultImpl = await AgentVault.new(ZERO_ADDRESS);
            const newCollateralPoolTokenImpl = await CollateralPoolToken.new(ZERO_ADDRESS, "", "");
            const newCollateralPoolImpl = await CollateralPool.new(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, 0, 0, 0);
            // create new factories
            const agentVaultFactory = await AgentVaultFactory.new(newAgentVaultImpl.address);
            const collateralPoolFactory = await CollateralPoolFactory.new(newCollateralPoolImpl.address);
            const collateralPoolTokenFactory = await CollateralPoolTokenFactory.new(newCollateralPoolTokenImpl.address);
            // upgrade factories
            await assetManager.setAgentVaultFactory(agentVaultFactory.address, { from: assetManagerController });
            await assetManager.setCollateralPoolFactory(collateralPoolFactory.address, { from: assetManagerController });
            await assetManager.setCollateralPoolTokenFactory(collateralPoolTokenFactory.address, { from: assetManagerController });
            // upgrade must be called through controller
            await expectRevert(assetManager.upgradeAgentVaultsAndPools(0, 100), "only asset manager controller");
            // upgrade vaults and pools
            await assetManager.upgradeAgentVaultsAndPools(0, 100, { from: assetManagerController });
            // check
            const { 0: vaultAddresses } = await assetManager.getAllAgents(0, 100);
            assert.equal(vaultAddresses.length, 10);
            for (const vaultAddress of vaultAddresses) {
                const agentVault = await AgentVault.at(vaultAddress);
                const collateralPool = await CollateralPool.at(await agentVault.collateralPool());
                const collateralPoolToken = await CollateralPoolToken.at(await collateralPool.poolToken());
                assert.equal(await agentVault.implementation(), newAgentVaultImpl.address);
                assert.equal(await collateralPool.implementation(), newCollateralPoolImpl.address);
                assert.equal(await collateralPoolToken.implementation(), newCollateralPoolTokenImpl.address);
            }
        });

        it("only owner can call upgrade vault and pool", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const testProxyImpl = await TestUUPSProxyImpl.new();
            const agentVaultFactory = await AgentVaultFactory.new(testProxyImpl.address);
            await assetManager.setAgentVaultFactory(agentVaultFactory.address, { from: assetManagerController });
            await expectRevert(assetManager.upgradeAgentVaultAndPool(agentVault.address), "only agent vault owner");
        });

        it("vault and pool upgrade cannot be called directly", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const collateralPool = await CollateralPool.at(await agentVault.collateralPool());
            const collateralPoolToken = await CollateralPoolToken.at(await collateralPool.poolToken());
            const testProxyImpl = await TestUUPSProxyImpl.new();
            //
            await expectRevert(agentVault.upgradeTo(testProxyImpl.address), "only asset manager");
            await expectRevert(collateralPool.upgradeTo(testProxyImpl.address), "only asset manager");
            await expectRevert(collateralPoolToken.upgradeTo(testProxyImpl.address), "only asset manager");
        });

        it("can upgrade with initialization", async () => {
            const MockProxyFactory = artifacts.require("MockProxyFactory");
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const testProxyImpl = await TestUUPSProxyImpl.new();
            const mockFactory = await MockProxyFactory.new(testProxyImpl.address);
            await assetManager.setAgentVaultFactory(mockFactory.address, { from: assetManagerController });
            // test
            await assetManager.upgradeAgentVaultAndPool(agentVault.address, { from: agentOwner1 });
            // check
            assert.equal(await agentVault.implementation(), testProxyImpl.address);
            const testProxy = await TestUUPSProxyImpl.at(agentVault.address);
            assert.equal(await testProxy.testResult(), "some test string");
        });
    });

    describe("collateral tokens", () => {

        it("should correctly add collateral token", async () => {
            const collateral = JSON.parse(JSON.stringify(web3DeepNormalize(collaterals[1]))); // make a deep copy
            collateral.token = (await ERC20Mock.new("New Token", "NT")).address;
            collateral.tokenFtsoSymbol = "NT";
            collateral.assetFtsoSymbol = "NT";
            await assetManager.addCollateralType(web3DeepNormalize(collateral), { from: assetManagerController });
            const resCollaterals = await assetManager.getCollateralTypes();
            assertWeb3DeepEqual(collateral.token, resCollaterals[3].token);
        });

        it("should set collateral ratios for token", async () => {
            await assetManager.setCollateralRatiosForToken(collaterals[0].collateralClass, collaterals[0].token,
                toBIPS(1.5), toBIPS(1.4), toBIPS(1.6), { from: assetManagerController });
            const collateralType = await assetManager.getCollateralType(collaterals[0].collateralClass, collaterals[0].token);
            assertWeb3Equal(collateralType.minCollateralRatioBIPS, toBIPS(1.5));
            assertWeb3Equal(collateralType.ccbMinCollateralRatioBIPS, toBIPS(1.4));
            assertWeb3Equal(collateralType.safetyMinCollateralRatioBIPS, toBIPS(1.6));
        });

        it("should not set collateral ratios for unknown token", async () => {
            const unknownToken = accounts[12];
            const res = assetManager.setCollateralRatiosForToken(collaterals[0].collateralClass, unknownToken,
                toBIPS(1.5), toBIPS(1.4), toBIPS(1.6), { from: assetManagerController });
            await expectRevert(res, "unknown token");
        });

        it("should deprecate collateral token", async () => {
            const tx = await assetManager.deprecateCollateralType(collaterals[0].collateralClass, collaterals[0].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[0].collateralClass, collaterals[0].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
        });

        it("should get revert if deprecating the same token multiple times", async () => {
            await assetManager.deprecateCollateralType(collaterals[0].collateralClass, collaterals[0].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            //Wait and call deprecate again to trigger revert that token is not valid
            await deterministicTimeIncrease(settings.tokenInvalidationTimeMinSeconds);
            const res = assetManager.deprecateCollateralType(collaterals[0].collateralClass, collaterals[0].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            await expectRevert(res,"token not valid");
        });

        it("should switch vault collateral token", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            //deprecate token
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[1].collateralClass, collaterals[1].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
            const tx1 = await assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: agentOwner1 });
            expectEvent(tx1, "AgentCollateralTypeChanged");
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.vaultCollateralToken, collaterals[2].token);
        });

        it("should not switch vault collateral token if uknown token", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            //deprecate token
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[1].collateralClass, collaterals[1].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
            const unknownToken = accounts[12];
            const tx1 = assetManager.switchVaultCollateral(agentVault.address,unknownToken, { from: agentOwner1 });
            await expectRevert(tx1, "unknown token");
        });

        it("should not be able to add a deprecated collateral token", async () => {
            const ci = testChainInfo.eth;
            // create asset manager
            collaterals = createTestCollaterals(contracts, ci);
            //Set token validUntil timestamp to some time in the past to make it deprecated
            collaterals[1].validUntil = chain.currentTimestamp()-100;
            settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true, announcedUnderlyingConfirmationMinSeconds: 10 });
            //Creating asset manager should revert because we are trying to addd a vault collateral that is deprecated
            const res = newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
            await expectRevert(res,"cannot add deprecated token");
        });

        it("should not switch vault collateral token", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(50));
            await ftsos.asset.setCurrentPrice(toBNExp(5, 10), 0);
            await ftsos.usdc.setCurrentPriceFromTrustedProviders(toBNExp(5, 10), 0);
            //Can't switch vault collateral if it has not been deprecated
            let res = assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: agentOwner1 });
            await expectRevert(res, "current collateral not deprecated");
            // Only agent owner can switch vault collateral
            res = assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: accounts[5] });
            await expectRevert(res, "only agent vault owner");
            //deprecate token
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[1].collateralClass, collaterals[1].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
            //Wait until you can swtich vault collateral token
            await deterministicTimeIncrease(settings.tokenInvalidationTimeMinSeconds);
            //Deprecated token can't be switched to
            res = assetManager.switchVaultCollateral(agentVault.address,collaterals[1].token, { from: agentOwner1 });
            await expectRevert(res, "collateral deprecated");
            //Can't switch if CR too low
            res = assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: agentOwner1 });
            await expectRevert(res, "not enough collateral");
        });

        it("should not switch vault collateral token when withdrawal announced", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await depositAgentCollaterals(agentVault, agentOwner1, toWei(1000), toWei(1000));
            // announce
            await assetManager.announceVaultCollateralWithdrawal(agentVault.address, toWei(1000), { from: agentOwner1 });
            // deprecate collateral
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            // should not work
            await expectRevert(assetManager.switchVaultCollateral(agentVault.address, collaterals[2].token, { from: agentOwner1 }),
                "collateral withdrawal announced");
            // should work after withdrawal is cleared
            await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 0, { from: agentOwner1 });
            await assetManager.switchVaultCollateral(agentVault.address, collaterals[2].token, { from: agentOwner1 });
        });

        it("If agent doesn't switch vault collateral after deprecation and invalidation time, liquidator can start liquidation", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(1));
            const liquidator = accounts[83];
            //deprecate token
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[1].collateralClass, collaterals[1].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
            // Should not be able to start liquidation before time passes
            await expectRevert(assetManager.startLiquidation.call(agentVault.address, { from: liquidator }), "liquidation not started");
            //Wait until you can swtich vault collateral token
            await deterministicTimeIncrease(settings.tokenInvalidationTimeMinSeconds);
            await deterministicTimeIncrease(settings.tokenInvalidationTimeMinSeconds);
            await assetManager.startLiquidation(agentVault.address, { from: liquidator });
            //Check for liquidation status
            const info = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info.status, 2);
            //If agent deposits a non collateral token, it shouldn't get out of liquidation
            const token = await ERC20Mock.new("Some NAT", "SNAT");
            await token.mintAmount(agentOwner1, toWei(3e8));
            await token.approve(agentVault.address, toWei(3e8), { from: agentOwner1 });
            await agentVault.depositCollateral(token.address, toWei(3e8), { from: agentOwner1 });
            const info1 = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info1.status, 2);
            //Deposit vault collateral and switch
            await usdt.mintAmount(agentOwner1, toWei(3e8));
            await usdt.approve(agentVault.address, toWei(3e8), { from: agentOwner1 });
            await agentVault.depositCollateral(usdt.address, toWei(3e8), { from: agentOwner1 });
            await assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: agentOwner1 });
            //Random address can't call collateral deposited
            let res = assetManager.updateCollateral(agentVault.address,usdt.address, { from: accounts[5] });
            await expectRevert(res, "only agent vault or pool");
            let res1 = agentVault.updateCollateral(usdt.address, { from: accounts[5] });
            await expectRevert(res1, "only owner");
            //Call collateral deposited from owner address to trigger liquidation end
            await agentVault.updateCollateral(usdt.address, { from: agentOwner1 });
            //Check that agent is out of liquidation
            const info2 = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info2.status, 0);
        });

        it("should set pool collateral token", async () => {
            const newWnat = await ERC20Mock.new("Wrapped NAT", "WNAT");
            await assetManager.updateSystemContracts(assetManagerController, newWnat.address, { from: assetManagerController });
            const token = await assetManager.getCollateralType(CollateralClass.POOL, newWnat.address);
            assertWeb3Equal(token.token, newWnat.address);
        });

        it("should set pool collateral token and upgrade wnat", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const newWnat = await ERC20Mock.new("Wrapped NAT", "WNAT");
            //Calling upgrade before updating contract won't do anything (just a branch test)
            await assetManager.upgradeWNatContract(agentVault.address, {from: agentOwner1});
            //Update wnat contract
            await assetManager.updateSystemContracts(assetManagerController, newWnat.address, { from: assetManagerController });
            //Random address shouldn't be able to upgrade wNat contract
            let tx = assetManager.upgradeWNatContract(agentVault.address, {from: accounts[5]});
            await expectRevert(tx, "only agent vault owner");
            const res = await assetManager.upgradeWNatContract(agentVault.address, {from: agentOwner1});
            expectEvent(res, "AgentCollateralTypeChanged");
            const eventArgs = requiredEventArgs(res, 'AgentCollateralTypeChanged');
            assert.equal(Number(eventArgs.collateralClass), CollateralClass.POOL);
            const token = await assetManager.getCollateralType(CollateralClass.POOL, eventArgs.token);
            assertWeb3Equal(token.token, newWnat.address);
        });
    });

    describe("whitelisting", () => {
        it("should require whitelisting, when whitelist exists, to create agent", async () => {
            // create governance settings
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const agentOwnerRegistry = await AgentOwnerRegistry.new(governanceSettings.address, governance, false);
            await agentOwnerRegistry.switchToProductionMode({ from: governance });
            await agentOwnerRegistry.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setAgentOwnerRegistry(agentOwnerRegistry.address, { from: assetManagerController });
            // assert
            const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAgent1);
            assert.isTrue(addressValidityProof.data.responseBody.isValid);
            const settings = createTestAgentSettings(usdc.address);
            await expectRevert(assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(settings), { from: agentOwner1 }),
                "not whitelisted");
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const txHash = await wallet.addTransaction(underlyingAgent1, underlyingBurnAddr, 1, PaymentReference.addressOwnership(whitelistedAccount));
            const proof = await attestationProvider.provePayment(txHash, underlyingAgent1, underlyingBurnAddr);
            await assetManager.proveUnderlyingAddressEOA(proof, { from: whitelistedAccount });
            expectEvent(await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(settings), { from: whitelistedAccount}), "AgentVaultCreated");
        });
    });

    describe("pause minting and terminate fasset", () => {
        it("should pause and terminate only after 30 days", async () => {
            const MINIMUM_PAUSE_BEFORE_STOP = 30 * DAYS;
            assert.isFalse(await assetManager.mintingPaused());
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            await deterministicTimeIncrease(MINIMUM_PAUSE_BEFORE_STOP / 2);
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            await expectRevert(assetManager.terminate({ from: assetManagerController }), "asset manager not paused enough");
            await deterministicTimeIncrease(MINIMUM_PAUSE_BEFORE_STOP / 2);
            assert.isFalse(await fAsset.terminated());
            assert.isFalse(await assetManager.terminated());
            await assetManager.terminate({ from: assetManagerController });
            assert.isTrue(await fAsset.terminated());
            assert.isTrue(await assetManager.terminated());
            await expectRevert(assetManager.unpauseMinting({ from: assetManagerController }), "f-asset terminated");
        });

        it("should unpause if not yet terminated", async () => {
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            await assetManager.unpauseMinting({ from: assetManagerController });
            assert.isFalse(await assetManager.mintingPaused());
        });

        it("should not pause if not called from asset manager controller", async () => {
            const promise = assetManager.pauseMinting({ from: accounts[0] });
            await expectRevert(promise, "only asset manager controller");
            assert.isFalse(await assetManager.mintingPaused());
        });

        it("should not unpause if not called from asset manager controller", async () => {
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            const promise = assetManager.unpauseMinting({ from: accounts[0] });
            await expectRevert(promise, "only asset manager controller");
            assert.isTrue(await assetManager.mintingPaused());
        });

        it("should not terminate if not called from asset manager controller", async () => {
            const MINIMUM_PAUSE_BEFORE_STOP = 30 * DAYS;
            assert.isFalse(await assetManager.mintingPaused());
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            await deterministicTimeIncrease(MINIMUM_PAUSE_BEFORE_STOP);
            const promise = assetManager.terminate({ from: accounts[0] });
            await expectRevert(promise, "only asset manager controller");
            assert.isFalse(await fAsset.terminated());
        });

        it("should buy back agent collateral", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1, toWei(3e8));
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(1));
            // terminate f-asset
            const MINIMUM_PAUSE_BEFORE_STOP = 30 * DAYS;
            await assetManager.pauseMinting({ from: assetManagerController });
            await deterministicTimeIncrease(MINIMUM_PAUSE_BEFORE_STOP);
            await assetManager.terminate({ from: assetManagerController });
            // buy back the collateral
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const mintedUSD = await ubaToC1Wei(toBN(agentInfo.mintedUBA));
            //Random address can't buy back agent collateral
            const res = assetManager.buybackAgentCollateral(agentVault.address, { from: accounts[12], value: toWei(3e6) });
            await expectRevert(res, "only agent vault owner");
            //Buy back agent collateral
            await assetManager.buybackAgentCollateral(agentVault.address, { from: agentOwner1, value: toWei(3e6) });
            const buybackPriceUSD = mulBIPS(mintedUSD, toBN(settings.buybackCollateralFactorBIPS));
            assertEqualWithNumError(await usdc.balanceOf(agentOwner1), buybackPriceUSD, toBN(1));
        });

        it("should buy back agent collateral when vault collateral token is the same as pool token", async () => {
            const ci = testChainInfo.eth;
            // create asset manager where pool and vault collateral is nat
            collaterals = createTestCollaterals(contracts, ci);
            collaterals[1].token = collaterals[0].token;
            collaterals[1].tokenFtsoSymbol = collaterals[0].tokenFtsoSymbol;
            settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true, announcedUnderlyingConfirmationMinSeconds: 10 });
            [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
            const agentVault = await createAvailableAgentWithEOANAT(agentOwner1, underlyingAgent1, toWei(3e8));
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(10));
            // terminate f-asset
            const MINIMUM_PAUSE_BEFORE_STOP = 30 * DAYS;
            await assetManager.pauseMinting({ from: assetManagerController });
            await deterministicTimeIncrease(MINIMUM_PAUSE_BEFORE_STOP);
            await assetManager.terminate({ from: assetManagerController });
            // buy back the collateral
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const beforeBalance = toBN(await wNat.balanceOf(agentVault.address));
            //Calculate buyback collateral
            const mintingUBA = toBN(agentInfo.reservedUBA).add(toBN(agentInfo.mintedUBA));
            const totalMintingUBAWithPremium = mintingUBA.mul(toBN(settings.buybackCollateralFactorBIPS)).divn(MAX_BIPS);
            const buyBackCollateral = await ubaToPoolWei(totalMintingUBAWithPremium);
            await assetManager.buybackAgentCollateral(agentVault.address, { from: agentOwner1, value: toWei(3e10) });
            const afterBalance = toBN(await wNat.balanceOf(agentVault.address));
            assertWeb3Equal(beforeBalance.sub(afterBalance),buyBackCollateral);
        });
    });

    describe("should update contracts", () => {
        it("should update contract addresses", async () => {
            let agentVaultFactoryNewAddress = accounts[21];
            let wnatNewAddress = accounts[23];
            const oldSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            const oldWNat = await assetManager.getWNat();
            await assetManager.updateSystemContracts(assetManagerController, wnatNewAddress, { from: assetManagerController });
            await assetManager.setAgentVaultFactory(agentVaultFactoryNewAddress, { from: assetManagerController });
            const res = web3ResultStruct(await assetManager.getSettings());
            const resWNat = await assetManager.getWNat();
            assert.notEqual(oldSettings.agentVaultFactory, res.agentVaultFactory)
            assert.notEqual(oldWNat, resWNat)
            assert.equal(agentVaultFactoryNewAddress, res.agentVaultFactory)
            assert.equal(wnatNewAddress, resWNat)
        });

        it("should not update contract addresses", async () => {
            const oldSettings: AssetManagerSettings = web3ResultStruct(await assetManager.getSettings());
            await assetManager.updateSystemContracts(assetManagerController, contracts.wNat.address, { from: assetManagerController });
            await assetManager.setAgentVaultFactory(contracts.agentVaultFactory.address, { from: assetManagerController });
            const res = web3ResultStruct(await assetManager.getSettings());
            assertWeb3DeepEqual(res, oldSettings)
        });
    });

    describe("should validate settings at creation", () => {
        it("should validate settings - cannot be zero (collateralReservationFeeBIPS)", async () => {
            let newSettings0 = createTestSettings(contracts, testChainInfo.eth);
            newSettings0.collateralReservationFeeBIPS = 0;
            let res0 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings0, collaterals);
            await expectRevert(res0, "cannot be zero");
        });

        it("should validate settings - cannot be zero (assetUnitUBA)", async () => {
            let newSettings1 = createTestSettings(contracts, testChainInfo.eth);
            newSettings1.assetUnitUBA = 0;
            let res1 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings1, collaterals);
            await expectRevert(res1, "cannot be zero");
        });

        it("should validate settings - cannot be zero (assetMintingGranularityUBA)", async () => {
            let newSettings2 = createTestSettings(contracts, testChainInfo.eth);
            newSettings2.assetMintingGranularityUBA = 0;
            let res2 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings2, collaterals);
            await expectRevert(res2, "cannot be zero");
        });

        it("should validate settings - cannot be zero (minCollateralRatioBIPS)", async () => {
            let collaterals3 = createTestCollaterals(contracts, testChainInfo.eth);
            collaterals3[0].minCollateralRatioBIPS = 0;
            let res3 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, settings, collaterals3);
            await expectRevert(res3, "invalid collateral ratios");
        });

        it("should validate settings - cannot be zero (underlyingBlocksForPayment)", async () => {
            let newSettings6 = createTestSettings(contracts, testChainInfo.eth);
            newSettings6.underlyingBlocksForPayment = 0;
            let res6 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings6, collaterals);
            await expectRevert(res6, "cannot be zero");
        });

        it("should validate settings - cannot be zero (underlyingSecondsForPayment)", async () => {
            let newSettings7 = createTestSettings(contracts, testChainInfo.eth);
            newSettings7.underlyingSecondsForPayment = 0;
            let res7 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings7, collaterals);
            await expectRevert(res7, "cannot be zero");
        });

        it("should validate settings - cannot be zero (redemptionFeeBIPS)", async () => {
            let newSettings8 = createTestSettings(contracts, testChainInfo.eth);
            newSettings8.redemptionFeeBIPS = 0;
            let res8 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings8, collaterals);
            await expectRevert(res8, "cannot be zero");;
        });

        it("should validate settings - cannot be zero (maxRedeemedTickets)", async () => {
            let newSettings10 = createTestSettings(contracts, testChainInfo.eth);
            newSettings10.maxRedeemedTickets = 0;
            let res10 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings10, collaterals);
            await expectRevert(res10, "cannot be zero");
        });

        it("should validate settings - cannot be zero (ccbTimeSeconds)", async () => {
            let newSettings11 = createTestSettings(contracts, testChainInfo.eth);
            newSettings11.ccbTimeSeconds = 0;
            let res11 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings11, collaterals);
            await expectRevert(res11, "cannot be zero");
        });

        it("should validate settings - cannot be zero (liquidationStepSeconds)", async () => {
            let newSettings12 = createTestSettings(contracts, testChainInfo.eth);
            newSettings12.liquidationStepSeconds = 0;
            let res12 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings12, collaterals);
            await expectRevert(res12, "cannot be zero");
        });

        it("should validate settings - cannot be zero (maxTrustedPriceAgeSeconds)", async () => {
            let newSettings13 = createTestSettings(contracts, testChainInfo.eth);
            newSettings13.maxTrustedPriceAgeSeconds = 0;
            let res13 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings13, collaterals);
            await expectRevert(res13, "cannot be zero");
        });

        it("should validate settings - cannot be zero (minUpdateRepeatTimeSeconds)", async () => {
            let newSettings15 = createTestSettings(contracts, testChainInfo.eth);
            newSettings15.minUpdateRepeatTimeSeconds = 0;
            let res15 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings15, collaterals);
            await expectRevert(res15, "cannot be zero");
        });

        it("should validate settings - cannot be zero (buybackCollateralFactorBIPS)", async () => {
            let newSettings16 = createTestSettings(contracts, testChainInfo.eth);
            newSettings16.buybackCollateralFactorBIPS = 0;
            let res16 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings16, collaterals);
            await expectRevert(res16, "cannot be zero");
        });

        it("should validate settings - cannot be zero (withdrawalWaitMinSeconds)", async () => {
            let newSettings17 = createTestSettings(contracts, testChainInfo.eth);
            newSettings17.withdrawalWaitMinSeconds = 0;
            let res17 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings17, collaterals);
            await expectRevert(res17, "cannot be zero");
        });

        it("should validate settings - cannot be zero (lotSizeAMG)", async () => {
            let newSettings19 = createTestSettings(contracts, testChainInfo.eth)
            newSettings19.lotSizeAMG = 0;
            let res19 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings19, collaterals);
            await expectRevert(res19, "cannot be zero");
        });

        it("should validate settings - cannot be zero (announcedUnderlyingConfirmationMinSeconds)", async () => {
            let newSettings20 = createTestSettings(contracts, testChainInfo.eth)
            newSettings20.announcedUnderlyingConfirmationMinSeconds = 2 * HOURS;
            let res20 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings20, collaterals);
            await expectRevert(res20, "confirmation time too big");
        });

        it("should validate settings - cannot be zero (underlyingSecondsForPayment)", async () => {
            let newSettings21 = createTestSettings(contracts, testChainInfo.eth)
            newSettings21.underlyingSecondsForPayment = 25 * HOURS;
            let res21 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings21, collaterals);
            await expectRevert(res21, "value too high");
        });

        it("should validate settings - cannot be zero (underlyingBlocksForPayment)", async () => {
            let newSettings22 = createTestSettings(contracts, testChainInfo.eth)
            newSettings22.underlyingBlocksForPayment = toBN(Math.round(25 * HOURS / testChainInfo.eth.blockTime));
            let res22 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings22, collaterals);
            await expectRevert(res22, "value too high");
        });

        it("should validate settings - cannot be zero (cancelCollateralReservationAfterSeconds)", async () => {
            let newSettings23 = createTestSettings(contracts, testChainInfo.eth)
            newSettings23.cancelCollateralReservationAfterSeconds = 0;
            let res23 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings23, collaterals);
            await expectRevert(res23, "cannot be zero");
        });

        it("should validate settings - cannot be zero (rejectRedemptionRequestWindowSeconds)", async () => {
            let newSettings24 = createTestSettings(contracts, testChainInfo.eth)
            newSettings24.rejectRedemptionRequestWindowSeconds = 0;
            let res24 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings24, collaterals);
            await expectRevert(res24, "cannot be zero");
        });

        it("should validate settings - cannot be zero (takeOverRedemptionRequestWindowSeconds)", async () => {
            let newSettings25 = createTestSettings(contracts, testChainInfo.eth)
            newSettings25.takeOverRedemptionRequestWindowSeconds = 0;
            let res25 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings25, collaterals);
            await expectRevert(res25, "cannot be zero");
        });

        it("should validate settings - cannot be zero (rejectedRedemptionDefaultFactorVaultCollateralBIPS)", async () => {
            let newSettings26 = createTestSettings(contracts, testChainInfo.eth)
            newSettings26.rejectedRedemptionDefaultFactorVaultCollateralBIPS = 9999;
            newSettings26.rejectedRedemptionDefaultFactorPoolBIPS = 0;
            let res26 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings26, collaterals);
            await expectRevert(res26, "bips value too low");
        });

        it("should validate settings - other validators (collateralReservationFeeBIPS)", async () => {
            let newSettings0 = createTestSettings(contracts, testChainInfo.eth);
            newSettings0.collateralReservationFeeBIPS = 10001;
            let res0 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings0, collaterals);
            await expectRevert(res0, "bips value too high");
        });

        it("should validate settings - other validators (redemptionFeeBIPS)", async () => {
            let newSettings1 = createTestSettings(contracts, testChainInfo.eth);
            newSettings1.redemptionFeeBIPS = 10001;
            let res1 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings1, collaterals);
            await expectRevert(res1, "bips value too high");
        });

        it("should validate settings - other validators (redemptionDefaultFactorVaultCollateralBIPS)", async () => {
            let newSettings2 = createTestSettings(contracts, testChainInfo.eth);
            newSettings2.redemptionDefaultFactorVaultCollateralBIPS = 5000;
            newSettings2.redemptionDefaultFactorPoolBIPS = 5000;
            let res2 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings2, collaterals);
            await expectRevert(res2, "bips value too low");
        });

        it("should validate settings - other validators (attestationWindowSeconds)", async () => {
            let newSettings3 = createTestSettings(contracts, testChainInfo.eth);
            newSettings3.attestationWindowSeconds = 0.9 * DAYS;
            let res3 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings3, collaterals);
            await expectRevert(res3, "window too small");
        });

        it("should validate settings - other validators (confirmationByOthersAfterSeconds)", async () => {
            let newSettings4 = createTestSettings(contracts, testChainInfo.eth);
            newSettings4.confirmationByOthersAfterSeconds = 1.9 * HOURS;
            let res4 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings4, collaterals);
            await expectRevert(res4, "must be at least two hours");
        });

        it("should validate settings - other validators (mintingCapAMG)", async () => {
            let newSettings5 = createTestSettings(contracts, testChainInfo.eth);
            newSettings5.mintingCapAMG = toBN(newSettings5.lotSizeAMG).divn(2);
            let res5x = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings5, collaterals);
            await expectRevert(res5x, "minting cap too small");
        });

        it("should validate settings - other validators (mintingCapAMG 2)", async () => {
            // should work for nonzero cap greater than lot size
            let newSettings6 = createTestSettings(contracts, testChainInfo.eth);
            newSettings6.mintingCapAMG = toBN(newSettings6.lotSizeAMG).muln(2);
            await newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings6, collaterals);
        });

        it("should validate settings - other validators (rejectOrCancelCollateralReservationReturnFactorBIPS)", async () => {
            let newSettings7 = createTestSettings(contracts, testChainInfo.eth);
            newSettings7.rejectOrCancelCollateralReservationReturnFactorBIPS = 10001;
            let res7x = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings7, collaterals);
            await expectRevert(res7x, "bips value too high");
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 1)", async () => {
            let liquidationSettings5 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings5.liquidationCollateralFactorBIPS = [];
            liquidationSettings5.liquidationFactorVaultCollateralBIPS = [];
            let res5 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings5, collaterals);
            await expectRevert(res5, "at least one factor required");
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 2)", async () => {
            let liquidationSettings6 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings6.liquidationCollateralFactorBIPS = [12000, 11000];
            liquidationSettings6.liquidationFactorVaultCollateralBIPS = [12000, 11000];
            let res6 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings6, collaterals);
            await expectRevert(res6, "factors not increasing");
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 3)", async () => {
            let liquidationSettings7 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings7.liquidationCollateralFactorBIPS = [12000];
            liquidationSettings7.liquidationFactorVaultCollateralBIPS = [12001];
            let res7 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings7, collaterals);
            await expectRevert(res7, "vault collateral factor higher than total");
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 4)", async () => {
            let liquidationSettings8 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings8.liquidationCollateralFactorBIPS = [1000];
            liquidationSettings8.liquidationFactorVaultCollateralBIPS = [1000];
            let res8 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings8, collaterals);
            await expectRevert(res8, "factor not above 1");
        });

        it("should validate settings - other validators (collateral ratios)", async () => {
            let collaterals6 = createTestCollaterals(contracts, testChainInfo.eth);
            collaterals6[0].minCollateralRatioBIPS = 1_8000;
            collaterals6[0].ccbMinCollateralRatioBIPS = 2_2000;
            collaterals6[0].safetyMinCollateralRatioBIPS = 2_4000;
            let res9 = newAssetManager(governance, assetManagerController, "Ethereum", "ETH", 18, settings, collaterals6);
            await expectRevert(res9, "invalid collateral ratios");
        });
    });

    describe("agent collateral deposit and withdrawal", () => {

        it("should announce vault collateral withdrawal and execute it", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            // deposit collateral
            await usdc.mintAmount(agentOwner1, 10000);
            await usdc.approve(agentVault.address, 10000, { from: agentOwner1 });
            await agentVault.depositCollateral(usdc.address, 10000, { from: agentOwner1 });
            const _agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(_agentInfo.totalVaultCollateralWei, 10000);
            // announce withdrawal and execute it
            await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 1000, { from: agentOwner1 });
            const agentWithdrawalTimelock = (await assetManager.getSettings()).withdrawalWaitMinSeconds;
            await deterministicTimeIncrease(agentWithdrawalTimelock);
            const res = await agentVault.withdrawCollateral(usdc.address, 1000, accounts[80], { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.totalVaultCollateralWei, 9000);
        });

        it("Withdraw non-collateral token branch test", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            const token = await ERC20Mock.new("Some NAT", "SNAT");
            await token.mintAmount(agentVault.address, toWei(3e8));
            await token.approve(agentVault.address, toWei(3e8), { from: agentOwner1 });
            const beforeBalance = await token.balanceOf(agentVault.address);
            //Non collateral token can be withdrawn without announcing
            await agentVault.withdrawCollateral(token.address, 1000, accounts[80], { from: agentOwner1 });
            const afterBalance = await token.balanceOf(agentVault.address);
            assertWeb3Equal(beforeBalance.sub(afterBalance), 1000);
        });

        it("should announce pool redemption (class2 withdrawal) and execute it", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            // deposit pool tokens to agent vault (there is a min-limit on nat deposited to collateral pool)
            await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: toWei(10) });
            const _agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(_agentInfo.totalAgentPoolTokensWei, toWei(10));
            await deterministicTimeIncrease(await assetManager.getCollateralPoolTokenTimelockSeconds()); // wait for token timelock
            // announce withdrawal and execute it (nat to pool token ratio is 1:1 as there are no minted f-assets)
            await assetManager.announceAgentPoolTokenRedemption(agentVault.address, toWei(1), { from: agentOwner1 });
            const agentWithdrawalTimelock = (await assetManager.getSettings()).withdrawalWaitMinSeconds;
            await deterministicTimeIncrease(agentWithdrawalTimelock);
            const natRecipient = "0xe34BDff68a5b89216D7f6021c1AB25c012142425"
            await agentVault.redeemCollateralPoolTokens(toWei(1), natRecipient, { from: agentOwner1 });
            // check pool tokens were withdrawn
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3DeepEqual(agentInfo.totalAgentPoolTokensWei, toWei(9));
            const token = await getCollateralPoolToken(agentVault.address);
            assertWeb3DeepEqual(await token.balanceOf(agentVault.address), toWei(9));
            assertWeb3Equal(await web3.eth.getBalance(natRecipient), toWei(1));
        });
    });

    describe("agent availability", () => {
        it("should make an agent available and then unavailable", async () => {
            // create an available agent
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // check if agent available in three ways
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);7
            assert.equal(agentInfo.publiclyAvailable, true);
            const availableAgentList = await assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgentList[0].length, 1);
            assert.equal(availableAgentList[0][0], agentVault.address);
            const availableAgentDetailedList = await assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgentDetailedList[0].length, 1);
            assert.equal(availableAgentDetailedList[0][0].agentVault, agentVault.address);
            // announce and make agent unavailable
            await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            // make agent unavailable
            await deterministicTimeIncrease((await assetManager.getSettings()).agentExitAvailableTimelockSeconds);
            await assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            // check that agent is no longer available in three ways
            const agentInfo2 = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo2.publiclyAvailable, false);
            const availableAgentList2 = await assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgentList2[0].length, 0);
            const availableAgentDetailedList2 = await assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgentDetailedList2[0].length, 0);
        });

        it("agent availability branch tests", async () => {
            // create an agent
            let agentVault = await createAgentVaultWithEOA(agentOwner1, "test");
            // Only agent owner can announce exit
            let res = assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert(res, "agent not available");
            // Only agent owner can announce exit
            agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            res = assetManager.announceExitAvailableAgentList(agentVault.address, { from: accounts[5] });
            await expectRevert(res, "only agent vault owner");
            //Must announce exit to be able to exit
            res = assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert(res, "exit not announced");
            //Announce exit
            let annRes = await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            let exitTime = requiredEventArgs(annRes, 'AvailableAgentExitAnnounced').exitAllowedAt;
            // announce twice start new countdown
            await deterministicTimeIncrease(10);
            let annRes2 = await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            let exitTime2 = requiredEventArgs(annRes2, 'AvailableAgentExitAnnounced').exitAllowedAt;
            assert.isTrue(exitTime2.gt(exitTime));
            //Must wait agentExitAvailableTimelockSeconds before agent can exit
            res = assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert(res, "exit too soon");
            // make agent unavailable
            await deterministicTimeIncrease((await assetManager.getSettings()).agentExitAvailableTimelockSeconds);
            await assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            // check that agent is no longer available in three ways
            const agentInfo2 = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo2.publiclyAvailable, false);
            const availableAgentList2 = await assetManager.getAvailableAgentsList(0, 10);
            assert.equal(availableAgentList2[0].length, 0);
            const availableAgentDetailedList2 = await assetManager.getAvailableAgentsDetailedList(0, 10);
            assert.equal(availableAgentDetailedList2[0].length, 0);
        });

        it("agent availability - exit too late", async () => {
            // create an agent
            let agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            //Announce exit
            let annRes = await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            let exitTime = requiredEventArgs(annRes, 'AvailableAgentExitAnnounced').exitAllowedAt;
            // exit available too late
            const settings = await assetManager.getSettings();
            await deterministicTimeIncrease(toBN(settings.agentExitAvailableTimelockSeconds).add(toBN(settings.agentTimelockedOperationWindowSeconds).addn(1)));
            const res = assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert(res, "exit too late");
        });
    });

    describe("minting", () => {
        it("should update the current block", async () => {
            chain.mine(3);  // make sure block no and timestamp change
            const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
            const res = await assetManager.updateCurrentBlock(proof);
            expectEvent(res, 'CurrentUnderlyingBlockUpdated', { underlyingBlockNumber: proof.data.requestBody.blockNumber, underlyingBlockTimestamp: proof.data.responseBody.blockTimestamp });
            const timestamp = await time.latest();
            const currentBlock = await assetManager.currentUnderlyingBlock();
            assertWeb3Equal(currentBlock[0], proof.data.requestBody.blockNumber);
            assertWeb3Equal(currentBlock[1], proof.data.responseBody.blockTimestamp);
            assertWeb3Equal(currentBlock[2], timestamp);
        });

        it("should execute minting (by minter)", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const executor = accounts[81];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const executorFee = toWei(0.1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, executor, [],
                { from: minter, value: reservationFee.add(executorFee) });
            const crt = findRequiredEvent(tx, "CollateralReserved").args;
            // make and prove the payment transaction
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            chain.mint("underlying_minter", paymentAmount);
            const txHash = await wallet.addTransaction("underlying_minter", underlyingAgent1, paymentAmount,
                PaymentReference.minting(crt.collateralReservationId));
            const proof = await attestationProvider.provePayment(txHash, "underlying_minter", underlyingAgent1);
            // execute f-asset minting
            const executorBalanceStart = toBN(await web3.eth.getBalance(executor));
            const minterBalanceStart = toBN(await web3.eth.getBalance(minter));
            const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minter });
            const gasFee = toBN(res.receipt.gasUsed).mul(toBN(res.receipt.effectiveGasPrice));
            const executorBalanceEnd = toBN(await web3.eth.getBalance(executor));
            const minterBalanceEnd = toBN(await web3.eth.getBalance(minter));
            const fassets = await fAsset.balanceOf(minter);
            assertWeb3Equal(fassets, crt.valueUBA);
            // executor fee got burned - nobody receives it
            assertWeb3Equal(executorBalanceEnd.sub(executorBalanceStart), BN_ZERO);
            assertWeb3Equal(minterBalanceEnd.sub(minterBalanceStart), gasFee.neg());
        });

        it("should execute minting (by executor)", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const executor = accounts[81];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const executorFee = toWei(0.1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, executor, [],
                { from: minter, value: reservationFee.add(executorFee) });
            const crt = findRequiredEvent(tx, "CollateralReserved").args;
            // make and prove the payment transaction
            const paymentAmount = crt.valueUBA.add(crt.feeUBA);
            chain.mint("underlying_minter", paymentAmount);
            const txHash = await wallet.addTransaction("underlying_minter", underlyingAgent1, paymentAmount,
                PaymentReference.minting(crt.collateralReservationId));
            const proof = await attestationProvider.provePayment(txHash, "underlying_minter", underlyingAgent1);
            // execute f-asset minting
            const executorBalanceStart = toBN(await web3.eth.getBalance(executor));
            const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: executor });
            const executorBalanceEnd = toBN(await web3.eth.getBalance(executor));
            const gasFee = toBN(res.receipt.gasUsed).mul(toBN(res.receipt.effectiveGasPrice));
            const fassets = await fAsset.balanceOf(minter);
            assertWeb3Equal(fassets, crt.valueUBA);
            assertWeb3Equal(executorBalanceEnd.sub(executorBalanceStart), executorFee.sub(gasFee));
        });

        it("should do a minting payment default", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const totalFee = reservationFee.add(toWei(0.1));    // 0.1 for executor fee
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, accounts[81], [],
                { from: minter, value: totalFee });
            const crt = findRequiredEvent(tx, "CollateralReserved").args;
            assertWeb3Equal(crt.valueUBA, lotsToUBA(1));
            // don't mint f-assets for a while
            chain.mineTo(crt.lastUnderlyingBlock.toNumber()+1);
            chain.skipTimeTo(crt.lastUnderlyingTimestamp.toNumber()+1);
            // prove non-payment
            const proof = await attestationProvider.proveReferencedPaymentNonexistence(underlyingAgent1,
                PaymentReference.minting(crt.collateralReservationId), crt.valueUBA.add(crt.feeUBA),
                0, chain.blockHeight()-1, chain.lastBlockTimestamp()-1);
            const tx2 = await assetManager.mintingPaymentDefault(proof, crt.collateralReservationId, { from: agentOwner1 });
            const def = findRequiredEvent(tx2, "MintingPaymentDefault").args;
            // check that events were emitted correctly
            const agentSettings = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(def.collateralReservationId, crt.collateralReservationId);
            const poolFeeUBA = mulBIPS(toBN(crt.feeUBA), toBN(agentSettings.poolFeeShareBIPS));
            assertWeb3Equal(def.reservedAmountUBA, toBN(crt.valueUBA).add(poolFeeUBA));
            // check that agent and pool got wNat (on default, they must share totalFee - including executor fee)
            const poolShare = mulBIPS(totalFee, toBN(agentSettings.poolFeeShareBIPS));
            const agentShare = totalFee.sub(poolShare);
            const agentWnatBalance = await wNat.balanceOf(agentVault.address);
            assertWeb3Equal(agentWnatBalance, agentShare);
            const poolAddress = await assetManager.getCollateralPool(agentVault.address);
            const poolWnatBalance = await wNat.balanceOf(poolAddress);
            assertWeb3Equal(poolWnatBalance.sub(toWei(3e8)), poolShare);
        });

        it("should unstick minting", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS, [],
                { from: minter, value: reservationFee });
            const crt = findRequiredEvent(tx, "CollateralReserved").args;
            // don't mint f-assets for a long time (> 24 hours)
            skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            // calculate the cost of unsticking the minting
            const { 0: multiplier, 1: divisor } = await assetManager.assetPriceNatWei();
            const mintedValueUBA = lotsToUBA(1);
            const mintedValueNAT = mintedValueUBA.mul(multiplier).div(divisor);
            const unstickMintingCost = mulBIPS(mintedValueNAT, toBN(settings.vaultCollateralBuyForFlareFactorBIPS));
            // unstick minting
            const heightExistenceProof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
            const tx2 = await assetManager.unstickMinting(heightExistenceProof, crt.collateralReservationId,
                { from: agentOwner1, value: unstickMintingCost });
            const collateralReservationDeleted = findRequiredEvent(tx2, "CollateralReservationDeleted").args;
            assertWeb3Equal(collateralReservationDeleted.collateralReservationId, crt.collateralReservationId);
        });

        it("should self-mint", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // calculate payment amount (as amount >= one lot => include pool fee)
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const amountUBA = lotsToUBA(1);
            const poolFeeShare = mulBIPS(mulBIPS(amountUBA, toBN(agentInfo.feeBIPS)), toBN(agentInfo.poolFeeShareBIPS));
            const paymentAmount = amountUBA.add(poolFeeShare);
            // make and prove payment transaction
            chain.mint("random_address", paymentAmount);
            const txHash = await wallet.addTransaction("random_address", underlyingAgent1, paymentAmount,
                PaymentReference.selfMint(agentVault.address));
            const proof = await attestationProvider.provePayment(txHash, "random_address", underlyingAgent1);
            // self-mint
            await assetManager.selfMint(proof, agentVault.address, 1, { from: agentOwner1 });
            const fassets = await fAsset.balanceOf(agentOwner1);
            assertWeb3Equal(fassets, amountUBA);
        });
    });

    describe("redemption", () => {

        it("should mint and redeem", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[80];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(1));
            // redemption request
            const redemptionRequestTx = await assetManager.redeem(1, underlyingRedeemer, ZERO_ADDRESS, { from: redeemer });
            const redemptionRequest = findRequiredEvent(redemptionRequestTx, "RedemptionRequested").args;
            const ticketDeleted = findRequiredEvent(redemptionRequestTx, "RedemptionTicketDeleted").args;
            assert.equal(ticketDeleted.agentVault, agentVault.address);
            assertWeb3Equal(ticketDeleted.redemptionTicketId, 1);
            // prove redemption payment
            const txhash = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer, 1,
                PaymentReference.redemption(redemptionRequest.requestId));
            const proof = await attestationProvider.provePayment(txhash, underlyingAgent1, underlyingRedeemer);
            const redemptionFinishedTx = await assetManager.confirmRedemptionPayment(proof, redemptionRequest.requestId, { from: agentOwner1 });
            const redemptionPerformed = findRequiredEvent(redemptionFinishedTx, "RedemptionPaymentFailed").args;
            // assert (should also check that ticket was burned)
            assertWeb3Equal(redemptionPerformed.requestId, redemptionRequest.requestId);
        });

        it("should do a redemption payment default", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(1));
            // redemption request
            const redemptionRequestTx = await assetManager.redeem(1, underlyingRedeemer, ZERO_ADDRESS, { from: redeemer });
            const redemptionRequest = findRequiredEvent(redemptionRequestTx, "RedemptionRequested").args;
            // agent doesn't pay for specified time / blocks
            chain.mineTo(redemptionRequest.lastUnderlyingBlock.toNumber()+1);
            chain.skipTimeTo(redemptionRequest.lastUnderlyingTimestamp.toNumber()+1);
            // do default
            const proof = await attestationProvider.proveReferencedPaymentNonexistence(underlyingRedeemer,
                PaymentReference.redemption(redemptionRequest.requestId), redemptionRequest.valueUBA.sub(redemptionRequest.feeUBA),
                0, chain.blockHeight()-1, chain.lastBlockTimestamp()-1);
            const redemptionDefaultTx = await assetManager.redemptionPaymentDefault(proof, redemptionRequest.requestId, { from: agentOwner1 });
            // expect events
            const redemptionDefault = findRequiredEvent(redemptionDefaultTx, "RedemptionDefault").args;
            expect(redemptionDefault.agentVault).to.equal(agentVault.address);
            expect(redemptionDefault.redeemer).to.equal(redeemer);
            assertWeb3Equal(redemptionDefault.requestId, redemptionRequest.requestId);
            // expect usdc / wnat balance changes
            const redeemedAssetUSD = await ubaToUSDWei(redemptionRequest.valueUBA, ftsos.asset);
            const redeemerUSDCBalanceUSD = await ubaToUSDWei(await usdc.balanceOf(redeemer), ftsos.usdc);
            const redeemerWNatBalanceUSD = await ubaToUSDWei(await wNat.balanceOf(redeemer), ftsos.nat);
            assertEqualWithNumError(redeemerUSDCBalanceUSD, mulBIPS(redeemedAssetUSD, toBN(settings.redemptionDefaultFactorVaultCollateralBIPS)), toBN(10));
            assertEqualWithNumError(redeemerWNatBalanceUSD, mulBIPS(redeemedAssetUSD, toBN(settings.redemptionDefaultFactorPoolBIPS)), toBN(10));
        });

        it("should do a redemption payment default by executor", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const executor = accounts[84];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(1));
            // redemption request
            const executorFee = toWei(0.1);
            const redemptionRequestTx = await assetManager.redeem(1, underlyingRedeemer, executor, { from: redeemer, value: executorFee });
            const redemptionRequest = findRequiredEvent(redemptionRequestTx, "RedemptionRequested").args;
            // agent doesn't pay for specified time / blocks
            chain.mineTo(redemptionRequest.lastUnderlyingBlock.toNumber() + 1);
            chain.skipTimeTo(redemptionRequest.lastUnderlyingTimestamp.toNumber() + 1);
            // do default
            const proof = await attestationProvider.proveReferencedPaymentNonexistence(underlyingRedeemer,
                PaymentReference.redemption(redemptionRequest.requestId), redemptionRequest.valueUBA.sub(redemptionRequest.feeUBA),
                0, chain.blockHeight() - 1, chain.lastBlockTimestamp() - 1);
            const executorBalanceStart = toBN(await web3.eth.getBalance(executor));
            const redemptionDefaultTx = await assetManager.redemptionPaymentDefault(proof, redemptionRequest.requestId, { from: executor });
            const executorBalanceEnd = toBN(await web3.eth.getBalance(executor));
            const gasFee = toBN(redemptionDefaultTx.receipt.gasUsed).mul(toBN(redemptionDefaultTx.receipt.effectiveGasPrice));
            // expect events
            const redemptionDefault = findRequiredEvent(redemptionDefaultTx, "RedemptionDefault").args;
            expect(redemptionDefault.agentVault).to.equal(agentVault.address);
            expect(redemptionDefault.redeemer).to.equal(redeemer);
            assertWeb3Equal(redemptionDefault.requestId, redemptionRequest.requestId);
            assertWeb3Equal(executorBalanceEnd.sub(executorBalanceStart), executorFee.sub(gasFee));
            // expect usdc / wnat balance changes
            const redeemedAssetUSD = await ubaToUSDWei(redemptionRequest.valueUBA, ftsos.asset);
            const redeemerUSDCBalanceUSD = await ubaToUSDWei(await usdc.balanceOf(redeemer), ftsos.usdc);
            const redeemerWNatBalanceUSD = await ubaToUSDWei(await wNat.balanceOf(redeemer), ftsos.nat);
            assertEqualWithNumError(redeemerUSDCBalanceUSD, mulBIPS(redeemedAssetUSD, toBN(settings.redemptionDefaultFactorVaultCollateralBIPS)), toBN(10));
            assertEqualWithNumError(redeemerWNatBalanceUSD, mulBIPS(redeemedAssetUSD, toBN(settings.redemptionDefaultFactorPoolBIPS)), toBN(10));
        });

        it("should finish non-defaulted redemption payment", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            const { agentFeeShareUBA } = await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(1));
            // default a redemption
            const redemptionRequestTx = await assetManager.redeem(1, underlyingRedeemer, ZERO_ADDRESS, { from: redeemer });
            const redemptionRequest = findRequiredEvent(redemptionRequestTx, "RedemptionRequested").args;
            // don't mint f-assets for a long time (> 24 hours) to escape the provable attestation window
            skipToProofUnavailability(redemptionRequest.lastUnderlyingBlock, redemptionRequest.lastUnderlyingTimestamp);
            // prove redemption payment
            const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
            const redemptionFinishedTx = await assetManager.finishRedemptionWithoutPayment(proof, redemptionRequest.requestId, { from: agentOwner1 });
            const redemptionDefault = findRequiredEvent(redemptionFinishedTx, "RedemptionDefault").args;
            assertWeb3Equal(redemptionDefault.agentVault, agentVault.address);
            assertWeb3Equal(redemptionDefault.requestId, redemptionRequest.requestId);
            assertWeb3Equal(redemptionDefault.redemptionAmountUBA, lotsToUBA(1));
            // check that free underlying balance was updated
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.freeUnderlyingBalanceUBA, lotsToUBA(1).add(agentFeeShareUBA));
        });

        it("should extend redemption payment time", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(10));
            // perform redemption requests
            const times1: number[] = [];
            const blocks1: number[] = [];
            for (let i = 0; i < 10; i++) {
                const redemptionRequestTx = await assetManager.redeem(1, underlyingRedeemer, ZERO_ADDRESS, { from: redeemer });
                const timestamp = chain.lastBlockTimestamp();
                const block = chain.blockHeight();
                const redemptionRequest = findRequiredEvent(redemptionRequestTx, "RedemptionRequested").args;
                times1.push(Number(redemptionRequest.lastUnderlyingTimestamp) - timestamp);
                blocks1.push(Number(redemptionRequest.lastUnderlyingBlock) - Number(block));
            }
            for (let i = 1; i < 10; i++) {
                assert.equal(times1[i] - times1[i - 1], 10);
                assert.isAtLeast(blocks1[i], blocks1[i - 1]);
            }
            assert.isAtLeast(blocks1[9] - blocks1[0], 5);
        });

        it("should not extend redemption payment time much when setting is 1", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(10));
            // set redemptionPaymentExtensionSeconds setting to 1 (needs two steps and timeskip due to validation)
            await assetManager.setRedemptionPaymentExtensionSeconds(3, { from: assetManagerController });
            await deterministicTimeIncrease(86400);
            await assetManager.setRedemptionPaymentExtensionSeconds(1, { from: assetManagerController });
            // default a redemption
            const times1: number[] = [];
            const blocks1: number[] = [];
            for (let i = 0; i < 10; i++) {
                const redemptionRequestTx = await assetManager.redeem(1, underlyingRedeemer, ZERO_ADDRESS, { from: redeemer });
                const timestamp = chain.lastBlockTimestamp();
                const block = chain.blockHeight();
                const redemptionRequest = findRequiredEvent(redemptionRequestTx, "RedemptionRequested").args;
                times1.push(Number(redemptionRequest.lastUnderlyingTimestamp) - timestamp);
                blocks1.push(Number(redemptionRequest.lastUnderlyingBlock) - Number(block));
                // console.log(times1[i], blocks1[i]);
            }
            for (let i = 1; i < 10; i++) {
                assert.isAtMost(times1[i] - times1[i - 1], 2);
                assert.isAtMost(blocks1[i] - blocks1[i - 1], 2);
            }
        });

        it("should not set redemption payment extension seconds - only asset manager controller", async () => {
            const promise = assetManager.setRedemptionPaymentExtensionSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set redemption payment extension seconds - decrease too big", async () => {
            const promise = assetManager.setRedemptionPaymentExtensionSeconds(0, { from: assetManagerController });
            await expectRevert(promise, "decrease too big");
        });

        it("should not set redemption payment extension seconds - increase too big", async () => {
            const currentExtensionSecs = await assetManager.redemptionPaymentExtensionSeconds();
            const averageBlockTimeMs = settings.averageBlockTimeMS;
            const newExtensionSecs = currentExtensionSecs.muln(4).add(toBN(averageBlockTimeMs).divn(1000)).addn(1);
            const promise = assetManager.setRedemptionPaymentExtensionSeconds(newExtensionSecs, { from: assetManagerController });
            await expectRevert(promise, "increase too big");
        });

        it("should revert setting redemption payment extension time to 0", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(10));
            // set redemptionPaymentExtensionSeconds setting to 1 (needs two steps and timeskip due to validation)
            await assetManager.setRedemptionPaymentExtensionSeconds(3, { from: assetManagerController });
            await deterministicTimeIncrease(86400);
            await expectRevert(assetManager.setRedemptionPaymentExtensionSeconds(0, { from: assetManagerController }), "value must be nonzero");
        });
    });

    describe("agent underlying", () => {

        it("should self-close", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            const { agentFeeShareUBA } = await mintFassets(agentVault, agentOwner1, underlyingAgent1, agentOwner1, toBN(1));
            const tx = await assetManager.selfClose(agentVault.address, lotsToUBA(1), { from: agentOwner1 });
            const selfClosed = findRequiredEvent(tx, "SelfClose").args;
            assertWeb3Equal(selfClosed.agentVault, agentVault.address);
            assertWeb3Equal(selfClosed.valueUBA, lotsToUBA(1));
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.freeUnderlyingBalanceUBA, lotsToUBA(1).add(agentFeeShareUBA));
        });

        it("should announce underlying withdraw and confirm (from agent owner)", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // deposit underlying asset to not trigger liquidation by making balance negative
            await depositUnderlyingAsset(agentVault, agentOwner1, underlyingAgent1, toWei(10));
            // announce underlying asset withdrawal
            const tx1 = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalAnnouncement = findRequiredEvent(tx1, "UnderlyingWithdrawalAnnounced").args;
            assertWeb3Equal(underlyingWithdrawalAnnouncement.agentVault, agentVault.address);
            // withdraw
            const txHash = await wallet.addTransaction(underlyingAgent1, "random_address", 1, underlyingWithdrawalAnnouncement.paymentReference);
            const proof = await attestationProvider.provePayment(txHash, underlyingAgent1, "random_address");
            // wait until confirmation
            await deterministicTimeIncrease(settings.announcedUnderlyingConfirmationMinSeconds);
            // confirm
            const tx2 = await assetManager.confirmUnderlyingWithdrawal(proof, agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalConfirmed = findRequiredEvent(tx2, "UnderlyingWithdrawalConfirmed").args;
            assertWeb3Equal(underlyingWithdrawalConfirmed.agentVault, agentVault.address);
            assertWeb3Equal(underlyingWithdrawalConfirmed.spentUBA, toBN(1));
            assertWeb3Equal(underlyingWithdrawalConfirmed.announcementId, underlyingWithdrawalAnnouncement.announcementId);
            // check that agent is not in liquidation
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 0);
        });

        it("should announce underlying withdraw and cancel (from agent owner)", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            const tx1 = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalAnnouncement = findRequiredEvent(tx1, "UnderlyingWithdrawalAnnounced").args;
            await deterministicTimeIncrease(settings.announcedUnderlyingConfirmationMinSeconds);
            const tx2 = await assetManager.cancelUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalConfirmed = findRequiredEvent(tx2, "UnderlyingWithdrawalCancelled").args;
            assertWeb3Equal(underlyingWithdrawalConfirmed.agentVault, agentVault.address);
            assertWeb3Equal(underlyingWithdrawalConfirmed.announcementId, underlyingWithdrawalAnnouncement.announcementId);
            // withdrawal didn't happen so agent is not in liquidation
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 0);
        });

        it("should topup the underlying balance", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            chain.mint("random_address", 1000);
            const txHash = await wallet.addTransaction("random_address", underlyingAgent1, 1000,
                PaymentReference.topup(agentVault.address));
            const proof = await attestationProvider.provePayment(txHash, "random_address", underlyingAgent1);
            const tx = await assetManager.confirmTopupPayment(proof, agentVault.address, { from: agentOwner1 });
            const underlyingBalanceToppedUp = findRequiredEvent(tx, "UnderlyingBalanceToppedUp").args;
            assertWeb3Equal(underlyingBalanceToppedUp.agentVault, agentVault.address);
            assertWeb3Equal(underlyingBalanceToppedUp.depositedUBA, 1000);
            // check that change was logged in agentInfo
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.freeUnderlyingBalanceUBA, 1000)
        });

    });

    describe("challenges", () => {
        it("should make an illegal payment challenge", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await depositUnderlyingAsset(agentVault, agentOwner1, underlyingAgent1, toWei(10));
            // make unannounced (illegal) payment
            const txHash = await wallet.addTransaction(underlyingAgent1, "random_address", 1000, PaymentReference.announcedWithdrawal(1));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const tx = await assetManager.illegalPaymentChallenge(proof, agentVault.address, { from: challenger });
            const illegalPaymentConfirmed = findRequiredEvent(tx, "IllegalPaymentConfirmed").args;
            assertWeb3Equal(illegalPaymentConfirmed.agentVault, agentVault.address);
            assertWeb3Equal(illegalPaymentConfirmed.transactionHash, txHash);
            // check that agent went into full liquidation
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 3); // full-liquidation status
            // check that challenger was rewarded
            const expectedChallengerReward = await usd5ToVaultCollateralWei(toBN(settings.paymentChallengeRewardUSD5));
            assertWeb3Equal(await usdc.balanceOf(challenger), expectedChallengerReward);
        });

        it("should make an illegal double payment challenge", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // announce ONE underlying withdrawal
            await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            // make two identical payments
            const txHash1 = await wallet.addTransaction(underlyingAgent1, "random_address", 500, PaymentReference.announcedWithdrawal(1));
            const txHash2 = await wallet.addTransaction(underlyingAgent1, "random_address", 500, PaymentReference.announcedWithdrawal(1));
            const proof1 = await attestationProvider.proveBalanceDecreasingTransaction(txHash1, underlyingAgent1);
            const proof2 = await attestationProvider.proveBalanceDecreasingTransaction(txHash2, underlyingAgent1);
            const tx = await assetManager.doublePaymentChallenge(proof1, proof2, agentVault.address, { from: challenger });
            const duplicatePaymentConfirmed = findRequiredEvent(tx, "DuplicatePaymentConfirmed").args;
            assertWeb3Equal(duplicatePaymentConfirmed.agentVault, agentVault.address);
            assertWeb3Equal(duplicatePaymentConfirmed.transactionHash1, txHash1);
            assertWeb3Equal(duplicatePaymentConfirmed.transactionHash2, txHash2);
            // check that agent went into full liquidation
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 3); // full-liquidation status
            // check that challenger was rewarded
            const expectedChallengerReward = await usd5ToVaultCollateralWei(toBN(settings.paymentChallengeRewardUSD5));
            assertWeb3Equal(await usdc.balanceOf(challenger), expectedChallengerReward);
        });

        it("should make a free-balance negative challenge", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // mint one lot of f-assets
            const lots = toBN(1);
            const { underlyingPaymentUBA } = await mintFassets(agentVault, agentOwner1, underlyingAgent1, agentVault.address, lots);
            // announce withdrawal
            const _tx = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalAnnouncement = findRequiredEvent(_tx, "UnderlyingWithdrawalAnnounced").args;
            // make payment that would make free balance negative
            const txHash = await wallet.addTransaction(underlyingAgent1, "random_address", lotsToUBA(lots),
                underlyingWithdrawalAnnouncement.paymentReference);
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            // make a challenge
            const tx = await assetManager.freeBalanceNegativeChallenge([proof], agentVault.address, { from: challenger });
            const underlyingBalanceTooLow = findRequiredEvent(tx, "UnderlyingBalanceTooLow").args;
            assertWeb3Equal(underlyingBalanceTooLow.agentVault, agentVault.address);
            assertWeb3Equal(underlyingBalanceTooLow.balance, underlyingPaymentUBA.sub(lotsToUBA(lots)));
            assertWeb3Equal(underlyingBalanceTooLow.requiredBalance,
                mulBIPS(await fAsset.totalSupply(), toBN(settings.minUnderlyingBackingBIPS)));
            // check that challenger was rewarded
            const expectedChallengerReward = await usd5ToVaultCollateralWei(toBN(settings.paymentChallengeRewardUSD5));
            assertWeb3Equal(await usdc.balanceOf(challenger), expectedChallengerReward);
        });
    });

    describe("liquidation", () => {

        it("should start liquidation", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1)
            // mint some f-assets that require backing
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[82], toBN(1));
            // price change
            await ftsos.asset.setCurrentPrice(toBNExp(3521, 50), 0);
            await ftsos.asset.setCurrentPriceFromTrustedProviders(toBNExp(3521, 50), 0);
            // start liquidation
            const tx = await assetManager.startLiquidation(agentVault.address, { from: accounts[83] });
            expectEvent(tx, "LiquidationStarted");
            // check that agent is in liquidation phase
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 2);
        });

        it("should liquidate", async () => {
            const liquidator = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1, toWei(3e8), toWei(3e8))
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, liquidator, toBN(2));
            // simulate liquidation (set cr to eps > 0)
            await ftsos.asset.setCurrentPrice(toBNExp(10, 12), 0);
            await ftsos.asset.setCurrentPriceFromTrustedProviders(toBNExp(10, 12), 0);
            await assetManager.startLiquidation(agentVault.address, { from: liquidator });
            // calculate liquidation value and liquidate liquidate
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const liquidationUBA = lotsToUBA(2);
            const liquidationUSDC = await ubaToC1Wei(mulBIPS(liquidationUBA, toBN(agentInfo.vaultCollateralRatioBIPS)));
            const liquidationPool = await ubaToPoolWei(mulBIPS(liquidationUBA, toBN(agentInfo.poolCollateralRatioBIPS)));
            const tx = await assetManager.liquidate(agentVault.address, lotsToUBA(2), { from: liquidator });
            expectEvent(tx, "LiquidationPerformed");
            assertWeb3Equal(await usdc.balanceOf(liquidator), liquidationUSDC);
            assertWeb3Equal(await wNat.balanceOf(liquidator), liquidationPool);
        });

        it("should start and then end liquidation", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1, toWei(3e8), toWei(3e8))
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(2));
            // price change #1
            await ftsos.asset.setCurrentPrice(toBNExp(3521, 50), 0);
            await ftsos.asset.setCurrentPriceFromTrustedProviders(toBNExp(3521, 50), 0);
            // start liquidation
            await assetManager.startLiquidation(agentVault.address, { from: accounts[83] });
            // price change #2
            await ftsos.asset.setCurrentPrice(testChainInfo.eth.startPrice, 0);
            await ftsos.asset.setCurrentPriceFromTrustedProviders(testChainInfo.eth.startPrice, 0);
            // end liquidation
            const tx = await assetManager.endLiquidation(agentVault.address, { from: accounts[83] });
            expectEvent(tx, "LiquidationEnded");
            // check that agent status is normal
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 0);
        });
    });

    describe("getting agents", () => {
        it("should get all agents", async () => {
            // create agent
            const agentVault1 = await createAgentVaultWithEOA(accounts[82], "Agent1");
            const agentVault2 = await createAgentVaultWithEOA(accounts[83], "Agent2")
            // get all agents
            const agents = await assetManager.getAllAgents(0, 10);
            assert.equal(agents[0].length, 2);
            assert.equal(agents[0][0], agentVault1.address);
            assert.equal(agents[0][1], agentVault2.address);
            assert.equal(agents[1].toString(), "2");
        });

        it("should announce and destroy agent", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
            await deterministicTimeIncrease(time.duration.hours(3));
            await assetManager.destroyAgent(agentVault.address, agentOwner1, { from: agentOwner1 });
            const tx = assetManager.getAgentInfo(agentVault.address);
            await expectRevert(tx, "invalid agent vault address");
        });

        it("should not be able to announce destroy if agent is backing fassets", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // announce and make agent unavailable
            await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            // make agent unavailable
            await deterministicTimeIncrease((await assetManager.getSettings()).agentExitAvailableTimelockSeconds);
            await assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            //Mint some fAssets (self-mints and sends so it should work even if unavailable)
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[5], toBN(1));
            //Should not be able to announce destroy if agent is backing fAssests
            let res = assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
            await expectRevert(res,"agent still active");
        });
    });

    describe("ERC-165 interface identification", () => {
        function erc165InterfaceIdLog(verbose: boolean, mainInterface: Truffle.Contract<any>, inheritedInterfaces: Truffle.Contract<any>[] = []) {
            const interfaceId = erc165InterfaceId(mainInterface, inheritedInterfaces);
            if (verbose) {
                console.log(`${(mainInterface as any)._json?.contractName}: ${interfaceId}`);
            }
            return interfaceId;
        }

        async function checkSupportInterfaceWorks(verbose: boolean) {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as "IERC165");
            const IAssetManager = artifacts.require("IAssetManager");
            const IIAssetManager = artifacts.require("IIAssetManager");
            const IDiamondLoupe = artifacts.require("IDiamondLoupe");
            const IDiamondCut = artifacts.require("IDiamondCut");
            const IGoverned = artifacts.require("IGoverned");
            const IAgentPing = artifacts.require("IAgentPing");
            const IRedemptionTimeExtension = artifacts.require("IRedemptionTimeExtension");
            const ITransferFees = artifacts.require("ITransferFees");
            const ICoreVault = artifacts.require("ICoreVault");
            const ICoreVaultSettings = artifacts.require("ICoreVaultSettings");
            const IISettingsManagement = artifacts.require("IISettingsManagement");
            const IAgentAlwaysAllowedMinters = artifacts.require("IAgentAlwaysAllowedMinters");
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IERC165)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IDiamondLoupe)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IDiamondCut)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IGoverned)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IAgentPing)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IRedemptionTimeExtension)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, ITransferFees)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, ICoreVault)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, ICoreVaultSettings)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IAssetManager,
                [IERC165, IDiamondLoupe, IAgentPing, IRedemptionTimeExtension, ITransferFees, ICoreVault, ICoreVaultSettings, IAgentAlwaysAllowedMinters])));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IIAssetManager,
                [IAssetManager, IGoverned, IDiamondCut, IISettingsManagement])));
            assert.isFalse(await assetManager.supportsInterface('0xFFFFFFFF'));     // must not support invalid interface
        }

        it("should properly respond to supportsInterface", async () => {
            await checkSupportInterfaceWorks(true);
        });

        it("calling AssetManagerInit.upgradeERC165Identifiers on initialized asset manager should work", async () => {
            const AssetManagerInit = artifacts.require("AssetManagerInit");
            const assetManagerInit = await AssetManagerInit.new();
            // upgrade should fail if called directly
            await expectRevert(assetManagerInit.upgradeERC165Identifiers(), "not initialized");
            // but it should work in diamond cut on existing asset manager
            await assetManager.diamondCut([], assetManagerInit.address, abiEncodeCall(assetManagerInit, (c) => c.upgradeERC165Identifiers()), { from: governance });
            // supportInterface should work as before
            await checkSupportInterfaceWorks(false);
        });
    });

    describe("branch tests", () => {
        it("random address shouldn't be able to update settings", async () => {
            let wnatNewAddress = accounts[23];
            const r = assetManager.updateSystemContracts(assetManagerController, wnatNewAddress, { from: accounts[29] });
            await expectRevert(r, "only asset manager controller");
        });

        it("random address shouldn't be able to attach controller", async () => {
            const r = assetManager.attachController(false, { from: accounts[29]});
            await expectRevert(r, "only asset manager controller");
        });

        it("unattached asset manager can't create agent", async () => {
            await assetManager.attachController(false, { from: assetManagerController });
            const r = createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await expectRevert(r, "not attached");
        });

        it("unattached asset manager can't do collateral reservations", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            await assetManager.attachController(false, { from: assetManagerController });
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const r = assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS, [],
                { from: minter, value: reservationFee });
            await expectRevert(r, "not attached");
        });

        it("when whitelist is enabled, address not whitelisted can't do collateral reservations", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // create governance settings
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const whitelist = await Whitelist.new(governanceSettings.address, governance, false);
            await whitelist.switchToProductionMode({ from: governance });
            await whitelist.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setWhitelist(whitelist.address, { from: assetManagerController });
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            // Try to reserve collateral from non whitelisted address
            const r = assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS, [],
                { from: minter, value: reservationFee });
            await expectRevert(r, "not whitelisted");
            //Whitelisted account should be able to reserve collateral
            const res = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS, [],
                { from: whitelistedAccount, value: reservationFee });
            expectEvent(res,"CollateralReserved");
        });

        it("agent can't self mint if asset manager is not attached", async () => {
            const agentVault = await createAgentVaultWithEOA(agentOwner1, underlyingAgent1);
            //unattach
            await assetManager.attachController(false, { from: assetManagerController });
            // calculate payment amount (as amount >= one lot => include pool fee)
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const amountUBA = lotsToUBA(1);
            const poolFeeShare = mulBIPS(mulBIPS(amountUBA, toBN(agentInfo.feeBIPS)), toBN(agentInfo.poolFeeShareBIPS));
            const paymentAmount = amountUBA.add(poolFeeShare);
            // make and prove payment transaction
            chain.mint("random_address", paymentAmount);
            const txHash = await wallet.addTransaction("random_address", underlyingAgent1, paymentAmount,
                PaymentReference.selfMint(agentVault.address));
            const proof = await attestationProvider.provePayment(txHash, "random_address", underlyingAgent1);
            // self-mint
            const r = assetManager.selfMint(proof, agentVault.address, 1, { from: agentOwner1 });
            await expectRevert(r, "not attached");
        });

        it("when whitelist is enabled, address not whitelisted can't redeem", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // create governance settings
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const whitelist = await Whitelist.new(governanceSettings.address, governance, false);
            await whitelist.switchToProductionMode({ from: governance });
            await whitelist.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setWhitelist(whitelist.address, { from: assetManagerController });
            const redeemer = accounts[83];
            const underlyingRedeemer = "redeemer"
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(1));
            // default a redemption
            const r = assetManager.redeem(1, underlyingRedeemer, ZERO_ADDRESS, { from: redeemer });
            await expectRevert(r, "not whitelisted");
        });

        it("when whitelist is enabled, address not whitelisted can't challenge illegal payment", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            await depositUnderlyingAsset(agentVault, agentOwner1, underlyingAgent1, toWei(10));
            // make unannounced (illegal) payment
            const txHash = await wallet.addTransaction(underlyingAgent1, "random_address", 1000, PaymentReference.announcedWithdrawal(1));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const whitelist = await Whitelist.new(governanceSettings.address, governance, false);
            await whitelist.switchToProductionMode({ from: governance });
            await whitelist.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setWhitelist(whitelist.address, { from: assetManagerController });
            const r = assetManager.illegalPaymentChallenge(proof, agentVault.address, { from: challenger });
            await expectRevert(r, "not whitelisted");
        });

        it("when whitelist is enabled, address not whitelisted can't challenge illegal double payment", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // announce ONE underlying withdrawal
            await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            // make two identical payments
            const txHash1 = await wallet.addTransaction(underlyingAgent1, "random_address", 500, PaymentReference.announcedWithdrawal(1));
            const txHash2 = await wallet.addTransaction(underlyingAgent1, "random_address", 500, PaymentReference.announcedWithdrawal(1));
            const proof1 = await attestationProvider.proveBalanceDecreasingTransaction(txHash1, underlyingAgent1);
            const proof2 = await attestationProvider.proveBalanceDecreasingTransaction(txHash2, underlyingAgent1);
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const whitelist = await Whitelist.new(governanceSettings.address, governance, false);
            await whitelist.switchToProductionMode({ from: governance });
            await whitelist.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setWhitelist(whitelist.address, { from: assetManagerController });
            const r = assetManager.doublePaymentChallenge(proof1, proof2, agentVault.address, { from: challenger });
            await expectRevert(r, "not whitelisted");
        });

        it("when whitelist is enabled, address not whitelisted can't challenge free balance negative", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // mint one lot of f-assets
            const lots = toBN(1);
            const { underlyingPaymentUBA } = await mintFassets(agentVault, agentOwner1, underlyingAgent1, agentVault.address, lots);
            // announce withdrawal
            const _tx = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalAnnouncement = findRequiredEvent(_tx, "UnderlyingWithdrawalAnnounced").args;
            // make payment that would make free balance negative
            const txHash = await wallet.addTransaction(underlyingAgent1, "random_address", lotsToUBA(lots),
                underlyingWithdrawalAnnouncement.paymentReference);
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const whitelist = await Whitelist.new(governanceSettings.address, governance, false);
            await whitelist.switchToProductionMode({ from: governance });
            await whitelist.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setWhitelist(whitelist.address, { from: assetManagerController });
            // make a challenge
            const r = assetManager.freeBalanceNegativeChallenge([proof], agentVault.address, { from: challenger });
            await expectRevert(r, "not whitelisted");
        });

        it("when whitelist is enabled, address not whitelisted can't start liquidation", async () => {
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1)
            // mint some f-assets that require backing
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[82], toBN(1));
            // price change
            await ftsos.asset.setCurrentPrice(toBNExp(3521, 50), 0);
            await ftsos.asset.setCurrentPriceFromTrustedProviders(toBNExp(3521, 50), 0);
            // start liquidation
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const whitelist = await Whitelist.new(governanceSettings.address, governance, false);
            await whitelist.switchToProductionMode({ from: governance });
            await whitelist.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setWhitelist(whitelist.address, { from: assetManagerController });
            const r = assetManager.startLiquidation(agentVault.address, { from: accounts[83] });
            await expectRevert(r, "not whitelisted");
        });

        it("when whitelist is enabled, address not whitelisted can't liquidate", async () => {
            const liquidator = accounts[83];
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1, toWei(3e8), toWei(3e8))
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, liquidator, toBN(2));
            // simulate liquidation (set cr to eps > 0)
            await ftsos.asset.setCurrentPrice(toBNExp(10, 12), 0);
            await ftsos.asset.setCurrentPriceFromTrustedProviders(toBNExp(10, 12), 0);
            await assetManager.startLiquidation(agentVault.address, { from: liquidator });
            // calculate liquidation value and liquidate liquidate
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const liquidationUBA = lotsToUBA(2);
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const whitelist = await Whitelist.new(governanceSettings.address, governance, false);
            await whitelist.switchToProductionMode({ from: governance });
            await whitelist.addAddressToWhitelist(whitelistedAccount, { from: governance });
            await assetManager.setWhitelist(whitelist.address, { from: assetManagerController });
            const r = assetManager.liquidate(agentVault.address, lotsToUBA(2), { from: liquidator });
            await expectRevert(r, "not whitelisted");
        });

        it("random address shouldn't be able to add collateral token", async () => {
            const collateral = JSON.parse(JSON.stringify(web3DeepNormalize(collaterals[1]))); // make a deep copy
            collateral.token = (await ERC20Mock.new("New Token", "NT")).address;
            collateral.tokenFtsoSymbol = "NT";
            collateral.assetFtsoSymbol = "NT";
            const r = assetManager.addCollateralType(web3DeepNormalize(collateral), { from: accounts[99]});
            await expectRevert(r, "only asset manager controller");

        });

        it("random address shouldn't be able to add collateral ratios for token", async () => {
            const r = assetManager.setCollateralRatiosForToken(collaterals[0].collateralClass, collaterals[0].token,
                toBIPS(1.5), toBIPS(1.4), toBIPS(1.6), { from: accounts[99] });
            await expectRevert(r, "only asset manager controller");
        });

        it("random address shouldn't be able to deprecate token", async () => {
            const r = assetManager.deprecateCollateralType(collaterals[0].collateralClass, collaterals[0].token,
                settings.tokenInvalidationTimeMinSeconds, { from: accounts[99] });
            await expectRevert(r, "only asset manager controller");
        });

        it("validate settings fAsset address can't be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "zero fAsset address");
        });

        it("validate settings AgentVaultfactory cannot be address zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.agentVaultFactory = ZERO_ADDRESS;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "zero agentVaultFactory address");
        });

        it("validate settings collateralPoolFactory address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.collateralPoolFactory = ZERO_ADDRESS;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "zero collateralPoolFactory address");
        });

        it("validate settings collateralPoolTokenFactory address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.collateralPoolTokenFactory = ZERO_ADDRESS;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "zero collateralPoolTokenFactory address");
        });

        it("validate settings fdcVerification address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.fdcVerification = ZERO_ADDRESS;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "zero fdcVerification address");
        });

        it("validate settings priceReader address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.priceReader = ZERO_ADDRESS;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "zero priceReader address");
        });

        it("validate settings agentOwnerRegistry address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.agentOwnerRegistry = ZERO_ADDRESS;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "zero agentOwnerRegistry address");
        });

        it("validate settings confirmationByOthersRewardUSD5 cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.confirmationByOthersRewardUSD5 = 0;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "cannot be zero");
        });

        it("validate settings minUnderlyingBackingBIPS cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.minUnderlyingBackingBIPS = 0;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "cannot be zero");
        });

        it("validate settings minUnderlyingBackingBIPS cannot be bigger than max bips", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.minUnderlyingBackingBIPS = 20000;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "bips value too high");
        });

        it("validate settings vaultCollateralBuyForFlareFactorBIPS cannot be smaller than max bips", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.vaultCollateralBuyForFlareFactorBIPS = 5000;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "value too small");
        });

        it("validate settings averageBLockTimeMS cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.averageBlockTimeMS = 0;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "cannot be zero");
        });

        it("validate settings agentTimelockedOperationWindowSeconds cannot be too small", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.agentTimelockedOperationWindowSeconds = 60;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "value too small");
        });

        it("validate settings collateralPoolTokenTimelockSeconds cannot be too small", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.collateralPoolTokenTimelockSeconds = 10;
            let res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert(res, "value too small");
        });

        it("Should unstick minting, where token direct price pair is true", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true, announcedUnderlyingConfirmationMinSeconds: 10 });
            collaterals[0].directPricePair=true;
            collaterals[1].directPricePair=true;
            [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
            // create agent vault and make available
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS, [],
                { from: minter, value: reservationFee });
            const crt = findRequiredEvent(tx, "CollateralReserved").args;
            // don't mint f-assets for a long time (> 24 hours)
            skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
            // calculate the cost of unsticking the minting
            const { 0: multiplier, 1: divisor } = await assetManager.assetPriceNatWei();
            const mintedValueUBA = lotsToUBA(1);
            const mintedValueNAT = mintedValueUBA.mul(multiplier).div(divisor);
            const unstickMintingCost = mulBIPS(mintedValueNAT, toBN(settings.vaultCollateralBuyForFlareFactorBIPS));
            // unstick minting
            const heightExistenceProof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
            const tx2 = await assetManager.unstickMinting(heightExistenceProof, crt.collateralReservationId,
                { from: agentOwner1, value: unstickMintingCost });
            const collateralReservationDeleted = findRequiredEvent(tx2, "CollateralReservationDeleted").args;
            assertWeb3Equal(collateralReservationDeleted.collateralReservationId, crt.collateralReservationId);
        });

        it("at least 2 collaterals required when creating asset managet", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true, announcedUnderlyingConfirmationMinSeconds: 10 });
            let collateralsNew: CollateralType[];
            //First collateral shouldn't be anything else than a Pool collateral
            collateralsNew = collaterals;
            //Make first collateral be VaultCollateral
            collateralsNew[0].collateralClass = collateralsNew[1].collateralClass;
            let res = newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collateralsNew, ci.assetName, ci.assetSymbol);
            await expectRevert(res,"not a pool collateral at 0");
        });

        it("pool collateral should be the first collateral when creating asset manager", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true, announcedUnderlyingConfirmationMinSeconds: 10 });
            //Only one collateral should not be enough to create asset manager
            let collateralsNew: CollateralType[];
            collateralsNew=[collaterals[0]];
            let res = newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collateralsNew, ci.assetName, ci.assetSymbol);
            await expectRevert(res,"at least two collaterals required");
        });

        it("collateral types after first collateral should be VaultCollateral when creating asset manager", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true, announcedUnderlyingConfirmationMinSeconds: 10 });
            let collateralsNew: CollateralType[];
            //First collateral shouldn't be anything else than a Pool collateral
            collateralsNew = collaterals;
            //Collaterals after the first should all be VaultCollateral
            //Make second and third collateral be Pool
            collaterals[1].collateralClass = collaterals[0].collateralClass;
            collaterals[2].collateralClass = collaterals[0].collateralClass;
            let res = newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collateralsNew, ci.assetName, ci.assetSymbol);
            await expectRevert(res,"not a vault collateral");
        });

        it("locked vault token branch test", async () => {
            // create agent
            const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
            const r1 = await assetManager.isLockedVaultToken(agentVault.address, wNat.address);
            const collateraPoolToken = await getCollateralPoolToken(agentVault.address);
            const r2 = await assetManager.isLockedVaultToken(agentVault.address, collateraPoolToken.address);
            const r3 = await assetManager.isLockedVaultToken(agentVault.address, usdc.address);
            assert.equal(r1,false);
            assert.equal(r2,true);
            assert.equal(r3,true);
        });

        it("should not set whitelist if not from asset manager controller", async () => {
            const promise = assetManager.setWhitelist(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set agent owner registry if not from asset manager controller", async () => {
            const promise = assetManager.setAgentOwnerRegistry(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set agent vault factory if not from asset manager controller", async () => {
            const promise = assetManager.setAgentVaultFactory(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set collateral pool factory if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralPoolFactory(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set collateral pool token factory if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralPoolTokenFactory(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set price reader if not from asset manager controller", async () => {
            const promise = assetManager.setPriceReader(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set cleaner contract if not from asset manager controller", async () => {
            const promise = assetManager.setCleanerContract(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set fdv verification if not from asset manager controller", async () => {
            const promise = assetManager.setFdcVerification(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set cleanup block number manager if not from asset manager controller", async () => {
            const promise = assetManager.setCleanupBlockNumberManager(accounts[0]);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not upgrade FAsset implementation if not from asset manager controller", async () => {
            const promise = assetManager.upgradeFAssetImplementation(accounts[0], "0x");
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set time for payment if not from asset manager controller", async () => {
            const promise = assetManager.setTimeForPayment(0, 0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set payment challenge rewards if not from asset manager controller", async () => {
            const promise = assetManager.setPaymentChallengeReward(0, 0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set MinUpdateRepeatTimeSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setMinUpdateRepeatTimeSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set lot size if not from asset manager controller", async () => {
            const promise = assetManager.setLotSizeAmg(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setMinUnderlyingBackingBips not from asset manager controller", async () => {
            const promise = assetManager.setMinUnderlyingBackingBips(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setMaxTrustedPriceAgeSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setMaxTrustedPriceAgeSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setCollateralReservationFeeBips if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralReservationFeeBips(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setRedemptionFeeBips if not from asset manager controller", async () => {
            const promise = assetManager.setRedemptionFeeBips(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setRedemptionDefaultFactorBips if not from asset manager controller", async () => {
            const promise = assetManager.setRedemptionDefaultFactorBips(0, 0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setConfirmationByOthersAfterSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setConfirmationByOthersAfterSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setConfirmationByOthersRewardUSD5 if not from asset manager controller", async () => {
            const promise = assetManager.setConfirmationByOthersRewardUSD5(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setMaxRedeemedTickets if not from asset manager controller", async () => {
            const promise = assetManager.setMaxRedeemedTickets(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setWithdrawalOrDestroyWaitMinSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setWithdrawalOrDestroyWaitMinSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setCcbTimeSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setCcbTimeSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setAttestationWindowSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAttestationWindowSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setAverageBlockTimeMS if not from asset manager controller", async () => {
            const promise = assetManager.setAverageBlockTimeMS(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setAnnouncedUnderlyingConfirmationMinSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAnnouncedUnderlyingConfirmationMinSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setMintingPoolHoldingsRequiredBIPS if not from asset manager controller", async () => {
            const promise = assetManager.setMintingPoolHoldingsRequiredBIPS(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setMintingCapAmg if not from asset manager controller", async () => {
            const promise = assetManager.setMintingCapAmg(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setTokenInvalidationTimeMinSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setTokenInvalidationTimeMinSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setVaultCollateralBuyForFlareFactorBIPS if not from asset manager controller", async () => {
            const promise = assetManager.setVaultCollateralBuyForFlareFactorBIPS(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setAgentExitAvailableTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentExitAvailableTimelockSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setAgentMintingCRChangeTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentMintingCRChangeTimelockSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setPoolExitAndTopupChangeTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setPoolExitAndTopupChangeTimelockSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setAgentTimelockedOperationWindowSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentTimelockedOperationWindowSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setCollateralPoolTokenTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralPoolTokenTimelockSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setLiquidationStepSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setLiquidationStepSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setLiquidationPaymentFactors if not from asset manager controller", async () => {
            const promise = assetManager.setLiquidationPaymentFactors([], []);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setMaxEmergencyPauseDurationSeconds - value zero", async () => {
            const promise = assetManager.setMaxEmergencyPauseDurationSeconds(0, { from: assetManagerController });
            await expectRevert(promise, "cannot be zero");
        });

        it("should not setEmergencyPauseDurationResetAfterSeconds - value zero", async () => {
            const promise = assetManager.setEmergencyPauseDurationResetAfterSeconds(0, { from: assetManagerController });
            await expectRevert(promise, "cannot be zero");
        });

        it("should not setMaxEmergencyPauseDurationSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setMaxEmergencyPauseDurationSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setEmergencyPauseDurationResetAfterSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setEmergencyPauseDurationResetAfterSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setCancelCollateralReservationAfterSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setCancelCollateralReservationAfterSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setRejectOrCancelCollateralReservationReturnFactorBIPS if not from asset manager controller", async () => {
            const promise = assetManager.setRejectOrCancelCollateralReservationReturnFactorBIPS(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setRejectRedemptionRequestWindowSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setRejectRedemptionRequestWindowSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setTakeOverRedemptionRequestWindowSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setTakeOverRedemptionRequestWindowSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setRejectedRedemptionDefaultFactorBips if not from asset manager controller", async () => {
            const promise = assetManager.setRejectedRedemptionDefaultFactorBips(0, 0);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not setAgentFeeChangeTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentFeeChangeTimelockSeconds(0);
            await expectRevert(promise, "only asset manager controller");
        });

        // rate limited
        it("should not set whitelist if rate limited", async () => {
            await assetManager.setWhitelist(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setWhitelist(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setWhitelist(accounts[0], { from: assetManagerController });
        });

        it("should not set agent owner registry if rate limited", async () => {
            await assetManager.setAgentOwnerRegistry(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentOwnerRegistry(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAgentOwnerRegistry(accounts[0], { from: assetManagerController });
        });

        it("should not set agent vault factory if rate limited", async () => {
            await assetManager.setAgentVaultFactory(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentVaultFactory(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAgentVaultFactory(accounts[0], { from: assetManagerController });
        });

        it("should not set collateral pool factory if rate limited", async () => {
            await assetManager.setCollateralPoolFactory(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralPoolFactory(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCollateralPoolFactory(accounts[0], { from: assetManagerController });
        });

        it("should not set collateral pool token factory if rate limited", async () => {
            await assetManager.setCollateralPoolTokenFactory(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralPoolTokenFactory(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCollateralPoolTokenFactory(accounts[0], { from: assetManagerController });
        });

        it("should not set price reader if rate limited", async () => {
            await assetManager.setPriceReader(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setPriceReader(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setPriceReader(accounts[0], { from: assetManagerController });
        });

        it("should not set cleaner contract if rate limited", async () => {
            await assetManager.setCleanerContract(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCleanerContract(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCleanerContract(accounts[0], { from: assetManagerController });
        });

        it("should not set fdv verification if rate limited", async () => {
            await assetManager.setFdcVerification(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setFdcVerification(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setFdcVerification(accounts[0], { from: assetManagerController });
        });

        it("should not set cleanup block number manager if rate limited", async () => {
            await assetManager.setCleanupBlockNumberManager(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCleanupBlockNumberManager(accounts[0], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCleanupBlockNumberManager(accounts[0], { from: assetManagerController });
        });

        it("should not upgrade FAsset implementation if rate limited", async () => {
            const impl = await TestUUPSProxyImpl.new();
            const initCall = abiEncodeCall(impl, c => c.initialize("an init message"));
            await assetManager.upgradeFAssetImplementation(impl.address, initCall, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const initCall1 = abiEncodeCall(impl, c => c.initialize("an init message 1"));
            const promise = assetManager.upgradeFAssetImplementation(impl.address, initCall1, { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.upgradeFAssetImplementation(impl.address, initCall1, { from: assetManagerController });
        });

        it("should not set time for payment if rate limited", async () => {
            await assetManager.setTimeForPayment(100, 100, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setTimeForPayment(200, 200, { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setTimeForPayment(200, 200, { from: assetManagerController });
        });

        it("should not set payment challenge rewards if rate limited", async () => {
            const paymentChallengeRewardBIPS = settings.paymentChallengeRewardBIPS;
            const paymentChallengeRewardNAT = settings.paymentChallengeRewardUSD5;
            await assetManager.setPaymentChallengeReward(toBN(paymentChallengeRewardNAT).addn(10), toBN(paymentChallengeRewardBIPS).addn(11), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise =  assetManager.setPaymentChallengeReward(toBN(paymentChallengeRewardNAT).addn(20), toBN(paymentChallengeRewardBIPS).addn(21), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setPaymentChallengeReward(toBN(paymentChallengeRewardNAT).addn(20), toBN(paymentChallengeRewardBIPS).addn(21), { from: assetManagerController });
        });

        it("should not set MinUpdateRepeatTimeSeconds if rate limited", async () => {
            await assetManager.setMinUpdateRepeatTimeSeconds(90000, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMinUpdateRepeatTimeSeconds(91000, { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(90000 - Number(minUpdateTime) + 1);
            await assetManager.setMinUpdateRepeatTimeSeconds(91000, { from: assetManagerController });
        });

        it("should not set lot size if rate limited", async () => {
            const oldLotSize = settings.lotSizeAMG;
            await assetManager.setLotSizeAmg(toBN(oldLotSize).addn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setLotSizeAmg(toBN(oldLotSize).addn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setLotSizeAmg(toBN(oldLotSize).addn(2), { from: assetManagerController });
        });

        it("should not setMinUnderlyingBackingBips rate limited", async () => {
            const oldValue = settings.minUnderlyingBackingBIPS;
            await assetManager.setMinUnderlyingBackingBips(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMinUnderlyingBackingBips(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setMinUnderlyingBackingBips(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setMaxTrustedPriceAgeSeconds if rate limited", async () => {
            const oldValue = settings.maxTrustedPriceAgeSeconds;
            await assetManager.setMaxTrustedPriceAgeSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMaxTrustedPriceAgeSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setMaxTrustedPriceAgeSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setCollateralReservationFeeBips if rate limited", async () => {
            const oldValue = settings.collateralReservationFeeBIPS;
            await assetManager.setCollateralReservationFeeBips(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralReservationFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCollateralReservationFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setRedemptionFeeBips if rate limited", async () => {
            const oldValue = settings.redemptionFeeBIPS;
            await assetManager.setRedemptionFeeBips(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setRedemptionFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setRedemptionFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setRedemptionDefaultFactorBips if rate limited", async () => {
            const oldValueVault = settings.redemptionDefaultFactorVaultCollateralBIPS;
            const oldValuePool = settings.redemptionDefaultFactorPoolBIPS;
            await assetManager.setRedemptionDefaultFactorBips(toBN(oldValueVault).subn(1), toBN(oldValuePool).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setRedemptionDefaultFactorBips(toBN(oldValueVault).subn(2), toBN(oldValuePool).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setRedemptionDefaultFactorBips(toBN(oldValueVault).subn(2), toBN(oldValuePool).subn(2), { from: assetManagerController });
        });

        it("should not setConfirmationByOthersAfterSeconds if rate limited", async () => {
            await assetManager.setConfirmationByOthersAfterSeconds(60 * 60 * 3, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setConfirmationByOthersAfterSeconds(60 * 60 * 4, { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setConfirmationByOthersAfterSeconds(60 * 60 * 4, { from: assetManagerController });
        });

        it("should not setConfirmationByOthersRewardUSD5 if rate limited", async () => {
            const oldValue = settings.confirmationByOthersRewardUSD5;
            await assetManager.setConfirmationByOthersRewardUSD5(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setConfirmationByOthersRewardUSD5(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setConfirmationByOthersRewardUSD5(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setMaxRedeemedTickets if rate limited", async () => {
            const oldValue = settings.maxRedeemedTickets;
            await assetManager.setMaxRedeemedTickets(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMaxRedeemedTickets(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setMaxRedeemedTickets(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setWithdrawalOrDestroyWaitMinSeconds if rate limited", async () => {
            const oldValue = settings.withdrawalWaitMinSeconds;
            await assetManager.setWithdrawalOrDestroyWaitMinSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setWithdrawalOrDestroyWaitMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setWithdrawalOrDestroyWaitMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setCcbTimeSeconds if rate limited", async () => {
            const oldValue = settings.ccbTimeSeconds;
            await assetManager.setCcbTimeSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCcbTimeSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCcbTimeSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAttestationWindowSeconds if rate limited", async () => {
            const oldValue = settings.attestationWindowSeconds;
            await assetManager.setAttestationWindowSeconds(toBN(oldValue).addn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAttestationWindowSeconds(toBN(oldValue).addn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAttestationWindowSeconds(toBN(oldValue).addn(2), { from: assetManagerController });
        });

        it("should not setAverageBlockTimeMS if rate limited", async () => {
            const oldValue = settings.averageBlockTimeMS;
            await assetManager.setAverageBlockTimeMS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAverageBlockTimeMS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAverageBlockTimeMS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAnnouncedUnderlyingConfirmationMinSeconds if rate limited", async () => {
            const oldValue = settings.announcedUnderlyingConfirmationMinSeconds;
            await assetManager.setAnnouncedUnderlyingConfirmationMinSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAnnouncedUnderlyingConfirmationMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAnnouncedUnderlyingConfirmationMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setMintingPoolHoldingsRequiredBIPS if rate limited", async () => {
            const oldValue = settings.mintingPoolHoldingsRequiredBIPS;
            await assetManager.setMintingPoolHoldingsRequiredBIPS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMintingPoolHoldingsRequiredBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setMintingPoolHoldingsRequiredBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setMintingCapAmg if rate limited", async () => {
            const lotSize = settings.lotSizeAMG;
            await assetManager.setMintingCapAmg(toBN(lotSize).addn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMintingCapAmg(toBN(lotSize).addn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setMintingCapAmg(toBN(lotSize).addn(2), { from: assetManagerController });
        });

        it("should not setTokenInvalidationTimeMinSeconds if rate limited", async () => {
            const oldValue = settings.tokenInvalidationTimeMinSeconds;
            await assetManager.setTokenInvalidationTimeMinSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setTokenInvalidationTimeMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setTokenInvalidationTimeMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setVaultCollateralBuyForFlareFactorBIPS if rate limited", async () => {
            const oldValue = settings.vaultCollateralBuyForFlareFactorBIPS;
            await assetManager.setVaultCollateralBuyForFlareFactorBIPS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setVaultCollateralBuyForFlareFactorBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setVaultCollateralBuyForFlareFactorBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAgentExitAvailableTimelockSeconds if rate limited", async () => {
            const oldValue = settings.agentExitAvailableTimelockSeconds;
            await assetManager.setAgentExitAvailableTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentExitAvailableTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAgentExitAvailableTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAgentMintingCRChangeTimelockSeconds if rate limited", async () => {
            const oldValue = settings.agentMintingCRChangeTimelockSeconds;
            await assetManager.setAgentMintingCRChangeTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentMintingCRChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAgentMintingCRChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setPoolExitAndTopupChangeTimelockSeconds if rate limited", async () => {
            const oldValue = settings.poolExitAndTopupChangeTimelockSeconds;
            await assetManager.setPoolExitAndTopupChangeTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setPoolExitAndTopupChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setPoolExitAndTopupChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAgentTimelockedOperationWindowSeconds if rate limited", async () => {
            const oldValue = settings.agentTimelockedOperationWindowSeconds;
            await assetManager.setAgentTimelockedOperationWindowSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentTimelockedOperationWindowSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setAgentTimelockedOperationWindowSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setCollateralPoolTokenTimelockSeconds if rate limited", async () => {
            const oldValue = settings.collateralPoolTokenTimelockSeconds;
            await assetManager.setCollateralPoolTokenTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralPoolTokenTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCollateralPoolTokenTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setLiquidationStepSeconds if rate limited", async () => {
            const oldValue = settings.liquidationStepSeconds;
            await assetManager.setLiquidationStepSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setLiquidationStepSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setLiquidationStepSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setLiquidationPaymentFactors if rate limited", async () => {
            await assetManager.setLiquidationPaymentFactors([20000], [1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setLiquidationPaymentFactors([30000], [2], { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setLiquidationPaymentFactors([30000], [2], { from: assetManagerController });
        });

        it("should not setMaxEmergencyPauseDurationSeconds if rate limited", async () => {
            const oldValue = settings.maxEmergencyPauseDurationSeconds;
            await assetManager.setMaxEmergencyPauseDurationSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMaxEmergencyPauseDurationSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setMaxEmergencyPauseDurationSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setEmergencyPauseDurationResetAfterSeconds if rate limited", async () => {
            const oldValue = settings.emergencyPauseDurationResetAfterSeconds;
            await assetManager.setEmergencyPauseDurationResetAfterSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setEmergencyPauseDurationResetAfterSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setEmergencyPauseDurationResetAfterSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setCancelCollateralReservationAfterSeconds if rate limited", async () => {
            const oldValue = settings.cancelCollateralReservationAfterSeconds;
            await assetManager.setCancelCollateralReservationAfterSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCancelCollateralReservationAfterSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setCancelCollateralReservationAfterSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setRejectOrCancelCollateralReservationReturnFactorBIPS if rate limited", async () => {
            const oldValue = settings.rejectOrCancelCollateralReservationReturnFactorBIPS;
            await assetManager.setRejectOrCancelCollateralReservationReturnFactorBIPS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setRejectOrCancelCollateralReservationReturnFactorBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setRejectOrCancelCollateralReservationReturnFactorBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setRejectRedemptionRequestWindowSeconds if rate limited", async () => {
            const oldValue = settings.rejectRedemptionRequestWindowSeconds;
            await assetManager.setRejectRedemptionRequestWindowSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setRejectRedemptionRequestWindowSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setRejectRedemptionRequestWindowSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setTakeOverRedemptionRequestWindowSeconds if rate limited", async () => {
            const oldValue = settings.takeOverRedemptionRequestWindowSeconds;
            await assetManager.setTakeOverRedemptionRequestWindowSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setTakeOverRedemptionRequestWindowSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setTakeOverRedemptionRequestWindowSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setRejectedRedemptionDefaultFactorBips if rate limited", async () => {
            const oldValueVault = settings.rejectedRedemptionDefaultFactorVaultCollateralBIPS;
            const oldValuePool = settings.rejectedRedemptionDefaultFactorPoolBIPS;
            await assetManager.setRejectedRedemptionDefaultFactorBips(toBN(oldValueVault).subn(1), toBN(oldValuePool).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setRejectedRedemptionDefaultFactorBips(toBN(oldValueVault).subn(2), toBN(oldValuePool).subn(2), { from: assetManagerController });
            await expectRevert(promise, "too close to previous update");
            await deterministicTimeIncrease(1);
            await assetManager.setRejectedRedemptionDefaultFactorBips(toBN(oldValueVault).subn(2), toBN(oldValuePool).subn(2), { from: assetManagerController });
        });

        it("should not set transfer fee millionths - only asset manager controller", async () => {
            const transferFeeMillionths = await assetManager.transferFeeMillionths();
            let transferFeeMillionths_new = transferFeeMillionths.muln(2);
            const ts = await latestBlockTimestamp();
            let promise = assetManager.setTransferFeeMillionths(transferFeeMillionths_new, ts + 3600);
            await expectRevert(promise, "only asset manager controller");
        });

        it("should not set transfer fee millionths - millionths value too high", async () => {
            const ts = await latestBlockTimestamp();
            let promise = assetManager.setTransferFeeMillionths(1e6, ts + 3600, { from: assetManagerController });
            await expectRevert(promise, "millionths value too high");
        });

        it("should not set transfer fee millionths - increase too big", async () => {
            const ts = await latestBlockTimestamp();
            await assetManager.setTransferFeeMillionths(10, ts + 1, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime));
            const transferFeeMillionths = await assetManager.transferFeeMillionths();
            let transferFeeMillionths_new = transferFeeMillionths.muln(5).addn(1000);
            const promise = assetManager.setTransferFeeMillionths(transferFeeMillionths_new, ts + 3600, { from: assetManagerController });
            await expectRevert(promise, "increase too big");
        });

        it("should not set transfer fee millionths - decrease too big", async () => {
            const ts = await latestBlockTimestamp();
            await assetManager.setTransferFeeMillionths(10, ts + 1, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await deterministicTimeIncrease(toBN(minUpdateTime));
            const promise = assetManager.setTransferFeeMillionths(0, ts + 3600, { from: assetManagerController });
            await expectRevert(promise, "decrease too big");
        });
    });

    describe("reading system properties", () => {

        describe("reading settings", () => {
            it("should read price reader", async () => {
                const priceReader = await assetManager.priceReader();
                expect(priceReader).to.not.be.equal(ZERO_ADDRESS);
                expect(priceReader).to.equal(settings.priceReader);
            });

            it("should read AMG UBA", async () => {
                const amgUba = await assetManager.assetMintingGranularityUBA();
                expect(amgUba.toString()).to.not.equal("0");
                expect(amgUba.toString()).to.equal(settings.assetMintingGranularityUBA.toString());
            });

            it("should read asset minting decimals", async () => {
                const assetMintingDecimals = await assetManager.assetMintingDecimals();
                expect(assetMintingDecimals.toString()).to.not.equal("0");
                expect(assetMintingDecimals.toString()).to.equal(settings.assetMintingDecimals.toString());
            })
        })

        describe("reading agent info", () => {
            it("should read agent's vault collateral token", async () => {
                const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
                const collateralToken = await assetManager.getAgentVaultCollateralToken(agentVault.address)
                expect(collateralToken).to.equal(usdc.address);
            });

            it("should read agent's full vault and pool collaterals", async () => {
                const vaultCollateralDeposit = toWei(3e8);
                const poolCollateralDeposit = toWei(3e10);
                await usdc.mintAmount(agentOwner1, vaultCollateralDeposit);
                await usdc.approve(assetManager.address, vaultCollateralDeposit, { from: agentOwner1 });
                const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1, vaultCollateralDeposit, poolCollateralDeposit);
                const fullVaultCollateral = await assetManager.getAgentFullVaultCollateral(agentVault.address);
                expect(fullVaultCollateral.toString()).to.equal(vaultCollateralDeposit.toString());
                const fullPoolCollateral = await assetManager.getAgentFullPoolCollateral(agentVault.address);
                expect(fullPoolCollateral.toString()).to.equal(poolCollateralDeposit.toString());
            });

            it("should get agent's liquidation params", async () => {
                const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
                const {
                    0: liquidationPaymentFactorVaultBIPS,
                    1: liquidationPaymentFactorPoolBIPS,
                    2: maxLiquidationAmountUBA
                } = await assetManager.getAgentLiquidationFactorsAndMaxAmount(agentVault.address);
                expect(liquidationPaymentFactorVaultBIPS.toString()).to.equal("0");
                expect(liquidationPaymentFactorPoolBIPS.toString()).to.equal("0");
                expect(maxLiquidationAmountUBA.toString()).to.equal("0");
            });

            it("should get agent's minimum collateral ratios", async () => {
                const agentVault = await createAvailableAgentWithEOA(agentOwner1, underlyingAgent1);
                const info = await assetManager.getAgentInfo(agentVault.address);
                const minVaultCR = await assetManager.getAgentMinVaultCollateralRatioBIPS(agentVault.address);
                const vaultToken = collaterals.filter(x => x.token === info.vaultCollateralToken)[0];
                expect(minVaultCR.toString()).to.equal(vaultToken.minCollateralRatioBIPS.toString());
                const minPoolCR = await assetManager.getAgentMinPoolCollateralRatioBIPS(agentVault.address);
                const poolToken = collaterals.filter(x => x.token === wNat.address)[0];
                expect(minPoolCR.toString()).to.equal(poolToken.minCollateralRatioBIPS.toString());
            });
        })

        describe("emergency pause", () => {
            async function triggerPauseAndCheck(byGovernance: boolean, duration: number, opts: { expectedEnd?: BN, expectedDuration?: number } = {}) {
                const response = await assetManager.emergencyPause(byGovernance, duration, { from: assetManagerController });
                const pauseTime = await time.latest();
                const expectedPauseEnd = opts.expectedEnd ?? pauseTime.addn(opts.expectedDuration ?? duration);
                const allowedError = opts.expectedEnd ? 5 : 0; // allow 5s error if clock jumps between two commands
                const event = findRequiredEvent(response, "EmergencyPauseTriggered");
                assertApproximatelyEqual(event.args.pausedUntil, expectedPauseEnd, "absolute", allowedError);
                // check simple
                assert.isTrue(await assetManager.emergencyPaused());
                assertWeb3Equal(await assetManager.emergencyPausedUntil(), event.args.pausedUntil);
                return [pauseTime, toBN(event.args.pausedUntil)];
            }

            it("only asset manager controller can pause", async () => {
                await expectRevert(assetManager.emergencyPause(false, 100), "only asset manager controller");
            });

            it("pause details should work", async () => {
                // pause by 12 hours first
                const [time1, expectedEnd1] = await triggerPauseAndCheck(false, 12 * HOURS);
                // check details
                const { 0: emergencyPausedUntil1, 1: emergencyPausedTotalDuration1, 2: emergencyPausedByGovernance1 } = await assetManager.emergencyPauseDetails();
                assertWeb3Equal(emergencyPausedUntil1, expectedEnd1);
                assert.equal(Number(emergencyPausedTotalDuration1), 12 * HOURS);
                assert.isFalse(emergencyPausedByGovernance1);
                // pause by 8 hours by governance
                const [time2, expectedEnd2] = await triggerPauseAndCheck(true, 20 * HOURS);
                // check details
                const { 0: emergencyPausedUntil2, 1: emergencyPausedTotalDuration2, 2: emergencyPausedByGovernance2 } = await assetManager.emergencyPauseDetails();
                assertWeb3Equal(emergencyPausedUntil2, expectedEnd2);
                assert.equal(Number(emergencyPausedTotalDuration2), 12 * HOURS);    // total used duration not affected by governance calls
                assert.isTrue(emergencyPausedByGovernance2);
            });

            it("pausing with 0 time unpauses", async () => {
                // pause by 12 hours first
                const [time1, expectedEnd1] = await triggerPauseAndCheck(false, 12 * HOURS);
                // after 1 hour pause should still be on
                await deterministicTimeIncrease(1 * HOURS);
                assert.isTrue(await assetManager.emergencyPaused());
                assertWeb3Equal(await assetManager.emergencyPausedUntil(), expectedEnd1);
                // unpause
                await assetManager.emergencyPause(false, 0, { from: assetManagerController });
                assert.isFalse(await assetManager.emergencyPaused());
                assertWeb3Equal(await assetManager.emergencyPausedUntil(), 0);
                // now there should be approx. 1 hours spent
                const { 1: emergencyPausedTotalDuration2 } = await assetManager.emergencyPauseDetails();
                assert.approximately(Number(emergencyPausedTotalDuration2), 1 * HOURS, 10);
            });

            it("total emergency pauses by 3rd party are limited", async () => {
                // pause by 12 hours first
                const [time1] = await triggerPauseAndCheck(false, 12 * HOURS);
                // after 1 hour, extend by 15 hours
                await time.increaseTo(time1.addn(1 * HOURS - 1));
                await triggerPauseAndCheck(false, 15 * HOURS, { expectedEnd: time1.addn(16 * HOURS) });
                // after 10 more hours pause should still be on
                await deterministicTimeIncrease(10 * HOURS);
                assert.isTrue(await assetManager.emergencyPaused());
                // after 5 more hours, the pause should have ended
                await deterministicTimeIncrease(5 * HOURS);
                assert.isFalse(await assetManager.emergencyPaused());
                // creating new pause for 12 hours, should only give us 8 hours now (total is 24)
                await triggerPauseAndCheck(false, 12 * HOURS, { expectedDuration: 8 * HOURS });
                // after 12 more hours, the pause should have ended
                await deterministicTimeIncrease(12 * HOURS);
                assert.isFalse(await assetManager.emergencyPaused());
                // all the time is used up, calling pause again has no effect
                const res4 = await assetManager.emergencyPause(false, 12 * HOURS, { from: assetManagerController });
                expectEvent.notEmitted(res4, "EmergencyPauseTriggered");
                assert.isFalse(await assetManager.emergencyPaused());
                assertWeb3Equal(await assetManager.emergencyPausedUntil(), 0);
                // after 1 week, the pause time accounting is reset
                await deterministicTimeIncrease(1 * WEEKS);
                // now the full pause time can be triggered again
                await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
            });

            it("governance can pause anytime and for unlimited time", async () => {
                // use up all pause time
                await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
                // after 24 hours, the pause should have ended
                await deterministicTimeIncrease(24 * HOURS);
                assert.isFalse(await assetManager.emergencyPaused());
                // all the time is used up, calling pause again has no effect
                const res2 = await assetManager.emergencyPause(false, 12 * HOURS, { from: assetManagerController });
                expectEvent.notEmitted(res2, "EmergencyPauseTriggered");
                assert.isFalse(await assetManager.emergencyPaused());
                assertWeb3Equal(await assetManager.emergencyPausedUntil(), 0);
                // but governance can still pause and for more than 24 hours
                await triggerPauseAndCheck(true, 48 * HOURS, { expectedDuration: 48 * HOURS });
                // after 40 more hours pause should still be on
                await deterministicTimeIncrease(40 * HOURS);
                assert.isTrue(await assetManager.emergencyPaused());
                // after 8 more hours, the pause should have ended
                await deterministicTimeIncrease(8 * HOURS);
                assert.isFalse(await assetManager.emergencyPaused());
            });

            it("governance can reset pause time", async () => {
                // use up all pause time
                await triggerPauseAndCheck(false, 24 * HOURS, { expectedDuration: 24 * HOURS });
                // after 24 hours, the pause should have ended
                await deterministicTimeIncrease(24 * HOURS);
                assert.isFalse(await assetManager.emergencyPaused());
                // reset
                await assetManager.resetEmergencyPauseTotalDuration({ from: assetManagerController });
                // now we can use all time again
                await triggerPauseAndCheck(true, 24 * HOURS, { expectedDuration: 24 * HOURS });
            });

            it("should not reset pause time if not from asset manager controller", async () => {
                // use up all pause time
                await triggerPauseAndCheck(false, 24 * HOURS, { expectedDuration: 24 * HOURS });
                // after 24 hours, the pause should have ended
                await deterministicTimeIncrease(24 * HOURS);
                assert.isFalse(await assetManager.emergencyPaused());
                // reset
                const promise = assetManager.resetEmergencyPauseTotalDuration();
                await expectRevert(promise, "only asset manager controller");
            });

            it("others cannot pause/unpause when governance pause is active", async () => {
                // governance pause
                const [time1, expectedEnd1] = await triggerPauseAndCheck(true, 4 * HOURS, { expectedDuration: 4 * HOURS });
                // wait a bit, pause still active
                await deterministicTimeIncrease(2 * HOURS);
                assert.isTrue(await assetManager.emergencyPaused());
                // try to unpause
                await expectRevert(assetManager.emergencyPause(false, 0, { from: assetManagerController }), "paused by governance");
                // try to increase pause
                await expectRevert(assetManager.emergencyPause(false, 12 * HOURS, { from: assetManagerController }), "paused by governance");
                // still the same pause
                assert.isTrue(await assetManager.emergencyPaused());
                assertWeb3Equal(await assetManager.emergencyPausedUntil(), expectedEnd1);
                // governance can unpause
                await assetManager.emergencyPause(true, 0, { from: assetManagerController });
                assert.isFalse(await assetManager.emergencyPaused());
                assertWeb3Equal(await assetManager.emergencyPausedUntil(), 0);
            });
        });

        describe("emergency pause transfers", () => {
            async function triggerPauseAndCheck(byGovernance: boolean, duration: number, opts: { expectedEnd?: BN, expectedDuration?: number } = {}) {
                const response = await assetManager.emergencyPauseTransfers(byGovernance, duration, { from: assetManagerController });
                const pauseTime = await time.latest();
                const expectedPauseEnd = opts.expectedEnd ?? pauseTime.addn(opts.expectedDuration ?? duration);
                const allowedError = opts.expectedEnd ? 5 : 0; // allow 5s error if clock jumps between two commands
                const event = findRequiredEvent(response, "EmergencyPauseTransfersTriggered");
                assertApproximatelyEqual(event.args.pausedUntil, expectedPauseEnd, "absolute", allowedError);
                // check simple
                assert.isTrue(await assetManager.transfersEmergencyPaused());
                assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), event.args.pausedUntil);
                return [pauseTime, toBN(event.args.pausedUntil)];
            }

            it("only asset manager controller can pause", async () => {
                await expectRevert(assetManager.emergencyPauseTransfers(false, 100), "only asset manager controller");
            });

            it("pause details should work", async () => {
                // pause by 12 hours first
                const [time1, expectedEnd1] = await triggerPauseAndCheck(false, 12 * HOURS);
                // check details
                const { 0: transfersEmergencyPausedUntil1, 1: transfersEmergencyPausedTotalDuration1, 2: transfersEmergencyPausedByGovernance1 } = await assetManager.emergencyPauseTransfersDetails();
                assertWeb3Equal(transfersEmergencyPausedUntil1, expectedEnd1);
                assert.equal(Number(transfersEmergencyPausedTotalDuration1), 12 * HOURS);
                assert.isFalse(transfersEmergencyPausedByGovernance1);
                // pause by 8 hours by governance
                const [time2, expectedEnd2] = await triggerPauseAndCheck(true, 20 * HOURS);
                // check details
                const { 0: transfersEmergencyPausedUntil2, 1: transfersEmergencyPausedTotalDuration2, 2: transfersEmergencyPausedByGovernance2 } = await assetManager.emergencyPauseTransfersDetails();
                assertWeb3Equal(transfersEmergencyPausedUntil2, expectedEnd2);
                assert.equal(Number(transfersEmergencyPausedTotalDuration2), 12 * HOURS);    // total used duration not affected by governance calls
                assert.isTrue(transfersEmergencyPausedByGovernance2);
            });

            it("pausing with 0 time unpauses", async () => {
                // pause by 12 hours first
                const [time1, expectedEnd1] = await triggerPauseAndCheck(false, 12 * HOURS);
                // after 1 hour pause should still be on
                await deterministicTimeIncrease(1 * HOURS);
                assert.isTrue(await assetManager.transfersEmergencyPaused());
                assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), expectedEnd1);
                // unpause
                await assetManager.emergencyPauseTransfers(false, 0, { from: assetManagerController });
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), 0);
                // now there should be approx. 1 hours spent
                const { 1: transfersEmergencyPausedTotalDuration2 } = await assetManager.emergencyPauseTransfersDetails();
                assert.approximately(Number(transfersEmergencyPausedTotalDuration2), 1 * HOURS, 10);
            });

            it("total emergency pauses by 3rd party are limited", async () => {
                // pause by 12 hours first
                const [time1] = await triggerPauseAndCheck(false, 12 * HOURS);
                // after 1 hour, extend by 15 hours
                await time.increaseTo(time1.addn(1 * HOURS - 1));
                await triggerPauseAndCheck(false, 15 * HOURS, { expectedEnd: time1.addn(16 * HOURS) });
                // after 10 more hours pause should still be on
                await deterministicTimeIncrease(10 * HOURS);
                assert.isTrue(await assetManager.transfersEmergencyPaused());
                // after 5 more hours, the pause should have ended
                await deterministicTimeIncrease(5 * HOURS);
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                // creating new pause for 12 hours, should only give us 8 hours now (total is 24)
                await triggerPauseAndCheck(false, 12 * HOURS, { expectedDuration: 8 * HOURS });
                // after 12 more hours, the pause should have ended
                await deterministicTimeIncrease(12 * HOURS);
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                // all the time is used up, calling pause again has no effect
                const res4 = await assetManager.emergencyPauseTransfers(false, 12 * HOURS, { from: assetManagerController });
                expectEvent.notEmitted(res4, "EmergencyPauseTransfersTriggered");
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), 0);
                // after 1 week, the pause time accounting is reset
                await deterministicTimeIncrease(1 * WEEKS);
                // now the full pause time can be triggered again
                await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
            });

            it("governance can pause anytime and for unlimited time", async () => {
                // use up all pause time
                await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
                // after 24 hours, the pause should have ended
                await deterministicTimeIncrease(24 * HOURS);
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                // all the time is used up, calling pause again has no effect
                const res2 = await assetManager.emergencyPauseTransfers(false, 12 * HOURS, { from: assetManagerController });
                expectEvent.notEmitted(res2, "EmergencyPauseTransfersTriggered");
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), 0);
                // but governance can still pause and for more than 24 hours
                await triggerPauseAndCheck(true, 48 * HOURS, { expectedDuration: 48 * HOURS });
                // after 40 more hours pause should still be on
                await deterministicTimeIncrease(40 * HOURS);
                assert.isTrue(await assetManager.transfersEmergencyPaused());
                // after 8 more hours, the pause should have ended
                await deterministicTimeIncrease(8 * HOURS);
                assert.isFalse(await assetManager.transfersEmergencyPaused());
            });

            it("governance can reset pause time", async () => {
                // use up all pause time
                await triggerPauseAndCheck(false, 24 * HOURS, { expectedDuration: 24 * HOURS });
                // after 24 hours, the pause should have ended
                await deterministicTimeIncrease(24 * HOURS);
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                // reset
                await assetManager.resetEmergencyPauseTotalDuration({ from: assetManagerController });
                // now we can use all time again
                await triggerPauseAndCheck(true, 24 * HOURS, { expectedDuration: 24 * HOURS });
            });

            it("should not reset pause time if not from asset manager controller", async () => {
                // use up all pause time
                await triggerPauseAndCheck(false, 24 * HOURS, { expectedDuration: 24 * HOURS });
                // after 24 hours, the pause should have ended
                await deterministicTimeIncrease(24 * HOURS);
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                // reset
                const promise = assetManager.resetEmergencyPauseTotalDuration();
                await expectRevert(promise, "only asset manager controller");
            });

            it("others cannot pause/unpause when governance pause is active", async () => {
                // governance pause
                const [time1, expectedEnd1] = await triggerPauseAndCheck(true, 4 * HOURS, { expectedDuration: 4 * HOURS });
                // wait a bit, pause still active
                await deterministicTimeIncrease(2 * HOURS);
                assert.isTrue(await assetManager.transfersEmergencyPaused());
                // try to unpause
                await expectRevert(assetManager.emergencyPauseTransfers(false, 0, { from: assetManagerController }), "paused by governance");
                // try to increase pause
                await expectRevert(assetManager.emergencyPauseTransfers(false, 12 * HOURS, { from: assetManagerController }), "paused by governance");
                // still the same pause
                assert.isTrue(await assetManager.transfersEmergencyPaused());
                assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), expectedEnd1);
                // governance can unpause
                await assetManager.emergencyPauseTransfers(true, 0, { from: assetManagerController });
                assert.isFalse(await assetManager.transfersEmergencyPaused());
                assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), 0);
            });
        });
    });
});
