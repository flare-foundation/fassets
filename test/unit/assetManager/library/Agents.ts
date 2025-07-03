import { ARESBase, AddressValidity, Payment } from "@flarenetwork/js-flare-common";
import { AgentSetting, AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { ether, expectEvent, expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestAgent, createTestAgentSettings, createTestCollaterals, createTestContracts, createTestSettings, whitelistAgentOwner } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { SourceId } from "../../../../lib/underlying-chain/SourceId";
import { requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BNish, ZERO_ADDRESS, toBN, toBNExp, toWei } from "../../../../lib/utils/helpers";
import { web3DeepNormalize } from "../../../../lib/utils/web3normalize";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance } from "../../../../typechain-truffle";

const CollateralPool = artifacts.require("CollateralPool");
const CollateralPoolToken = artifacts.require("CollateralPoolToken");

contract(`Agent.sol; ${getTestFile(__filename)}; Agent basic tests`, accounts => {
    const governance = accounts[10];
    const assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManager: IIAssetManagerInstance;
    let fAsset: FAssetInstance;
    let usdc: ERC20MockInstance;
    let settings: AssetManagerInitSettings;
    let collaterals: CollateralType[];
    let chain: MockChain;
    let wallet: MockChainWallet;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;

    // addresses
    const underlyingBurnAddr = "Burn";
    const agentOwner1 = accounts[20];
    const underlyingAgent1 = "Agent1";  // addresses on mock underlying chain can be any string, as long as it is unique

    function createAgent(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const vaultCollateralToken = options?.vaultCollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, chain, wallet, attestationProvider }, owner, underlyingAddress, vaultCollateralToken, options);
    }

    async function depositCollateral(owner: string, agentVault: AgentVaultInstance, amount: BN, token: ERC20MockInstance = usdc) {
        await token.mintAmount(owner, amount);
        await token.approve(agentVault.address, amount, { from: owner });
        await agentVault.depositCollateral(token.address, amount, { from: owner });
    }

    async function changeAgentSetting(owner: string, agentVault: AgentVaultInstance, name: AgentSetting, value: BNish) {
        const res = await assetManager.announceAgentSettingUpdate(agentVault.address, name, value, { from: owner });
        const announcement = requiredEventArgs(res, 'AgentSettingChangeAnnounced');
        await time.increaseTo(announcement.validAt);
        return await assetManager.executeAgentSettingUpdate(agentVault.address, name, { from: owner });
    }

    async function initialize() {
        const ci = testChainInfo.btc;
        contracts = await createTestContracts(governance);
        usdc = contracts.stablecoins.USDC;
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        return { contracts, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset };
    }

    beforeEach(async () => {
        ({ contracts, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset } = await loadFixtureCopyVars(initialize));
    });

    it("should create agent", async () => {
        // init
        chain.mint(underlyingAgent1, toBNExp(100, 18));
        // act
        // whitelist agent management address
        await whitelistAgentOwner(settings.agentOwnerRegistry, agentOwner1);
        const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAgent1);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const agentSettings = createTestAgentSettings(usdc.address);
        agentSettings.redemptionPoolFeeShareBIPS = 1;
        const res = await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: agentOwner1 });
        // assert
        expectEvent(res, "AgentVaultCreated", { owner: agentOwner1 });
        const args = requiredEventArgs(res, "AgentVaultCreated");
        assert.equal(args.creationData.underlyingAddress, underlyingAgent1);
        assert.notEqual(args.creationData.collateralPool, ZERO_ADDRESS);
        assert.notEqual(args.creationData.collateralPoolToken, ZERO_ADDRESS);
        assert.equal(args.creationData.vaultCollateralToken, usdc.address);
        assert.notEqual(args.creationData.collateralPoolToken, contracts.wNat.address);
        assertWeb3Equal(args.creationData.redemptionPoolFeeShareBIPS, 1);
    });

    it("should create agent from owner's work address", async () => {
        // init
        chain.mint(underlyingAgent1, toBNExp(100, 18));
        // whitelist agent management address
        await whitelistAgentOwner(settings.agentOwnerRegistry, agentOwner1);
        const ownerWorkAddress = accounts[21];
        await contracts.agentOwnerRegistry.setWorkAddress(ownerWorkAddress, { from: agentOwner1 });
        // act
        const addressValidityProof = await attestationProvider.proveAddressValidity(underlyingAgent1);
        assert.isTrue(addressValidityProof.data.responseBody.isValid);
        const agentSettings = createTestAgentSettings(usdc.address);
        const res = await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: ownerWorkAddress });
        // assert
        // the owner returned in the AgentVaultCreated event must be management address
        expectEvent(res, "AgentVaultCreated", { owner: agentOwner1 });
    });

    it("should detect if pool token suffix is reserved", async () => {
        const suffix = "SUFFX1";
        assert.isFalse(await assetManager.isPoolTokenSuffixReserved(suffix));
        await createAgent(agentOwner1, underlyingAgent1, { poolTokenSuffix: suffix });
        assert.isTrue(await assetManager.isPoolTokenSuffixReserved(suffix));
    });

    it("should require underlying address to not be empty", async () => {
        // init
        // act
        // assert
        const addressValidityProof = await attestationProvider.proveAddressValidity("");
        assert.isFalse(addressValidityProof.data.responseBody.isValid);
        assert.isFalse(addressValidityProof.data.responseBody.isValid);
        const agentSettings = createTestAgentSettings(usdc.address);
        // whitelist agent management address
        await whitelistAgentOwner(settings.agentOwnerRegistry, agentOwner1);
        await expectRevert.custom(assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: agentOwner1 }),
            "AddressInvalid", []);
    });

    it("should not create agent - address already claimed", async () => {
        // init
        // act
        await createAgent(agentOwner1, underlyingAgent1);
        // assert
        await expectRevert.custom(createAgent(accounts[1], underlyingAgent1),
            "AddressAlreadyClaimed", []);
    });

    it("should not create agent - underlying address used twice", async () => {
        // init
        // act
        await createAgent(agentOwner1, underlyingAgent1);
        // assert
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1),
            "AddressAlreadyClaimed", []);
    });

    it("should create expected pool token name and symbol", async () => {
        // init
        const agent = await createAgent(agentOwner1, underlyingAgent1, { poolTokenSuffix: "AGX" });
        // act
        // assert
        const pool = await CollateralPool.at(await agent.collateralPool());
        const poolToken = await CollateralPoolToken.at(await pool.poolToken());
        assert.equal(await poolToken.name(), "FAsset Collateral Pool Token BTC-AGX");
        assert.equal(await poolToken.symbol(), "FCPT-BTC-AGX");
    });

    it("should not create agent if pool token is not unique or invalid", async () => {
        // init
        const agent = await createAgent(agentOwner1, underlyingAgent1, { poolTokenSuffix: "AG-X-5" });
        // act
        // assert
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_1", { poolTokenSuffix: "AG-X-5" }),
            "SuffixReserved", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_2", { poolTokenSuffix: "" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_2", { poolTokenSuffix: "AGX12345678901234567890" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_3", { poolTokenSuffix: "A B" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_5", { poolTokenSuffix: "ABČ" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_6", { poolTokenSuffix: "ABc" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_7", { poolTokenSuffix: "A+B" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_7a", { poolTokenSuffix: "A=B" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_7b", { poolTokenSuffix: "A_B" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_8", { poolTokenSuffix: "-AB" }),
            "SuffixInvalidFormat", []);
        await expectRevert.custom(createAgent(agentOwner1, underlyingAgent1 + "_9", { poolTokenSuffix: "AB-" }),
            "SuffixInvalidFormat", []);
    });

    it("should require proof that address is valid", async () => {
        // init
        const ci = testChainInfo.btc;
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        // act
        // assert
        const addressValidityProof = await attestationProvider.proveAddressValidity("INVALID_ADDRESS");
        const agentSettings = createTestAgentSettings(usdc.address);
        // whitelist agent management address
        await whitelistAgentOwner(settings.agentOwnerRegistry, agentOwner1);
        await expectRevert.custom(assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: agentOwner1 }),
            "AddressInvalid", []);
    });

    function createAddressValidityProof(): AddressValidity.Proof {
        return {
            data: {
                "attestationType": "0x4164647265737356616c69646974790000000000000000000000000000000000",
                "sourceId": SourceId.BTC,
                "votingRound": "0",
                "lowestUsedTimestamp": "0",
                "requestBody": {
                    "addressStr": "MY_VALID_ADDRESS"
                },
                "responseBody": {
                    "isValid": true,
                    "standardAddress": "MY_VALID_ADDRESS",
                    "standardAddressHash": "0x5835bde41ad7151fa621c0d2c59b721c7be4d7df81451a418a8e76f868050272"
                }
            },
            merkleProof: []
        };
    }

    async function forceProveResponse(attestationType: string, response: ARESBase) {
        const definition = flareDataConnectorClient.definitionStore.getDefinitionForDecodedAttestationType(attestationType);
        const hash = web3.utils.keccak256(web3.eth.abi.encodeParameters([definition!.responseAbi], [response]));
        await flareDataConnectorClient.relay.setMerkleRoot(200, response.votingRound, hash);
    }

    it("should require verified proof", async () => {
        // init
        const ci = testChainInfo.btc;
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        // assert
        const addressValidityProof: AddressValidity.Proof = createAddressValidityProof();
        const agentSettings = createTestAgentSettings(usdc.address);
        // whitelist agent management address
        await whitelistAgentOwner(settings.agentOwnerRegistry, agentOwner1);
        await expectRevert.custom(assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: agentOwner1 }),
            "AddressValidityNotProven", []);
    });

    it("should require verified proof - wrong attestation type", async () => {
        // init
        const ci = testChainInfo.btc;
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        // assert
        const addressValidityProof: AddressValidity.Proof = createAddressValidityProof();
        const agentSettings = createTestAgentSettings(usdc.address);
        // should not work with wrong attestation type
        addressValidityProof.data.attestationType = Payment.TYPE;
        await forceProveResponse("AddressValidity", addressValidityProof.data);
        // whitelist agent management address
        await whitelistAgentOwner(settings.agentOwnerRegistry, agentOwner1);
        await expectRevert.custom(assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: agentOwner1 }),
            "AddressValidityNotProven", []);
        // should work with correct attestation type
        addressValidityProof.data.attestationType = AddressValidity.TYPE;
        await forceProveResponse("AddressValidity", addressValidityProof.data);
        await assetManager.createAgentVault(web3DeepNormalize(addressValidityProof), web3DeepNormalize(agentSettings), { from: agentOwner1 });
    });

    it("only owner can make agent available", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await expectRevert.custom(assetManager.makeAgentAvailable(agentVault.address),
            "OnlyAgentVaultOwner", []);
    });

    it("cannot add agent to available list if agent's status is not 'NORMAL'", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
        // act
        // assert
        await expectRevert.custom(assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 }),
            "InvalidAgentStatus", []);
    });

    it("cannot add agent to available list twice", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = toWei(3e8);
        await depositCollateral(agentOwner1, agentVault, amount);
        await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: amount });
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        // assert
        await expectRevert.custom(assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 }),
            "AgentAlreadyAvailable", []);
    });

    it("cannot add agent to available list if not enough free collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await expectRevert.custom(assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 }),
            "NotEnoughFreeCollateral", []);
    });

    it("cannot exit if not active", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = toWei(3e8);
        await depositCollateral(agentOwner1, agentVault, amount);
        // act
        // assert
        await expectRevert.custom(assetManager.exitAvailableAgentList(agentVault.address, { from: agentOwner1 }),
            "AgentNotAvailable", []);
    });

    it("only owner can exit agent", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await expectRevert.custom(assetManager.exitAvailableAgentList(agentVault.address),
            "OnlyAgentVaultOwner", []);
    });

    it("only owner can announce destroy agent", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await expectRevert.custom(assetManager.announceDestroyAgent(agentVault.address),
            "OnlyAgentVaultOwner", []);
    });

    it("cannot announce destroy agent if still active", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = toWei(3e8);
        await depositCollateral(agentOwner1, agentVault, amount);
        await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: amount });
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        // assert
        await expectRevert.custom(assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 }),
            "AgentStillAvailable", []);
    });

    it("only owner can destroy agent", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await expectRevert.custom(assetManager.destroyAgent(agentVault.address, agentOwner1),
            "OnlyAgentVaultOwner", []);
    });

    it("cannot destroy agent without announcement", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await expectRevert.custom(assetManager.destroyAgent(agentVault.address, agentOwner1, { from: agentOwner1 }),
            "DestroyNotAnnounced", []);
    });

    it("cannot destroy agent too soon", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        // act
        await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
        await time.deterministicIncrease(150);
        // assert
        await expectRevert.custom(assetManager.destroyAgent(agentVault.address, agentOwner1, { from: agentOwner1 }), "DestroyNotAllowedYet", []);
    });

    it("should destroy agent after announced withdrawal time passes", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        // act
        await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
        // should update status
        const info = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info.status, 3);
        await time.deterministicIncrease(150);
        // should not change destroy time
        await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
        await time.deterministicIncrease(150);
        const startBalance = await usdc.balanceOf(agentOwner1);
        const tx = await assetManager.destroyAgent(agentVault.address, agentOwner1, { from: agentOwner1 });
        // nothing is returned automatically, but the owner can withdraw collateral without announcement now
        assertWeb3Equal(await usdc.balanceOf(agentVault.address), amount);
        await agentVault.withdrawCollateral(usdc.address, amount, agentOwner1, { from: agentOwner1 });
        assertWeb3Equal(await usdc.balanceOf(agentVault.address), 0);
        // assert
        const recovered = (await usdc.balanceOf(agentOwner1)).sub(startBalance);
        // console.log(`recovered = ${recovered},  rec=${recipient}`);
        assert.isTrue(recovered.gte(amount), `value recovered from agent vault is ${recovered}, which is less than deposited ${amount}`);
    });

    it("only owner can announce collateral withdrawal", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await expectRevert.custom(assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100),
            "OnlyAgentVaultOwner", []);
    });

    it("should announce collateral withdrawal", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        // act
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: agentOwner1 });
        // assert
        const info = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(toBN(info.totalVaultCollateralWei).sub(toBN(info.freeVaultCollateralWei)), 100);
    });

    it("should decrease announced collateral withdrawal", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: agentOwner1 });
        // act
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 50, { from: agentOwner1 });
        // assert
        const info = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(toBN(info.totalVaultCollateralWei).sub(toBN(info.freeVaultCollateralWei)), 50);
    });

    it("should cancel announced collateral withdrawal", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: agentOwner1 });
        // act
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 0, { from: agentOwner1 });
        // assert
        const info = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info.totalVaultCollateralWei, info.freeVaultCollateralWei);
    });

    it("should withdraw collateral after announced withdrawal time passes", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: agentOwner1 });
        // act
        await time.deterministicIncrease(300);
        const startBalance = await usdc.balanceOf(agentOwner1);
        const tx = await agentVault.withdrawCollateral(usdc.address, 100, agentOwner1, { from: agentOwner1 });
        // assert
        const withdrawn = (await usdc.balanceOf(agentOwner1)).sub(startBalance);
        assertWeb3Equal(withdrawn, 100);
    });

    it("should withdraw collateral in a few transactions after announced withdrawal time passes, but not more than announced", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 101, { from: agentOwner1 });
        // act
        await time.deterministicIncrease(300);
        const startBalance = await usdc.balanceOf(agentOwner1);
        const tx1 = await agentVault.withdrawCollateral(usdc.address, 45, agentOwner1, { from: agentOwner1 });
        const withdrawn1 = (await usdc.balanceOf(agentOwner1)).sub(startBalance);
        const tx2 = await agentVault.withdrawCollateral(usdc.address, 55, agentOwner1, { from: agentOwner1 });
        const withdrawn2 = (await usdc.balanceOf(agentOwner1)).sub(startBalance);
        // assert
        assertWeb3Equal(withdrawn1, 45);
        assertWeb3Equal(withdrawn2, 100);
        await expectRevert.custom(agentVault.withdrawCollateral(usdc.address, 2, agentOwner1, { from: agentOwner1 }),
            "WithdrawalMoreThanAnnounced", []);
    });

    it("only owner can withdraw collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        // act
        // assert
        await expectRevert.custom(agentVault.withdrawCollateral(usdc.address, 100, accounts[2]),
            "OnlyOwner", []);
    });

    it("should not withdraw collateral if not accounced", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        // act
        // assert
        await expectRevert.custom(agentVault.withdrawCollateral(usdc.address, 100, agentOwner1, { from: agentOwner1 }),
            "WithdrawalNotAnnounced", []);
    });

    it("should not withdraw collateral before announced withdrawal time passes", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: agentOwner1 });
        // act
        await time.deterministicIncrease(150);
        // assert
        await expectRevert.custom(agentVault.withdrawCollateral(usdc.address, 100, agentOwner1, { from: agentOwner1 }),
            "WithdrawalNotAllowedYet", []);
    });

    it("should not withdraw collateral after too much time passes", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: agentOwner1 });
        // act
        await time.deterministicIncrease(toBN(settings.withdrawalWaitMinSeconds).add(toBN(settings.agentTimelockedOperationWindowSeconds)).addn(100));
        // assert
        await expectRevert.custom(agentVault.withdrawCollateral(usdc.address, 100, agentOwner1, { from: agentOwner1 }),
            "WithdrawalTooLate", []);
    });

    it("should not withdraw more collateral than announced", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const amount = ether('1');
        await depositCollateral(agentOwner1, agentVault, amount);
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: agentOwner1 });
        // act
        await time.deterministicIncrease(300);
        // assert
        await expectRevert.custom(agentVault.withdrawCollateral(usdc.address, 101, agentOwner1, { from: agentOwner1 }),
            "WithdrawalMoreThanAnnounced", []);
    });

    it("should change agent's min collateral ratio", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        const collateralRatioBIPS = 23000;
        await changeAgentSetting(agentOwner1, agentVault, 'mintingVaultCollateralRatioBIPS', collateralRatioBIPS);
        // assert
        const info = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info.mintingVaultCollateralRatioBIPS, collateralRatioBIPS);
    });

    it("only owner can change agent's min collateral ratio", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        const collateralRatioBIPS = 23000;
        // assert
        await expectRevert.custom(assetManager.announceAgentSettingUpdate(agentVault.address, 'mintingVaultCollateralRatioBIPS', collateralRatioBIPS),
            "OnlyAgentVaultOwner", []);
        await expectRevert.custom(assetManager.executeAgentSettingUpdate(agentVault.address, 'mintingVaultCollateralRatioBIPS'),
            "OnlyAgentVaultOwner", []);
    });

    it("should not set too low agent's min collateral ratio", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        const collateralRatioBIPS = 1_4000 - 1;
        // assert
        await expectRevert.custom(changeAgentSetting(agentOwner1, agentVault, 'mintingVaultCollateralRatioBIPS', collateralRatioBIPS),
            "CollateralRatioTooSmall", []);
        const info = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info.mintingVaultCollateralRatioBIPS, 1_6000);
    });

    it("anyone can call convertDustToTicket", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        // assert
        await assetManager.convertDustToTicket(agentVault.address);
    });

    it("bot should respond to agent ping", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        const ping = await assetManager.agentPing(agentVault.address, 1, { from: accounts[18] });
        expectEvent(ping, "AgentPing", { sender: accounts[18], agentVault: agentVault.address, query: "1" });
        // assert
        // only owner can respond
        await expectRevert.custom(assetManager.agentPingResponse(agentVault.address, 1, "some data", { from: accounts[0] }), "OnlyAgentVaultOwner", []);
        // response must emit event with owner's address
        const response = await assetManager.agentPingResponse(agentVault.address, 1, "some data", { from: agentOwner1 });
        expectEvent(response, "AgentPingResponse", { agentVault: agentVault.address, owner: agentOwner1, query: "1", response: "some data" });
    });

    // it("create agent underlying XRP address validation tests", async () => {
    //     const ci = testChainInfo.xrp;
    //     const rippleAddressValidator = await RippleAddressValidator.new();
    //     settings.underlyingAddressValidator = rippleAddressValidator.address;
    //     [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals);
    //     const agentXRPAddressCorrect = "rfsK8pNsNeGA8nYWM3PzoRxMRHeAyEtNjN";
    //     const agentXRPAddressTooShort = "rfsK8pNsNeGA8nYWM3PzoRx";
    //     const agentXRPAddressTooLong = "rfsK8pNsNeGA8nYWM3PzoRxMRHeAyEtNjNMRHNFsg";
    //     //Incorrect address with out of vocabulary letter
    //     const agentXRPAddressIncorrect = "rfsK8pNsNeGA8nYWM3PzoRxMRHeAyEtNjž";
    //     //Create agent, underlying address too short
    //     let res = createAgent(agentOwner1, agentXRPAddressTooShort);
    //     await expectRevert.custom(res, "invalid underlying address");
    //     //Create agent, underlying address too short
    //     res = createAgent(agentOwner1, agentXRPAddressTooLong);
    //     await expectRevert.custom(res, "invalid underlying address");
    //     //Create agent, underlying address too short
    //     res = createAgent(agentOwner1, agentXRPAddressIncorrect);
    //     await expectRevert.custom(res, "invalid underlying address");
    //     //Create agent
    //     await createAgent(agentOwner1, agentXRPAddressCorrect);
    // });
});
