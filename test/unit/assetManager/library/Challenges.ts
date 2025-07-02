import { BalanceDecreasingTransaction } from "@flarenetwork/js-flare-common";
import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectEvent, expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { createTestAgent, createTestCollaterals, createTestContracts, createTestSettings, TestSettingsContracts } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { filterEvents, requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { toBN, toBNExp, toWei, ZERO_ADDRESS } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";

const CollateralPool = artifacts.require('CollateralPool');
const CollateralPoolToken = artifacts.require('CollateralPoolToken');

contract(`Challenges.sol; ${getTestFile(__filename)}; Challenges basic tests`, accounts => {
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

    let agentVault: AgentVaultInstance;
    let agentVault2: AgentVaultInstance;

    let agentTxHash: string;
    let agentTxProof: BalanceDecreasingTransaction.Proof;

    // addresses
    const underlyingBurnAddr = "Burn";
    const agentOwner1 = accounts[20];
    const underlyingAgent1 = "Agent1";  // addresses on mock underlying chain can be any string, as long as it is unique
    const challengerAddress = accounts[1];
    const underlyingRedeemer = "Redeemer";
    const agentOwner2 = accounts[40];
    const underlyingAgent2 = "Agent2";
    const underlyingMinterAddress = "Minter";
    const minterAddress1 = accounts[30];
    const underlyingRedeemer1 = "Redeemer1";
    const redeemerAddress1 = accounts[50]


    function createAgent(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const vaultCollateralToken = options?.vaultCollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, chain, wallet, attestationProvider }, owner, underlyingAddress, vaultCollateralToken, options);
    }

    async function depositAndMakeAgentAvailable(agentVault: AgentVaultInstance, owner: string) {
        // depositCollateral
        const agentPoolTokens = toWei(3e8);
        const vaultCollateral = toBNExp(250_000, 18);
        await usdc.mintAmount(owner, vaultCollateral);
        await usdc.increaseAllowance(agentVault.address, vaultCollateral, { from: owner });
        await agentVault.depositCollateral(usdc.address, vaultCollateral, { from: owner });
        await depositPoolTokens(agentVault, owner, agentPoolTokens);
        await assetManager.makeAgentAvailable(agentVault.address, { from: owner });
    }

    async function updateUnderlyingBlock() {
        const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        await assetManager.updateCurrentBlock(proof);
    }

    async function mint(agentVault: AgentVaultInstance, lots: number, minterAddress: string, chain: MockChain, underlyingMinterAddress: string, updateBlock: boolean) {
        chain.mint(underlyingMinterAddress, toBNExp(10000, 18));
        if (updateBlock) await updateUnderlyingBlock();
        // perform minting
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        const crFee = await assetManager.collateralReservationFee(lots);
        const resAg = await assetManager.reserveCollateral(agentVault.address, lots, agentInfo.feeBIPS, ZERO_ADDRESS, { from: minterAddress, value: crFee });
        const crt = requiredEventArgs(resAg, 'CollateralReserved');
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        const txHash = await wallet.addTransaction(underlyingMinterAddress, crt.paymentAddress, paymentAmount, crt.paymentReference);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinterAddress, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: minterAddress });
        return requiredEventArgs(res, 'MintingExecuted');
    }

    async function mintAndRedeem(agentVault: AgentVaultInstance, chain: MockChain, underlyingMinterAddress: string, minterAddress: string, underlyingRedeemerAddress: string, redeemerAddress: string, updateBlock: boolean) {
        const lots = 3;
        // minter
        const minted = await mint(agentVault, lots, minterAddress, chain, underlyingMinterAddress, updateBlock);
        // redeemer "buys" f-assets
        await fAsset.transfer(redeemerAddress, minted.mintedAmountUBA, { from: minterAddress });
        // redemption request
        const resR = await assetManager.redeem(lots, underlyingRedeemerAddress, ZERO_ADDRESS, { from: redeemerAddress });
        const redemptionRequests = filterEvents(resR, 'RedemptionRequested').map(e => e.args);
        const request = redemptionRequests[0];
        return request;
    }

    async function depositPoolTokens(agentVault: AgentVaultInstance, owner: string, tokens: BN) {
        const pool = await CollateralPool.at(await assetManager.getCollateralPool(agentVault.address));
        const poolToken = await CollateralPoolToken.at(await pool.poolToken());
        await pool.enter({ value: tokens, from: owner }); // owner will get at least `tokens` of tokens
        await time.deterministicIncrease(await assetManager.getCollateralPoolTokenTimelockSeconds()); // wait for token timelock
        await poolToken.transfer(agentVault.address, tokens, { from: owner });
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

        agentVault = await createAgent(agentOwner1, underlyingAgent1);
        agentVault2 = await createAgent(agentOwner2, underlyingAgent2);

        agentTxHash = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer, toWei(1), PaymentReference.redemption(1));
        agentTxProof = await attestationProvider.proveBalanceDecreasingTransaction(agentTxHash, underlyingAgent1);
        return { contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, agentVault, agentVault2, agentTxHash, agentTxProof };
    };

    beforeEach(async () => {
        ({ contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset, agentVault, agentVault2, agentTxHash, agentTxProof } =
            await loadFixtureCopyVars(initialize));
    });

    describe("illegal payment challenge", () => {

        it("should succeed challenging illegal payment", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(0));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = await assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: challengerAddress });
            expectEvent(res, "IllegalPaymentConfirmed");
        });

        it("should succeed challenging illegal payment for redemption", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(1));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = await assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: challengerAddress });
            expectEvent(res, "IllegalPaymentConfirmed");
        });

        it("should succeed challenging illegal withdrawal payment", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.announcedWithdrawal(1));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = await assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: challengerAddress });
            expectEvent(res, "IllegalPaymentConfirmed");
        });

        it("should succeed challenging illegal withdrawal payment - no announcement, zero id in reference", async () => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.announcedWithdrawal(0));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = await assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: challengerAddress });
            expectEvent(res, "IllegalPaymentConfirmed");
        });

        it("should succeed challenging illegal payment even after a year", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(0));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);

            await time.deterministicIncrease(365 * 86400);
            const res = await assetManager.illegalPaymentChallenge(
                proof, agentVault.address, { from: challengerAddress });
            expectEvent(res, "IllegalPaymentConfirmed");
        });

        it("should not succeed challenging illegal payment - ChallengeNotAgentsAddress", async () => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(0));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);

            const res = assetManager.illegalPaymentChallenge(
                proof, agentVault2.address, { from: challengerAddress });
            await expectRevert.custom(res, "ChallengeNotAgentsAddress", [])
        });

        it("should not succeed challenging illegal payment - matching ongoing announced pmt", async () => {
            const resp = await assetManager.announceUnderlyingWithdrawal(agentVault.address, { from: agentOwner1 });
            const req = requiredEventArgs(resp, 'UnderlyingWithdrawalAnnounced')
            const txHash = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer, 1, req.paymentReference);

            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = assetManager.illegalPaymentChallenge(proof, agentVault.address, { from: challengerAddress });
            await expectRevert.custom(res, "MatchingAnnouncedPaymentActive", []);
        });

    });

    describe("double payment challenge", () => {

        it("should revert on transactions with same references", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(2));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const promise = assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault.address, { from: challengerAddress });
            await expectRevert.custom(promise, "ChallengeNotDuplicate", []);
        });

        it("should revert on wrong agent's address", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent2, underlyingRedeemer, 1, PaymentReference.redemption(2));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent2);
            const promise = assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault.address, { from: challengerAddress });
            await expectRevert.custom(promise, "ChallengeNotAgentsAddress", []);
        });

        it("should revert on same references", async() => {
            const promise = assetManager.doublePaymentChallenge(
                agentTxProof, agentTxProof, agentVault.address, { from: challengerAddress });
            await expectRevert.custom(promise, "ChallengeSameTransactionRepeated", []);
        });

        it("should revert on not agent's address", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(1));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault2.address, { from: challengerAddress });
            await expectRevert.custom(res, "ChallengeNotAgentsAddress", []);
        });

        it("should successfully challenge double payments", async() => {
            const txHash = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, 1, PaymentReference.redemption(1));
            const proof = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
            const res = await assetManager.doublePaymentChallenge(
                agentTxProof, proof, agentVault.address, { from: challengerAddress });
            expectEvent(res, 'DuplicatePaymentConfirmed', {
                agentVault: agentVault.address, transactionHash1: agentTxHash, transactionHash2: txHash
            });
        });
    });

   describe("payments making free balance negative challange", () => {

        it("should revert repeated transaction", async() => {
            // payment references match
            const prms1 = assetManager.freeBalanceNegativeChallenge(
                [agentTxProof, agentTxProof], agentVault.address, { from: challengerAddress });
            await expectRevert.custom(prms1, "ChallengeSameTransactionRepeated", []);
        });

        it("should revert if transaction has different sources", async() => {
            const txHashA2 = await wallet.addTransaction(
                underlyingAgent2, underlyingRedeemer, 1, PaymentReference.redemption(2));
            const proofA2 = await attestationProvider.proveBalanceDecreasingTransaction(txHashA2, underlyingAgent2);
            // transaction sources are not the same agent
            const prmsW = assetManager.freeBalanceNegativeChallenge(
                [agentTxProof, proofA2], agentVault.address, { from: challengerAddress });
            await expectRevert.custom(prmsW, "ChallengeNotAgentsAddress", []);
        });

        it("should revert - already confirmed payments should be ignored", async () => {
            // init
            await depositAndMakeAgentAvailable(agentVault, agentOwner1);
            const request = await mintAndRedeem(agentVault, chain, underlyingMinterAddress, minterAddress1, underlyingRedeemer1, redeemerAddress1, true);
            //perform redemption payment
            const paymentAmt = request.valueUBA.sub(request.feeUBA);
            const tx1Hash = await wallet.addTransaction(underlyingAgent1, request.paymentAddress, paymentAmt, request.paymentReference);
            const proofR = await attestationProvider.provePayment(tx1Hash, underlyingAgent1, request.paymentAddress);
            await assetManager.confirmRedemptionPayment(proofR, request.requestId, { from: agentOwner1 });

            const proof2 = await attestationProvider.proveBalanceDecreasingTransaction(tx1Hash, underlyingAgent1);

            const res = assetManager.freeBalanceNegativeChallenge([agentTxProof, proof2], agentVault.address, { from: challengerAddress });
            await expectRevert.custom(res, "MultiplePaymentsChallengeEnoughBalance", []);
        });

        it("should revert - mult chlg: enough balance", async () => {
            // init
            await depositAndMakeAgentAvailable(agentVault, agentOwner1);
            const request = await mintAndRedeem(agentVault, chain, underlyingMinterAddress, minterAddress1, underlyingRedeemer1, redeemerAddress1, true);
            //perform redemption payment
            const paymentAmt = request.valueUBA.sub(request.feeUBA);
            const tx1Hash = await wallet.addTransaction(underlyingAgent1, request.paymentAddress, paymentAmt, request.paymentReference);
            const proofR = await attestationProvider.provePayment(tx1Hash, underlyingAgent1, request.paymentAddress);
            await assetManager.confirmRedemptionPayment(proofR, request.requestId, { from: agentOwner1 });

            const txHash2 = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer, 1, PaymentReference.announcedWithdrawal(2));
            const proof2 = await attestationProvider.proveBalanceDecreasingTransaction(txHash2, underlyingAgent1);

            const res = assetManager.freeBalanceNegativeChallenge([agentTxProof, proof2], agentVault.address, { from: challengerAddress });
            await expectRevert.custom(res, "MultiplePaymentsChallengeEnoughBalance", []);
        });

        it("should succeed in challenging payments if they make balance negative", async() => {
            await depositAndMakeAgentAvailable(agentVault, agentOwner1);
            await mint(agentVault, 1, minterAddress1, chain, underlyingMinterAddress, true);
            const info = await assetManager.getAgentInfo(agentVault.address);
            const transferAmount = toBN(info.underlyingBalanceUBA).muln(2);
            // make sure agent has enough available to make transaction (but without asset manager accounting it)
            chain.mint(underlyingAgent1, transferAmount);
            // console.log(deepFormat(info));
            const txHash2 = await wallet.addTransaction(
                underlyingAgent1, underlyingRedeemer, transferAmount, PaymentReference.announcedWithdrawal(2));
            const proof2 = await attestationProvider.proveBalanceDecreasingTransaction(txHash2, underlyingAgent1);
            // successful challenge
            const res1 = await assetManager.freeBalanceNegativeChallenge(
                [agentTxProof, proof2], agentVault.address, { from: challengerAddress });
            expectEvent(res1, 'UnderlyingBalanceTooLow', {agentVault: agentVault.address});
       });
    });

});
