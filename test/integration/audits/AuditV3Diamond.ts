import { AssetContext } from "../../../lib/test-utils/actors/AssetContext";
import { CommonContext } from "../../../lib/test-utils/actors/CommonContext";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { abiEncodeCall, ZERO_ADDRESS } from "../../../lib/utils/helpers";

contract(`AuditV3Diamond.ts; ${getTestFile(__filename)}; FAsset diamond design audit tests`, accounts => {
    const governance = accounts[10];
    // addresses on mock underlying chain can be any string, as long as it is unique

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

    it.skip("Coinspect - Destroy AssetManagerDiamondCutFacet implementation", async () => {
        // For this test, an extended interface for GovernedBase was coded
        // It extends IGoverned with the initialise() function
        const IDiamondCut = artifacts.require("IDiamondCut");
        const AssetManagerInit = artifacts.require("AssetManagerInit");
        // diamondCuts is an array of facets, the first one is the AssetManagerDiamondCutFacet
        const assetManagerDiamondCutFacetAddr = await context.assetManager.facetAddress('0x1f931c1c');
        // The AssetManagerDiamondCutFacet implements both IDiamondCut and IGovernedBase
        const iDiamondCut = await IDiamondCut.at(assetManagerDiamondCutFacetAddr);
        const iGovernedBase = await AssetManagerInit.at(assetManagerDiamondCutFacetAddr);
        // Deploy fake governance settings
        const FakeGovernanceSettings = artifacts.require("GovernanceSettingsMock");
        const fakeGovSettings = await FakeGovernanceSettings.new();
        // Deploy a suicidal contract (will be used in a delegated context)
        const SuicidalContract = artifacts.require("SuicidalMock");
        const suicidalContract = await SuicidalContract.new(ZERO_ADDRESS);
        // Call initialise directly on the implementation
        // initialise is now internal so the call cannot even be made
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        await (iGovernedBase as any).initialise(fakeGovSettings.address, accounts[1]);
        // Execute the call to selfdestruct the AssetManagerDiamondCutFacet
        // getTimelock() == 0 from the FakeGovernanceSettings
        // No call will be enqueued as it will be executed directly
        // get init parameters for the diamondCut call
        const initParametersEncodedCall = abiEncodeCall(suicidalContract, (sc) => sc.die());
        // Fetch the contract's bytecode
        let bytecode = await web3.eth.getCode(iGovernedBase.address);
        // Calculate the size of the bytecode (subtract 2 for the '0x', divide by 2 to go from hex digits to bytes)
        let size = (bytecode.length - 2) / 2;
        // Call diamondCut passing no Facets, the suicidal contract and die() encoded
        console.log("[BEFORE] - AssetManagerDiamondCutFacet size (bytes):", size);
        const res = await iDiamondCut.diamondCut([], suicidalContract.address, initParametersEncodedCall, { from: accounts[1], });
        // Fetch the contract's bytecode
        bytecode = await web3.eth.getCode(iGovernedBase.address);
        // Calculate the size of the bytecode
        size = (bytecode.length - 2) / 2;
        console.log("[AFTER] - AssetManagerDiamondCutFacet size (bytes):", size);
    });

    it("Fix - Destroy AssetManagerDiamondCutFacet implementation prevented", async () => {
        // For this test, an extended interface for GovernedBase was coded
        // It extends IGoverned with the initialise() function
        const IDiamondCut = artifacts.require("IDiamondCut");
        const IGovernedBase = artifacts.require("GovernedBase");
        // diamondCuts is an array of facets, the first one is the AssetManagerDiamondCutFacet
        const assetManagerDiamondCutFacetAddr = await context.assetManager.facetAddress('0x1f931c1c');
        // The AssetManagerDiamondCutFacet implements both IDiamondCut and IGovernedBase
        const iDiamondCut = await IDiamondCut.at(assetManagerDiamondCutFacetAddr);
        const iGovernedBase = await IGovernedBase.at(assetManagerDiamondCutFacetAddr);
        // Deploy fake governance settings
        const FakeGovernanceSettings = artifacts.require("GovernanceSettingsMock");
        const fakeGovSettings = await FakeGovernanceSettings.new();
        // Deploy a suicidal contract (will be used in a delegated context)
        const SuicidalContract = artifacts.require("SuicidalMock");
        const suicidalContract = await SuicidalContract.new(ZERO_ADDRESS);
        // Call initialise directly on the implementation
        // initialise is now internal so the call cannot even be made
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
        assert.throw(() => (iGovernedBase as any).initialise(fakeGovSettings.address, accounts[1]), "iGovernedBase.initialise is not a function");
    });
});
