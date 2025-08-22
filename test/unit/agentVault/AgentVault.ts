import { AgentSettings, CollateralType } from "../../../lib/fasset/AssetManagerTypes";
import { testChainInfo } from "../../../lib/test-utils/actors/TestChainInfo";
import { impersonateContract } from "../../../lib/test-utils/contract-test-helpers";
import { AssetManagerInitSettings, newAssetManager, newAssetManagerController } from "../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain } from "../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestAgent, createTestCollaterals, createTestContracts, createTestSettings } from "../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { AttestationHelper } from "../../../lib/underlying-chain/AttestationHelper";
import { abiEncodeCall, erc165InterfaceId, toBN, toBNExp, toWei } from "../../../lib/utils/helpers";
import { AgentVaultInstance, AssetManagerMockInstance, CollateralPoolInstance, CollateralPoolTokenInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerControllerInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../typechain-truffle";

const AgentVault = artifacts.require("AgentVault");
const MockContract = artifacts.require('MockContract');
const ERC20Mock = artifacts.require("ERC20Mock");
const AssetManagerMock = artifacts.require("AssetManagerMock");
const CollateralPoolToken = artifacts.require("CollateralPoolToken");
const CollateralPool = artifacts.require("CollateralPool");
const FAsset = artifacts.require('FAsset');
const FAssetProxy = artifacts.require('FAssetProxy');
// const DistributionToDelegatorsMock = artifacts.require('DistributionToDelegatorsMock');
const RewardManager = artifacts.require("RewardManagerMock");

contract(`AgentVault.sol; ${getTestFile(__filename)}; AgentVault unit tests`, accounts => {
    let contracts: TestSettingsContracts;
    let wNat: WNatMockInstance;
    let stablecoins: Record<string, ERC20MockInstance>;
    let usdc: ERC20MockInstance;
    let assetManagerController: IIAssetManagerControllerInstance;
    let settings: AssetManagerInitSettings;
    let assetManager: IIAssetManagerInstance;
    let assetManagerMock: AssetManagerMockInstance;
    let collaterals: CollateralType[];
    let fAsset: FAssetInstance;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;

    const owner = accounts[1];
    const governance = accounts[10];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";


    function createAgentVault(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const vaultCollateralToken = options?.vaultCollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, attestationProvider }, owner, underlyingAddress, vaultCollateralToken, options);
    }

    async function createGovernanceVP() {
        const governanceVotePower = await MockContract.new();
        const ownerTokenCall = web3.eth.abi.encodeFunctionCall({ type: 'function', name: 'ownerToken', inputs: [] }, []);
        await governanceVotePower.givenMethodReturnAddress(ownerTokenCall, wNat.address);
        return governanceVotePower;
    }

    async function getCollateralPool(assetManager: IIAssetManagerInstance, agentVault: AgentVaultInstance): Promise<CollateralPoolInstance> {
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        const collateralPool = await CollateralPool.at(agentInfo.collateralPool);
        return collateralPool;
    }

    async function getCollateralPoolToken(assetManager: IIAssetManagerInstance, agentVault: AgentVaultInstance): Promise<CollateralPoolTokenInstance> {
        const collateralPool = await getCollateralPool(assetManager, agentVault);
        return CollateralPoolToken.at(await collateralPool.token());
    }

    async function initialize() {
        const ci = testChainInfo.btc;
        contracts = await createTestContracts(governance);
        // save some contracts as globals
        ({ wNat, stablecoins } = contracts);
        usdc = stablecoins.USDC;
        // create asset manager controller (don't switch to production)
        assetManagerController = await newAssetManagerController(contracts.governanceSettings.address, governance, contracts.addressUpdater.address);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals);
        await assetManagerController.addAssetManager(assetManager.address, { from: governance });
        // create attestation provider
        const chain = new MockChain(await time.latest());
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager mock (for tests that use AgentVault.new)
        assetManagerMock = await AssetManagerMock.new(wNat.address);
        await assetManagerMock.setCommonOwner(owner);
        return { contracts, wNat, stablecoins, usdc, assetManagerController, collaterals, settings, assetManager, fAsset, assetManagerMock };
    }

    beforeEach(async () => {
        ({ contracts, wNat, stablecoins, usdc, assetManagerController, collaterals, settings, assetManager, fAsset, assetManagerMock } = await loadFixtureCopyVars(initialize));
    });

    describe("pool token methods", () => {

        it("should buy collateral pool tokens", async () => {
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.totalPoolCollateralNATWei, toWei(1000));
        });

        it("should withdraw pool fees", async () => {
            // mock fAsset
            const ci = testChainInfo.eth;
            const fAssetImpl = await FAsset.new();
            const fAssetProxy = await FAssetProxy.new(fAssetImpl.address, ci.name, ci.symbol, ci.assetName, ci.assetSymbol, ci.decimals, { from: governance });
            fAsset = await FAsset.at(fAssetProxy.address);
            fAsset = await FAsset.at(fAssetProxy.address);
            await fAsset.setAssetManager(assetManagerMock.address, { from: governance });
            // create agent with mocked fAsset
            await assetManagerMock.setCheckForValidAgentVaultAddress(false);
            await assetManagerMock.registerFAssetForCollateralPool(fAsset.address);
            await impersonateContract(assetManagerMock.address, toBNExp(1000, 18), accounts[0]);
            const agentVault = await AgentVault.new(assetManagerMock.address);
            // create pool
            const pool = await CollateralPool.new(agentVault.address, assetManagerMock.address, fAsset.address, 12000);
            const token = await CollateralPoolToken.new(pool.address, "FAsset Collateral Pool Token ETH-AG1", "FCPT-ETH-AG1");
            await assetManagerMock.callFunctionAt(pool.address, abiEncodeCall(pool, (p) => p.setPoolToken(token.address)));
            await assetManagerMock.setCollateralPool(pool.address);
            // deposit nat
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            // mint fAssets to the pool
            await fAsset.mint(pool.address, toWei(10), { from: assetManagerMock.address });
            await assetManagerMock.callFunctionAt(pool.address, abiEncodeCall(pool, (p) => p.fAssetFeeDeposited(toWei(1000))));
            // withdraw pool fees
            await agentVault.withdrawPoolFees(toWei(10), owner, { from: owner });
            const ownerFassets = await fAsset.balanceOf(owner);
            assertWeb3Equal(ownerFassets, toWei(10));
        });

        it("should redeem collateral from pool", async () => {
            const natRecipient = "0xDe6E4607008a6B6F4341E046d18297d03e11ECa1";
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const tokens = agentInfo.totalAgentPoolTokensWei;
            await time.deterministicIncrease(await assetManager.getCollateralPoolTokenTimelockSeconds()); // wait for token timelock
            await assetManager.announceAgentPoolTokenRedemption(agentVault.address, tokens, { from: owner });
            await time.deterministicIncrease((await assetManager.getSettings()).withdrawalWaitMinSeconds);
            await agentVault.redeemCollateralPoolTokens(tokens, natRecipient, { from: owner });
            const pool = await getCollateralPoolToken(assetManager, agentVault);
            const poolTokenBalance = await pool.balanceOf(agentVault.address);
            assertWeb3Equal(poolTokenBalance, toBN(0));
            assertWeb3Equal(await web3.eth.getBalance(natRecipient), toWei(1000));
        });

    });

    it("should deposit vault collateral from owner - via approve & depositCollateral", async () => {
        await usdc.mintAmount(owner, 2000);
        const agentVault = await createAgentVault(owner, underlyingAgent1, { vaultCollateralToken: usdc.address });
        await usdc.approve(agentVault.address, 1100, { from: owner });
        await agentVault.depositCollateral(usdc.address, 100, { from: owner });
        const votePower = await wNat.votePowerOf(agentVault.address);
        assertWeb3Equal(votePower, 0);
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(agentInfo.totalVaultCollateralWei, 100);
        await agentVault.depositCollateral(usdc.address, 1000, { from: owner });
        const agentInfo2 = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(agentInfo2.totalVaultCollateralWei, 1100);
    });

    it("can only deposit by owner - via approve & depositCollateral", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1, { vaultCollateralToken: usdc.address });
        const user = accounts[20];
        await usdc.mintAmount(user, 2000);
        await usdc.approve(agentVault.address, 1100, { from: user });
        await expectRevert.custom(agentVault.depositCollateral(usdc.address, 100, { from: user }), "OnlyOwner", []);
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(agentInfo.totalVaultCollateralWei, 0);
    });

    it("should deposit vault collateral from owner - via transfer & updateCollateral", async () => {
        await usdc.mintAmount(owner, 2000);
        const agentVault = await createAgentVault(owner, underlyingAgent1, { vaultCollateralToken: usdc.address });
        await usdc.transfer(agentVault.address, 100, { from: owner });
        await agentVault.updateCollateral(usdc.address, { from: owner });
        const votePower = await wNat.votePowerOf(agentVault.address);
        assertWeb3Equal(votePower, 0);
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(agentInfo.totalVaultCollateralWei, 100);
        await usdc.transfer(agentVault.address, 1000, { from: owner });
        await agentVault.updateCollateral(usdc.address, { from: owner });
        const agentInfo2 = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(agentInfo2.totalVaultCollateralWei, 1100);
    });

    it("can only call updateCollateral by owner", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1, { vaultCollateralToken: usdc.address });
        const user = accounts[20];
        await usdc.mintAmount(user, 2000);
        await usdc.transfer(agentVault.address, 100, { from: user });
        await expectRevert.custom(agentVault.updateCollateral(usdc.address, { from: user }), "OnlyOwner", []);
    });

    it("should withdraw vault collateral from owner", async () => {
        const recipient = "0xe34BDff68a5b89216D7f6021c1AB25c012142425";
        // deposit collateral
        await usdc.mintAmount(owner, 2000);
        const agentVault = await createAgentVault(owner, underlyingAgent1, { vaultCollateralToken: usdc.address });
        await usdc.approve(agentVault.address, 1100, { from: owner });
        await agentVault.depositCollateral(usdc.address, 100, { from: owner });
        // withdraw collateral
        await assetManager.announceVaultCollateralWithdrawal(agentVault.address, 100, { from: owner });
        await time.deterministicIncrease(time.duration.hours(1));
        await agentVault.withdrawCollateral(usdc.address, 100, recipient, { from: owner });
        assertWeb3Equal(await usdc.balanceOf(recipient), toBN(100));
    });

    it("cannot deposit if agent vault not created through asset manager", async () => {
        await usdc.mintAmount(owner, 2000);
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await usdc.approve(agentVault.address, 2000, { from: owner });
        const res = agentVault.depositCollateral(usdc.address, 100, { from: owner });
        await expectRevert.custom(res, "InvalidAgentVaultAddress", [])
    });

    it("cannot deposit/withdraw unknown tokens", async () => {
        const myToken = await ERC20Mock.new("My Token", "MTOK");
        const agentVault = await createAgentVault(owner, underlyingAgent1, { vaultCollateralToken: usdc.address });
        // cannot deposit myToken
        await myToken.mintAmount(owner, 2000);
        await myToken.approve(agentVault.address, 2000, { from: owner });
        await expectRevert.custom(agentVault.depositCollateral(myToken.address, 1000, { from: owner }), "UnknownToken", []);
        // cannot deposit myToken via updateCollateral
        await myToken.transfer(agentVault.address, 1000, { from: owner });
        await expectRevert.custom(agentVault.updateCollateral(myToken.address, { from: owner }), "UnknownToken", []);
        // cannot withdraw myToken
        await expectRevert.custom(agentVault.withdrawCollateral(myToken.address, 1000, owner, { from: owner }), "UnknownToken", []);
    });

    it("but can deposit/withdraw vault collateral tokens even if they are not current collateral for this vault", async () => {
        const usdt = stablecoins.USDT;
        await usdt.mintAmount(owner, 2000);
        const agentVault = await createAgentVault(owner, underlyingAgent1, { vaultCollateralToken: usdc.address });
        // cannot deposit myToken
        await usdt.mintAmount(owner, 2000);
        await usdt.approve(agentVault.address, 2000, { from: owner });
        await agentVault.depositCollateral(usdt.address, 1000, { from: owner });
        // cannot deposit myToken via updateCollateral
        await usdt.transfer(agentVault.address, 1000, { from: owner });
        await agentVault.updateCollateral(usdt.address, { from: owner });
        // cannot withdraw myToken
        await agentVault.withdrawCollateral(usdt.address, 1000, owner, { from: owner });
    });

    it("cannot transfer NAT to agent vault", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = web3.eth.sendTransaction({ from: owner, to: agentVault.address, value: 500 });
        await expectRevert(res, "there's no fallback nor receive function")
    });

    it("cannot withdraw collateral if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.withdrawCollateral(usdc.address, 100, accounts[2], { from: accounts[2] });
        await expectRevert.custom(res, "OnlyOwner", [])
    });

    it("cannot call destroy if not asset manager", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.destroy({ from: accounts[2] });
        await expectRevert.custom(res, "OnlyAssetManager", [])
    });

    it("cannot call payout if not asset manager", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.payout(wNat.address, accounts[2], 100, { from: accounts[2] });
        await expectRevert.custom(res, "OnlyAssetManager", [])
    });

    it("should not transfer wnat tokens", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        const res = agentVault.transferExternalToken(usdc.address, 1, { from: owner });
        await expectRevert.custom(res, "OnlyNonCollateralTokens", []);
    });

    it("should not transfer if not owner", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        const res = agentVault.transferExternalToken(wNat.address, 1);
        await expectRevert.custom(res, "OnlyOwner", []);
    });

    it("should transfer erc20 tokens", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        const token = await ERC20Mock.new("XTOK", "XToken")
        await token.mintAmount(agentVault.address, 10);
        const balance = (await token.balanceOf(agentVault.address)).toString();
        assert.equal(balance, "10");
        await agentVault.transferExternalToken(token.address, 3, { from: owner });
        const balance2 = (await token.balanceOf(agentVault.address)).toString();
        assert.equal(balance2, "7");
    });

    it("after destroy of agentVault contract collateral can be withdrawn immediatelly", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        //Deposit some token collateral
        await usdc.mintAmount(owner, toBN(100));
        await usdc.approve(agentVault.address, toBN(100), { from: owner })
        await agentVault.depositCollateral(usdc.address, toBN(100), { from: owner });
        //Withdraw token so balance is 0
        await expectRevert.custom(agentVault.withdrawCollateral(usdc.address, toBN(100), accounts[12], { from: owner }), "WithdrawalNotAnnounced", []);
        await assetManager.announceDestroyAgent(agentVault.address, { from: owner });
        await time.deterministicIncrease(settings.withdrawalWaitMinSeconds);
        await assetManager.destroyAgent(agentVault.address, owner, { from: owner });
        // now it should work
        assertWeb3Equal(await usdc.balanceOf(agentVault.address), toBN(100));
        await agentVault.withdrawCollateral(usdc.address, toBN(100), accounts[12], { from: owner });
        assertWeb3Equal(await usdc.balanceOf(agentVault.address), 0);
    });

    it("should payout from a given token", async () => {
        const erc20 = await ERC20Mock.new("XTOK", "XToken");
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await erc20.mintAmount(agentVault.address, 100);
        await assetManagerMock.callFunctionAt(agentVault.address, abiEncodeCall(agentVault, (av) => av.payout(erc20.address, owner, 100)), { from: owner });
        assertWeb3Equal(await erc20.balanceOf(owner), toBN(100));
    });

    describe("ERC-165 interface identification for Agent Vault", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as "IERC165");
            const IAgentVault = artifacts.require("IAgentVault");
            const IIAgentVault = artifacts.require("IIAgentVault");
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            const iERC165 = await IERC165.at(agentVault.address);
            const iAgentVault = await IAgentVault.at(agentVault.address);
            const iiAgentVault = await IIAgentVault.at(agentVault.address);
            assert.isTrue(await agentVault.supportsInterface(erc165InterfaceId(iERC165.abi)));
            assert.isTrue(await agentVault.supportsInterface(erc165InterfaceId(iAgentVault.abi)));
            assert.isTrue(await agentVault.supportsInterface(erc165InterfaceId(iiAgentVault.abi, [iAgentVault.abi])));
            assert.isFalse(await agentVault.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });


    describe("ERC-165 interface identification for Agent Vault Factory", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as "IERC165");
            const IIAgentVaultFactory = artifacts.require("IIAgentVaultFactory");
            const IUpgradableContractFactory = artifacts.require("IUpgradableContractFactory");
            assert.isTrue(await contracts.agentVaultFactory.supportsInterface(erc165InterfaceId(IERC165)));
            assert.isTrue(await contracts.agentVaultFactory.supportsInterface(erc165InterfaceId(IIAgentVaultFactory, [IUpgradableContractFactory])));
            assert.isFalse(await contracts.agentVaultFactory.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });

    describe("branch tests", () => {
        it("random address shouldn't be able to withdraw pool fees", async () => {
            // mock fAsset
            const ci = testChainInfo.eth;
            const fAssetImpl = await FAsset.new();
            const fAssetProxy = await FAssetProxy.new(fAssetImpl.address, ci.name, ci.symbol, ci.assetName, ci.assetSymbol, ci.decimals, { from: governance });
            fAsset = await FAsset.at(fAssetProxy.address);
            fAsset = await FAsset.at(fAssetProxy.address);
            await fAsset.setAssetManager(assetManagerMock.address, { from: governance });
            await assetManagerMock.setCheckForValidAgentVaultAddress(false);
            await assetManagerMock.registerFAssetForCollateralPool(fAsset.address);
            await impersonateContract(assetManagerMock.address, toBNExp(1000, 18), accounts[0]);
            // create agent with mocked fAsset
            const agentVault = await AgentVault.new(assetManagerMock.address);
            // create pool
            const pool = await CollateralPool.new(agentVault.address, assetManagerMock.address, fAsset.address, 12000);
            const token = await CollateralPoolToken.new(pool.address, "FAsset Collateral Pool Token ETH-AG2", "FCPT-ETH-AG2");
            await assetManagerMock.callFunctionAt(pool.address, abiEncodeCall(pool, (p) => p.setPoolToken(token.address)));
            await assetManagerMock.setCollateralPool(pool.address);
            // deposit nat
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            // mint fAssets to the pool
            await fAsset.mint(pool.address, toWei(10), { from: assetManagerMock.address });
            await assetManagerMock.callFunctionAt(pool.address, abiEncodeCall(pool, (p) => p.fAssetFeeDeposited(toWei(1000))));
            // withdraw pool fees
            const res = agentVault.withdrawPoolFees(toWei(10), owner, { from: accounts[14] });
            await expectRevert.custom(res, "OnlyOwner", []);
        });

        it("random address shouldn't be able to redeem collateral pool tokens", async () => {
            const natRecipient = "0xDe6E4607008a6B6F4341E046d18297d03e11ECa1";
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const tokens = agentInfo.totalAgentPoolTokensWei;
            await assetManager.announceAgentPoolTokenRedemption(agentVault.address, tokens, { from: owner });
            await time.deterministicIncrease((await assetManager.getSettings()).withdrawalWaitMinSeconds);
            const res = agentVault.redeemCollateralPoolTokens(tokens, natRecipient, { from: accounts[14] });
            await expectRevert.custom(res, "OnlyOwner", []);
        });

        it("random address shouldn't be able to buy collateral pool tokens for the vault", async () => {
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            await expectRevert.custom(agentVault.buyCollateralPoolTokens({ from: accounts[15], value: toWei(1000) }), "OnlyOwner", []);
        });
    });

    describe("CR calculation", () => {
        it("check CR calculation if amg==0 and collateral==0", async () => {
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            assertWeb3Equal(agentInfo.vaultCollateralRatioBIPS, 1e10);
            assertWeb3Equal(agentInfo.poolCollateralRatioBIPS, 1e10);
        });
    });
});
