import { CollateralType } from "../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager, newAssetManagerController, waitForTimelock } from "../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createAgentOwnerRegistry, createTestAgentSettings, createTestCollaterals, createTestContracts, createTestSettings, whitelistAgentOwner } from "../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { AttestationHelper } from "../../../lib/underlying-chain/AttestationHelper";
import { findRequiredEvent } from "../../../lib/utils/events/truffle";
import { ZERO_ADDRESS, abiEncodeCall, erc165InterfaceId, toBNExp } from "../../../lib/utils/helpers";
import { web3DeepNormalize } from "../../../lib/utils/web3normalize";
import { AgentOwnerRegistryInstance, AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerControllerInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../typechain-truffle";

const AgentOwnerRegistry = artifacts.require("AgentOwnerRegistry");
const AgentVault = artifacts.require('AgentVault');

contract(`AgentOwnerRegistry.sol; ${getTestFile(__filename)}; Agent owner registry tests`, accounts => {
    const governance = accounts[10];
    const updateExecutor = accounts[11];
    let assetManagerController: IIAssetManagerControllerInstance;
    let contracts: TestSettingsContracts;
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
    let agentOwnerRegistry: AgentOwnerRegistryInstance;

    const underlyingBurnAddr = "Burn";
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[23];
    const underlyingAgent1 = "Agent1";

    async function createAgentVault(owner: string, underlyingAddress: string): Promise<AgentVaultInstance> {
        // update current block in asset manager
        const blockHeightProof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        await assetManager.updateCurrentBlock(blockHeightProof);
        await whitelistAgentOwner(agentOwnerRegistry.address, owner);
        chain.mint(underlyingAddress, toBNExp(100, 18));
        const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAddress);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const agentSettings = createTestAgentSettings(usdc.address);
        const response = await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: owner });
        return AgentVault.at(findRequiredEvent(response, 'AgentVaultCreated').args.agentVault);
    }

    async function initialize() {
        const ci = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        await contracts.governanceSettings.setExecutors([governance, updateExecutor], { from: governance });
        // save some contracts as globals
        ({ wNat } = contracts);
        usdc = contracts.stablecoins.USDC;
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager controller
        assetManagerController = await newAssetManagerController(contracts.governanceSettings.address, governance, contracts.addressUpdater.address);
        await assetManagerController.switchToProductionMode({ from: governance });
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals,
            ci.assetName, ci.assetSymbol, { governanceSettings: contracts.governanceSettings, updateExecutor });

        agentOwnerRegistry = await createAgentOwnerRegistry(contracts.governanceSettings, governance);
        await agentOwnerRegistry.switchToProductionMode({ from: governance });

        const res = await assetManagerController.setAgentOwnerRegistry([assetManager.address], agentOwnerRegistry.address, { from: governance });
        await waitForTimelock(res, assetManagerController, updateExecutor);
        return { contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, assetManagerController, collaterals, settings, assetManager, fAsset, agentOwnerRegistry };
    }

    beforeEach(async () => {
        ({ contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, assetManagerController, collaterals, settings, assetManager, fAsset, agentOwnerRegistry } =
            await loadFixtureCopyVars(initialize));
    });

    describe("whitelist functions", () => {
        it('should not add addresses if not governance or manager', async function () {
            const res = agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url");
            await expectRevert.custom(res, "OnlyGovernanceOrManager", []);
        });

        it('should not add address 0', async function () {
            const res = agentOwnerRegistry.whitelistAndDescribeAgent(ZERO_ADDRESS, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            await expectRevert.custom(res, "AddressZero", []);
        });

        it('should add addresses to the whitelist', async function () {
            const res = await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[0], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            expectEvent(res, "Whitelisted");
            const res1 = await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[1], "Agent 2", "Agent 2 description", "Agent 2 icon url", "Agent 2 tou url", { from: governance });
            expectEvent(res1, "Whitelisted");
            const isWhitelisted0 = await agentOwnerRegistry.isWhitelisted(accounts[0]);
            const isWhitelisted1 = await agentOwnerRegistry.isWhitelisted(accounts[1]);

            assert.equal(isWhitelisted0, true);
            assert.equal(isWhitelisted1, true);
        });

        it('should not add addresses to the whitelist twice', async function () {
            const res = await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[0], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            expectEvent(res, "Whitelisted");
            const res2 = await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[0], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            expectEvent.notEmitted(res2, "Whitelisted");
        });

        it('should revoke addresses from the whitelist', async function () {
            const res_1 = await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[0], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            const res_2 = await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[1], "Agent 2", "Agent 2 description", "Agent 2 icon url", "Agent 2 tou url", { from: governance });
            const isWhitelisted0 = await agentOwnerRegistry.isWhitelisted(accounts[0]);
            const isWhitelisted1 = await agentOwnerRegistry.isWhitelisted(accounts[1]);

            assert.equal(isWhitelisted0, true);
            assert.equal(isWhitelisted1, true);

            await agentOwnerRegistry.revokeAddress(accounts[0], { from: governance });
            const isWhitelisted = await agentOwnerRegistry.isWhitelisted(accounts[0]);
            assert.equal(isWhitelisted, false);
        });

        it("should not revoke address from the whitelist if not governance or manager", async () => {
            await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[0], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            await expectRevert.custom(agentOwnerRegistry.revokeAddress(accounts[0], {from: accounts[5]}), "OnlyGovernanceOrManager", []);
        });

        it('should not revoke addresses from the whitelist twice', async function () {
            const res = await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[0], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            expectEvent(res, "Whitelisted");
            const res2w = await agentOwnerRegistry.revokeAddress(accounts[0], { from: governance });
            expectEvent(res2w, "WhitelistingRevoked");
            const res3w = await agentOwnerRegistry.revokeAddress(accounts[0], { from: governance });
            expectEvent.notEmitted(res3w, "WhitelistingRevoked");
            const res4w = await agentOwnerRegistry.revokeAddress(accounts[5], { from: governance });
            expectEvent.notEmitted(res4w, "WhitelistingRevoked");
        });

        it("governance can assign manager", async () => {
            const manager = accounts[15];
            const res = await waitForTimelock(agentOwnerRegistry.setManager(manager, { from: governance }), agentOwnerRegistry, governance);
            expectEvent(res, "ManagerChanged", { manager });
        });

        it("manager can perform whitelisting operations", async () => {
            const manager = accounts[15];
            // cannot whitelist before being set
            await expectRevert.custom(agentOwnerRegistry.whitelistAndDescribeAgent(accounts[5], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: manager }), "OnlyGovernanceOrManager", []);
            //
            await waitForTimelock(agentOwnerRegistry.setManager(manager, { from: governance }), agentOwnerRegistry, governance);
            await agentOwnerRegistry.whitelistAndDescribeAgent(accounts[5], "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: manager });
            assert.isTrue(await agentOwnerRegistry.isWhitelisted(accounts[5]));
            // revoke
            await agentOwnerRegistry.revokeAddress(accounts[5], { from: manager });
            assert.isFalse(await agentOwnerRegistry.isWhitelisted(accounts[5]));
        });
    });

    describe("agent registry functions", () => {
        it("should not create agent from work address after revoking management address", async () => {
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const ownerWorkAddress = accounts[21];
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            await agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });
            const agentSettings = createTestAgentSettings(usdc.address);

            //Revoke address and wait for timelock
            const rev = await agentOwnerRegistry.revokeAddress(agentOwner1, { from: governance });
            await waitForTimelock(rev, agentOwnerRegistry, governance);

            //Try to create agent
            const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAgent1);
            assert.isTrue(addressValidityProof.data.responseBody.isValid);
            const res = assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: ownerWorkAddress });
            await expectRevert.custom(res, "AgentNotWhitelisted", []);
        });
    });

    describe("setting work address", () => {
        it("should set owner work address", async () => {
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            // create agent
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            // set owner work address
            await agentOwnerRegistry.setWorkAddress("0xe34BDff68a5b89216D7f6021c1AB25c012142425", { from: agentOwner1 });
            const managementAddress = await assetManager.getAgentVaultOwner(agentVault.address);
            const info = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(managementAddress, agentOwner1);
            assert.equal(info.ownerManagementAddress, agentOwner1);
            assert.equal(info.ownerWorkAddress, "0xe34BDff68a5b89216D7f6021c1AB25c012142425");
            // set owner work address again
            await agentOwnerRegistry.setWorkAddress("0x27e80dB1f5a975f4C43C5eC163114E796cdB603D", { from: agentOwner1 });
            const info2 = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(info2.ownerManagementAddress, agentOwner1);
            assert.equal(info2.ownerWorkAddress, "0x27e80dB1f5a975f4C43C5eC163114E796cdB603D");
            // set owner work address again with address 0
            await agentOwnerRegistry.setWorkAddress(ZERO_ADDRESS, { from: agentOwner1 });
            const info3 = await assetManager.getAgentInfo(agentVault.address);
            assert.equal(info3.ownerManagementAddress, agentOwner1);
            assert.equal(info3.ownerWorkAddress, ZERO_ADDRESS);
        });

        it("should not set owner work address when not whitelisted", async () => {
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const ownerWorkAddress = accounts[21];
            const res = agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });
            await expectRevert.custom(res, "AgentNotWhitelisted", []);
        });

        it("should set owner work address after whitelisting", async () => {
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const ownerWorkAddress = accounts[21];
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            await agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });
            const res = await agentOwnerRegistry.isWhitelisted(agentOwner1);
            assert.equal(res, true);
        });

        it("should not allow setting work address if work address is set on another agent owner", async () => {
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const ownerWorkAddress = accounts[21];
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            await agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });

            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner2, "Agent 2", "Agent 2 description", "Agent 2 icon url", "Agent 2 tou url", { from: governance });
            const res = agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner2 });
            await expectRevert.custom(res, "WorkAddressInUse", []);
        });

        it("checking agent vault owner with work address should work", async () => {
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            // create agent
            const agentVault = await createAgentVault(agentOwner1, underlyingAgent1);
            const workAddress = "0xe34BDff68a5b89216D7f6021c1AB25c012142425";
            // set owner work address
            await agentOwnerRegistry.setWorkAddress(workAddress, { from: agentOwner1 });
            assert.equal(await assetManager.isAgentVaultOwner(agentVault.address, workAddress), true);
        });

        it("should not set owner work address when not whitelisted", async () => {
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const ownerWorkAddress = accounts[21];
            const res = agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });
            await expectRevert.custom(res, "AgentNotWhitelisted", []);
        });

        it("should set owner work address after whitelisting", async () => {
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const ownerWorkAddress = accounts[21];
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            await agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });
            const res = await agentOwnerRegistry.isWhitelisted(agentOwner1);
            assert.equal(res, true);
        });

        it("should not allow setting work address if work address is set on another agent owner", async () => {
            chain.mint(underlyingAgent1, toBNExp(100, 18));
            const ownerWorkAddress = accounts[21];
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            await agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });

            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner2, "Agent 2", "Agent 2 description", "Agent 2 icon url", "Agent 2 tou url", { from: governance });
            const res = agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner2 });
            await expectRevert.custom(res, "WorkAddressInUse", []);
        });
    });

    describe("Agent owner data", () => {
        it("should set owner data with whitelisting", async () => {
            const name = "Agent 1";
            const description = "This is first agent";
            const iconUrl = "https://some.address/icon.jpg";
            const touUrl = "https://some.address/tos.html";
            const res = await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, name, description, iconUrl, touUrl, { from: governance });
            expectEvent(res, "Whitelisted", { value: agentOwner1 });
            expectEvent(res, "AgentDataChanged", { managementAddress: agentOwner1, name, description, iconUrl, termsOfUseUrl: touUrl });
            assert.equal(await agentOwnerRegistry.isWhitelisted(agentOwner1), true);
            assert.equal(await agentOwnerRegistry.getAgentName(agentOwner1), name);
            assert.equal(await agentOwnerRegistry.getAgentDescription(agentOwner1), description);
            assert.equal(await agentOwnerRegistry.getAgentIconUrl(agentOwner1), iconUrl);
            assert.equal(await agentOwnerRegistry.getAgentTermsOfUseUrl(agentOwner1), touUrl);
        });

        it("should set owner data for already whitelisted agent", async () => {
            const name = "Agent 1";
            const description = "This is first agent";
            const iconUrl = "https://some.address/icon.jpg";
            const touUrl = "https://some.address/tos.html";
            await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, "Agent 1", "Agent 1 description", "Agent 1 icon url", "Agent 1 tou url", { from: governance });
            const res = await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, name, description, iconUrl, touUrl, { from: governance });
            expectEvent.notEmitted(res, "Whitelisted");
            expectEvent(res, "AgentDataChanged", { managementAddress: agentOwner1, name, description, iconUrl, termsOfUseUrl: touUrl });
            assert.equal(await agentOwnerRegistry.isWhitelisted(agentOwner1), true);
            assert.equal(await agentOwnerRegistry.getAgentName(agentOwner1), name);
            assert.equal(await agentOwnerRegistry.getAgentDescription(agentOwner1), description);
            assert.equal(await agentOwnerRegistry.getAgentIconUrl(agentOwner1), iconUrl);
            assert.equal(await agentOwnerRegistry.getAgentTermsOfUseUrl(agentOwner1), touUrl);
        });

        it("should update separate pieces of owner data", async () => {
            const name = "Agent 1";
            const description = "This is first agent";
            const iconUrl = "https://some.address/icon.jpg";
            const touUrl = "https://some.address/tos.html";
            const nameU = "Agent 1 updated";
            const descriptionU = "This is first agent updated";
            const iconUrlU = "https://some.address/icon-updated.jpg";
            const touUrlU = "https://some.address/tos-updated.html";
            const res = await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, name, description, iconUrl, touUrl, { from: governance });
            expectEvent(res, "AgentDataChanged", { managementAddress: agentOwner1, name, description, iconUrl, termsOfUseUrl: touUrl });

            const res1 = await agentOwnerRegistry.setAgentName(agentOwner1, nameU, { from: governance });
            expectEvent(res1, "AgentDataChanged", { managementAddress: agentOwner1, name: nameU, description, iconUrl, termsOfUseUrl: touUrl });
            assert.equal(await agentOwnerRegistry.getAgentName(agentOwner1), nameU);

            const res2 = await agentOwnerRegistry.setAgentDescription(agentOwner1, descriptionU, { from: governance });
            expectEvent(res2, "AgentDataChanged", { managementAddress: agentOwner1, name: nameU, description: descriptionU, iconUrl, termsOfUseUrl: touUrl });
            assert.equal(await agentOwnerRegistry.getAgentDescription(agentOwner1), descriptionU);

            const res3 = await agentOwnerRegistry.setAgentIconUrl(agentOwner1, iconUrlU, { from: governance });
            expectEvent(res3, "AgentDataChanged", { managementAddress: agentOwner1, name: nameU, description: descriptionU, iconUrl: iconUrlU, termsOfUseUrl: touUrl });
            assert.equal(await agentOwnerRegistry.getAgentIconUrl(agentOwner1), iconUrlU);

            const res4 = await agentOwnerRegistry.setAgentTermsOfUseUrl(agentOwner1, touUrlU, { from: governance });
            expectEvent(res4, "AgentDataChanged", { managementAddress: agentOwner1, name: nameU, description: descriptionU, iconUrl: iconUrlU, termsOfUseUrl: touUrlU });
            assert.equal(await agentOwnerRegistry.getAgentTermsOfUseUrl(agentOwner1), touUrlU);
        });

        it("only governance can set agent data", async () => {
            const name = "Agent 1";
            const description = "This is first agent";
            const iconUrl = "https://some.address/icon.jpg";
            const touUrl = "https://some.address/tos.html";
            await expectRevert.custom(agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, name, description, iconUrl, touUrl, { from: accounts[1] }), "OnlyGovernanceOrManager", []);

            await expectRevert.custom(agentOwnerRegistry.setAgentName(agentOwner1, name), "OnlyGovernanceOrManager", []);
            await expectRevert.custom(agentOwnerRegistry.setAgentDescription(agentOwner1, description), "OnlyGovernanceOrManager", []);
            await expectRevert.custom(agentOwnerRegistry.setAgentIconUrl(agentOwner1, iconUrl), "OnlyGovernanceOrManager", []);
            await expectRevert.custom(agentOwnerRegistry.setAgentTermsOfUseUrl(agentOwner1, touUrl), "OnlyGovernanceOrManager", []);
        });

        it("manager can also set agent data", async () => {
            const manager = accounts[15];
            const name = "Agent 1";
            const description = "This is first agent";
            const iconUrl = "https://some.address/icon.jpg";
            const touUrl = "https://some.address/tos.html";
            // cannot whitelist before being set
            await expectRevert.custom(agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, name, description, iconUrl, touUrl, { from: manager }), "OnlyGovernanceOrManager", []);
            //
            await waitForTimelock(agentOwnerRegistry.setManager(manager, { from: governance }), agentOwnerRegistry, governance);
            // now it should work
            const res = await agentOwnerRegistry.whitelistAndDescribeAgent(agentOwner1, name, description, iconUrl, touUrl, { from: manager });
            expectEvent(res, "AgentDataChanged");
        });
    });

    describe("UUPS upgrade", () => {
        it("should upgrade and downgrade", async () => {
            const TestUUPSProxyImpl = artifacts.require("TestUUPSProxyImpl")
            const testProxy = await TestUUPSProxyImpl.at(agentOwnerRegistry.address);
            // test method doesn't work now
            await expectRevert(testProxy.testResult(), "function selector was not recognized and there's no fallback function");
            // prepare upgrade
            const testProxyImpl = await TestUUPSProxyImpl.new();
            const initCall = abiEncodeCall(testProxyImpl, c => c.initialize("an init message"));
            // upgrade requires governance
            await expectRevert.custom(agentOwnerRegistry.upgradeTo(testProxyImpl.address), "OnlyGovernance", []);
            await expectRevert.custom(agentOwnerRegistry.upgradeToAndCall(testProxyImpl.address, initCall), "OnlyGovernance", []);
            // upgrade
            const res = await agentOwnerRegistry.upgradeToAndCall(testProxyImpl.address, initCall, { from: governance });
            await waitForTimelock(res, agentOwnerRegistry, governance);
            // test method works now
            assertWeb3Equal(await testProxy.testResult(), "an init message");
            // downgrade
            const registryImpl = await AgentOwnerRegistry.new();
            await agentOwnerRegistry.upgradeTo(registryImpl.address, { from: governance });
            // test method doesn't work any more
            await expectRevert(testProxy.testResult(), "function selector was not recognized and there's no fallback function");
        });

    });

    describe("ERC-165 interface identification for Agent Owner Registry", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as 'IERC165');
            const IAgentOwnerRegistry = artifacts.require("IAgentOwnerRegistry");
            const iERC165 = await IERC165.at(agentOwnerRegistry.address);
            const iAgentOwnerRegistry = await IAgentOwnerRegistry.at(agentOwnerRegistry.address);
            assert.isTrue(await agentOwnerRegistry.supportsInterface(erc165InterfaceId(iERC165.abi)));
            assert.isTrue(await agentOwnerRegistry.supportsInterface(erc165InterfaceId(iAgentOwnerRegistry.abi)));
            assert.isFalse(await agentOwnerRegistry.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });
});
