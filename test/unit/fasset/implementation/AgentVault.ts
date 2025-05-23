import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { expectRevert, time } from "@openzeppelin/test-helpers";
import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { erc165InterfaceId, toBN, toBNExp, toWei } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, AssetManagerMockInstance, CollateralPoolInstance, CollateralPoolTokenInstance, ERC20MockInstance, FAssetInstance, IERC165Contract, IIAssetManagerControllerInstance, IIAssetManagerInstance, WNatInstance } from "../../../../typechain-truffle";
import { testChainInfo } from "../../../integration/utils/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager, newAssetManagerController } from "../../../utils/fasset/CreateAssetManager";
import { MockChain } from "../../../utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../utils/fasset/MockFlareDataConnectorClient";
import { deterministicTimeIncrease, getTestFile, loadFixtureCopyVars } from "../../../utils/test-helpers";
import { TestFtsos, TestSettingsContracts, createTestAgent, createTestCollaterals, createTestContracts, createTestFtsos, createTestSettings } from "../../../utils/test-settings";
import { assertWeb3Equal } from "../../../utils/web3assertions";
import { impersonateContract } from "../../../utils/contract-test-helpers";

const AgentVault = artifacts.require("AgentVault");
const MockContract = artifacts.require('MockContract');
const ERC20Mock = artifacts.require("ERC20Mock");
const AssetManagerMock = artifacts.require("AssetManagerMock");
const CollateralPoolToken = artifacts.require("CollateralPoolToken");
const CollateralPool = artifacts.require("CollateralPool");
const FAsset = artifacts.require('FAsset');
const FAssetProxy = artifacts.require('FAssetProxy');

