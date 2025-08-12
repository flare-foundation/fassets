import { AgentStatus, AssetManagerSettings, CollateralClass, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { assertApproximatelyEqual } from "../../../../lib/test-utils/approximation";
import { GENESIS_GOVERNANCE_ADDRESS } from "../../../../lib/test-utils/constants";
import { calcGasCost } from "../../../../lib/test-utils/eth";
import { AssetManagerInitSettings, deployAssetManagerFacets, newAssetManager, newAssetManagerDiamond } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectEvent, expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createAgentOwnerRegistry, createTestAgentSettings, createTestCollaterals, createTestContracts, createTestSettings, whitelistAgentOwner } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3DeepEqual, assertWeb3Equal, web3ResultStruct } from "../../../../lib/test-utils/web3assertions";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { deepCopy } from "../../../../lib/utils/deepCopy";
import { DiamondCut } from "../../../../lib/utils/diamond";
import { findRequiredEvent, requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BN_ZERO, BNish, DAYS, HOURS, MAX_BIPS, WEEKS, ZERO_ADDRESS, abiEncodeCall, contractMetadata, erc165InterfaceId, toBIPS, toBN, toBNExp, toWei } from "../../../../lib/utils/helpers";
import { web3DeepNormalize } from "../../../../lib/utils/web3normalize";
import { AgentVaultInstance, AssetManagerInitInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";

const FAsset = artifacts.require('FAsset');
const FAssetProxy = artifacts.require('FAssetProxy');
const GovernanceSettings = artifacts.require('GovernanceSettingsMock');
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

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager basic tests`, accounts => {
    const governance = accounts[10];
    const assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManagerInit: AssetManagerInitInstance;
    let diamondCuts: DiamondCut[];
    let assetManager: IIAssetManagerInstance;
    let fAsset: FAssetInstance;
    let wNat: WNatMockInstance;
    let usdc: ERC20MockInstance;
    let settings: AssetManagerInitSettings;
    let collaterals: CollateralType[];
    let chain: MockChain;
    let wallet: MockChainWallet;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;
    let usdt: ERC20MockInstance;

    let assetSymbol: string;
    const natSymbol = "NAT";
    const usdcSymbol = "USDC";
    const usdtSymbol = "USDT";

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
    async function ubaToTokenWei(uba: BN, tokenSymbol: string) {
        const { 0: assetPrice, 2: decimals } = await contracts.priceReader.getPrice(tokenSymbol);
        return uba.mul(assetPrice).div(toBN(10**decimals.toNumber()));
    }
    async function ubaToC1Wei(uba: BN) {
        const { 0: assetPrice } = await contracts.priceReader.getPrice(assetSymbol);
        const { 0: usdcPrice } = await contracts.priceReader.getPrice(usdcSymbol);
        return uba.mul(assetPrice).div(usdcPrice);
    }
    async function ubaToPoolWei(uba: BN) {
        const { 0: assetPriceMul, 1: assetPriceDiv } = await assetManager.assetPriceNatWei();
        return uba.mul(assetPriceMul).div(assetPriceDiv);
    }
    async function usd5ToVaultCollateralWei(usd5: BN) {
        const { 0: usdcPrice, 2: usdcDecimals } = await contracts.priceReader.getPrice(usdcSymbol);
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

    async function createAgentVault(owner: string, underlyingAddress: string): Promise<AgentVaultInstance> {
        // update current block in asset manager
        const blockHeightProof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        await assetManager.updateCurrentBlock(blockHeightProof);
        await whitelistAgentOwner(settings.agentOwnerRegistry, owner);
        const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAddress);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const agentSettings = createTestAgentSettings(usdc.address);
        const response = await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: owner });
        return AgentVault.at(findRequiredEvent(response, 'AgentVaultCreated').args.agentVault);
    }

    //For creating agent where vault collateral and pool wnat tokens are the same
    async function depositAgentCollateralsNAT(
        agentVault: AgentVaultInstance, owner: string,
        depositVaultCollateral: BN = toWei(3e8), depositPool: BN = toWei(3e8)
    ) {
        await wNat.deposit({ from: owner, value: depositVaultCollateral })
        await wNat.approve(agentVault.address, depositVaultCollateral, { from: owner });
        await agentVault.depositCollateral(wNat.address, depositVaultCollateral, { from: owner });
        await agentVault.buyCollateralPoolTokens({ from: owner, value: depositPool });
    }

    //For creating agent where vault collateral and pool wnat are the same
    async function createAgentVaultNatVaultCollateral(owner: string, underlyingAddress: string): Promise<AgentVaultInstance> {
        // update current block in asset manager
        const blockHeightProof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        await assetManager.updateCurrentBlock(blockHeightProof);
        await whitelistAgentOwner(settings.agentOwnerRegistry, owner);
        const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAddress);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const agentSettings = createTestAgentSettings(collaterals[0].token);
        const response = await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: owner });
        return AgentVault.at(findRequiredEvent(response, 'AgentVaultCreated').args.agentVault);
    }

    //For creating agent where vault collateral and pool wnat are the same
    async function createAvailableAgentNAT(
        owner: string, underlyingAddress: string,
        depositVaultCollateral: BN = toWei(3e8), depositPool: BN = toWei(3e8)
    ): Promise<AgentVaultInstance> {
        const agentVault = await createAgentVaultNatVaultCollateral(owner, underlyingAddress);
        await depositAgentCollateralsNAT(agentVault, owner, depositVaultCollateral, depositPool);
        await assetManager.makeAgentAvailable(agentVault.address, { from: owner });
        return agentVault;
    }

    async function createAvailableAgent(
        owner: string, underlyingAddress: string,
        depositVaultCollateral: BN = toWei(3e8), depositPool: BN = toWei(3e8)
    ): Promise<AgentVaultInstance> {
        const agentVault = await createAgentVault(owner, underlyingAddress);
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

    // Like newAssetManager in CreateAssetManager.ts but split out all facet creation to speed up the code.
    // Only used for asset manager init validation tests.
    async function newAssetManagerQuick(governanceAddress: string, assetManagerController: string, name: string, symbol: string, decimals: number,
        assetManagerSettings: AssetManagerInitSettings, collateralTokens: CollateralType[], assetName = name, assetSymbol = symbol) {
        const governanceSettings = "0x8000000000000000000000000000000000000000";
        const fAssetImpl = await FAsset.new();
        const fAssetProxy = await FAssetProxy.new(fAssetImpl.address, name, symbol, assetName, assetSymbol, decimals);
        const fAsset = await FAsset.at(fAssetProxy.address);
        assetManagerSettings = web3DeepNormalize({
            ...assetManagerSettings,
            assetManagerController,
            fAsset: fAsset.address
        });
        collateralTokens = web3DeepNormalize(collateralTokens);
        const assetManager = await newAssetManagerDiamond(diamondCuts, assetManagerInit, governanceSettings, governanceAddress, assetManagerSettings, collateralTokens);
        await fAsset.setAssetManager(assetManager.address);
        return [assetManager, fAsset];
    }

    async function initialize() {
        const ci = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        [diamondCuts, assetManagerInit] = await deployAssetManagerFacets();
        // save some contracts as globals
        ({ wNat } = contracts);
        usdc = contracts.stablecoins.USDC;
        usdt = contracts.stablecoins.USDT;
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        assetSymbol = ci.symbol;
        return { contracts, diamondCuts, assetManagerInit, wNat, usdc, assetSymbol, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, usdt };
    }

    beforeEach(async () => {
        ({ contracts, diamondCuts, assetManagerInit, wNat, usdc, assetSymbol, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, usdt } = await loadFixtureCopyVars(initialize));
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
            // add CoreVaultClient settings
            resInitSettings.coreVaultNativeAddress = await assetManager.getCoreVaultNativeAddress();
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
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await expectRevert.custom(assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: accounts[80] }),
                "OnlyAgentVaultOwner", []);
        });

        it("should fail at changing announced agent settings from non-agent-owner account", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: agentOwner1 });
            await time.deterministicIncrease(agentFeeChangeTimelock);
            await expectRevert.custom(assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: accounts[80] }),
                "OnlyAgentVaultOwner", []);
        });

        it("should correctly update agent settings fee BIPS", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            //Invalid setting name will be reverted
            let res = assetManager.announceAgentSettingUpdate(agentVault.address, "something", 2000, { from: agentOwner1 });
            await expectRevert.custom(res, "InvalidSettingName", []);
            //Can't execute update if it is not announced
            res = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert.custom(res, "NoPendingUpdate", []);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: agentOwner1 });
            //Can't execute update if called to early after announcement
            res = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert.custom(res, "UpdateNotValidYet", []);
            await time.deterministicIncrease(agentFeeChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.feeBIPS.toString(), "2000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "feeBIPS"), agentInfo.feeBIPS);
        });

        it("should fail if the agent setting is executed too early or too late", async () => {
            const settings = await assetManager.getSettings();
            const agentFeeChangeTimelock = settings.agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            // announce
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 2000, { from: agentOwner1 });
            // can't execute update if called to early after announcement
            const res1 = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert.custom(res1, "UpdateNotValidYet", []);
            await time.deterministicIncrease(agentFeeChangeTimelock);
            await time.deterministicIncrease(1 * DAYS);  // too late
            const res2 = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert.custom(res2, "UpdateNotValidAnymore", []);
        });

        it("should not update agent settings fee BIPS if value too high", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "feeBIPS", 200000000, { from: agentOwner1 });
            await time.deterministicIncrease(agentFeeChangeTimelock);
            const res = assetManager.executeAgentSettingUpdate(agentVault.address, "feeBIPS", { from: agentOwner1 });
            await expectRevert.custom(res, "FeeTooHigh", []);
        });

        it("should correctly update agent setting pool fee share BIPS", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", 2000, { from: agentOwner1 });
            await time.deterministicIncrease(agentFeeChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolFeeShareBIPS.toString(), "2000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolFeeShareBIPS"), agentInfo.poolFeeShareBIPS);
        });

        it("should not update agent setting pool fee share BIPS if value too high", async () => {
            const agentFeeChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", 20000000, { from: agentOwner1 });
            await time.deterministicIncrease(agentFeeChangeTimelock);
            const res = assetManager.executeAgentSettingUpdate(agentVault.address, "poolFeeShareBIPS", { from: agentOwner1 });
            await expectRevert.custom(res, "ValueTooHigh", []);
        });

        it("should correctly update agent setting minting VaultCollateral collateral ratio BIPS", async () => {
            const agentCollateralRatioChangeTimelock = (await assetManager.getSettings()).agentMintingCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "mintingVaultCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await time.deterministicIncrease(agentCollateralRatioChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "mintingVaultCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.mintingVaultCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "mintingVaultCollateralRatioBIPS"), agentInfo.mintingVaultCollateralRatioBIPS);
        });

        it("should correctly update agent setting minting pool collateral ratio BIPS", async () => {
            const agentCollateralRatioChangeTimelock = (await assetManager.getSettings()).agentMintingCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await time.deterministicIncrease(agentCollateralRatioChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.mintingPoolCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "mintingPoolCollateralRatioBIPS"), agentInfo.mintingPoolCollateralRatioBIPS);
        });

        it("should not update agent setting minting pool collateral ratio BIPS if value too small", async () => {
            const agentCollateralRatioChangeTimelock = (await assetManager.getSettings()).agentMintingCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", 10, { from: agentOwner1 });
            await time.deterministicIncrease(agentCollateralRatioChangeTimelock);
            const res = assetManager.executeAgentSettingUpdate(agentVault.address, "mintingPoolCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert.custom(res, "CollateralRatioTooSmall", []);
        });

        it("should correctly update agent setting buy fasset by agent factor BIPS", async () => {
            const agentBuyFactorChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", 9300, { from: agentOwner1 });
            await time.deterministicIncrease(agentBuyFactorChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.buyFAssetByAgentFactorBIPS.toString(), "9300");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "buyFAssetByAgentFactorBIPS"), agentInfo.buyFAssetByAgentFactorBIPS);
        });

        it("should not update agent setting buy fasset by agent factor BIPS if value is too low or too high", async () => {
            const agentBuyFactorChangeTimelock = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", 10100, { from: agentOwner1 });
            await time.deterministicIncrease(agentBuyFactorChangeTimelock);
            await expectRevert.custom(assetManager.executeAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", { from: agentOwner1 }), "ValueTooHigh", []);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", 8000, { from: agentOwner1 });
            await time.deterministicIncrease(agentBuyFactorChangeTimelock);
            await expectRevert.custom(assetManager.executeAgentSettingUpdate(agentVault.address, "buyFAssetByAgentFactorBIPS", { from: agentOwner1 }), "ValueTooLow", []);
        });

        it("should correctly update agent setting pool exit collateral ratio BIPS", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await time.deterministicIncrease(agentPoolExitCRChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolExitCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolExitCollateralRatioBIPS"), agentInfo.poolExitCollateralRatioBIPS);
        });

        it("should not update agent setting pool exit collateral ratio BIPS if value too low", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", 2, { from: agentOwner1 });
            await time.deterministicIncrease(agentPoolExitCRChangeTimelock);
            const res = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert.custom(res, "ValueTooLow", [])
        });

        it("should not update agent setting pool exit collateral ratio BIPS if increase too big", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const newExitCR = toBN(agentInfo.poolExitCollateralRatioBIPS).muln(2);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newExitCR, { from: agentOwner1 });
            await time.deterministicIncrease(agentPoolExitCRChangeTimelock);
            const res = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert.custom(res, "IncreaseTooBig", [])
        });

        it("should always be able to update exitCR to 1.2 minCR (even if minCR grows so fast that the increase is higher that 3/2)", async () => {
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const ct = await assetManager.getCollateralType(CollateralClass.POOL, wNat.address);
            const newMinCR = toBN(ct.minCollateralRatioBIPS).muln(2);
            // cannot increase before the minCR grows
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newMinCR.muln(119).divn(100), { from: agentOwner1 });
            await time.deterministicIncrease(agentPoolExitCRChangeTimelock);
            const res1 = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert.custom(res1, "IncreaseTooBig", [])
            //
            await assetManager.setCollateralRatiosForToken(CollateralClass.POOL, wNat.address,
                newMinCR, toBN(ct.safetyMinCollateralRatioBIPS).muln(2),
                { from: assetManagerController });
            // still can't increase too much
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newMinCR.muln(121).divn(100), { from: agentOwner1 });
            await time.deterministicIncrease(agentPoolExitCRChangeTimelock);
            const res2 = assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            await expectRevert.custom(res2, "IncreaseTooBig", [])
            // but can increase up to 1.2 minCR
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newMinCR.muln(119).divn(100), { from: agentOwner1 });
            await time.deterministicIncrease(agentPoolExitCRChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
        });

        it("should not update agent setting pool exit collateral ratio BIPS to more than 3 time minCR", async () => {
            async function changeExitCR(mul: BNish, div: BNish) {
                const agentInfo = await assetManager.getAgentInfo(agentVault.address);
                const newExitCR = toBN(agentInfo.poolExitCollateralRatioBIPS).mul(toBN(mul)).div(toBN(div));
                await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", newExitCR, { from: agentOwner1 });
                await time.deterministicIncrease(agentPoolExitCRChangeTimelock);
                return await assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            }
            const agentPoolExitCRChangeTimelock = (await assetManager.getSettings()).poolExitCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            // the third increase by 3/2 should fail because the value becomes more than 3 * minCR
            await changeExitCR(3, 2);
            await changeExitCR(3, 2);
            await expectRevert.custom(changeExitCR(3, 2), "ValueTooHigh", []);
        });

        it("should correctly update agent setting pool exit collateral ratio BIPS", async () => {
            const agentPoolTopupCRChangeTimelock = (await assetManager.getSettings()).poolExitCRChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", 25000, { from: agentOwner1 });
            await time.deterministicIncrease(agentPoolTopupCRChangeTimelock);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "poolExitCollateralRatioBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(agentInfo.poolExitCollateralRatioBIPS.toString(), "25000");
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "poolExitCollateralRatioBIPS"), agentInfo.poolExitCollateralRatioBIPS);
        });

        it("should correctly update agent setting redemptionPoolFeeShareBIPS", async () => {
            const agentFeeChangeTimelockSeconds = (await assetManager.getSettings()).agentFeeChangeTimelockSeconds;
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "redemptionPoolFeeShareBIPS"), 0);   // always 0 initially
            await assetManager.announceAgentSettingUpdate(agentVault.address, "redemptionPoolFeeShareBIPS", 2000, { from: agentOwner1 });
            await time.deterministicIncrease(agentFeeChangeTimelockSeconds);
            await assetManager.executeAgentSettingUpdate(agentVault.address, "redemptionPoolFeeShareBIPS", { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(await assetManager.getAgentSetting(agentVault.address, "redemptionPoolFeeShareBIPS"), 2000);
        });
    });

    describe("agent vault and pool upgrade", () => {
        it("should upgrade agent vault", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
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
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const collateralPool = await CollateralPool.at(await agentVault.collateralPool());
            const collateralPoolToken = await CollateralPoolToken.at(await collateralPool.poolToken());
            const testProxyImpl = await TestUUPSProxyImpl.new();
            const newCollateralPoolImpl = await CollateralPool.new(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, 0);
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
                const agentVault = await createAgentVault(accounts[20 + i], `underlying_agent_${i}`);
                agentVaults.push(agentVault);
            }
            // create new implementations
            const newAgentVaultImpl = await AgentVault.new(ZERO_ADDRESS);
            const newCollateralPoolTokenImpl = await CollateralPoolToken.new(ZERO_ADDRESS, "", "");
            const newCollateralPoolImpl = await CollateralPool.new(ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS, 0);
            // create new factories
            const agentVaultFactory = await AgentVaultFactory.new(newAgentVaultImpl.address);
            const collateralPoolFactory = await CollateralPoolFactory.new(newCollateralPoolImpl.address);
            const collateralPoolTokenFactory = await CollateralPoolTokenFactory.new(newCollateralPoolTokenImpl.address);
            // upgrade factories
            await assetManager.setAgentVaultFactory(agentVaultFactory.address, { from: assetManagerController });
            await assetManager.setCollateralPoolFactory(collateralPoolFactory.address, { from: assetManagerController });
            await assetManager.setCollateralPoolTokenFactory(collateralPoolTokenFactory.address, { from: assetManagerController });
            // upgrade must be called through controller
            await expectRevert.custom(assetManager.upgradeAgentVaultsAndPools(0, 100), "OnlyAssetManagerController", []);
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
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const testProxyImpl = await TestUUPSProxyImpl.new();
            const agentVaultFactory = await AgentVaultFactory.new(testProxyImpl.address);
            await assetManager.setAgentVaultFactory(agentVaultFactory.address, { from: assetManagerController });
            await expectRevert.custom(assetManager.upgradeAgentVaultAndPool(agentVault.address), "OnlyAgentVaultOwner", []);
        });

        it("vault and pool upgrade cannot be called directly", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const collateralPool = await CollateralPool.at(await agentVault.collateralPool());
            const collateralPoolToken = await CollateralPoolToken.at(await collateralPool.poolToken());
            const testProxyImpl = await TestUUPSProxyImpl.new();
            //
            await expectRevert.custom(agentVault.upgradeTo(testProxyImpl.address), "OnlyAssetManager", []);
            await expectRevert.custom(collateralPool.upgradeTo(testProxyImpl.address), "OnlyAssetManager", []);
            await expectRevert.custom(collateralPoolToken.upgradeTo(testProxyImpl.address), "OnlyAssetManager", []);
        });

        it("can upgrade with initialization", async () => {
            const MockProxyFactory = artifacts.require("MockProxyFactory");
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
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
            const collateral = deepCopy(web3DeepNormalize(collaterals[1]));
            const newToken = await ERC20Mock.new("New Token", "NT");
            collateral.token = newToken.address;
            collateral.tokenFtsoSymbol = "NT";
            await contracts.priceStore.addFeed("0xd51", "NT");
            await contracts.priceStore.setDecimals("NT", 5);
            await contracts.priceStore.setCurrentPrice("NT", "123456", 0);
            await assetManager.addCollateralType(collateral, { from: assetManagerController });
            const resCollaterals = await assetManager.getCollateralTypes();
            assertWeb3DeepEqual(collateral.token, resCollaterals[3].token);
        });

        it("should not add collateral token if ftso does not contain symbol or price is not initialized", async () => {
            const collateral = deepCopy(web3DeepNormalize(collaterals[1]));
            const newToken = await ERC20Mock.new("New Token", "NT");
            collateral.token = newToken.address;
            collateral.directPricePair = false;
            collateral.tokenFtsoSymbol = "NT";
            await expectRevert.custom(assetManager.addCollateralType(collateral, { from: assetManagerController }), "SymbolNotSupported", []);
            await contracts.priceStore.addFeed("0xd51", "NT");
            await contracts.priceStore.setDecimals("NT", 5);
            await expectRevert.custom(assetManager.addCollateralType(collateral, { from: assetManagerController }), "PriceNotInitialized", []);
            await contracts.priceStore.setCurrentPrice("NT", "123456", 0);
            await assetManager.addCollateralType(collateral, { from: assetManagerController });
        });

        it("should not add collateral token if ftso does not contain symbol or price is not initialized (direct price pair)", async () => {
            const collateral = deepCopy(web3DeepNormalize(collaterals[1]));
            const newToken = await ERC20Mock.new("New Token", "NT");
            collateral.token = newToken.address;
            collateral.directPricePair = true;
            collateral.tokenFtsoSymbol = "";
            collateral.assetFtsoSymbol = "AtoNT";
            await expectRevert.custom(assetManager.addCollateralType(collateral, { from: assetManagerController }), "SymbolNotSupported", []);
            await contracts.priceStore.addFeed("0xd51", "AtoNT");
            await contracts.priceStore.setDecimals("AtoNT", 5);
            await expectRevert.custom(assetManager.addCollateralType(collateral, { from: assetManagerController }), "PriceNotInitialized", []);
            await contracts.priceStore.setCurrentPrice("AtoNT", "123456", 0);
            await assetManager.addCollateralType(collateral, { from: assetManagerController });
        });

        it("should set collateral ratios for token", async () => {
            await assetManager.setCollateralRatiosForToken(collaterals[0].collateralClass, collaterals[0].token,
                toBIPS(1.5), toBIPS(1.6), { from: assetManagerController });
            const collateralType = await assetManager.getCollateralType(collaterals[0].collateralClass, collaterals[0].token);
            assertWeb3Equal(collateralType.minCollateralRatioBIPS, toBIPS(1.5));
            assertWeb3Equal(collateralType.safetyMinCollateralRatioBIPS, toBIPS(1.6));
        });

        it("should not set collateral ratios for unknown token", async () => {
            const unknownToken = accounts[12];
            const res = assetManager.setCollateralRatiosForToken(collaterals[0].collateralClass, unknownToken,
                toBIPS(1.5), toBIPS(1.6), { from: assetManagerController });
            await expectRevert.custom(res, "UnknownToken", []);
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
            await time.deterministicIncrease(settings.tokenInvalidationTimeMinSeconds);
            const res = assetManager.deprecateCollateralType(collaterals[0].collateralClass, collaterals[0].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            await expectRevert.custom(res, "TokenNotValid", []);
        });

        it("should switch vault collateral token", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
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

        it("should not switch vault collateral token if unknown token", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            //deprecate token
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[1].collateralClass, collaterals[1].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
            const unknownToken = accounts[12];
            const tx1 = assetManager.switchVaultCollateral(agentVault.address,unknownToken, { from: agentOwner1 });
            await expectRevert.custom(tx1, "UnknownToken", []);
        });

        it("should not be able to add a deprecated collateral token", async () => {
            const ci = testChainInfo.eth;
            // create asset manager
            collaterals = createTestCollaterals(contracts, ci);
            //Set token validUntil timestamp to some time in the past to make it deprecated
            collaterals[1].validUntil = chain.currentTimestamp()-100;
            settings = createTestSettings(contracts, ci);
            //Creating asset manager should revert because we are trying to add a vault collateral that is deprecated
            const res = newAssetManagerQuick(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
            await expectRevert.custom(res, "CannotAddDeprecatedToken", []);
        });

        it("should not switch vault collateral token", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1, toWei(3e6), toWei(3e6));
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(2));
            await contracts.priceStore.setCurrentPrice(assetSymbol, toBNExp(5, 8), 0);
            await contracts.priceStore.setCurrentPriceFromTrustedProviders(usdcSymbol, toBNExp(5, 8), 0);
            //Can't switch vault collateral if it has not been deprecated
            let res = assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: agentOwner1 });
            await expectRevert.custom(res, "CollateralNotDeprecated", []);
            // Only agent owner can switch vault collateral
            res = assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: accounts[5] });
            await expectRevert.custom(res, "OnlyAgentVaultOwner", []);
            //deprecate token
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[1].collateralClass, collaterals[1].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
            //Wait until you can switch vault collateral token
            await time.deterministicIncrease(settings.tokenInvalidationTimeMinSeconds);
            //Deprecated token can't be switched to
            res = assetManager.switchVaultCollateral(agentVault.address,collaterals[1].token, { from: agentOwner1 });
            await expectRevert.custom(res, "CollateralDeprecated", []);
            //Can't switch if CR too low
            res = assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: agentOwner1 });
            await expectRevert.custom(res, "NotEnoughCollateral", []);
        });

        it("should not switch vault collateral token when withdrawal announced", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            await depositAgentCollaterals(agentVault, agentOwner1, toWei(1000), toWei(1000));
            // announce
            await assetManager.announceVaultCollateralWithdrawal(agentVault.address, toWei(1000), { from: agentOwner1 });
            // deprecate collateral
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            // should not work
            await expectRevert.custom(assetManager.switchVaultCollateral(agentVault.address, collaterals[2].token, { from: agentOwner1 }),
                "CollateralWithdrawalAnnounced", []);
            // should work after withdrawal is cleared
            await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 0, { from: agentOwner1 });
            await assetManager.switchVaultCollateral(agentVault.address, collaterals[2].token, { from: agentOwner1 });
        });

        it("If agent doesn't switch vault collateral after deprecation and invalidation time, liquidator can start liquidation", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(1));
            const liquidator = accounts[83];
            //deprecate token
            const tx = await assetManager.deprecateCollateralType(collaterals[1].collateralClass, collaterals[1].token,
                settings.tokenInvalidationTimeMinSeconds, { from: assetManagerController });
            expectEvent(tx, "CollateralTypeDeprecated");
            const collateralType = await assetManager.getCollateralType(collaterals[1].collateralClass, collaterals[1].token);
            assertWeb3Equal(collateralType.validUntil, (await time.latest()).add(toBN(settings.tokenInvalidationTimeMinSeconds)));
            // Should not be able to start liquidation before time passes
            await expectRevert.custom(assetManager.startLiquidation(agentVault.address, { from: liquidator }), "LiquidationNotStarted", []);
            //Wait until you can switch vault collateral token
            await time.deterministicIncrease(settings.tokenInvalidationTimeMinSeconds);
            await time.deterministicIncrease(settings.tokenInvalidationTimeMinSeconds);
            await assetManager.startLiquidation(agentVault.address, { from: liquidator });
            //Check for liquidation status
            const info = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info.status, 1);
            //Deposit new vault collateral
            await usdt.mintAmount(agentOwner1, toWei(3e8));
            await usdt.approve(agentVault.address, toWei(3e8), { from: agentOwner1 });
            await agentVault.depositCollateral(usdt.address, toWei(3e8), { from: agentOwner1 });
            //Before switching, the agent is still in liquidation
            const info1 = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info1.status, 1);
            //Agent switches the collateral
            await assetManager.switchVaultCollateral(agentVault.address,collaterals[2].token, { from: agentOwner1 });
            //Agent still has to call updateCollateral to get out of liquidation
            const info2 = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info2.status, 1);
            //Random address can't call collateral deposited
            const res = assetManager.updateCollateral(agentVault.address,usdt.address, { from: accounts[5] });
            await expectRevert.custom(res, "OnlyAgentVaultOrPool", []);
            const res1 = agentVault.updateCollateral(usdt.address, { from: accounts[5] });
            await expectRevert.custom(res1, "OnlyOwner", []);
            //Call collateral deposited from owner address to trigger liquidation end
            await agentVault.updateCollateral(usdt.address, { from: agentOwner1 });
            //Check that agent is out of liquidation
            const info3 = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info3.status, 0);
        });

        it("should set pool collateral token", async () => {
            const newWnat = await ERC20Mock.new("Wrapped NAT", "WNAT");
            await assetManager.updateSystemContracts(assetManagerController, newWnat.address, { from: assetManagerController });
            const token = await assetManager.getCollateralType(CollateralClass.POOL, newWnat.address);
            assertWeb3Equal(token.token, newWnat.address);
        });

        it("should set pool collateral token and upgrade wnat", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const newWnat = await ERC20Mock.new("Wrapped NAT", "WNAT");
            //Calling upgrade before updating contract won't do anything (just a branch test)
            await assetManager.upgradeWNatContract(agentVault.address, {from: agentOwner1});
            //Update wnat contract
            await assetManager.updateSystemContracts(assetManagerController, newWnat.address, { from: assetManagerController });
            //Random address shouldn't be able to upgrade wNat contract
            const tx = assetManager.upgradeWNatContract(agentVault.address, {from: accounts[5]});
            await expectRevert.custom(tx, "OnlyAgentVaultOwner", []);
            const res = await assetManager.upgradeWNatContract(agentVault.address, {from: agentOwner1});
            expectEvent(res, "AgentCollateralTypeChanged");
            const eventArgs = requiredEventArgs(res, 'AgentCollateralTypeChanged');
            assert.equal(Number(eventArgs.collateralClass), CollateralClass.POOL);
            const token = await assetManager.getCollateralType(CollateralClass.POOL, eventArgs.token);
            assertWeb3Equal(token.token, newWnat.address);
        });
    });

    describe("agent owner registry", () => {
        async function addOwnerRegistry() {
            // create governance settings
            const governanceSettings = await GovernanceSettings.new();
            await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
            // create whitelist
            const agentOwnerRegistry = await createAgentOwnerRegistry(governanceSettings, governance);
            await agentOwnerRegistry.switchToProductionMode({ from: governance });
            await assetManager.setAgentOwnerRegistry(agentOwnerRegistry.address, { from: assetManagerController });
            return agentOwnerRegistry;
        }

        it("should require whitelisting, when agent owner registry exists, to create agent", async () => {
            const agentOwnerRegistry = await addOwnerRegistry();
            await agentOwnerRegistry.whitelistAndDescribeAgent(whitelistedAccount, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAgent1);
            assert.isTrue(addressValidityProof.data.responseBody.isValid);
            const settings = createTestAgentSettings(usdc.address);
            await expectRevert.custom(assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(settings), { from: agentOwner1 }),
                "AgentNotWhitelisted", []);
            expectEvent(await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(settings), { from: whitelistedAccount}), "AgentVaultCreated");
        });

        it("should set and get work address", async () => {
            const agentOwnerRegistry = await addOwnerRegistry();
            const workAddress = accounts[33];
            await agentOwnerRegistry.whitelistAndDescribeAgent(whitelistedAccount, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            // initially work address is 0
            assertWeb3Equal(await assetManager.getWorkAddress(whitelistedAccount), ZERO_ADDRESS);
            // change
            await agentOwnerRegistry.setWorkAddress(workAddress, { from: whitelistedAccount });
            assertWeb3Equal(await assetManager.getWorkAddress(whitelistedAccount), workAddress);
            // create agent vault from work address
            const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAgent1);
            const settings = createTestAgentSettings(usdc.address);
            expectEvent(await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(settings), { from: workAddress }), "AgentVaultCreated");
        });
    });

    describe("pause and unpause minting", () => {
        it("should pause", async () => {
            assert.isFalse(await assetManager.mintingPaused());
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            // pause can be called twice with no extra effect
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
        });

        it("should unpause", async () => {
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            await assetManager.unpauseMinting({ from: assetManagerController });
            assert.isFalse(await assetManager.mintingPaused());
        });

        it("should not pause if not called from asset manager controller", async () => {
            const promise = assetManager.pauseMinting({ from: accounts[0] });
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
            assert.isFalse(await assetManager.mintingPaused());
        });

        it("should not unpause if not called from asset manager controller", async () => {
            await assetManager.pauseMinting({ from: assetManagerController });
            assert.isTrue(await assetManager.mintingPaused());
            const promise = assetManager.unpauseMinting({ from: accounts[0] });
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
            assert.isTrue(await assetManager.mintingPaused());
        });
    });

    describe("should update contracts", () => {
        it("should update contract addresses", async () => {
            const agentVaultFactoryNewAddress = accounts[21];
            const wnatNewAddress = accounts[23];
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
            const newSettings0 = createTestSettings(contracts, testChainInfo.eth);
            newSettings0.collateralReservationFeeBIPS = 0;
            const res0 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings0, collaterals);
            await expectRevert.custom(res0, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (assetUnitUBA)", async () => {
            const newSettings1 = createTestSettings(contracts, testChainInfo.eth);
            newSettings1.assetUnitUBA = 0;
            const res1 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings1, collaterals);
            await expectRevert.custom(res1, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (assetMintingGranularityUBA)", async () => {
            const newSettings2 = createTestSettings(contracts, testChainInfo.eth);
            newSettings2.assetMintingGranularityUBA = 0;
            const res2 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings2, collaterals);
            await expectRevert.custom(res2, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (minCollateralRatioBIPS)", async () => {
            const collaterals3 = createTestCollaterals(contracts, testChainInfo.eth);
            collaterals3[0].minCollateralRatioBIPS = 0;
            const res3 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, settings, collaterals3);
            await expectRevert.custom(res3, "InvalidCollateralRatios", []);
        });

        it("should validate settings - cannot be zero (underlyingBlocksForPayment)", async () => {
            const newSettings6 = createTestSettings(contracts, testChainInfo.eth);
            newSettings6.underlyingBlocksForPayment = 0;
            const res6 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings6, collaterals);
            await expectRevert.custom(res6, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (underlyingSecondsForPayment)", async () => {
            const newSettings7 = createTestSettings(contracts, testChainInfo.eth);
            newSettings7.underlyingSecondsForPayment = 0;
            const res7 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings7, collaterals);
            await expectRevert.custom(res7, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (redemptionFeeBIPS)", async () => {
            const newSettings8 = createTestSettings(contracts, testChainInfo.eth);
            newSettings8.redemptionFeeBIPS = 0;
            const res8 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings8, collaterals);
            await expectRevert.custom(res8, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (maxRedeemedTickets)", async () => {
            const newSettings10 = createTestSettings(contracts, testChainInfo.eth);
            newSettings10.maxRedeemedTickets = 0;
            const res10 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings10, collaterals);
            await expectRevert.custom(res10, "CannotBeZero", []);
        });

        it("should validate settings - must be zero (__ccbTimeSeconds)", async () => {
            const newSettings11 = createTestSettings(contracts, testChainInfo.eth);
            newSettings11.__ccbTimeSeconds = 1;
            const res11 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings11, collaterals);
            await expectRevert.custom(res11, "MustBeZero", []);
        });

        it("should validate settings - cannot be zero (liquidationStepSeconds)", async () => {
            const newSettings12 = createTestSettings(contracts, testChainInfo.eth);
            newSettings12.liquidationStepSeconds = 0;
            const res12 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings12, collaterals);
            await expectRevert.custom(res12, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (maxTrustedPriceAgeSeconds)", async () => {
            const newSettings13 = createTestSettings(contracts, testChainInfo.eth);
            newSettings13.maxTrustedPriceAgeSeconds = 0;
            const res13 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings13, collaterals);
            await expectRevert.custom(res13, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (minUpdateRepeatTimeSeconds)", async () => {
            const newSettings15 = createTestSettings(contracts, testChainInfo.eth);
            newSettings15.minUpdateRepeatTimeSeconds = 0;
            const res15 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings15, collaterals);
            await expectRevert.custom(res15, "CannotBeZero", []);
        });

        it("should validate settings - must be zero (__buybackCollateralFactorBIPS)", async () => {
            const newSettings16 = createTestSettings(contracts, testChainInfo.eth);
            newSettings16.__buybackCollateralFactorBIPS = 1;
            const res16 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings16, collaterals);
            await expectRevert.custom(res16, "MustBeZero", []);
        });

        it("should validate settings - cannot be zero (withdrawalWaitMinSeconds)", async () => {
            const newSettings17 = createTestSettings(contracts, testChainInfo.eth);
            newSettings17.withdrawalWaitMinSeconds = 0;
            const res17 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings17, collaterals);
            await expectRevert.custom(res17, "CannotBeZero", []);
        });

        it("should validate settings - cannot be zero (lotSizeAMG)", async () => {
            const newSettings19 = createTestSettings(contracts, testChainInfo.eth)
            newSettings19.lotSizeAMG = 0;
            const res19 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings19, collaterals);
            await expectRevert.custom(res19, "CannotBeZero", []);
        });

        it("should validate settings - must be zero (__announcedUnderlyingConfirmationMinSeconds)", async () => {
            const newSettings20 = createTestSettings(contracts, testChainInfo.eth)
            newSettings20.__announcedUnderlyingConfirmationMinSeconds = 1;
            const res20 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings20, collaterals);
            await expectRevert.custom(res20, "MustBeZero", []);
        });

        it("should validate settings - cannot be zero (underlyingSecondsForPayment)", async () => {
            const newSettings21 = createTestSettings(contracts, testChainInfo.eth)
            newSettings21.underlyingSecondsForPayment = 25 * HOURS;
            const res21 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings21, collaterals);
            await expectRevert.custom(res21, "ValueTooHigh", []);
        });

        it("should validate settings - cannot be zero (underlyingBlocksForPayment)", async () => {
            const newSettings22 = createTestSettings(contracts, testChainInfo.eth)
            newSettings22.underlyingBlocksForPayment = toBN(Math.round(25 * HOURS / testChainInfo.eth.blockTime));
            const res22 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings22, collaterals);
            await expectRevert.custom(res22, "ValueTooHigh", []);
        });

        it("should validate settings - must be zero (__cancelCollateralReservationAfterSeconds)", async () => {
            const newSettings23 = createTestSettings(contracts, testChainInfo.eth)
            newSettings23.__cancelCollateralReservationAfterSeconds = 1;
            const res23 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings23, collaterals);
            await expectRevert.custom(res23, "MustBeZero", []);
        });

        it("should validate settings - must be zero (__rejectOrCancelCollateralReservationReturnFactorBIPS)", async () => {
            const newSettings23 = createTestSettings(contracts, testChainInfo.eth)
            newSettings23.__rejectOrCancelCollateralReservationReturnFactorBIPS = 1;
            const res23 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings23, collaterals);
            await expectRevert.custom(res23, "MustBeZero", []);
        });

        it("should validate settings - must be zero (__rejectRedemptionRequestWindowSeconds)", async () => {
            const newSettings24 = createTestSettings(contracts, testChainInfo.eth)
            newSettings24.__rejectRedemptionRequestWindowSeconds = 1;
            const res24 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings24, collaterals);
            await expectRevert.custom(res24, "MustBeZero", []);
        });

        it("should validate settings - must be zero (__takeOverRedemptionRequestWindowSeconds)", async () => {
            const newSettings25 = createTestSettings(contracts, testChainInfo.eth)
            newSettings25.__takeOverRedemptionRequestWindowSeconds = 1;
            const res25 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings25, collaterals);
            await expectRevert.custom(res25, "MustBeZero", []);
        });

        it("should validate settings - must be zero (__rejectedRedemptionDefaultFactorVaultCollateralBIPS)", async () => {
            const newSettings26 = createTestSettings(contracts, testChainInfo.eth)
            newSettings26.__rejectedRedemptionDefaultFactorVaultCollateralBIPS = 1;
            const res26 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings26, collaterals);
            await expectRevert.custom(res26, "MustBeZero", []);
        });

        it("should validate settings - must be zero (__rejectedRedemptionDefaultFactorPoolBIPS)", async () => {
            const newSettings26 = createTestSettings(contracts, testChainInfo.eth)
            newSettings26.__rejectedRedemptionDefaultFactorPoolBIPS = 1;
            const res26 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings26, collaterals);
            await expectRevert.custom(res26, "MustBeZero", []);
        });

        it("should validate settings - other validators (collateralReservationFeeBIPS)", async () => {
            const newSettings0 = createTestSettings(contracts, testChainInfo.eth);
            newSettings0.collateralReservationFeeBIPS = 10001;
            const res0 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings0, collaterals);
            await expectRevert.custom(res0, "BipsValueTooHigh", []);
        });

        it("should validate settings - other validators (redemptionFeeBIPS)", async () => {
            const newSettings1 = createTestSettings(contracts, testChainInfo.eth);
            newSettings1.redemptionFeeBIPS = 10001;
            const res1 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings1, collaterals);
            await expectRevert.custom(res1, "BipsValueTooHigh", []);
        });

        it("should validate settings - other validators (redemptionDefaultFactorVaultCollateralBIPS)", async () => {
            const newSettings2 = createTestSettings(contracts, testChainInfo.eth);
            newSettings2.redemptionDefaultFactorVaultCollateralBIPS = 10000;
            const res2 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings2, collaterals);
            await expectRevert.custom(res2, "BipsValueTooLow", []);
        });

        it("should validate settings - must be zero (__redemptionDefaultFactorPoolBIPS)", async () => {
            const newSettings23 = createTestSettings(contracts, testChainInfo.eth)
            newSettings23.__redemptionDefaultFactorPoolBIPS = 1;
            const res23 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings23, collaterals);
            await expectRevert.custom(res23, "MustBeZero", []);
        });

        it("should validate settings - other validators (attestationWindowSeconds)", async () => {
            const newSettings3 = createTestSettings(contracts, testChainInfo.eth);
            newSettings3.attestationWindowSeconds = 0.9 * DAYS;
            const res3 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings3, collaterals);
            await expectRevert.custom(res3, "WindowTooSmall", []);
        });

        it("should validate settings - other validators (confirmationByOthersAfterSeconds)", async () => {
            const newSettings4 = createTestSettings(contracts, testChainInfo.eth);
            newSettings4.confirmationByOthersAfterSeconds = 1.9 * HOURS;
            const res4 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings4, collaterals);
            await expectRevert.custom(res4, "MustBeTwoHours", []);
        });

        it("should validate settings - other validators (mintingCapAMG)", async () => {
            const newSettings5 = createTestSettings(contracts, testChainInfo.eth);
            newSettings5.mintingCapAMG = toBN(newSettings5.lotSizeAMG).divn(2);
            const res5x = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings5, collaterals);
            await expectRevert.custom(res5x, "MintingCapTooSmall", []);
        });

        it("should validate settings - other validators (mintingCapAMG 2)", async () => {
            // should work for nonzero cap greater than lot size
            const newSettings6 = createTestSettings(contracts, testChainInfo.eth);
            newSettings6.mintingCapAMG = toBN(newSettings6.lotSizeAMG).muln(2);
            await newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, newSettings6, collaterals);
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 1)", async () => {
            const liquidationSettings5 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings5.liquidationCollateralFactorBIPS = [];
            liquidationSettings5.liquidationFactorVaultCollateralBIPS = [];
            const res5 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings5, collaterals);
            await expectRevert.custom(res5, "AtLeastOneFactorRequired", []);
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 2)", async () => {
            const liquidationSettings6 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings6.liquidationCollateralFactorBIPS = [12000, 11000];
            liquidationSettings6.liquidationFactorVaultCollateralBIPS = [12000, 11000];
            const res6 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings6, collaterals);
            await expectRevert.custom(res6, "FactorsNotIncreasing", []);
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 3)", async () => {
            const liquidationSettings7 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings7.liquidationCollateralFactorBIPS = [12000];
            liquidationSettings7.liquidationFactorVaultCollateralBIPS = [12001];
            const res7 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings7, collaterals);
            await expectRevert.custom(res7, "VaultCollateralFactorHigherThanTotal", []);
        });

        it("should validate settings - other validators (liquidationCollateralFactorBIPS - 4)", async () => {
            const liquidationSettings8 = createTestSettings(contracts, testChainInfo.eth);
            liquidationSettings8.liquidationCollateralFactorBIPS = [1000];
            liquidationSettings8.liquidationFactorVaultCollateralBIPS = [1000];
            const res8 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, liquidationSettings8, collaterals);
            await expectRevert.custom(res8, "FactorNotAboveOne", []);
        });

        it("should validate settings - other validators (collateral ratios)", async () => {
            const collaterals6 = createTestCollaterals(contracts, testChainInfo.eth);
            collaterals6[0].minCollateralRatioBIPS = 2_8000;
            collaterals6[0].safetyMinCollateralRatioBIPS = 2_4000;
            const res9 = newAssetManagerQuick(governance, assetManagerController, "Ethereum", "ETH", 18, settings, collaterals6);
            await expectRevert.custom(res9, "InvalidCollateralRatios", []);
        });
    });

    describe("agent collateral deposit and withdrawal", () => {

        it("should announce vault collateral withdrawal and execute it", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            // deposit collateral
            await usdc.mintAmount(agentOwner1, 10000);
            await usdc.approve(agentVault.address, 10000, { from: agentOwner1 });
            await agentVault.depositCollateral(usdc.address, 10000, { from: agentOwner1 });
            const _agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(_agentInfo.totalVaultCollateralWei, 10000);
            // announce withdrawal and execute it
            await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 1000, { from: agentOwner1 });
            const agentWithdrawalTimelock = (await assetManager.getSettings()).withdrawalWaitMinSeconds;
            await time.deterministicIncrease(agentWithdrawalTimelock);
            const res = await agentVault.withdrawCollateral(usdc.address, 1000, accounts[80], { from: agentOwner1 });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.totalVaultCollateralWei, 9000);
        });

        it("Agent can always withdraw a collateral token that is not its current collateral", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const token = usdt;
            await token.mintAmount(agentVault.address, toWei(3e8));
            await token.approve(agentVault.address, toWei(3e8), { from: agentOwner1 });
            const beforeBalance = await token.balanceOf(agentVault.address);
            //Non collateral token can be withdrawn without announcing
            await agentVault.withdrawCollateral(token.address, 1000, accounts[80], { from: agentOwner1 });
            const afterBalance = await token.balanceOf(agentVault.address);
            assertWeb3Equal(beforeBalance.sub(afterBalance), 1000);
        });

        it("should announce pool redemption (class2 withdrawal) and execute it", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            // deposit pool tokens to agent vault (there is a min-limit on nat deposited to collateral pool)
            await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: toWei(10) });
            const _agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(_agentInfo.totalAgentPoolTokensWei, toWei(10));
            await time.deterministicIncrease(await assetManager.getCollateralPoolTokenTimelockSeconds()); // wait for token timelock
            // announce withdrawal and execute it (nat to pool token ratio is 1:1 as there are no minted f-assets)
            await assetManager.announceAgentPoolTokenRedemption(agentVault.address, toWei(1), { from: agentOwner1 });
            const agentWithdrawalTimelock = (await assetManager.getSettings()).withdrawalWaitMinSeconds;
            await time.deterministicIncrease(agentWithdrawalTimelock);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            await time.deterministicIncrease((await assetManager.getSettings()).agentExitAvailableTimelockSeconds);
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
            let agentVault = await createAgentVault(agentOwner1, "test");
            // Only agent owner can announce exit
            let res = assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert.custom(res, "AgentNotAvailable", []);
            // Only agent owner can announce exit
            agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            res = assetManager.announceExitAvailableAgentList(agentVault.address, { from: accounts[5] });
            await expectRevert.custom(res, "OnlyAgentVaultOwner", []);
            //Must announce exit to be able to exit
            res = assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert.custom(res, "ExitNotAnnounced", []);
            //Announce exit
            const annRes = await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            const exitTime = requiredEventArgs(annRes, 'AvailableAgentExitAnnounced').exitAllowedAt;
            // announce twice start new countdown
            await time.deterministicIncrease(10);
            const annRes2 = await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            const exitTime2 = requiredEventArgs(annRes2, 'AvailableAgentExitAnnounced').exitAllowedAt;
            assert.isTrue(exitTime2.gt(exitTime));
            //Must wait agentExitAvailableTimelockSeconds before agent can exit
            res = assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert.custom(res, "ExitTooSoon", []);
            // make agent unavailable
            await time.deterministicIncrease((await assetManager.getSettings()).agentExitAvailableTimelockSeconds);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            //Announce exit
            const annRes = await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            const exitTime = requiredEventArgs(annRes, 'AvailableAgentExitAnnounced').exitAllowedAt;
            // exit available too late
            const settings = await assetManager.getSettings();
            await time.deterministicIncrease(toBN(settings.agentExitAvailableTimelockSeconds).add(toBN(settings.agentTimelockedOperationWindowSeconds).addn(1)));
            const res = assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            await expectRevert.custom(res, "ExitTooLate", []);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const executor = accounts[81];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const executorFee = toWei(0.1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, executor,
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
            const burnBalanceStart = toBN(await web3.eth.getBalance(settings.burnAddress));
            const poolWNatBalanceStart = await wNat.balanceOf(agentInfo.collateralPool);
            const agentWNatBalanceStart = await wNat.balanceOf(agentOwner1);
            //
            const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minter });
            //
            const gasFee = calcGasCost(res);
            const executorBalanceEnd = toBN(await web3.eth.getBalance(executor));
            const minterBalanceEnd = toBN(await web3.eth.getBalance(minter));
            const burnBalanceEnd = toBN(await web3.eth.getBalance(settings.burnAddress));
            const poolWNatBalanceEnd = await wNat.balanceOf(agentInfo.collateralPool);
            const agentWNatBalanceEnd = await wNat.balanceOf(agentOwner1);
            const fassets = await fAsset.balanceOf(minter);
            assertWeb3Equal(fassets, crt.valueUBA);
            // executor fee got burned - nobody receives it
            assertWeb3Equal(executorBalanceEnd.sub(executorBalanceStart), BN_ZERO);
            assertWeb3Equal(minterBalanceEnd.sub(minterBalanceStart), gasFee.neg());
            assertWeb3Equal(burnBalanceEnd.sub(burnBalanceStart), executorFee);
            // agent and pool shared the collateral reservation fee
            assert.isTrue(agentWNatBalanceEnd.gt(agentWNatBalanceStart));
            assert.isTrue(poolWNatBalanceEnd.gt(poolWNatBalanceStart));
            assertWeb3Equal(poolWNatBalanceEnd.sub(poolWNatBalanceStart).add(agentWNatBalanceEnd.sub(agentWNatBalanceStart)), reservationFee);
        });

        it("should execute minting (by agent)", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const executor = accounts[81];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const executorFee = toWei(0.1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, executor,
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
            const agentBalanceStart = toBN(await web3.eth.getBalance(agentOwner1));
            const burnBalanceStart = toBN(await web3.eth.getBalance(settings.burnAddress));
            const poolWNatBalanceStart = await wNat.balanceOf(agentInfo.collateralPool);
            const agentWNatBalanceStart = await wNat.balanceOf(agentOwner1);
            //
            const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: agentOwner1 });
            //
            const gasFee = calcGasCost(res);
            const executorBalanceEnd = toBN(await web3.eth.getBalance(executor));
            const minterBalanceEnd = toBN(await web3.eth.getBalance(minter));
            const agentBalanceEnd = toBN(await web3.eth.getBalance(agentOwner1));
            const burnBalanceEnd = toBN(await web3.eth.getBalance(settings.burnAddress));
            const poolWNatBalanceEnd = await wNat.balanceOf(agentInfo.collateralPool);
            const agentWNatBalanceEnd = await wNat.balanceOf(agentOwner1);
            const fassets = await fAsset.balanceOf(minter);
            assertWeb3Equal(fassets, crt.valueUBA);
            // executor fee got burned - nobody receives it
            assertWeb3Equal(executorBalanceEnd.sub(executorBalanceStart), BN_ZERO);
            assertWeb3Equal(minterBalanceEnd.sub(minterBalanceStart), BN_ZERO);
            assertWeb3Equal(agentBalanceEnd.sub(agentBalanceStart), gasFee.neg());
            assertWeb3Equal(burnBalanceEnd.sub(burnBalanceStart), executorFee);
            // agent and pool shared the collateral reservation fee
            assert.isTrue(agentWNatBalanceEnd.gt(agentWNatBalanceStart));
            assert.isTrue(poolWNatBalanceEnd.gt(poolWNatBalanceStart));
            assertWeb3Equal(poolWNatBalanceEnd.sub(poolWNatBalanceStart).add(agentWNatBalanceEnd.sub(agentWNatBalanceStart)), reservationFee);
        });

        it("should execute minting (by executor)", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const executor = accounts[81];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const executorFee = toWei(0.1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, executor,
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
            const executorWNatBalanceStart = await wNat.balanceOf(executor);
            const poolWNatBalanceStart = await wNat.balanceOf(agentInfo.collateralPool);
            const agentWNatBalanceStart = await wNat.balanceOf(agentOwner1);
            //
            const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: executor });
            //
            const gasFee = calcGasCost(res);
            const executorBalanceEnd = toBN(await web3.eth.getBalance(executor));
            const executorWNatBalanceEnd = await wNat.balanceOf(executor);
            const poolWNatBalanceEnd = await wNat.balanceOf(agentInfo.collateralPool);
            const agentWNatBalanceEnd = await wNat.balanceOf(agentOwner1);
            const fassets = await fAsset.balanceOf(minter);
            assertWeb3Equal(fassets, crt.valueUBA);
            // executor fee paid to executor
            assertWeb3Equal(executorBalanceStart.sub(executorBalanceEnd), gasFee);
            assertWeb3Equal(executorWNatBalanceEnd.sub(executorWNatBalanceStart), executorFee);
            // agent and pool shared the collateral reservation fee
            assert.isTrue(agentWNatBalanceEnd.gt(agentWNatBalanceStart));
            assert.isTrue(poolWNatBalanceEnd.gt(poolWNatBalanceStart));
            assertWeb3Equal(poolWNatBalanceEnd.sub(poolWNatBalanceStart).add(agentWNatBalanceEnd.sub(agentWNatBalanceStart)), reservationFee);
        });

        it("should do a minting payment default", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const totalFee = reservationFee.add(toWei(0.1));    // 0.1 for executor fee
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, accounts[81],
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
            const agentWnatBalance = await wNat.balanceOf(agentOwner1);
            assertWeb3Equal(agentWnatBalance, agentShare);
            const poolAddress = await assetManager.getCollateralPool(agentVault.address);
            const poolWnatBalance = await wNat.balanceOf(poolAddress);
            assertWeb3Equal(poolWnatBalance.sub(toWei(3e8)), poolShare);
        });

        it("should unstick minting", async () => {
            // create agent vault and make available
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS,
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

        it("should unstick minting when vault collateral token is the same as pool token", async () => {
            const ci = testChainInfo.eth;
            // create asset manager where pool and vault collateral is nat
            collaterals = createTestCollaterals(contracts, ci);
            collaterals[1].token = collaterals[0].token;
            collaterals[1].tokenFtsoSymbol = collaterals[0].tokenFtsoSymbol;
            settings = createTestSettings(contracts, ci);
            [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
            const agentVault = await createAvailableAgentNAT(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS,
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const redeemedAssetUSD = await ubaToTokenWei(redemptionRequest.valueUBA, assetSymbol);
            const redeemerUSDCBalanceUSD = await ubaToTokenWei(await usdc.balanceOf(redeemer), usdcSymbol);
            const redeemerWNatBalanceUSD = await ubaToTokenWei(await wNat.balanceOf(redeemer), natSymbol);
            assertEqualWithNumError(redeemerUSDCBalanceUSD, mulBIPS(redeemedAssetUSD, toBN(settings.redemptionDefaultFactorVaultCollateralBIPS)), toBN(10));
            assertWeb3Equal(redeemerWNatBalanceUSD, 0);
        });

        it("should do a redemption payment default by executor", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const executor = accounts[84];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const executorWNatBalanceStart = await wNat.balanceOf(executor);
            const redemptionDefaultTx = await assetManager.redemptionPaymentDefault(proof, redemptionRequest.requestId, { from: executor });
            const executorBalanceEnd = toBN(await web3.eth.getBalance(executor));
            const executorWNatBalanceEnd = await wNat.balanceOf(executor);
            const gasFee = calcGasCost(redemptionDefaultTx);
            // expect events
            const redemptionDefault = findRequiredEvent(redemptionDefaultTx, "RedemptionDefault").args;
            expect(redemptionDefault.agentVault).to.equal(agentVault.address);
            expect(redemptionDefault.redeemer).to.equal(redeemer);
            assertWeb3Equal(redemptionDefault.requestId, redemptionRequest.requestId);
            assertWeb3Equal(executorBalanceStart.sub(executorBalanceEnd), gasFee);
            assertWeb3Equal(executorWNatBalanceEnd.sub(executorWNatBalanceStart), executorFee);
            // expect usdc / wnat balance changes
            const redeemedAssetUSD = await ubaToTokenWei(redemptionRequest.valueUBA, assetSymbol);
            const redeemerUSDCBalanceUSD = await ubaToTokenWei(await usdc.balanceOf(redeemer), usdcSymbol);
            const redeemerWNatBalanceUSD = await ubaToTokenWei(await wNat.balanceOf(redeemer), natSymbol);
            assertEqualWithNumError(redeemerUSDCBalanceUSD, mulBIPS(redeemedAssetUSD, toBN(settings.redemptionDefaultFactorVaultCollateralBIPS)), toBN(10));
            assertWeb3Equal(redeemerWNatBalanceUSD, 0);
        });

        it("should revert redeeming if sending funds but not setting executor ", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(1));
            // redemption request
            const executorFee = toWei(0.1);
            await expectRevert.custom(assetManager.redeem(1, underlyingRedeemer, ZERO_ADDRESS, { from: redeemer, value: executorFee }),
                "ExecutorFeeWithoutExecutor", []);
        });

        it("should finish non-defaulted redemption payment", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            const underlyingRedeemer = "redeemer"
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(10));
            // set redemptionPaymentExtensionSeconds setting to 1 (needs two steps and timeskip due to validation)
            await assetManager.setRedemptionPaymentExtensionSeconds(3, { from: assetManagerController });
            await time.deterministicIncrease(86400);
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
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set redemption payment extension seconds - decrease too big", async () => {
            const promise = assetManager.setRedemptionPaymentExtensionSeconds(0, { from: assetManagerController });
            await expectRevert.custom(promise, "DecreaseTooBig", []);
        });

        it("should not set redemption payment extension seconds - increase too big", async () => {
            const currentExtensionSecs = await assetManager.redemptionPaymentExtensionSeconds();
            const averageBlockTimeMs = settings.averageBlockTimeMS;
            const newExtensionSecs = currentExtensionSecs.muln(4).add(toBN(averageBlockTimeMs).divn(1000)).addn(1);
            const promise = assetManager.setRedemptionPaymentExtensionSeconds(newExtensionSecs, { from: assetManagerController });
            await expectRevert.custom(promise, "IncreaseTooBig", []);
        });

        it("should revert setting redemption payment extension time to 0", async () => {
            // define redeemer and its underlying address
            const redeemer = accounts[83];
            // create available agentVault and mint f-assets
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, redeemer, toBN(10));
            // set redemptionPaymentExtensionSeconds setting to 1 (needs two steps and timeskip due to validation)
            await assetManager.setRedemptionPaymentExtensionSeconds(3, { from: assetManagerController });
            await time.deterministicIncrease(86400);
            await expectRevert.custom(assetManager.setRedemptionPaymentExtensionSeconds(0, { from: assetManagerController }), "ValueMustBeNonzero", []);
        });
    });

    describe("agent underlying", () => {

        it("should self-close", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            const { agentFeeShareUBA } = await mintFassets(agentVault, agentOwner1, underlyingAgent1, agentOwner1, toBN(1));
            const tx = await assetManager.selfClose(agentVault.address, lotsToUBA(1), { from: agentOwner1 });
            const selfClosed = findRequiredEvent(tx, "SelfClose").args;
            assertWeb3Equal(selfClosed.agentVault, agentVault.address);
            assertWeb3Equal(selfClosed.valueUBA, lotsToUBA(1));
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.freeUnderlyingBalanceUBA, lotsToUBA(1).add(agentFeeShareUBA));
        });

        it("should announce underlying withdraw and confirm (from agent owner)", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // deposit underlying asset to not trigger liquidation by making balance negative
            await depositUnderlyingAsset(agentVault, agentOwner1, underlyingAgent1, toWei(10));
            // announce underlying asset withdrawal
            const tx1 = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalAnnouncement = findRequiredEvent(tx1, "UnderlyingWithdrawalAnnounced").args;
            assertWeb3Equal(underlyingWithdrawalAnnouncement.agentVault, agentVault.address);
            // withdraw
            const txHash = await wallet.addTransaction(underlyingAgent1, "random_address", 1, underlyingWithdrawalAnnouncement.paymentReference);
            const proof = await attestationProvider.provePayment(txHash, underlyingAgent1, "random_address");
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            const tx1 = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalAnnouncement = findRequiredEvent(tx1, "UnderlyingWithdrawalAnnounced").args;
            const tx2 = await assetManager.cancelUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const underlyingWithdrawalConfirmed = findRequiredEvent(tx2, "UnderlyingWithdrawalCancelled").args;
            assertWeb3Equal(underlyingWithdrawalConfirmed.agentVault, agentVault.address);
            assertWeb3Equal(underlyingWithdrawalConfirmed.announcementId, underlyingWithdrawalAnnouncement.announcementId);
            // withdrawal didn't happen so agent is not in liquidation
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 0);
        });

        it("should topup the underlying balance", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            assertWeb3Equal(agentInfo.status, 2); // full-liquidation status
            // check that challenger was rewarded
            const expectedChallengerReward = await usd5ToVaultCollateralWei(toBN(settings.paymentChallengeRewardUSD5));
            assertWeb3Equal(await usdc.balanceOf(challenger), expectedChallengerReward);
        });

        it("should make an illegal double payment challenge", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            assertWeb3Equal(agentInfo.status, 2); // full-liquidation status
            // check that challenger was rewarded
            const expectedChallengerReward = await usd5ToVaultCollateralWei(toBN(settings.paymentChallengeRewardUSD5));
            assertWeb3Equal(await usdc.balanceOf(challenger), expectedChallengerReward);
        });

        it("should make a free-balance negative challenge", async () => {
            const challenger = accounts[83];
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            assertWeb3Equal(underlyingBalanceTooLow.requiredBalance, await fAsset.totalSupply());
            // check that challenger was rewarded
            const expectedChallengerReward = await usd5ToVaultCollateralWei(toBN(settings.paymentChallengeRewardUSD5));
            assertWeb3Equal(await usdc.balanceOf(challenger), expectedChallengerReward);
        });
    });

    describe("liquidation", () => {

        it("should start liquidation", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1, toWei(3e6), toWei(3e6))
            // mint some f-assets that require backing
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[82], toBN(5));
            // price change
            await contracts.priceStore.setCurrentPrice(assetSymbol, toBNExp(9, 8), 0);
            await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetSymbol, toBNExp(9, 8), 0);
            // start liquidation
            const tx = await assetManager.startLiquidation(agentVault.address, { from: accounts[83] });
            expectEvent(tx, "LiquidationStarted");
            // check that agent is in liquidation phase
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.status, 1);
        });

        it("should liquidate", async () => {
            const liquidator = accounts[83];
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1, toWei(3e6), toWei(3e6))
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, liquidator, toBN(5));
            // simulate liquidation (set cr to eps > 0)
            await contracts.priceStore.setCurrentPrice(assetSymbol, toBNExp(9, 8), 0);
            await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetSymbol, toBNExp(9, 8), 0);
            await assetManager.startLiquidation(agentVault.address, { from: liquidator });
            // calculate liquidation value and liquidate liquidate
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const liquidationUBA = lotsToUBA(2);
            const liquidationUSDC = await ubaToC1Wei(mulBIPS(liquidationUBA, toBN(agentInfo.liquidationPaymentFactorVaultBIPS)));
            const liquidationPool = await ubaToPoolWei(mulBIPS(liquidationUBA, toBN(agentInfo.liquidationPaymentFactorPoolBIPS)));
            const tx = await assetManager.liquidate(agentVault.address, liquidationUBA, { from: liquidator });
            expectEvent(tx, "LiquidationPerformed");
            assertApproximatelyEqual(await usdc.balanceOf(liquidator), liquidationUSDC, "absolute", 100);
            assertApproximatelyEqual(await wNat.balanceOf(liquidator), liquidationPool, "absolute", 100);
        });

        it("should start and then end liquidation", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1, toWei(3e6), toWei(3e6))
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[83], toBN(2));
            // price change #1
            await contracts.priceStore.setCurrentPrice(assetSymbol, toBNExp(3, 9), 0);
            await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetSymbol, toBNExp(3, 9), 0);
            // start liquidation
            await assetManager.startLiquidation(agentVault.address, { from: accounts[83] });
            const agentInfo1 = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo1.status, 1);
            // price change #2
            await contracts.priceStore.setCurrentPrice(assetSymbol, testChainInfo.eth.startPrice, 0);
            await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetSymbol, testChainInfo.eth.startPrice, 0);
            // end liquidation
            const tx = await assetManager.endLiquidation(agentVault.address, { from: accounts[83] });
            expectEvent(tx, "LiquidationEnded");
            // check that agent status is normal
            const agentInfo2 = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo2.status, 0);
        });
    });

    describe("getting agents", () => {
        it("should get all agents", async () => {
            // create agent
            const agentVault1 = await createAgentVault(accounts[82], "Agent1");
            const agentVault2 = await createAgentVault(accounts[83], "Agent2")
            // get all agents
            const agents = await assetManager.getAllAgents(0, 10);
            assert.equal(agents[0].length, 2);
            assert.equal(agents[0][0], agentVault1.address);
            assert.equal(agents[0][1], agentVault2.address);
            assert.equal(agents[1].toString(), "2");
        });

        it("should announce and destroy agent", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
            await time.deterministicIncrease(time.duration.hours(3));
            await assetManager.destroyAgent(agentVault.address, agentOwner1, { from: agentOwner1 });
            const info = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(info.status, AgentStatus.DESTROYED);
        });

        it("should not be able to announce destroy if agent is backing fassets", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // announce and make agent unavailable
            await assetManager.announceExitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            // make agent unavailable
            await time.deterministicIncrease((await assetManager.getSettings()).agentExitAvailableTimelockSeconds);
            await assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 });
            //Mint some fAssets (self-mints and sends so it should work even if unavailable)
            await mintFassets(agentVault, agentOwner1, underlyingAgent1, accounts[5], toBN(1));
            //Should not be able to announce destroy if agent is backing fAssets
            const res = assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
            await expectRevert.custom(res, "AgentStillActive", []);
        });
    });

    describe("ERC-165 interface identification", () => {
        function erc165InterfaceIdLog(verbose: boolean, mainInterface: Truffle.Contract<unknown>, inheritedInterfaces: Truffle.Contract<unknown>[] = []) {
            const interfaceId = erc165InterfaceId(mainInterface, inheritedInterfaces);
            if (verbose) {
                console.log(`${contractMetadata(mainInterface)?.contractName}: ${interfaceId}`);
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
            const ICoreVaultClient = artifacts.require("ICoreVaultClient");
            const ICoreVaultClientSettings = artifacts.require("ICoreVaultClientSettings");
            const IISettingsManagement = artifacts.require("IISettingsManagement");
            const IAgentAlwaysAllowedMinters = artifacts.require("IAgentAlwaysAllowedMinters");
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IERC165)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IDiamondLoupe)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IDiamondCut)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IGoverned)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IAgentPing)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IRedemptionTimeExtension)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, ICoreVaultClient)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, ICoreVaultClientSettings)));
            assert.isTrue(await assetManager.supportsInterface(erc165InterfaceIdLog(verbose, IAssetManager,
                [IERC165, IDiamondLoupe, IAgentPing, IRedemptionTimeExtension, ICoreVaultClient, ICoreVaultClientSettings, IAgentAlwaysAllowedMinters])));
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
            await expectRevert.custom(assetManagerInit.upgradeERC165Identifiers(), "NotInitialized", []);
            // but it should work in diamond cut on existing asset manager
            await assetManager.diamondCut([], assetManagerInit.address, abiEncodeCall(assetManagerInit, (c) => c.upgradeERC165Identifiers()), { from: governance });
            // supportInterface should work as before
            await checkSupportInterfaceWorks(false);
        });
    });

    describe("settings update and validation", () => {
        it("random address shouldn't be able to update settings", async () => {
            const wnatNewAddress = accounts[23];
            const r = assetManager.updateSystemContracts(assetManagerController, wnatNewAddress, { from: accounts[29] });
            await expectRevert.custom(r, "OnlyAssetManagerController", []);
        });

        it("random address shouldn't be able to attach controller", async () => {
            const r = assetManager.attachController(false, { from: accounts[29]});
            await expectRevert.custom(r, "OnlyAssetManagerController", []);
        });

        it("unattached asset manager can't create agent", async () => {
            await assetManager.attachController(false, { from: assetManagerController });
            const r = createAgentVault(agentOwner1, underlyingAgent1);
            await expectRevert.custom(r, "NotAttached", []);
        });

        it("unattached asset manager can't do collateral reservations", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            await assetManager.attachController(false, { from: assetManagerController });
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const r = assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS,
                { from: minter, value: reservationFee });
            await expectRevert.custom(r, "NotAttached", []);
        });

        it("agent can't self mint if asset manager is not attached", async () => {
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
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
            await expectRevert.custom(r, "NotAttached", []);
        });

        it("random address shouldn't be able to add collateral token", async () => {
            const collateral = deepCopy(web3DeepNormalize(collaterals[1]));
            collateral.token = (await ERC20Mock.new("New Token", "NT")).address;
            collateral.tokenFtsoSymbol = "NT";
            collateral.assetFtsoSymbol = "NT";
            const r = assetManager.addCollateralType(web3DeepNormalize(collateral), { from: accounts[99]});
            await expectRevert.custom(r, "OnlyAssetManagerController", []);
        });

        it("random address shouldn't be able to add collateral ratios for token", async () => {
            const r = assetManager.setCollateralRatiosForToken(collaterals[0].collateralClass, collaterals[0].token,
                toBIPS(1.5), toBIPS(1.6), { from: accounts[99] });
            await expectRevert.custom(r, "OnlyAssetManagerController", []);
        });

        it("random address shouldn't be able to deprecate token", async () => {
            const r = assetManager.deprecateCollateralType(collaterals[0].collateralClass, collaterals[0].token,
                settings.tokenInvalidationTimeMinSeconds, { from: accounts[99] });
            await expectRevert.custom(r, "OnlyAssetManagerController", []);
        });

        it("validate settings fAsset address can't be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ZeroAddress", []);
        });

        it("validate settings AgentVaultFactory cannot be address zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.agentVaultFactory = ZERO_ADDRESS;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ZeroAddress", []);
        });

        it("validate settings collateralPoolFactory address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.collateralPoolFactory = ZERO_ADDRESS;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ZeroAddress", []);
        });

        it("validate settings collateralPoolTokenFactory address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.collateralPoolTokenFactory = ZERO_ADDRESS;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ZeroAddress", []);
        });

        it("validate settings fdcVerification address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.fdcVerification = ZERO_ADDRESS;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ZeroAddress", []);
        });

        it("validate settings priceReader address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.priceReader = ZERO_ADDRESS;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ZeroAddress", []);
        });

        it("validate settings agentOwnerRegistry address cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.agentOwnerRegistry = ZERO_ADDRESS;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ZeroAddress", []);
        });

        it("validate settings confirmationByOthersRewardUSD5 cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.confirmationByOthersRewardUSD5 = 0;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "CannotBeZero", []);
        });

        it("validate settings - must be zero (__whitelist)", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.__whitelist = accounts[5];
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "MustBeZero", []);
        });

        it("validate settings - must be zero (__minUnderlyingBackingBIPS)", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.__minUnderlyingBackingBIPS = 1;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "MustBeZero", []);
        });

        it("validate settings vaultCollateralBuyForFlareFactorBIPS cannot be smaller than max bips", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.vaultCollateralBuyForFlareFactorBIPS = 5000;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ValueTooSmall", []);
        });

        it("validate settings averageBLockTimeMS cannot be zero", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.averageBlockTimeMS = 0;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "CannotBeZero", []);
        });

        it("validate settings agentTimelockedOperationWindowSeconds cannot be too small", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.agentTimelockedOperationWindowSeconds = 60;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ValueTooSmall", []);
        });

        it("validate settings collateralPoolTokenTimelockSeconds cannot be too small", async () => {
            const Collaterals = web3DeepNormalize(collaterals);
            const Settings = web3DeepNormalize(settings);
            Settings.fAsset = accounts[5];
            Settings.collateralPoolTokenTimelockSeconds = 10;
            const res = newAssetManagerDiamond(diamondCuts, assetManagerInit, contracts.governanceSettings, governance, Settings, Collaterals);
            await expectRevert.custom(res, "ValueTooSmall", []);
        });

        it("Should unstick minting, where token direct price pair is true", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci);
            collaterals[0].directPricePair=true;
            collaterals[1].directPricePair=true;
            [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
            // create agent vault and make available
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            // reserve collateral
            const minter = accounts[80];
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const reservationFee = await assetManager.collateralReservationFee(1);
            const tx = await assetManager.reserveCollateral(agentVault.address, 1, agentInfo.feeBIPS, ZERO_ADDRESS,
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

        it("at least 2 collaterals required when creating asset manager", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci);
            //First collateral shouldn't be anything else than a Pool collateral
            const collateralsNew: CollateralType[] = collaterals;
            //Make first collateral be VaultCollateral
            collateralsNew[0].collateralClass = collateralsNew[1].collateralClass;
            const res = newAssetManagerQuick(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collateralsNew, ci.assetName, ci.assetSymbol);
            await expectRevert.custom(res, "NotAPoolCollateralAtZero", []);
        });

        it("pool collateral should be the first collateral when creating asset manager", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci);
            //Only one collateral should not be enough to create asset manager
            const collateralsNew: CollateralType[] = [collaterals[0]];
            const res = newAssetManagerQuick(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collateralsNew, ci.assetName, ci.assetSymbol);
            await expectRevert.custom(res, "AtLeastTwoCollateralsRequired", []);
        });

        it("collateral types after first collateral should be VaultCollateral when creating asset manager", async () => {
            const ci = testChainInfo.eth;
            collaterals = createTestCollaterals(contracts, ci);
            settings = createTestSettings(contracts, ci);
            //First collateral shouldn't be anything else than a Pool collateral
            const collateralsNew: CollateralType[] = collaterals;
            //Collaterals after the first should all be VaultCollateral
            //Make second and third collateral be Pool
            collaterals[1].collateralClass = collaterals[0].collateralClass;
            collaterals[2].collateralClass = collaterals[0].collateralClass;
            const res = newAssetManagerQuick(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collateralsNew, ci.assetName, ci.assetSymbol);
            await expectRevert.custom(res, "NotAVaultCollateral", []);
        });

        it("locked vault token branch test", async () => {
            // create agent
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            const r1 = await assetManager.isLockedVaultToken(agentVault.address, wNat.address);
            const collateralPoolToken = await getCollateralPoolToken(agentVault.address);
            const r2 = await assetManager.isLockedVaultToken(agentVault.address, collateralPoolToken.address);
            const r3 = await assetManager.isLockedVaultToken(agentVault.address, usdc.address);
            assert.equal(r1,false);
            assert.equal(r2,true);
            assert.equal(r3,true);
        });

        it("should not set agent owner registry if not from asset manager controller", async () => {
            const promise = assetManager.setAgentOwnerRegistry(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set agent vault factory if not from asset manager controller", async () => {
            const promise = assetManager.setAgentVaultFactory(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set collateral pool factory if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralPoolFactory(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set collateral pool token factory if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralPoolTokenFactory(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set price reader if not from asset manager controller", async () => {
            const promise = assetManager.setPriceReader(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set cleaner contract if not from asset manager controller", async () => {
            const promise = assetManager.setCleanerContract(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set fdv verification if not from asset manager controller", async () => {
            const promise = assetManager.setFdcVerification(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set cleanup block number manager if not from asset manager controller", async () => {
            const promise = assetManager.setCleanupBlockNumberManager(accounts[0]);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not upgrade FAsset implementation if not from asset manager controller", async () => {
            const promise = assetManager.upgradeFAssetImplementation(accounts[0], "0x");
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set time for payment if not from asset manager controller", async () => {
            const promise = assetManager.setTimeForPayment(0, 0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set payment challenge rewards if not from asset manager controller", async () => {
            const promise = assetManager.setPaymentChallengeReward(0, 0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set MinUpdateRepeatTimeSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setMinUpdateRepeatTimeSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set lot size if not from asset manager controller", async () => {
            const promise = assetManager.setLotSizeAmg(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setMaxTrustedPriceAgeSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setMaxTrustedPriceAgeSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setCollateralReservationFeeBips if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralReservationFeeBips(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setRedemptionFeeBips if not from asset manager controller", async () => {
            const promise = assetManager.setRedemptionFeeBips(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setRedemptionDefaultFactorVaultCollateralBIPS if not from asset manager controller", async () => {
            const promise = assetManager.setRedemptionDefaultFactorVaultCollateralBIPS(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setConfirmationByOthersAfterSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setConfirmationByOthersAfterSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setConfirmationByOthersRewardUSD5 if not from asset manager controller", async () => {
            const promise = assetManager.setConfirmationByOthersRewardUSD5(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setMaxRedeemedTickets if not from asset manager controller", async () => {
            const promise = assetManager.setMaxRedeemedTickets(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setWithdrawalOrDestroyWaitMinSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setWithdrawalOrDestroyWaitMinSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setAttestationWindowSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAttestationWindowSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setAverageBlockTimeMS if not from asset manager controller", async () => {
            const promise = assetManager.setAverageBlockTimeMS(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setMintingPoolHoldingsRequiredBIPS if not from asset manager controller", async () => {
            const promise = assetManager.setMintingPoolHoldingsRequiredBIPS(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setMintingCapAmg if not from asset manager controller", async () => {
            const promise = assetManager.setMintingCapAmg(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setTokenInvalidationTimeMinSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setTokenInvalidationTimeMinSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setVaultCollateralBuyForFlareFactorBIPS if not from asset manager controller", async () => {
            const promise = assetManager.setVaultCollateralBuyForFlareFactorBIPS(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setAgentExitAvailableTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentExitAvailableTimelockSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setAgentMintingCRChangeTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentMintingCRChangeTimelockSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setPoolExitCRChangeTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setPoolExitCRChangeTimelockSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setAgentTimelockedOperationWindowSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentTimelockedOperationWindowSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setCollateralPoolTokenTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setCollateralPoolTokenTimelockSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setLiquidationStepSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setLiquidationStepSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setLiquidationPaymentFactors if not from asset manager controller", async () => {
            const promise = assetManager.setLiquidationPaymentFactors([], []);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setMaxEmergencyPauseDurationSeconds - value zero", async () => {
            const promise = assetManager.setMaxEmergencyPauseDurationSeconds(0, { from: assetManagerController });
            await expectRevert.custom(promise, "CannotBeZero", []);
        });

        it("should not setEmergencyPauseDurationResetAfterSeconds - value zero", async () => {
            const promise = assetManager.setEmergencyPauseDurationResetAfterSeconds(0, { from: assetManagerController });
            await expectRevert.custom(promise, "CannotBeZero", []);
        });

        it("should not setMaxEmergencyPauseDurationSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setMaxEmergencyPauseDurationSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setEmergencyPauseDurationResetAfterSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setEmergencyPauseDurationResetAfterSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not setAgentFeeChangeTimelockSeconds if not from asset manager controller", async () => {
            const promise = assetManager.setAgentFeeChangeTimelockSeconds(0);
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("should not set agent owner registry if rate limited", async () => {
            await assetManager.setAgentOwnerRegistry(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentOwnerRegistry(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setAgentOwnerRegistry(accounts[0], { from: assetManagerController });
        });

        it("should not set agent vault factory if rate limited", async () => {
            await assetManager.setAgentVaultFactory(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentVaultFactory(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setAgentVaultFactory(accounts[0], { from: assetManagerController });
        });

        it("should not set collateral pool factory if rate limited", async () => {
            await assetManager.setCollateralPoolFactory(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralPoolFactory(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setCollateralPoolFactory(accounts[0], { from: assetManagerController });
        });

        it("should not set collateral pool token factory if rate limited", async () => {
            await assetManager.setCollateralPoolTokenFactory(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralPoolTokenFactory(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setCollateralPoolTokenFactory(accounts[0], { from: assetManagerController });
        });

        it("should not set price reader if rate limited", async () => {
            await assetManager.setPriceReader(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setPriceReader(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setPriceReader(accounts[0], { from: assetManagerController });
        });

        it("should not set cleaner contract if rate limited", async () => {
            await assetManager.setCleanerContract(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCleanerContract(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setCleanerContract(accounts[0], { from: assetManagerController });
        });

        it("should not set fdv verification if rate limited", async () => {
            await assetManager.setFdcVerification(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setFdcVerification(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setFdcVerification(accounts[0], { from: assetManagerController });
        });

        it("should not set cleanup block number manager if rate limited", async () => {
            await assetManager.setCleanupBlockNumberManager(accounts[1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCleanupBlockNumberManager(accounts[0], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setCleanupBlockNumberManager(accounts[0], { from: assetManagerController });
        });

        it("should not upgrade FAsset implementation if rate limited", async () => {
            const impl = await TestUUPSProxyImpl.new();
            const initCall = abiEncodeCall(impl, c => c.initialize("an init message"));
            await assetManager.upgradeFAssetImplementation(impl.address, initCall, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const initCall1 = abiEncodeCall(impl, c => c.initialize("an init message 1"));
            const promise = assetManager.upgradeFAssetImplementation(impl.address, initCall1, { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.upgradeFAssetImplementation(impl.address, initCall1, { from: assetManagerController });
        });

        it("should not set time for payment if rate limited", async () => {
            await assetManager.setTimeForPayment(100, 100, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setTimeForPayment(200, 200, { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setTimeForPayment(200, 200, { from: assetManagerController });
        });

        it("should not set payment challenge rewards if rate limited", async () => {
            const paymentChallengeRewardBIPS = settings.paymentChallengeRewardBIPS;
            const paymentChallengeRewardNAT = settings.paymentChallengeRewardUSD5;
            await assetManager.setPaymentChallengeReward(toBN(paymentChallengeRewardNAT).addn(10), toBN(paymentChallengeRewardBIPS).addn(11), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise =  assetManager.setPaymentChallengeReward(toBN(paymentChallengeRewardNAT).addn(20), toBN(paymentChallengeRewardBIPS).addn(21), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setPaymentChallengeReward(toBN(paymentChallengeRewardNAT).addn(20), toBN(paymentChallengeRewardBIPS).addn(21), { from: assetManagerController });
        });

        it("should not set MinUpdateRepeatTimeSeconds if rate limited", async () => {
            await assetManager.setMinUpdateRepeatTimeSeconds(90000, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMinUpdateRepeatTimeSeconds(91000, { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(90000 - Number(minUpdateTime) + 1);
            await assetManager.setMinUpdateRepeatTimeSeconds(91000, { from: assetManagerController });
        });

        it("should not set lot size if rate limited", async () => {
            const oldLotSize = settings.lotSizeAMG;
            await assetManager.setLotSizeAmg(toBN(oldLotSize).addn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setLotSizeAmg(toBN(oldLotSize).addn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setLotSizeAmg(toBN(oldLotSize).addn(2), { from: assetManagerController });
        });

        it("should not setMaxTrustedPriceAgeSeconds if rate limited", async () => {
            const oldValue = settings.maxTrustedPriceAgeSeconds;
            await assetManager.setMaxTrustedPriceAgeSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMaxTrustedPriceAgeSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setMaxTrustedPriceAgeSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setCollateralReservationFeeBips if rate limited", async () => {
            const oldValue = settings.collateralReservationFeeBIPS;
            await assetManager.setCollateralReservationFeeBips(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralReservationFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setCollateralReservationFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setRedemptionFeeBips if rate limited", async () => {
            const oldValue = settings.redemptionFeeBIPS;
            await assetManager.setRedemptionFeeBips(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setRedemptionFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setRedemptionFeeBips(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setRedemptionDefaultFactorVaultCollateralBIPS if rate limited", async () => {
            const oldValue = settings.redemptionDefaultFactorVaultCollateralBIPS;
            await assetManager.setRedemptionDefaultFactorVaultCollateralBIPS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setRedemptionDefaultFactorVaultCollateralBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setRedemptionDefaultFactorVaultCollateralBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setConfirmationByOthersAfterSeconds if rate limited", async () => {
            await assetManager.setConfirmationByOthersAfterSeconds(60 * 60 * 3, { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setConfirmationByOthersAfterSeconds(60 * 60 * 4, { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setConfirmationByOthersAfterSeconds(60 * 60 * 4, { from: assetManagerController });
        });

        it("should not setConfirmationByOthersRewardUSD5 if rate limited", async () => {
            const oldValue = settings.confirmationByOthersRewardUSD5;
            await assetManager.setConfirmationByOthersRewardUSD5(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setConfirmationByOthersRewardUSD5(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setConfirmationByOthersRewardUSD5(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setMaxRedeemedTickets if rate limited", async () => {
            const oldValue = settings.maxRedeemedTickets;
            await assetManager.setMaxRedeemedTickets(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMaxRedeemedTickets(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setMaxRedeemedTickets(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setWithdrawalOrDestroyWaitMinSeconds if rate limited", async () => {
            const oldValue = settings.withdrawalWaitMinSeconds;
            await assetManager.setWithdrawalOrDestroyWaitMinSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setWithdrawalOrDestroyWaitMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setWithdrawalOrDestroyWaitMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAttestationWindowSeconds if rate limited", async () => {
            const oldValue = settings.attestationWindowSeconds;
            await assetManager.setAttestationWindowSeconds(toBN(oldValue).addn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAttestationWindowSeconds(toBN(oldValue).addn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setAttestationWindowSeconds(toBN(oldValue).addn(2), { from: assetManagerController });
        });

        it("should not setAverageBlockTimeMS if rate limited", async () => {
            const oldValue = settings.averageBlockTimeMS;
            await assetManager.setAverageBlockTimeMS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAverageBlockTimeMS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setAverageBlockTimeMS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setMintingPoolHoldingsRequiredBIPS if rate limited", async () => {
            const oldValue = settings.mintingPoolHoldingsRequiredBIPS;
            await assetManager.setMintingPoolHoldingsRequiredBIPS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMintingPoolHoldingsRequiredBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setMintingPoolHoldingsRequiredBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setMintingCapAmg if rate limited", async () => {
            const lotSize = settings.lotSizeAMG;
            await assetManager.setMintingCapAmg(toBN(lotSize).addn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMintingCapAmg(toBN(lotSize).addn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setMintingCapAmg(toBN(lotSize).addn(2), { from: assetManagerController });
        });

        it("should not setTokenInvalidationTimeMinSeconds if rate limited", async () => {
            const oldValue = settings.tokenInvalidationTimeMinSeconds;
            await assetManager.setTokenInvalidationTimeMinSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setTokenInvalidationTimeMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setTokenInvalidationTimeMinSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setVaultCollateralBuyForFlareFactorBIPS if rate limited", async () => {
            const oldValue = settings.vaultCollateralBuyForFlareFactorBIPS;
            await assetManager.setVaultCollateralBuyForFlareFactorBIPS(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setVaultCollateralBuyForFlareFactorBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setVaultCollateralBuyForFlareFactorBIPS(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAgentExitAvailableTimelockSeconds if rate limited", async () => {
            const oldValue = settings.agentExitAvailableTimelockSeconds;
            await assetManager.setAgentExitAvailableTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentExitAvailableTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setAgentExitAvailableTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAgentMintingCRChangeTimelockSeconds if rate limited", async () => {
            const oldValue = settings.agentMintingCRChangeTimelockSeconds;
            await assetManager.setAgentMintingCRChangeTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentMintingCRChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setAgentMintingCRChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setPoolExitCRChangeTimelockSeconds if rate limited", async () => {
            const oldValue = settings.poolExitCRChangeTimelockSeconds;
            await assetManager.setPoolExitCRChangeTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setPoolExitCRChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setPoolExitCRChangeTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setAgentTimelockedOperationWindowSeconds if rate limited", async () => {
            const oldValue = settings.agentTimelockedOperationWindowSeconds;
            await assetManager.setAgentTimelockedOperationWindowSeconds(toBN(oldValue).addn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setAgentTimelockedOperationWindowSeconds(toBN(oldValue).addn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setAgentTimelockedOperationWindowSeconds(toBN(oldValue).addn(2), { from: assetManagerController });
        });

        it("should not setAgentTimelockedOperationWindowSeconds if value less than 1 hour", async () => {
            await expectRevert.custom(assetManager.setAgentTimelockedOperationWindowSeconds(toBN(1 * HOURS).subn(1), { from: assetManagerController }),
                "ValueTooSmall", []);
            // 1 hour is ok
            await assetManager.setAgentTimelockedOperationWindowSeconds(toBN(1 * HOURS), { from: assetManagerController });
        });

        it("should not setCollateralPoolTokenTimelockSeconds if rate limited", async () => {
            const oldValue = settings.collateralPoolTokenTimelockSeconds;
            await assetManager.setCollateralPoolTokenTimelockSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setCollateralPoolTokenTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setCollateralPoolTokenTimelockSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setLiquidationStepSeconds if rate limited", async () => {
            const oldValue = settings.liquidationStepSeconds;
            await assetManager.setLiquidationStepSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setLiquidationStepSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setLiquidationStepSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setLiquidationPaymentFactors if rate limited", async () => {
            await assetManager.setLiquidationPaymentFactors([20000], [1], { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setLiquidationPaymentFactors([30000], [2], { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setLiquidationPaymentFactors([30000], [2], { from: assetManagerController });
        });

        it("should not setMaxEmergencyPauseDurationSeconds if rate limited", async () => {
            const oldValue = settings.maxEmergencyPauseDurationSeconds;
            await assetManager.setMaxEmergencyPauseDurationSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setMaxEmergencyPauseDurationSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setMaxEmergencyPauseDurationSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });

        it("should not setEmergencyPauseDurationResetAfterSeconds if rate limited", async () => {
            const oldValue = settings.emergencyPauseDurationResetAfterSeconds;
            await assetManager.setEmergencyPauseDurationResetAfterSeconds(toBN(oldValue).subn(1), { from: assetManagerController });
            const minUpdateTime = settings.minUpdateRepeatTimeSeconds;
            // skip time
            await time.deterministicIncrease(toBN(minUpdateTime).subn(2));
            const promise = assetManager.setEmergencyPauseDurationResetAfterSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
            await expectRevert.custom(promise, "TooCloseToPreviousUpdate", []);
            await time.deterministicIncrease(1);
            await assetManager.setEmergencyPauseDurationResetAfterSeconds(toBN(oldValue).subn(2), { from: assetManagerController });
        });
    });

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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
            const collateralToken = await assetManager.getAgentVaultCollateralToken(agentVault.address)
            expect(collateralToken).to.equal(usdc.address);
        });

        it("should read agent's full vault and pool collaterals", async () => {
            const vaultCollateralDeposit = toWei(3e8);
            const poolCollateralDeposit = toWei(3e10);
            await usdc.mintAmount(agentOwner1, vaultCollateralDeposit);
            await usdc.approve(assetManager.address, vaultCollateralDeposit, { from: agentOwner1 });
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1, vaultCollateralDeposit, poolCollateralDeposit);
            const fullVaultCollateral = await assetManager.getAgentFullVaultCollateral(agentVault.address);
            expect(fullVaultCollateral.toString()).to.equal(vaultCollateralDeposit.toString());
            const fullPoolCollateral = await assetManager.getAgentFullPoolCollateral(agentVault.address);
            expect(fullPoolCollateral.toString()).to.equal(poolCollateralDeposit.toString());
        });

        it("should get agent's liquidation params", async () => {
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const agentVault = await createAvailableAgent(agentOwner1, underlyingAgent1);
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
            const allowedError = 5; // allow 5s error if clock jumps between two commands
            const event = findRequiredEvent(response, "EmergencyPauseTriggered");
            assertApproximatelyEqual(event.args.pausedUntil, expectedPauseEnd, "absolute", allowedError);
            // check simple
            assert.isTrue(await assetManager.emergencyPaused());
            assertWeb3Equal(await assetManager.emergencyPausedUntil(), event.args.pausedUntil);
            return [pauseTime, toBN(event.args.pausedUntil)];
        }

        it("only asset manager controller can pause", async () => {
            await expectRevert.custom(assetManager.emergencyPause(false, 100), "OnlyAssetManagerController", []);
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
            await time.deterministicIncrease(1 * HOURS);
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
            await time.deterministicIncrease(10 * HOURS);
            assert.isTrue(await assetManager.emergencyPaused());
            // after 5 more hours, the pause should have ended
            await time.deterministicIncrease(5 * HOURS);
            assert.isFalse(await assetManager.emergencyPaused());
            // creating new pause for 12 hours, should only give us 8 hours now (total is 24)
            await triggerPauseAndCheck(false, 12 * HOURS, { expectedDuration: 8 * HOURS });
            // after 12 more hours, the pause should have ended
            await time.deterministicIncrease(12 * HOURS);
            assert.isFalse(await assetManager.emergencyPaused());
            // all the time is used up, calling pause again has no effect
            const res4 = await assetManager.emergencyPause(false, 12 * HOURS, { from: assetManagerController });
            expectEvent.notEmitted(res4, "EmergencyPauseTriggered");
            assert.isFalse(await assetManager.emergencyPaused());
            assertWeb3Equal(await assetManager.emergencyPausedUntil(), 0);
            // after 1 week, the pause time accounting is reset
            await time.deterministicIncrease(1 * WEEKS);
            // now the full pause time can be triggered again
            await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
        });

        it("governance can pause anytime and for unlimited time", async () => {
            // use up all pause time
            await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
            // after 24 hours, the pause should have ended
            await time.deterministicIncrease(24 * HOURS);
            assert.isFalse(await assetManager.emergencyPaused());
            // all the time is used up, calling pause again has no effect
            const res2 = await assetManager.emergencyPause(false, 12 * HOURS, { from: assetManagerController });
            expectEvent.notEmitted(res2, "EmergencyPauseTriggered");
            assert.isFalse(await assetManager.emergencyPaused());
            assertWeb3Equal(await assetManager.emergencyPausedUntil(), 0);
            // but governance can still pause and for more than 24 hours
            await triggerPauseAndCheck(true, 48 * HOURS, { expectedDuration: 48 * HOURS });
            // after 40 more hours pause should still be on
            await time.deterministicIncrease(40 * HOURS);
            assert.isTrue(await assetManager.emergencyPaused());
            // after 8 more hours, the pause should have ended
            await time.deterministicIncrease(8 * HOURS);
            assert.isFalse(await assetManager.emergencyPaused());
        });

        it("governance can reset pause time", async () => {
            // use up all pause time
            await triggerPauseAndCheck(false, 24 * HOURS, { expectedDuration: 24 * HOURS });
            // after 24 hours, the pause should have ended
            await time.deterministicIncrease(24 * HOURS);
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
            await time.deterministicIncrease(24 * HOURS);
            assert.isFalse(await assetManager.emergencyPaused());
            // reset
            const promise = assetManager.resetEmergencyPauseTotalDuration();
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("others cannot pause/unpause when governance pause is active", async () => {
            // governance pause
            const [time1, expectedEnd1] = await triggerPauseAndCheck(true, 4 * HOURS, { expectedDuration: 4 * HOURS });
            // wait a bit, pause still active
            await time.deterministicIncrease(2 * HOURS);
            assert.isTrue(await assetManager.emergencyPaused());
            // try to unpause
            await expectRevert.custom(assetManager.emergencyPause(false, 0, { from: assetManagerController }), "PausedByGovernance", []);
            // try to increase pause
            await expectRevert.custom(assetManager.emergencyPause(false, 12 * HOURS, { from: assetManagerController }), "PausedByGovernance", []);
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
            const allowedError = 5; // allow 5s error if clock jumps between two commands
            const event = findRequiredEvent(response, "EmergencyPauseTransfersTriggered");
            assertApproximatelyEqual(event.args.pausedUntil, expectedPauseEnd, "absolute", allowedError);
            // check simple
            assert.isTrue(await assetManager.transfersEmergencyPaused());
            assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), event.args.pausedUntil);
            return [pauseTime, toBN(event.args.pausedUntil)];
        }

        it("only asset manager controller can pause", async () => {
            await expectRevert.custom(assetManager.emergencyPauseTransfers(false, 100), "OnlyAssetManagerController", []);
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
            await time.deterministicIncrease(1 * HOURS);
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
            await time.deterministicIncrease(10 * HOURS);
            assert.isTrue(await assetManager.transfersEmergencyPaused());
            // after 5 more hours, the pause should have ended
            await time.deterministicIncrease(5 * HOURS);
            assert.isFalse(await assetManager.transfersEmergencyPaused());
            // creating new pause for 12 hours, should only give us 8 hours now (total is 24)
            await triggerPauseAndCheck(false, 12 * HOURS, { expectedDuration: 8 * HOURS });
            // after 12 more hours, the pause should have ended
            await time.deterministicIncrease(12 * HOURS);
            assert.isFalse(await assetManager.transfersEmergencyPaused());
            // all the time is used up, calling pause again has no effect
            const res4 = await assetManager.emergencyPauseTransfers(false, 12 * HOURS, { from: assetManagerController });
            expectEvent.notEmitted(res4, "EmergencyPauseTransfersTriggered");
            assert.isFalse(await assetManager.transfersEmergencyPaused());
            assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), 0);
            // after 1 week, the pause time accounting is reset
            await time.deterministicIncrease(1 * WEEKS);
            // now the full pause time can be triggered again
            await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
        });

        it("governance can pause anytime and for unlimited time", async () => {
            // use up all pause time
            await triggerPauseAndCheck(false, 30 * HOURS, { expectedDuration: 24 * HOURS });
            // after 24 hours, the pause should have ended
            await time.deterministicIncrease(24 * HOURS);
            assert.isFalse(await assetManager.transfersEmergencyPaused());
            // all the time is used up, calling pause again has no effect
            const res2 = await assetManager.emergencyPauseTransfers(false, 12 * HOURS, { from: assetManagerController });
            expectEvent.notEmitted(res2, "EmergencyPauseTransfersTriggered");
            assert.isFalse(await assetManager.transfersEmergencyPaused());
            assertWeb3Equal(await assetManager.transfersEmergencyPausedUntil(), 0);
            // but governance can still pause and for more than 24 hours
            await triggerPauseAndCheck(true, 48 * HOURS, { expectedDuration: 48 * HOURS });
            // after 40 more hours pause should still be on
            await time.deterministicIncrease(40 * HOURS);
            assert.isTrue(await assetManager.transfersEmergencyPaused());
            // after 8 more hours, the pause should have ended
            await time.deterministicIncrease(8 * HOURS);
            assert.isFalse(await assetManager.transfersEmergencyPaused());
        });

        it("governance can reset pause time", async () => {
            // use up all pause time
            await triggerPauseAndCheck(false, 24 * HOURS, { expectedDuration: 24 * HOURS });
            // after 24 hours, the pause should have ended
            await time.deterministicIncrease(24 * HOURS);
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
            await time.deterministicIncrease(24 * HOURS);
            assert.isFalse(await assetManager.transfersEmergencyPaused());
            // reset
            const promise = assetManager.resetEmergencyPauseTotalDuration();
            await expectRevert.custom(promise, "OnlyAssetManagerController", []);
        });

        it("others cannot pause/unpause when governance pause is active", async () => {
            // governance pause
            const [time1, expectedEnd1] = await triggerPauseAndCheck(true, 4 * HOURS, { expectedDuration: 4 * HOURS });
            // wait a bit, pause still active
            await time.deterministicIncrease(2 * HOURS);
            assert.isTrue(await assetManager.transfersEmergencyPaused());
            // try to unpause
            await expectRevert.custom(assetManager.emergencyPauseTransfers(false, 0, { from: assetManagerController }), "PausedByGovernance", []);
            // try to increase pause
            await expectRevert.custom(assetManager.emergencyPauseTransfers(false, 12 * HOURS, { from: assetManagerController }), "PausedByGovernance", []);
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
