import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { newAssetManager, waitForTimelock } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { expectEvent, expectRevert } from "../../../../lib/test-utils/test-helpers";
import { SourceNetwork, createTestCollaterals, createTestContracts, createTestSettings } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { ZERO_ADDRESS, abiEncodeCall } from "../../../../lib/utils/helpers";
import { IIAssetManagerInstance } from "../../../../typechain-truffle";

const ForbiddenAddressesInit = artifacts.require("ForbiddenAddressesInit");
const ForbiddenAddressListMock = artifacts.require("ForbiddenAddressListMock");

contract(`ForbiddenAddressesInit.sol; ${getTestFile(__filename)}; Forbidden addresses diamond cut initializer tests`, accounts => {
    const governance = accounts[10];
    const executor = accounts[11];
    const assetManagerController = accounts[11];
    let assetManager: IIAssetManagerInstance;

    async function initialize() {
        const ci = testChainInfo.xrp;
        const contracts = await createTestContracts(governance);
        await contracts.governanceSettings.setExecutors([executor], { from: governance });
        const collaterals = createTestCollaterals(contracts, ci);
        const settings = createTestSettings(contracts, ci);
        [assetManager] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol,
            { governanceSettings: contracts.governanceSettings, updateExecutor: executor });
        await assetManager.switchToProductionMode({ from: governance });
        return { assetManager };
    }

    beforeEach(async () => {
        ({ assetManager } = await loadFixtureCopyVars(initialize));
    });

    async function diamondCutWithForbiddenAddressesInit(forbiddenAddressList: string) {
        const forbiddenAddressesInit = await ForbiddenAddressesInit.new();
        const initCalldata = abiEncodeCall(forbiddenAddressesInit, (inst) => inst.initialize(forbiddenAddressList));
        return await waitForTimelock(assetManager.diamondCut([], forbiddenAddressesInit.address, initCalldata, { from: governance }), assetManager, executor);
    }

    it("sets the forbidden address list in the diamond cut", async () => {
        const forbiddenAddressList = await ForbiddenAddressListMock.new(SourceNetwork.Mainnet);
        const res = await diamondCutWithForbiddenAddressesInit(forbiddenAddressList.address);
        expectEvent(res, "ContractChanged", { name: "forbiddenAddressList", value: forbiddenAddressList.address });
        assertWeb3Equal(await assetManager.getForbiddenAddressList(), forbiddenAddressList.address);
        // the asset manager checks the list
        const forbiddenAddress = accounts[20];
        assert.isFalse(await assetManager.isForbiddenFlareAddress(forbiddenAddress));
        await forbiddenAddressList.addForbiddenEvmAddresses([forbiddenAddress]);
        assert.isTrue(await assetManager.isForbiddenFlareAddress(forbiddenAddress));
    });

    it("zero forbidden address list leaves the list unset", async () => {
        const res = await diamondCutWithForbiddenAddressesInit(ZERO_ADDRESS);
        expectEvent.notEmitted(res, "ContractChanged");
        assertWeb3Equal(await assetManager.getForbiddenAddressList(), ZERO_ADDRESS);
        // nothing is forbidden
        assert.isFalse(await assetManager.isForbiddenFlareAddress(accounts[20]));
    });

    it("zero forbidden address list keeps the list that is already set", async () => {
        const forbiddenAddressList = await ForbiddenAddressListMock.new(SourceNetwork.Mainnet);
        await diamondCutWithForbiddenAddressesInit(forbiddenAddressList.address);
        const res = await diamondCutWithForbiddenAddressesInit(ZERO_ADDRESS);
        expectEvent.notEmitted(res, "ContractChanged");
        assertWeb3Equal(await assetManager.getForbiddenAddressList(), forbiddenAddressList.address);
    });

    it("diamond cut reverts for a list without the asset manager's source", async () => {
        // a Testnet list holds no string list under the (mainnet) XRP source of the test asset manager
        const forbiddenAddressList = await ForbiddenAddressListMock.new(SourceNetwork.Testnet);
        await expectRevert.custom(diamondCutWithForbiddenAddressesInit(forbiddenAddressList.address), "UnsupportedSourceId");
        assertWeb3Equal(await assetManager.getForbiddenAddressList(), ZERO_ADDRESS);
    });

    it("diamond cut reverts for an address that is not a list", async () => {
        await expectRevert.custom(diamondCutWithForbiddenAddressesInit(accounts[20]), "InitializationFunctionReverted");
        assertWeb3Equal(await assetManager.getForbiddenAddressList(), ZERO_ADDRESS);
    });

    it("initializer cannot be used outside a diamond", async () => {
        const forbiddenAddressesInit = await ForbiddenAddressesInit.new();
        await expectRevert.custom(forbiddenAddressesInit.initialize(ZERO_ADDRESS), "DiamondNotInitialized", []);
    });
});