contract(`AgentVault.sol; ${getTestFile(__filename)}; AgentVault unit tests`, async accounts => {
    let contracts: TestSettingsContracts;
    let wNat: WNatInstance;
    let stablecoins: Record<string, ERC20MockInstance>;
    let usdc: ERC20MockInstance;
    let assetManagerController: IIAssetManagerControllerInstance;
    let ftsos: TestFtsos;
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
        // create FTSOs for nat, stablecoins and asset and set some price
        ftsos = await createTestFtsos(contracts.ftsoRegistry, ci);
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
        return { contracts, wNat, stablecoins, usdc, ftsos, assetManagerController, collaterals, settings, assetManager, fAsset, assetManagerMock };
    }

    beforeEach(async () => {
        ({ contracts, wNat, stablecoins, usdc, ftsos, assetManagerController, collaterals, settings, assetManager, fAsset, assetManagerMock } = await loadFixtureCopyVars(initialize));
    });

    describe("pool token methods", async () => {

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
            const pool = await CollateralPool.new(agentVault.address, assetManagerMock.address, fAsset.address, 12000, 13000, 8000);
            const token = await CollateralPoolToken.new(pool.address, "FAsset Collateral Pool Token ETH-AG1", "FCPT-ETH-AG1");
            await assetManagerMock.callFunctionAt(pool.address, pool.contract.methods.setPoolToken(token.address).encodeABI());
            await assetManagerMock.setCollateralPool(pool.address);
            // deposit nat
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            // mint fAssets to the pool
            await fAsset.mint(pool.address, toWei(10), { from: assetManagerMock.address });
            await assetManagerMock.callFunctionAt(pool.address, pool.contract.methods.fAssetFeeDeposited(toWei(1000)).encodeABI());
            // withdraw pool fees
            await agentVault.withdrawPoolFees(toWei(10), owner, { from: owner });
            const transferFeeMillionths = await assetManagerMock.transferFeeMillionths();
            const transferFee = toWei(10).mul(transferFeeMillionths).divn(1e6);
            const ownerFassets = await fAsset.balanceOf(owner);
            assertWeb3Equal(ownerFassets, toWei(10).sub(transferFee));
        });

        it("should redeem collateral from pool", async () => {
            const natRecipient = "0xDe6E4607008a6B6F4341E046d18297d03e11ECa1";
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const tokens = agentInfo.totalAgentPoolTokensWei;
            await deterministicTimeIncrease(await assetManager.getCollateralPoolTokenTimelockSeconds()); // wait for token timelock
            await assetManager.announceAgentPoolTokenRedemption(agentVault.address, tokens, { from: owner });
            await deterministicTimeIncrease((await assetManager.getSettings()).withdrawalWaitMinSeconds);
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
        await expectRevert(agentVault.depositCollateral(usdc.address, 100, { from: user }), "only owner");
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
        await expectRevert(agentVault.updateCollateral(usdc.address, { from: user }), "only owner");
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
        await deterministicTimeIncrease(time.duration.hours(1));
        await agentVault.withdrawCollateral(usdc.address, 100, recipient, { from: owner });
        assertWeb3Equal(await usdc.balanceOf(recipient), toBN(100));
    });

    it("cannot deposit if agent vault not created through asset manager", async () => {
        await usdc.mintAmount(owner, 2000);
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await usdc.approve(agentVault.address, 2000, { from: owner });
        const res = agentVault.depositCollateral(usdc.address, 100, { from: owner });
        await expectRevert(res, "invalid agent vault address")
    });

    it("cannot transfer NAT to agent vault", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = web3.eth.sendTransaction({ from: owner, to: agentVault.address, value: 500 });
        await expectRevert(res, "internal use only")
    });

    it("cannot payoutNAT if transfer fails", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await wNat.depositTo(agentVault.address, { value: toBN(100) });
        await assetManagerMock.payoutNAT(agentVault.address, agentVault.address, 0, { from: owner });
        const res = assetManagerMock.payoutNAT(agentVault.address, agentVault.address, 100, { from: owner });
        await expectRevert(res, "transfer failed")
    });

    it("cannot delegate if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.delegate(wNat.address, accounts[2], 50);
        await expectRevert(res, "only owner")
    });

    it("should delegate", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await agentVault.delegate(wNat.address, accounts[2], 50, { from: owner });
        const { _delegateAddresses } = await wNat.delegatesOf(agentVault.address) as any;
        assertWeb3Equal(_delegateAddresses[0], accounts[2]);
    });

    it("should undelegate all", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await agentVault.delegate(wNat.address, accounts[2], 50, { from: owner });
        await agentVault.delegate(wNat.address, accounts[3], 10, { from: owner });
        let resDelegate = await wNat.delegatesOf(agentVault.address) as any;
        assertWeb3Equal(resDelegate._delegateAddresses.length, 2);

        await agentVault.undelegateAll(wNat.address, { from: owner });
        let resUndelegate = await wNat.delegatesOf(agentVault.address) as any;
        assertWeb3Equal(resUndelegate._delegateAddresses.length, 0);
    });

    it("cannot undelegate if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.undelegateAll(wNat.address, { from: accounts[2] });
        await expectRevert(res, "only owner")
    });

    it("should revoke delegation", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await agentVault.delegate(wNat.address, accounts[2], 50, { from: owner });
        const blockNumber = await web3.eth.getBlockNumber();
        await agentVault.revokeDelegationAt(wNat.address, accounts[2], blockNumber, { from: owner });
        let votePower = await wNat.votePowerOfAt(accounts[2], blockNumber);
        assertWeb3Equal(votePower.toNumber(), 0);
    });

    it("cannot revoke delegation if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const blockNumber = await web3.eth.getBlockNumber();
        const res = agentVault.revokeDelegationAt(wNat.address, accounts[2], blockNumber, { from: accounts[2] });
        await expectRevert(res, "only owner")
    });

    it("cannot delegate governance if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.delegateGovernance(wNat.address, accounts[2]);
        await expectRevert(res, "only owner")
    });

    it("should delegate governance", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const governanceVP = await createGovernanceVP();
        await wNat.setGovernanceVotePower(governanceVP.address, { from: governance });
        await agentVault.delegateGovernance(wNat.address, accounts[2], { from: owner });
        const delegate = web3.eth.abi.encodeFunctionCall({
            type: "function", name: "delegate",
            inputs: [{ name: "_to", type: "address" }]
        } as AbiItem,
            [accounts[2]] as any[]);
        const invocationCount = await governanceVP.invocationCountForCalldata.call(delegate);
        assert.equal(invocationCount.toNumber(), 1);
    });

    it("cannot undelegate governance if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.undelegateGovernance(wNat.address);
        await expectRevert(res, "only owner")
    });

    it("should undelegate governance", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const governanceVP = await createGovernanceVP();
        await wNat.setGovernanceVotePower(governanceVP.address, { from: governance });
        await agentVault.undelegateGovernance(wNat.address, { from: owner });
        const undelegate = web3.eth.abi.encodeFunctionCall({
            type: "function", name: "undelegate",
            inputs: []
        } as AbiItem,
            [] as any[]);
        const invocationCount = await governanceVP.invocationCountForCalldata.call(undelegate);
        assert.equal(invocationCount.toNumber(), 1);
    });

    it("should claim rewards", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const rewardManagerMock = await MockContract.new();
        await agentVault.claimDelegationRewards(rewardManagerMock.address, 5, owner, [], { from: owner });
        const claimReward = web3.eth.abi.encodeFunctionCall({
            type: "function", name: "claim",
            inputs: [{ name: "_rewardOwner", type: "address" }, { name: "_recipient", type: "address" }, { name: "_rewardEpoch", type: "uint24" }, { name: "_wrap", type: "bool" },
            {
                components: [{ name: "merkleProof", type: "bytes32[]" }, {
                    components: [{ name: "rewardEpochId", type: "uint24" }, { name: "beneficiary", type: "bytes20" },
                    { name: "amount", type: "uint120" }, { name: "claimType", type: "uint8" }], name: "body", type: "tuple"
                }], name: "_proofs", type: "tuple[]"
            }]
        } as AbiItem,
            [agentVault.address, owner, 5, false, []] as any[]);
        const invocationCount = await rewardManagerMock.invocationCountForCalldata.call(claimReward);
        assert.equal(invocationCount.toNumber(), 1);
    });

    it("cannot claim rewards if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const rewardManagerMock = await MockContract.new();
        const claimPromise = agentVault.claimDelegationRewards(rewardManagerMock.address, 5, owner, [], { from: accounts[2] });
        await expectRevert(claimPromise, "only owner");
    });

    it("should opt out of airdrop distribution", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const distributionMock = await MockContract.new();
        await agentVault.optOutOfAirdrop(distributionMock.address, { from: owner });
        const optOutOfAirdrop = web3.eth.abi.encodeFunctionCall({
            type: "function", name: "optOutOfAirdrop",
            inputs: []
        } as AbiItem,
            [] as any[]);
        const invocationCount = await distributionMock.invocationCountForCalldata.call(optOutOfAirdrop);
        assert.equal(invocationCount.toNumber(), 1);
    });

    it("cannot opt out of airdrop distribution if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const distributionMock = await MockContract.new();
        const optOutOfAirdropPromise = agentVault.optOutOfAirdrop(distributionMock.address, { from: accounts[2] });
        await expectRevert(optOutOfAirdropPromise, "only owner");
    });

    it("should claim airdrop distribution", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const distributionMock = await MockContract.new();
        await agentVault.claimAirdropDistribution(distributionMock.address, 2, owner, { from: owner });
        const claim = web3.eth.abi.encodeFunctionCall({
            type: "function", name: "claim",
            inputs: [{ name: "_rewardOwner", type: "address" }, { name: "_recipient", type: "address" }, { name: "_month", type: "uint256" }, { name: "_wrap", type: "bool" }]
        } as AbiItem,
            [agentVault.address, owner, 2, false] as any[]);
        const invocationCount = await distributionMock.invocationCountForCalldata.call(claim);
        assert.equal(invocationCount.toNumber(), 1);
    });

    it("cannot claim airdrop distribution if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const distributionMock = await MockContract.new();
        const claimPromise = agentVault.claimAirdropDistribution(distributionMock.address, 2, owner, { from: accounts[2] });
        await expectRevert(claimPromise, "only owner");
    });

    it("cannot withdraw collateral if not owner", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.withdrawCollateral(usdc.address, 100, accounts[2], { from: accounts[2] });
        await expectRevert(res, "only owner")
    });

    it("should call governanceVP.undelegate() when destroying agent if governanceVP was delegated", async () => {
        const governanceVP = await createGovernanceVP();
        await wNat.setGovernanceVotePower(governanceVP.address, { from: governance });
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        await agentVault.delegateGovernance(wNat.address, accounts[5], { from: owner });
        await assetManager.announceDestroyAgent(agentVault.address, { from: owner });
        await deterministicTimeIncrease(settings.withdrawalWaitMinSeconds);
        await assetManager.destroyAgent(agentVault.address, owner, { from: owner });
        const undelegate = web3.eth.abi.encodeFunctionCall({ type: "function", name: "undelegate", inputs: [] } as AbiItem, []);
        const invocationCount = await governanceVP.invocationCountForCalldata.call(undelegate);
        assert.equal(invocationCount.toNumber(), 1);
    });

    it("cannot call destroy if not asset manager", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.destroy(owner, { from: accounts[2] });
        await expectRevert(res, "only asset manager")
    });

    it("cannot call payout if not asset manager", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.payout(wNat.address, accounts[2], 100, { from: accounts[2] });
        await expectRevert(res, "only asset manager")
    });

    it("cannot call payoutNAT if not asset manager", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        const res = agentVault.payoutNAT(wNat.address, accounts[2], 100, { from: accounts[2] });
        await expectRevert(res, "only asset manager")
    });

    it("should not transfer wnat tokens", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        let res = agentVault.transferExternalToken(usdc.address, 1, { from: owner });
        await expectRevert(res, "only non-collateral tokens");
    });

    it("should not transfer if not owner", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        let res = agentVault.transferExternalToken(wNat.address, 1);
        await expectRevert(res, "only owner");
    });

    it("should transfer erc20 tokens", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        const token = await ERC20Mock.new("XTOK", "XToken")
        await token.mintAmount(agentVault.address, 10);
        let balance = (await token.balanceOf(agentVault.address)).toString();
        assert.equal(balance, "10");
        await agentVault.transferExternalToken(token.address, 3, { from: owner });
        let balance2 = (await token.balanceOf(agentVault.address)).toString();
        assert.equal(balance2, "7");
    });

    it("should destroy the agentVault contract with with no token used", async () => {
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await setBalance(agentVault.address, 1000);
        assert.equal(await web3.eth.getBalance(agentVault.address), "1000");
        await assetManagerMock.callFunctionAt(agentVault.address, agentVault.contract.methods.destroy(owner).encodeABI(), { from: owner });
        assert.equal(await web3.eth.getBalance(agentVault.address), "0");
    });

    it("should destroy the agentVault contract with token used", async () => {
        await assetManagerMock.setCheckForValidAgentVaultAddress(false);
        const agentVault = await AgentVault.new(assetManagerMock.address);
        // use a token and delegate
        await wNat.deposit({ from: owner, value: toBN(100) })
        await wNat.approve(agentVault.address, toBN(100), { from: owner })
        await agentVault.depositCollateral(wNat.address, toBN(100), { from: owner });
        await agentVault.delegate(wNat.address, owner, 10_000, { from: owner });
        const delegatedBefore = await wNat.votePowerOf(owner);
        assertWeb3Equal(delegatedBefore, toBN(100));
        // destroy contract
        await setBalance(agentVault.address, 1000);
        assert.equal(await web3.eth.getBalance(agentVault.address), "1000");
        await assetManagerMock.callFunctionAt(agentVault.address, agentVault.contract.methods.destroy(accounts[80]).encodeABI(), { from: owner });
        assert.equal(await web3.eth.getBalance(agentVault.address), "0");
        // check that wnat was returned
        const recipientWNat = await wNat.balanceOf(accounts[80]);
        assertWeb3Equal(recipientWNat, toBN(100));
        // check that delegation was removed
        const delegatedAfter = await wNat.votePowerOf(owner);
        assertWeb3Equal(delegatedAfter, toBN(0));
    });

    it("should destroy the agentVault contract with token used but 0 token balance in agent vault branch test", async () => {
        const agentVault = await createAgentVault(owner, underlyingAgent1);
        //Deposit some token collateral
        await wNat.deposit({ from: owner, value: toBN(100) })
        await wNat.approve(agentVault.address, toBN(100), { from: owner })
        await agentVault.depositCollateral(wNat.address, toBN(100), { from: owner });
        //Withdraw token so balance is 0
        await agentVault.withdrawCollateral(wNat.address, toBN(100), accounts[12], { from: owner });
        await assetManager.announceDestroyAgent(agentVault.address, { from: owner });
        await deterministicTimeIncrease(settings.withdrawalWaitMinSeconds);
        await assetManager.destroyAgent(agentVault.address, owner, { from: owner });
    });

    it("should payout from a given token", async () => {
        const erc20 = await ERC20Mock.new("XTOK", "XToken");
        const agentVault = await AgentVault.new(assetManagerMock.address);
        await erc20.mintAmount(agentVault.address, 100);
        await assetManagerMock.callFunctionAt(agentVault.address, agentVault.contract.methods.payout(
            erc20.address, owner, 100).encodeABI(), { from: owner });
        assertWeb3Equal(await erc20.balanceOf(owner), toBN(100));
    });

    describe("ERC-165 interface identification for Agent Vault", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as any) as any as IERC165Contract;
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
            const IAgentVaultFactory = artifacts.require("IAgentVaultFactory");
            const IUpgradableContractFactory = artifacts.require("IUpgradableContractFactory");
            assert.isTrue(await contracts.agentVaultFactory.supportsInterface(erc165InterfaceId(IERC165)));
            assert.isTrue(await contracts.agentVaultFactory.supportsInterface(erc165InterfaceId(IAgentVaultFactory, [IUpgradableContractFactory])));
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
            const pool = await CollateralPool.new(agentVault.address, assetManagerMock.address, fAsset.address, 12000, 13000, 8000);
            const token = await CollateralPoolToken.new(pool.address, "FAsset Collateral Pool Token ETH-AG2", "FCPT-ETH-AG2");
            await assetManagerMock.callFunctionAt(pool.address, pool.contract.methods.setPoolToken(token.address).encodeABI());
            await assetManagerMock.setCollateralPool(pool.address);
            // deposit nat
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            // mint fAssets to the pool
            await fAsset.mint(pool.address, toWei(10), { from: assetManagerMock.address });
            await assetManagerMock.callFunctionAt(pool.address, pool.contract.methods.fAssetFeeDeposited(toWei(1000)).encodeABI());
            // withdraw pool fees
            const res = agentVault.withdrawPoolFees(toWei(10), owner, { from: accounts[14] });
            await expectRevert(res, "only owner");
        });

        it("random address shouldn't be able to redeem collateral pool tokens", async () => {
            const natRecipient = "0xDe6E4607008a6B6F4341E046d18297d03e11ECa1";
            const agentVault = await createAgentVault(owner, underlyingAgent1);
            await agentVault.buyCollateralPoolTokens({ from: owner, value: toWei(1000) });
            const agentInfo = await assetManager.getAgentInfo(agentVault.address);
            const tokens = agentInfo.totalAgentPoolTokensWei;
            await assetManager.announceAgentPoolTokenRedemption(agentVault.address, tokens, { from: owner });
            await deterministicTimeIncrease((await assetManager.getSettings()).withdrawalWaitMinSeconds);
            const res = agentVault.redeemCollateralPoolTokens(tokens, natRecipient, { from: accounts[14] });
            await expectRevert(res, "only owner");
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
