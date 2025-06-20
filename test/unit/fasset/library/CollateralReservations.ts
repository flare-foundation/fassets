import { expectRevert, time } from "@openzeppelin/test-helpers";
import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { EventArgs } from "../../../../lib/utils/events/common";
import { requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BNish, toBN, toWei, ZERO_ADDRESS, ZERO_BYTES32 } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatInstance, MinterMockInstance } from "../../../../typechain-truffle";
import { CollateralReserved } from "../../../../typechain-truffle/IIAssetManager";
import { TestChainInfo, testChainInfo } from "../../../integration/utils/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager } from "../../../utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../utils/fasset/MockFlareDataConnectorClient";
import { deterministicTimeIncrease, getTestFile, loadFixtureCopyVars } from "../../../utils/test-helpers";
import { TestFtsos, TestSettingsContracts, createTestAgent, createTestCollaterals, createTestContracts, createTestFtsos, createTestSettings } from "../../../utils/test-settings";
import { assertWeb3Equal } from "../../../utils/web3assertions";
import { AgentCollateral } from "../../../utils/fasset/AgentCollateral";

contract(`CollateralReservations.sol; ${getTestFile(__filename)}; CollateralReservations basic tests`, async accounts => {
    const governance = accounts[10];
    let assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManager: IIAssetManagerInstance;
    let fAsset: FAssetInstance;
    let wNat: WNatInstance;
    let usdc: ERC20MockInstance;
    let ftsos: TestFtsos;
    let settings: AssetManagerInitSettings;
    let collaterals: CollateralType[];
    let chain: MockChain;
    let chainInfo: TestChainInfo;
    let wallet: MockChainWallet;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;

    const feeBIPS = 500;

    // addresses
    const agentOwner1 = accounts[20];
    const minterAddress1 = accounts[30];
    const noExecutorAddress = ZERO_ADDRESS;
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingMinter1 = "Minter1";
    const underlyingRandomAddress = "Random";

    function createAgent(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const vaultCollateralToken = options?.vaultCollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, chain, wallet, attestationProvider }, owner, underlyingAddress, vaultCollateralToken, options);
    }

    async function depositCollateral(owner: string, agentVault: AgentVaultInstance, amount: BN, token: ERC20MockInstance = usdc) {
        await token.mintAmount(owner, amount);
        await token.approve(agentVault.address, amount, { from: owner });
        await agentVault.depositCollateral(token.address, amount, { from: owner });
    }

    async function depositAndMakeAgentAvailable(agentVault: AgentVaultInstance, owner: string, fullAgentCollateral: BN = toWei(3e8)) {
        await depositCollateral(owner, agentVault, fullAgentCollateral);
        await agentVault.buyCollateralPoolTokens({ from: owner, value: fullAgentCollateral });  // add pool collateral and agent pool tokens
        await assetManager.makeAgentAvailable(agentVault.address, { from: owner });
    }

    async function reserveCollateral(agentVault: string, lots: BNish, underlyingAddresses?: string[]) {
        const agentInfo = await assetManager.getAgentInfo(agentVault);
        const crFee = await assetManager.collateralReservationFee(lots);
        const res = await assetManager.reserveCollateral(agentVault, lots, agentInfo.feeBIPS, noExecutorAddress, underlyingAddresses ?? [], { from: minterAddress1, value: crFee });
        return requiredEventArgs(res, 'CollateralReserved');
    }

    async function performMintingPayment(crt: EventArgs<CollateralReserved>) {
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        chain.mint(underlyingMinter1, paymentAmount);
        return await wallet.addTransaction(underlyingMinter1, crt.paymentAddress, paymentAmount, crt.paymentReference);
    }

    async function performSelfMintingPayment(agentVault: string, paymentAmount: BNish) {
        chain.mint(underlyingRandomAddress, paymentAmount);
        return await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentVault));
    }

    async function initialize() {
        const ci = chainInfo = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        // save some contracts as globals
        ({ wNat } = contracts);
        usdc = contracts.stablecoins.USDC;
        // create FTSOs for nat, stablecoins and asset and set some price
        ftsos = await createTestFtsos(contracts.ftsoRegistry, ci);
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci, { requireEOAAddressProof: true });
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        return { contracts, wNat, usdc, ftsos, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset };
    }

    beforeEach(async () => {
        ({ contracts, wNat, usdc, ftsos, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset } = await loadFixtureCopyVars(initialize));
    });

    it("should reserve collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        const settings = await assetManager.getSettings();
        const lotSize = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
        const args = requiredEventArgs(tx, "CollateralReserved");
        assertWeb3Equal(args.agentVault, agentVault.address);
        assert.isAbove(Number(args.collateralReservationId), 0);
        assertWeb3Equal(args.minter, minterAddress1);
        assertWeb3Equal(args.paymentAddress, underlyingAgent1);
        assertWeb3Equal(args.paymentReference, PaymentReference.minting(args.collateralReservationId));
        assertWeb3Equal(args.valueUBA, lotSize.muln(lots));
        assertWeb3Equal(args.feeUBA, lotSize.muln(lots * feeBIPS).divn(10000));
    });

    it("should reserve collateral and require a handshake", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(agentInfo.handshakeType, 1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        // assert
        const settings = await assetManager.getSettings();
        const lotSize = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
        const args = requiredEventArgs(tx, "HandshakeRequired");
        assertWeb3Equal(args.agentVault, agentVault.address);
        assert.isAbove(Number(args.collateralReservationId), 0);
        assertWeb3Equal(args.minter, minterAddress1);
        assertWeb3Equal(args.valueUBA, lotSize.muln(lots));
        assertWeb3Equal(args.feeUBA, lotSize.muln(lots * feeBIPS).divn(10000));
    });

    it("should reserve collateral and require a handshake - two underlying addresses", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(agentInfo.handshakeType, 1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, ["Agent2", "Agent1"], { from: minterAddress1, value: crFee });
        // assert
        const settings = await assetManager.getSettings();
        const lotSize = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
        const args = requiredEventArgs(tx, "HandshakeRequired");
        assertWeb3Equal(args.agentVault, agentVault.address);
        assert.isAbove(Number(args.collateralReservationId), 0);
        assertWeb3Equal(args.minter, minterAddress1);
        assertWeb3Equal(args.valueUBA, lotSize.muln(lots));
        assertWeb3Equal(args.feeUBA, lotSize.muln(lots * feeBIPS).divn(10000));
    });

    it("should reserve collateral, require a handshake and approve reservation", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        const settings = await assetManager.getSettings();
        const lotSize = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA));
        // approve reservation
        const tx1 = await assetManager.approveCollateralReservation(args.collateralReservationId, { from: agentOwner1 });
        const args1 = requiredEventArgs(tx1, "CollateralReserved");
        assertWeb3Equal(args1.agentVault, agentVault.address);
        assert.isAbove(Number(args1.collateralReservationId), 0);
        assertWeb3Equal(args1.minter, minterAddress1);
        assertWeb3Equal(args1.paymentAddress, underlyingAgent1);
        assertWeb3Equal(args1.paymentReference, PaymentReference.minting(args.collateralReservationId));
        assertWeb3Equal(args1.valueUBA, lotSize.muln(lots));
        assertWeb3Equal(args1.feeUBA, lotSize.muln(lots * feeBIPS).divn(10000));
    });

    it("should revert approving collateral reservation if not called by the agent", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        await expectRevert(assetManager.approveCollateralReservation(args.collateralReservationId), "only agent vault owner");
    });

    it("should revert approving collateral reservation if handshake not required", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 0 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "CollateralReserved");
        await expectRevert(assetManager.approveCollateralReservation(args.collateralReservationId, { from: agentOwner1 }), "handshake not required");
    });

    it("should reserve collateral, require a handshake and reject reservation", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const settings = await assetManager.getSettings();
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const returnFee = crFee.mul(toBN(settings.rejectOrCancelCollateralReservationReturnFactorBIPS)).div(toBN(10000));
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        // reject reservation
        const minterBalanceBefore = await web3.eth.getBalance(minterAddress1);
        const burnAddressBalanceBefore = await web3.eth.getBalance(settings.burnAddress);
        await assetManager.rejectCollateralReservation(args.collateralReservationId, { from: agentOwner1 });
        const minterBalanceAfter = await web3.eth.getBalance(minterAddress1);
        const burnAddressBalanceAfter = await web3.eth.getBalance(settings.burnAddress);
        assertWeb3Equal(toBN(minterBalanceBefore).add(returnFee), minterBalanceAfter);
        assertWeb3Equal(toBN(burnAddressBalanceAfter).sub(toBN(burnAddressBalanceBefore)), crFee.sub(returnFee));
    });

    it("should reject collateral reservation and burn fee", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const MinterMock = artifacts.require("MinterMock");
        const minterMock: MinterMockInstance = await MinterMock.new();
        await minterMock.receiveFunds({ from: minterAddress1, value: "100" });
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await minterMock.reserveCollateral(assetManager.address, agentVault.address, lots, feeBIPS, noExecutorAddress, ["addr1"], { from: minterAddress1, value: crFee });
        let rec = await web3.eth.getTransactionReceipt(tx.tx);
        const topics = rec.logs[0].topics;
        const crId = topics[3];
        // reject reservation
        // returning fee to minter should fail - fee should be burned
        const burnAddressBalance = await web3.eth.getBalance(settings.burnAddress);
        await assetManager.rejectCollateralReservation(crId, { from: agentOwner1 });
        const burnAddressBalanceAfter = await web3.eth.getBalance(settings.burnAddress);
        assertWeb3Equal(toBN(burnAddressBalance).add(crFee), burnAddressBalanceAfter);
    });

    it("should revert rejecting reservation if already approved", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        // approve reservation
        const tx1 = await assetManager.approveCollateralReservation(args.collateralReservationId, { from: agentOwner1 });
        requiredEventArgs(tx1, "CollateralReserved");
        await expectRevert(assetManager.rejectCollateralReservation(args.collateralReservationId, { from: agentOwner1 }), "handshake not required or collateral reservation already approved");
    });

    it("should cancel collateral reservation", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const settings = await assetManager.getSettings();
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const returnFee = crFee.mul(toBN(settings.rejectOrCancelCollateralReservationReturnFactorBIPS)).div(toBN(10000));
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        // move time for cancelCollateralReservationAfterSeconds
        await deterministicTimeIncrease(Number(settings.cancelCollateralReservationAfterSeconds));
        // cancel reservation
        const minterBalanceBefore = await web3.eth.getBalance(minterAddress1);
        const burnAddressBalanceBefore = await web3.eth.getBalance(settings.burnAddress);
        const tx1 = await assetManager.cancelCollateralReservation(args.collateralReservationId, { from: minterAddress1 });
        const minterBalanceAfter = await web3.eth.getBalance(minterAddress1);
        const burnAddressBalanceAfter = await web3.eth.getBalance(settings.burnAddress);
        assertWeb3Equal(toBN(minterBalanceBefore).add(returnFee).sub(toBN(tx1.receipt.gasUsed).mul(toBN(tx1.receipt.effectiveGasPrice))), minterBalanceAfter);
        assertWeb3Equal(toBN(burnAddressBalanceAfter).sub(toBN(burnAddressBalanceBefore)), crFee.sub(returnFee));
    });

    it("should not cancel collateral reservation if not called by minter", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        // try to cancel reservation
        await expectRevert(assetManager.cancelCollateralReservation(args.collateralReservationId), "only minter");
    });

    it("should not cancel collateral reservation if already approved", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        // approve reservation
        await assetManager.approveCollateralReservation(args.collateralReservationId, { from: agentOwner1 });
        // try to cancel reservation
        await expectRevert(assetManager.cancelCollateralReservation(args.collateralReservationId, { from: minterAddress1 }), "collateral reservation already approved");
    });

    it("should not cancel collateral reservation if called to early", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        // try to cancel reservation
        await expectRevert(assetManager.cancelCollateralReservation(args.collateralReservationId, { from: minterAddress1 }), "collateral reservation cancellation too early");
    });

    it("should not reserve collateral if agent not available", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "agent not in mint queue");
    });

    it("should not reserve collateral if trying to mint 0 lots", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, 0, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "cannot mint 0 lots");
    });

    it("should not reserve collateral if agent's status is not 'NORMAL'", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const tx = await wallet.addTransaction(underlyingAgent1, underlyingRandomAddress, 100, null);
        const proof = await attestationProvider.proveBalanceDecreasingTransaction(tx, underlyingAgent1);
        await assetManager.illegalPaymentChallenge(proof, agentVault.address);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "rc: invalid agent status");
    });

    it("should not reserve collateral if not enough free collateral", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 500000000;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "not enough free collateral");
    });

    it("should reserve collateral when agent has minimum required amount of all types of collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        const ac = await AgentCollateral.create(assetManager, settings, agentVault.address);
        const collateralPool = await artifacts.require("CollateralPool").at(ac.agentInfo.collateralPool);
        //
        const lots = 10;
        const mintValueAMG = toBN(settings.lotSizeAMG).muln(lots);
        // deposit collaterals
        const vaultCollateral = ac.collateralRequiredToMintAmountAMG(ac.vault, mintValueAMG);
        const poolCollateral = ac.collateralRequiredToMintAmountAMG(ac.pool, mintValueAMG);
        const poolTokens = ac.collateralRequiredToMintAmountAMG(ac.agentPoolTokens, mintValueAMG);
        // // debug
        // const poolTokensCorrect = ac.agentPoolTokens.amgPrice.convertAmgToTokenWei(mintValueAMG).mul(toBN(settings.mintingPoolHoldingsRequiredBIPS)).divn(MAX_BIPS);
        // console.log(deepFormat({ vaultCollateral, poolCollateral, poolTokens, poolTokensCorrect, amountWei: ac.agentPoolTokens.amgPrice.convertAmgToTokenWei(mintValueAMG) }));
        // separately deposit vault collateral, buy pool tokens, and enter pool - all at minimum required amount
        await depositCollateral(agentOwner1, agentVault, vaultCollateral);
        await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: poolTokens });
        await collateralPool.enter(0, false, { from: agentOwner1, value: poolCollateral.sub(poolTokens) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
    });

    it("should not reserve collateral if not enough free agent pool tokens", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        const ac = await AgentCollateral.create(assetManager, settings, agentVault.address);
        const collateralPool = await artifacts.require("CollateralPool").at(ac.agentInfo.collateralPool);
        //
        const lots = 10;
        const mintValueAMG = toBN(settings.lotSizeAMG).muln(lots);
        // deposit collaterals
        const vaultCollateral = ac.collateralRequiredToMintAmountAMG(ac.vault, mintValueAMG);
        const poolCollateral = ac.collateralRequiredToMintAmountAMG(ac.pool, mintValueAMG);
        const poolTokens = ac.collateralRequiredToMintAmountAMG(ac.agentPoolTokens, mintValueAMG);
        // separately deposit vault collateral, buy pool tokens, and enter pool
        await depositCollateral(agentOwner1, agentVault, vaultCollateral);
        await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: poolTokens.subn(100) });
        await collateralPool.enter(0, false, { from: agentOwner1, value: poolCollateral.sub(poolTokens) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "not enough free collateral");
    });

    it("should not reserve collateral if not enough free vault collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        const ac = await AgentCollateral.create(assetManager, settings, agentVault.address);
        const collateralPool = await artifacts.require("CollateralPool").at(ac.agentInfo.collateralPool);
        //
        const lots = 10;
        const mintValueAMG = toBN(settings.lotSizeAMG).muln(lots);
        // deposit collaterals
        const vaultCollateral = ac.collateralRequiredToMintAmountAMG(ac.vault, mintValueAMG);
        const poolCollateral = ac.collateralRequiredToMintAmountAMG(ac.pool, mintValueAMG);
        const poolTokens = ac.collateralRequiredToMintAmountAMG(ac.agentPoolTokens, mintValueAMG);
        // separately deposit vault collateral, buy pool tokens, and enter pool
        await depositCollateral(agentOwner1, agentVault, vaultCollateral.subn(100));
        await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: poolTokens });
        await collateralPool.enter(0, false, { from: agentOwner1, value: poolCollateral.sub(poolTokens) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "not enough free collateral");
    });

    it("should not reserve collateral if not enough free pool collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        const ac = await AgentCollateral.create(assetManager, settings, agentVault.address);
        const collateralPool = await artifacts.require("CollateralPool").at(ac.agentInfo.collateralPool);
        //
        const lots = 10;
        const mintValueAMG = toBN(settings.lotSizeAMG).muln(lots);
        // deposit collaterals
        const vaultCollateral = ac.collateralRequiredToMintAmountAMG(ac.vault, mintValueAMG);
        const poolCollateral = ac.collateralRequiredToMintAmountAMG(ac.pool, mintValueAMG);
        const poolTokens = ac.collateralRequiredToMintAmountAMG(ac.agentPoolTokens, mintValueAMG);
        // separately deposit vault collateral, buy pool tokens, and enter pool
        await depositCollateral(agentOwner1, agentVault, vaultCollateral);
        await agentVault.buyCollateralPoolTokens({ from: agentOwner1, value: poolTokens });
        await collateralPool.enter(0, false, { from: agentOwner1, value: poolCollateral.sub(poolTokens).subn(100) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "not enough free collateral");
    });

    it("should not reserve collateral if agent's fee is too high", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS - 1, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        // assert
        await expectRevert(promise, "agent's fee too high");
    });

    it("should not reserve collateral if inappropriate fee amount is sent", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        // assert
        const promise1 = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee.subn(1) });
        await expectRevert(promise1, "inappropriate fee amount");
    });

    it("should not reserve collateral - minter underlying addresses required", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        // assert
        const promise1 = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [], { from: minterAddress1, value: crFee });
        await expectRevert(promise1, "minter underlying addresses required");
    });

    it("should not reserve collateral - minter underlying addresses not sorted", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        // assert
        const promise1 = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, ["Agent1", "Agent2"], { from: minterAddress1, value: crFee });
        await expectRevert(promise1, "minter underlying addresses not sorted");
    });

    it("should not reserve collateral - minter underlying address invalid", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        // assert
        const promise1 = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, ["", "Agent2"], { from: minterAddress1, value: crFee });
        await expectRevert(promise1, "minter underlying address invalid");
        const promise2 = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, ["Agent1", ""], { from: minterAddress1, value: crFee });
        await expectRevert(promise2, "minter underlying address invalid");
    });

    it("should not default minting if minting non-payment mismatch", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const crt = await reserveCollateral(agentVault.address, 3);
        // mine some blocks to create overflow block
        for (let i = 0; i <= chainInfo.underlyingBlocksForPayment * 25; i++) {
            await wallet.addTransaction(underlyingMinter1, underlyingMinter1, 1, null);
        }
        // act
        // wrong address
        const proofAddress = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingMinter1, crt.paymentReference, crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        const promiseAddress = assetManager.mintingPaymentDefault(proofAddress, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert(promiseAddress, "minting non-payment mismatch");
        // wrong reference
        const proofReference = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, PaymentReference.minting(crt.collateralReservationId.addn(1)), crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        const promiseReference = assetManager.mintingPaymentDefault(proofReference, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert(promiseReference, "minting non-payment mismatch");
        // wrong amount
        const proofAmount = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, crt.paymentReference, crt.valueUBA.add(crt.feeUBA).addn(1),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        const promiseAmount = assetManager.mintingPaymentDefault(proofAmount, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert(promiseAmount, "minting non-payment mismatch");
    });

    it("should not default minting if called too early", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const crt = await reserveCollateral(agentVault.address, 3);
        // mine some blocks to create overflow block
        for (let i = 0; i <= chainInfo.underlyingBlocksForPayment * 25; i++) {
            await wallet.addTransaction(underlyingMinter1, underlyingMinter1, 1, null);
        }
        // act
        // wrong overflow block
        const proofOverflow = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, crt.paymentReference, crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber() - 1, crt.lastUnderlyingTimestamp.toNumber() - chainInfo.blockTime * 2);
        const promiseOverflow = assetManager.mintingPaymentDefault(proofOverflow, crt.collateralReservationId, { from: agentOwner1 });
        // assert
        await expectRevert(promiseOverflow, "minting default too early");
    });

    it("should not default minting if reservation not approved", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        const agentVault1 = await createAgent(accounts[123], accounts[234], { feeBIPS: feeBIPS, handshakeType: 0 });
        await depositAndMakeAgentAvailable(agentVault1, accounts[123]);
        const crt = await reserveCollateral(agentVault1.address, 3);
        // it doesn't matter if the proof is correct
        for (let i = 0; i <= chainInfo.underlyingBlocksForPayment * 25; i++) {
            await wallet.addTransaction(underlyingMinter1, underlyingMinter1, 1, null);
        }
        const proof = await attestationProvider.proveReferencedPaymentNonexistence(
            accounts[234], crt.paymentReference, crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber() - 1, crt.lastUnderlyingTimestamp.toNumber() - chainInfo.blockTime * 2);
        const promise = assetManager.mintingPaymentDefault(proof, args.collateralReservationId, { from: agentOwner1 });
        // assert
        await expectRevert(promise, "collateral reservation not approved");
    });

    it("should not default minting if invalid check or source addresses root", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const crt = await reserveCollateral(agentVault.address, 3);
        // mine some blocks to create overflow block
        for (let i = 0; i <= chainInfo.underlyingBlocksForPayment * 25; i++) {
            await wallet.addTransaction(underlyingMinter1, underlyingMinter1, 1, null);
        }
        // act
        // wrong source addresses root
        const proofAddress = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, crt.paymentReference, crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber(), web3.utils.soliditySha3("non-zero-root")!);
        const promiseAddress = assetManager.mintingPaymentDefault(proofAddress, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert(promiseAddress, "invalid check or source addresses root");
    });

    it("should revert default minting if invalid check (even if zero root)", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const crt = await reserveCollateral(agentVault.address, 3);
        // mine some blocks to create overflow block
        for (let i = 0; i <= chainInfo.underlyingBlocksForPayment * 25; i++) {
            await wallet.addTransaction(underlyingMinter1, underlyingMinter1, 1, null);
        }
        // act
        // wrong source addresses root (zero root)
        const proofAddress = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, crt.paymentReference, crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber(), ZERO_BYTES32);
        const promiseAddress = assetManager.mintingPaymentDefault(proofAddress, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert(promiseAddress, "invalid check or source addresses root");
    });

    it("should not unstick minting if collateral reservation is not approved", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        const agentVault1 = await createAgent(accounts[123], accounts[234], { feeBIPS: feeBIPS, handshakeType: 0 });
        const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        await depositAndMakeAgentAvailable(agentVault1, accounts[123]);
        // should provide enough funds
        await expectRevert(assetManager.unstickMinting(proof, args.collateralReservationId, { from: agentOwner1 }), "collateral reservation not approved");
    });

    it("should not default minting if minting non-payment proof window too short", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        const crt = await reserveCollateral(agentVault.address, 3);
        // mine some blocks to create overflow block
        chain.mine(chainInfo.underlyingBlocksForPayment + 1);
        // skip the time until the proofs cannot be made anymore
        chain.skipTime(Number(settings.attestationWindowSeconds) + 1);
        // act
        // wrong overflow block
        const proofOverflow = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, crt.paymentReference, crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber() + 1, crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        const promiseOverflow = assetManager.mintingPaymentDefault(proofOverflow, crt.collateralReservationId, { from: agentOwner1 });
        // assert
        await expectRevert(promiseOverflow, "minting non-payment proof window too short");
    });

    it("should not approve reservation if emergency paused", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS: feeBIPS, handshakeType: 1 });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, [underlyingMinter1], { from: minterAddress1, value: crFee });
        const args = requiredEventArgs(tx, "HandshakeRequired");
        // approve reservation
        await assetManager.emergencyPause(false, 12 * 60, { from: assetManagerController });
        const promise = assetManager.approveCollateralReservation(args.collateralReservationId, { from: agentOwner1 });
        await expectRevert(promise, "emergency pause active");
    });

});
