import { CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { executeTimelockedGovernanceCall } from "../../../../lib/test-utils/contract-test-helpers";
import { AssetManagerInitSettings, deployAssetManagerFacets, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestCollaterals, createTestContracts, createTestSettings } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { DiamondCut, DiamondSelectors, FacetCutAction } from "../../../../lib/utils/diamond";
import { requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { ZERO_ADDRESS } from "../../../../lib/utils/helpers";
import { AssetManagerInitInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";

contract(`AssetManager.sol; ${getTestFile(__filename)}; Asset manager diamond tests`, accounts => {
    const governance = accounts[10];
    const executor = accounts[11];
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

    async function initialize() {
        const ci = testChainInfo.xrp;
        contracts = await createTestContracts(governance);
        await contracts.governanceSettings.setExecutors([executor], { from: governance });
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
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol,
            { governanceSettings: contracts.governanceSettings, updateExecutor: executor });
        await assetManager.switchToProductionMode({ from: governance });
        return { contracts, diamondCuts, assetManagerInit, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, usdt };
    }

    beforeEach(async () => {
        ({ contracts, diamondCuts, assetManagerInit, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, usdt } = await loadFixtureCopyVars(initialize));
    });

    describe("governed with extra timelock", () => {
        it("can add a new cut to asset manager", async () => {
            const test1Facet = await artifacts.require("Test1Facet").new();
            const selectors = DiamondSelectors.fromABI(test1Facet).remove(["supportsInterface(bytes4)"]);
            const test1Cut: DiamondCut = {
                action: FacetCutAction.Add,
                facetAddress: test1Facet.address,
                functionSelectors: selectors.selectors
            };
            await executeTimelockedGovernanceCall(assetManager, (gov) => assetManager.diamondCut([test1Cut], ZERO_ADDRESS, "0x0", { from: gov }));
            // assert
            const loupeRes = await assetManager.facetFunctionSelectors(test1Facet.address);
            assert.isAbove(loupeRes.length, 10);
        });

        it("must wait at least diamondCutMinTimelockSeconds when adding cut", async () => {
            const test1Facet = await artifacts.require("Test1Facet").new();
            const selectors = DiamondSelectors.fromABI(test1Facet).remove(["supportsInterface(bytes4)"]);
            const test1Cut: DiamondCut = {
                action: FacetCutAction.Add,
                facetAddress: test1Facet.address,
                functionSelectors: selectors.selectors
            };
            const res = await assetManager.diamondCut([test1Cut], ZERO_ADDRESS, "0x0", { from: governance });
            const timelocked = requiredEventArgs(res, "GovernanceCallTimelocked");
            // assert
            await time.deterministicIncrease(300);
            await expectRevert.custom(assetManager.executeGovernanceCall(timelocked.encodedCall, { from: executor }),
                "TimelockNotAllowedYet", []);
            await time.deterministicIncrease(3600);
            await assetManager.executeGovernanceCall(timelocked.encodedCall, { from: executor });
        });

        it("if diamondCutMinTimelockSeconds is small, GovernanceSettings.timelock applies", async () => {
            // init
            const ci = testChainInfo.xrp;
            const settings2: AssetManagerInitSettings = { ...settings, diamondCutMinTimelockSeconds: 0 };
            const [assetManager2] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings2, collaterals, ci.assetName, ci.assetSymbol,
                { governanceSettings: contracts.governanceSettings, updateExecutor: executor });
            await assetManager2.switchToProductionMode({ from: governance });
            // act
            const test1Facet = await artifacts.require("Test1Facet").new();
            const selectors = DiamondSelectors.fromABI(test1Facet).remove(["supportsInterface(bytes4)"]);
            const test1Cut: DiamondCut = {
                action: FacetCutAction.Add,
                facetAddress: test1Facet.address,
                functionSelectors: selectors.selectors
            };
            const res = await assetManager2.diamondCut([test1Cut], ZERO_ADDRESS, "0x0", { from: governance });
            const timelocked = requiredEventArgs(res, "GovernanceCallTimelocked");
            // assert
            await time.deterministicIncrease(30);
            await expectRevert.custom(assetManager2.executeGovernanceCall(timelocked.encodedCall, { from: executor }),
                "TimelockNotAllowedYet", []);
            await time.deterministicIncrease(60);
            await assetManager2.executeGovernanceCall(timelocked.encodedCall, { from: executor });
        });
    });
});
