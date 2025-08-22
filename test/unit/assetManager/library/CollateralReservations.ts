import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { TestChainInfo, testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { calcGasCost } from "../../../../lib/test-utils/eth";
import { AgentCollateral } from "../../../../lib/test-utils/fasset/AgentCollateral";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { createTestAgent, createTestCollaterals, createTestContracts, createTestSettings, TestSettingsContracts } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { EventArgs } from "../../../../lib/utils/events/common";
import { requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BNish, toBN, toWei, ZERO_ADDRESS, ZERO_BYTES32 } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";
import { CollateralReserved } from "../../../../typechain-truffle/IIAssetManager";

contract(`CollateralReservations.sol; ${getTestFile(__filename)}; CollateralReservations basic tests`, accounts => {
    const governance = accounts[10];
    const assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManager: IIAssetManagerInstance;
    let fAsset: FAssetInstance;
    let wNat: WNatMockInstance;
    let usdc: ERC20MockInstance;
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

    async function reserveCollateral(agentVault: string, lots: BNish) {
        const agentInfo = await assetManager.getAgentInfo(agentVault);
        const crFee = await assetManager.collateralReservationFee(lots);
        const res = await assetManager.reserveCollateral(agentVault, lots, agentInfo.feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
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
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        return { contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset };
    }

    beforeEach(async () => {
        ({ contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset } = await loadFixtureCopyVars(initialize));
    });

    it("should reserve collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
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

    it("should reserve collateral and get funds back if not setting executor", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const balanceBefore = await web3.eth.getBalance(minterAddress1);
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee.addn(1000) });
        const balanceAfter = await web3.eth.getBalance(minterAddress1);
        assertWeb3Equal(toBN(balanceBefore).sub(crFee).sub(calcGasCost(tx)), balanceAfter);
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

    it("should reserve collateral and not get funds back if setting executor", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const balanceBefore = await web3.eth.getBalance(minterAddress1);
        const crFee = await assetManager.collateralReservationFee(lots);
        const tx = await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, accounts[19], { from: minterAddress1, value: crFee.addn(1000) });
        const balanceAfter = await web3.eth.getBalance(minterAddress1);
        assertWeb3Equal(toBN(balanceBefore).sub(crFee).subn(1000).sub(calcGasCost(tx)), balanceAfter);
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

    it("should not reserve collateral if agent not available", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "AgentNotInMintQueue", []);
    });

    it("should not reserve collateral if trying to mint 0 lots", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, 0, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "CannotMintZeroLots", []);
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
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "InvalidAgentStatus", []);
    });

    it("should not reserve collateral if not enough free collateral", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 500000000;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "NotEnoughFreeCollateral", []);
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
        await collateralPool.enter({ from: agentOwner1, value: poolCollateral.sub(poolTokens) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        await assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
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
        await collateralPool.enter({ from: agentOwner1, value: poolCollateral.sub(poolTokens) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "NotEnoughFreeCollateral", []);
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
        await collateralPool.enter({ from: agentOwner1, value: poolCollateral.sub(poolTokens) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "NotEnoughFreeCollateral", []);
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
        await collateralPool.enter({ from: agentOwner1, value: poolCollateral.sub(poolTokens).subn(100) });
        //
        await assetManager.makeAgentAvailable(agentVault.address, { from: agentOwner1 });
        // act
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "NotEnoughFreeCollateral", []);
    });

    it("should not reserve collateral if agent's fee is too high", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 1;
        const crFee = await assetManager.collateralReservationFee(lots);
        const promise = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS - 1, noExecutorAddress, { from: minterAddress1, value: crFee });
        // assert
        await expectRevert.custom(promise, "AgentsFeeTooHigh", []);
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
        const promise1 = assetManager.reserveCollateral(agentVault.address, lots, feeBIPS, noExecutorAddress, { from: minterAddress1, value: crFee.subn(1) });
        await expectRevert.custom(promise1, "InappropriateFeeAmount", []);
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
        await expectRevert.custom(promiseAddress, "MintingNonPaymentMismatch", []);
        // wrong reference
        const proofReference = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, PaymentReference.minting(crt.collateralReservationId.addn(1)), crt.valueUBA.add(crt.feeUBA),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        const promiseReference = assetManager.mintingPaymentDefault(proofReference, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert.custom(promiseReference, "MintingNonPaymentMismatch", []);
        // wrong amount
        const proofAmount = await attestationProvider.proveReferencedPaymentNonexistence(
            underlyingAgent1, crt.paymentReference, crt.valueUBA.add(crt.feeUBA).addn(1),
            crt.firstUnderlyingBlock.toNumber(), crt.lastUnderlyingBlock.toNumber(), crt.lastUnderlyingTimestamp.toNumber());
        const promiseAmount = assetManager.mintingPaymentDefault(proofAmount, crt.collateralReservationId, { from: agentOwner1 });
        await expectRevert.custom(promiseAmount, "MintingNonPaymentMismatch", []);
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
        await expectRevert.custom(promiseOverflow, "MintingDefaultTooEarly", []);
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
        await expectRevert.custom(promiseAddress, "SourceAddressesNotSupported", []);
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
        await expectRevert.custom(promiseAddress, "SourceAddressesNotSupported", []);
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
        await expectRevert.custom(promiseOverflow, "MintingNonPaymentProofWindowTooShort", []);
    });

});
