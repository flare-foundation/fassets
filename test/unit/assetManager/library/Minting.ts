import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { lotSize } from "../../../../lib/fasset/Conversions";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { precomputeContractAddress } from "../../../../lib/test-utils/contract-test-helpers";
import { calcGasCost } from "../../../../lib/test-utils/eth";
import { AgentCollateral } from "../../../../lib/test-utils/fasset/AgentCollateral";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectEvent, expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { createTestAgent, createTestCollaterals, createTestContracts, createTestSettings, TestSettingsContracts } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { TX_BLOCKED, TX_FAILED } from "../../../../lib/underlying-chain/interfaces/IBlockChain";
import { EventArgs } from "../../../../lib/utils/events/common";
import { requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BNish, MAX_BIPS, toBIPS, toBN, toWei } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";
import { CollateralReserved } from "../../../../typechain-truffle/IIAssetManager";

contract(`Minting.sol; ${getTestFile(__filename)}; Minting basic tests`, accounts => {
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
    let wallet: MockChainWallet;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;

    // addresses
    const agentOwner1 = accounts[20];
    const agentOwner2 = accounts[21];
    const minterAddress1 = accounts[30];
    const executorAddress1 = accounts[41];
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingAgent2 = "Agent2";
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
        const totalNatFee = crFee.add(toWei(0.1));
        const res = await assetManager.reserveCollateral(agentVault, lots, agentInfo.feeBIPS, executorAddress1,
            { from: minterAddress1, value: totalNatFee });
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

    function getAgentFeeShare(fee: BN, poolFeeShareBIPS: BN) {
        return fee.sub(getPoolFeeShare(fee, poolFeeShareBIPS));
    }

    function getPoolFeeShare(fee: BN, poolFeeShareBIPS: BN) {
        return fee.mul(poolFeeShareBIPS).divn(MAX_BIPS);
    }

    function skipToProofUnavailability(lastUnderlyingBlock: BNish, lastUnderlyingTimestamp: BNish) {
        chain.skipTimeTo(Number(lastUnderlyingTimestamp) + 1);
        chain.mineTo(Number(lastUnderlyingBlock) + 1);
        chain.skipTime(flareDataConnectorClient.queryWindowSeconds + 1);
        chain.mine(chain.finalizationBlocks);
    }

    async function initialize() {
        const ci = testChainInfo.eth;
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
    };

    beforeEach(async () => {
        ({ contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset } = await loadFixtureCopyVars(initialize));
    });

    it("should execute minting (minter)", async () => {
        // init
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const txHash = await performMintingPayment(crt);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        const event = requiredEventArgs(res, 'MintingExecuted');
        assertWeb3Equal(event.agentVault, agentVault.address);
        assertWeb3Equal(event.collateralReservationId, crt.collateralReservationId);
        assertWeb3Equal(event.mintedAmountUBA, crt.valueUBA);
        assertWeb3Equal(event.agentFeeUBA, getAgentFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        assertWeb3Equal(event.poolFeeUBA, getPoolFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        const ticketCreated = requiredEventArgs(res, "RedemptionTicketCreated");
        assertWeb3Equal(ticketCreated.agentVault, agentVault.address);
        assertWeb3Equal(ticketCreated.redemptionTicketId, 1);
        assertWeb3Equal(ticketCreated.ticketValueUBA, crt.valueUBA);
    });

    it("should execute minting (minter, many lots)", async () => {
        // init
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 30);
        const txHash = await performMintingPayment(crt);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        const event = requiredEventArgs(res, 'MintingExecuted');
        assertWeb3Equal(event.agentVault, agentVault.address);
        assertWeb3Equal(event.collateralReservationId, crt.collateralReservationId);
        assertWeb3Equal(event.mintedAmountUBA, crt.valueUBA);
        assertWeb3Equal(event.agentFeeUBA, getAgentFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        assertWeb3Equal(event.poolFeeUBA, getPoolFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        const ticketCreated = requiredEventArgs(res, "RedemptionTicketCreated");
        assertWeb3Equal(ticketCreated.agentVault, agentVault.address);
        assertWeb3Equal(ticketCreated.redemptionTicketId, 1);
        const lotSz = lotSize(settings);
        const totalMintedWholeLots = toBN(event.mintedAmountUBA).add(toBN(event.poolFeeUBA)).div(lotSz).mul(lotSz);
        assertWeb3Equal(ticketCreated.ticketValueUBA, totalMintedWholeLots);
    });

    it("should execute minting (agent)", async () => {
        // init
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const txHash = await performMintingPayment(crt);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: agentOwner1 });
        // assert
        const event = requiredEventArgs(res, 'MintingExecuted');
        assertWeb3Equal(event.agentVault, agentVault.address);
        assertWeb3Equal(event.collateralReservationId, crt.collateralReservationId);
        assertWeb3Equal(event.mintedAmountUBA, crt.valueUBA);
        assertWeb3Equal(event.agentFeeUBA, getAgentFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        assertWeb3Equal(event.poolFeeUBA, getPoolFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        const ticketCreated = requiredEventArgs(res, "RedemptionTicketCreated");
        assertWeb3Equal(ticketCreated.agentVault, agentVault.address);
        assertWeb3Equal(ticketCreated.redemptionTicketId, 1);
        assertWeb3Equal(ticketCreated.ticketValueUBA, crt.valueUBA);
    });

    it("should execute minting (executor)", async () => {
        // init
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const txHash = await performMintingPayment(crt);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const executorBalanceStart = toBN(await web3.eth.getBalance(executorAddress1));
        const executorWNatBalanceStart = await wNat.balanceOf(executorAddress1);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: executorAddress1 });
        const executorBalanceEnd = toBN(await web3.eth.getBalance(executorAddress1));
        const executorWNatBalanceEnd = await wNat.balanceOf(executorAddress1);
        const gasFee = calcGasCost(res);
        assertWeb3Equal(executorBalanceStart.sub(executorBalanceEnd), gasFee);
        assertWeb3Equal(executorWNatBalanceEnd.sub(executorWNatBalanceStart), toWei(0.1));
        // assert
        const event = requiredEventArgs(res, 'MintingExecuted');
        assertWeb3Equal(event.agentVault, agentVault.address);
        assertWeb3Equal(event.collateralReservationId, crt.collateralReservationId);
        assertWeb3Equal(event.mintedAmountUBA, crt.valueUBA);
        assertWeb3Equal(event.agentFeeUBA, getAgentFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        assertWeb3Equal(event.poolFeeUBA, getPoolFeeShare(toBN(crt.feeUBA), poolFeeShareBIPS));
        const ticketCreated = requiredEventArgs(res, "RedemptionTicketCreated");
        assertWeb3Equal(ticketCreated.agentVault, agentVault.address);
        assertWeb3Equal(ticketCreated.redemptionTicketId, 1);
        assertWeb3Equal(ticketCreated.ticketValueUBA, crt.valueUBA);
    });

    it("should not execute minting if not agent or minter or executor", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const txHash = await performMintingPayment(crt);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const promise = assetManager.executeMinting(proof, crt.collateralReservationId, { from: accounts[0] });
        // assert
        await expectRevert.custom(promise, "OnlyMinterExecutorOrAgent", []);
    });

    it("should not execute minting if invalid minting reference", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        chain.mint(underlyingMinter1, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingMinter1, crt.paymentAddress, paymentAmount, PaymentReference.redemption(crt.collateralReservationId));
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const promise = assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        await expectRevert.custom(promise, "InvalidMintingReference", []);
    });

    it("should not execute minting if minting payment failed", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        chain.mint(underlyingMinter1, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingMinter1, crt.paymentAddress, paymentAmount, crt.paymentReference, {status: TX_FAILED});
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const promise = assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        await expectRevert.custom(promise, "PaymentFailed", []);
    });

    it("should not execute minting if minting payment blocked", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        chain.mint(underlyingMinter1, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingMinter1, crt.paymentAddress, paymentAmount, crt.paymentReference, {status: TX_BLOCKED});
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const promise = assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        await expectRevert.custom(promise, "PaymentFailed", []);
    });

    it("should not execute minting if not minting agent's address", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        chain.mint(underlyingMinter1, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingMinter1, underlyingRandomAddress, paymentAmount, crt.paymentReference);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, underlyingRandomAddress);
        const promise = assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        await expectRevert.custom(promise, "NotMintingAgentsAddress", []);
    });

    it("should not execute minting if minting payment too small", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const paymentAmount = crt.valueUBA.add(crt.feeUBA).subn(1);
        chain.mint(underlyingMinter1, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingMinter1, crt.paymentAddress, paymentAmount, crt.paymentReference);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const promise = assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        await expectRevert.custom(promise, "MintingPaymentTooSmall", []);
    });

    it("should unstick minting", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        skipToProofUnavailability(crt.lastUnderlyingBlock, crt.lastUnderlyingTimestamp);
        // assert
        const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        const agentCollateral = await AgentCollateral.create(assetManager, settings, agentVault.address);
        const burnNats = agentCollateral.pool.convertUBAToTokenWei(crt.valueUBA)
            .mul(toBN(settings.vaultCollateralBuyForFlareFactorBIPS)).divn(MAX_BIPS);
        // should provide enough funds
        await expectRevert.custom(assetManager.unstickMinting(proof, crt.collateralReservationId, { from: agentOwner1, value: burnNats.muln(0.99) }),
            "NotEnoughFundsProvided", []);
        // succeed when there is enough
        await assetManager.unstickMinting(proof, crt.collateralReservationId, { from: agentOwner1, value: burnNats });
    });

    it("should merge redemption tickets when two consecutive mintings go to the same agent", async () => {
        // init
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act/1
        const crt = await reserveCollateral(agentVault.address, 1);
        const txHash = await performMintingPayment(crt);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // act/2
        const crt2 = await reserveCollateral(agentVault.address, 1);
        const txHash2 = await performMintingPayment(crt2);
        const proof2 = await attestationProvider.provePayment(txHash2, underlyingMinter1, crt2.paymentAddress);
        const res2 = await assetManager.executeMinting(proof2, crt2.collateralReservationId, { from: minterAddress1 });
        // assert
        const ticketValue1 = toBN(crt.valueUBA);    // no fee - only whole lots are assigned to ticket
        const ticketValue2 = toBN(crt2.valueUBA);
        expectEvent(res, "MintingExecuted");
        expectEvent(res, "RedemptionTicketCreated", { ticketValueUBA: ticketValue1 });
        expectEvent(res2, "MintingExecuted");
        expectEvent.notEmitted(res2, "RedemptionTicketCreated");
        expectEvent(res2, "RedemptionTicketUpdated", { ticketValueUBA: ticketValue1.add(ticketValue2) });
    });

    it("should update underlying block with minting proof", async () => {
        // init
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const crt = await reserveCollateral(agentVault.address, 1);
        const txHash = await performMintingPayment(crt);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinter1, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress1 });
        // assert
        const { 0: underlyingBlock, 1: underlyingTime, 2: updateTime } = await assetManager.currentUnderlyingBlock();
        assertWeb3Equal(underlyingBlock, toBN(proof.data.responseBody.blockNumber).addn(1));
        assert.isTrue(underlyingTime.gt(toBN(proof.data.responseBody.blockTimestamp)));
        assertWeb3Equal(updateTime, await time.latest());
    });

    it("should self-mint", async () => {
        // init
        const feeBIPS = toBIPS("10%");
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        const poolFee = paymentAmount.mul(feeBIPS).divn(MAX_BIPS).mul(poolFeeShareBIPS).divn(MAX_BIPS);
        const txHash = await performSelfMintingPayment(agentVault.address, paymentAmount.add(poolFee));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const res = await assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        const event = requiredEventArgs(res, 'SelfMint');
        assertWeb3Equal(event.agentVault, agentVault.address);
        assertWeb3Equal(event.mintFromFreeUnderlying, false);
        assertWeb3Equal(event.mintedAmountUBA, paymentAmount);
        assertWeb3Equal(event.depositedAmountUBA, paymentAmount.add(poolFee));
        assertWeb3Equal(event.poolFeeUBA, poolFee);
        const ticketCreated = requiredEventArgs(res, "RedemptionTicketCreated");
        assertWeb3Equal(ticketCreated.agentVault, agentVault.address);
        assertWeb3Equal(ticketCreated.redemptionTicketId, 1);
        assertWeb3Equal(ticketCreated.ticketValueUBA, event.mintedAmountUBA);
    });

    it("should self-mint and increase free balance", async () => {
        // init
        const feeBIPS = toBIPS("10%");
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        const txHash = await performSelfMintingPayment(agentVault.address, paymentAmount);
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const res = await assetManager.selfMint(proof, agentVault.address, 1, { from: agentOwner1 });
        // assert
        const event = requiredEventArgs(res, 'SelfMint');
        const poolFee = toBN(event.mintedAmountUBA).mul(feeBIPS).divn(MAX_BIPS).mul(poolFeeShareBIPS).divn(MAX_BIPS);
        assertWeb3Equal(event.agentVault, agentVault.address);
        assertWeb3Equal(event.mintFromFreeUnderlying, false);
        assertWeb3Equal(event.mintedAmountUBA, paymentAmount.divn(2));
        assertWeb3Equal(event.depositedAmountUBA, paymentAmount);
        assertWeb3Equal(event.poolFeeUBA, poolFee);
        const ticketCreated = requiredEventArgs(res, "RedemptionTicketCreated");
        assertWeb3Equal(ticketCreated.agentVault, agentVault.address);
        assertWeb3Equal(ticketCreated.redemptionTicketId, 1);
        assertWeb3Equal(ticketCreated.ticketValueUBA, event.mintedAmountUBA);
    });

    it("should not self-mint if not agent", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        const txHash = await performSelfMintingPayment(agentVault.address, paymentAmount);
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: accounts[0] });
        // assert
        await expectRevert.custom(promise, "OnlyAgentVaultOwner", []);
    });

    it("should not self-mint if invalid self-mint reference", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentOwner1));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "InvalidSelfMintReference", []);
    });

    it("should not self-mint if payment failed", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentVault.address), {status: TX_FAILED});
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "PaymentFailed", []);
    });

    it("should not self-mint if payment blocked", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentVault.address), {status: TX_BLOCKED});
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "PaymentFailed", []);
    });

    it("should not self-mint if not agent's address", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingMinter1, paymentAmount, PaymentReference.selfMint(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingMinter1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "SelfMintNotAgentsAddress", []);
    });

    it("should not self-mint if self-mint payment too small", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots).subn(1);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "SelfMintPaymentTooSmall", []);
    });

    it("should not self-mint if not enough free collateral", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1, toWei(1_000_000));
        // act
        const lots = 10;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "NotEnoughFreeCollateral", []);
    });

    it("should update underlying block with self mint proof", async () => {
        // init
        const feeBIPS = toBIPS("10%");
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        const poolFee = paymentAmount.mul(feeBIPS).divn(MAX_BIPS).mul(poolFeeShareBIPS).divn(MAX_BIPS);
        const txHash = await performSelfMintingPayment(agentVault.address, paymentAmount.add(poolFee));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const res = await assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        const { 0: underlyingBlock, 1: underlyingTime, 2: updateTime } = await assetManager.currentUnderlyingBlock();
        assertWeb3Equal(underlyingBlock, toBN(proof.data.responseBody.blockNumber).addn(1));
        assert.isTrue(underlyingTime.gt(toBN(proof.data.responseBody.blockTimestamp)));
        assertWeb3Equal(updateTime, await time.latest());
    });


    it("check agent's minting capacity", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1, toWei(1_000_000));
        // act
        const settings = await assetManager.getSettings();
        // console.log("Settings", formatStruct(settings));
        const info = await assetManager.getAgentInfo(agentVault.address);
        // console.log("Agent info", formatStruct(info));
        const ac = await AgentCollateral.create(assetManager, settings, agentVault.address);
        // console.log(`Free lots: ${ac.freeCollateralLots()}`);
        //
        assertWeb3Equal(ac.freeCollateralLots(), info.freeCollateralLots);
        assertWeb3Equal(ac.freeCollateralWei(ac.vault), info.freeVaultCollateralWei);
        assertWeb3Equal(ac.freeCollateralWei(ac.pool), info.freePoolCollateralNATWei);
        assertWeb3Equal(ac.freeCollateralWei(ac.agentPoolTokens), info.freeAgentPoolTokensWei);
    });


    it("should only topup if trying to self-mint 0 lots", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots).subn(1);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const before = await assetManager.getAgentInfo(agentVault.address);
        const res = await assetManager.selfMint(proof, agentVault.address, 0, { from: agentOwner1 });
        const after = await assetManager.getAgentInfo(agentVault.address);
        // assert
        expectEvent(res, 'SelfMint', { agentVault: agentVault.address, mintFromFreeUnderlying: false, mintedAmountUBA: toBN(0), depositedAmountUBA: paymentAmount, poolFeeUBA: toBN(0) });
        assertWeb3Equal(toBN(after.freeUnderlyingBalanceUBA).sub(toBN(before.freeUnderlyingBalanceUBA)), paymentAmount, "invalid self-mint topup value");
    });

    it("should not self-mint if agent's status is not 'NORMAL'", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        //await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1});
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots).subn(1);
        chain.mint(underlyingRandomAddress, paymentAmount);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount, PaymentReference.selfMint(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "SelfMintInvalidAgentStatus", []);
    });

    it("should not self-mint if self-mint payment too old", async () => {
        // init
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        const feeBIPS = toBIPS("10%");
        const poolFeeShareBIPS = toBIPS(0.4);
        const poolFee = paymentAmount.mul(feeBIPS).divn(MAX_BIPS).mul(poolFeeShareBIPS).divn(MAX_BIPS);
        chain.mint(underlyingRandomAddress, paymentAmount.add(poolFee));
        const nonce = await web3.eth.getTransactionCount(contracts.agentVaultFactory.address);
        const agentVaultAddressCalc = precomputeContractAddress(contracts.agentVaultFactory.address, nonce);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, paymentAmount.add(poolFee), PaymentReference.selfMint(agentVaultAddressCalc));
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, poolFeeShareBIPS });
        const amount = toWei(3e8);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "SelfMintPaymentTooOld", []);
    });

    it("should not self-mint if it is emergency paused", async () => {
        // init
        const feeBIPS = toBIPS("10%");
        const poolFeeShareBIPS = toBIPS(0.4);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1, { feeBIPS, poolFeeShareBIPS });
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        // act
        const lots = 2;
        const paymentAmount = toBN(settings.lotSizeAMG).mul(toBN(settings.assetMintingGranularityUBA)).muln(lots);
        const poolFee = paymentAmount.mul(feeBIPS).divn(MAX_BIPS).mul(poolFeeShareBIPS).divn(MAX_BIPS);
        const txHash = await performSelfMintingPayment(agentVault.address, paymentAmount.add(poolFee));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        await assetManager.emergencyPause(false, 12 * 60, { from: assetManagerController });
        const promise = assetManager.selfMint(proof, agentVault.address, lots, { from: agentOwner1 });
        // assert
        await expectRevert.custom(promise, "EmergencyPauseActive", []);
    });

    it("should not mint from free underlying if agent's status is not 'NORMAL'", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        //await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1});
        // act
        const lots = 2;
        const promise = assetManager.mintFromFreeUnderlying(agentVault.address, lots, { from: agentOwner1});
        // assert
        await expectRevert.custom(promise, "SelfMintInvalidAgentStatus", []);
    });

    it("should not mint from free underlying if minting is paused", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // pause minting
        await assetManager.pauseMinting({ from: assetManagerController });
        // act
        const lots = 2;
        const promise = assetManager.mintFromFreeUnderlying(agentVault.address, lots, { from: agentOwner1});
        // assert
        await expectRevert.custom(promise, "MintingPaused", []);
    });

    it("should not mint from free underlying if emergency paused", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // emergency pause minting
        await assetManager.emergencyPause(false, 12 * 60, { from: assetManagerController });
        // act
        const lots = 2;
        const promise = assetManager.mintFromFreeUnderlying(agentVault.address, lots, { from: agentOwner1});
        // assert
        await expectRevert.custom(promise, "EmergencyPauseActive", []);
    });

    it("should not mint from free underlying if not attached", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // emergency pause minting
        await assetManager.attachController(false, { from: assetManagerController });
        // act
        const lots = 2;
        const promise = assetManager.mintFromFreeUnderlying(agentVault.address, lots, { from: agentOwner1});
        // assert
        await expectRevert.custom(promise, "NotAttached", []);
    });


});
