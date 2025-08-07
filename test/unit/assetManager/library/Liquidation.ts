import { AgentSettings, AgentStatus, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { createTestAgent, createTestCollaterals, createTestContracts, createTestSettings, TestSettingsContracts } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { EventArgs } from "../../../../lib/utils/events/common";
import { filterEvents, requiredEventArgs } from "../../../../lib/utils/events/truffle";
import { BN_ZERO, BNish, toBN, toBNExp, toWei, ZERO_ADDRESS } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";
import { CollateralReserved } from "../../../../typechain-truffle/IIAssetManager";

contract(`Liquidation.sol; ${getTestFile(__filename)}; Liquidation basic tests`, accounts => {
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
    const minterAddress1 = accounts[30];
    const redeemerAddress1 = accounts[40];
    const noExecutorAddress = ZERO_ADDRESS;
    const liquidatorAddress1 = accounts[60];

    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingMinter1 = "Minter1";
    const underlyingRedeemer1 = "Redeemer1";


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

    async function reserveCollateral(agentVault: AgentVaultInstance, minterAddress: string, lots: BNish) {
        const agentInfo = await assetManager.getAgentInfo(agentVault.address);
        const crFee = await assetManager.collateralReservationFee(lots);
        const resAg = await assetManager.reserveCollateral(agentVault.address, lots, agentInfo.feeBIPS, noExecutorAddress, { from: minterAddress, value: crFee });
        const crt = requiredEventArgs(resAg, 'CollateralReserved');
        return crt;
    }

    async function performMinting(crt: EventArgs<CollateralReserved>, underlyingMinterAddress: string) {
        chain.mint(underlyingMinterAddress, toBNExp(10000, 18));
        const paymentAmount = crt.valueUBA.add(crt.feeUBA);
        const txHash = await wallet.addTransaction(underlyingMinterAddress, crt.paymentAddress, paymentAmount, crt.paymentReference);
        const proof = await attestationProvider.provePayment(txHash, underlyingMinterAddress, crt.paymentAddress);
        const res = await assetManager.executeMinting(proof, crt.collateralReservationId, { from: crt.minter });
        return requiredEventArgs(res, 'MintingExecuted');
    }

    async function mint(agentVault: AgentVaultInstance, underlyingMinterAddress: string, minterAddress: string, lots: BNish = 3) {
        // minter
        const crt = await reserveCollateral(agentVault, minterAddress, lots);
        return await performMinting(crt, underlyingMinterAddress);
    }

    async function redeem(underlyingRedeemerAddress: string, redeemerAddress: string, lots: BNish = 3) {
        const resR = await assetManager.redeem(lots, underlyingRedeemerAddress, noExecutorAddress, { from: redeemerAddress });
        const redemptionRequests = filterEvents(resR, 'RedemptionRequested').map(e => e.args);
        const request = redemptionRequests[0];
        return request;
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
    }

    beforeEach(async () => {
        ({ contracts, wNat, usdc, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset } = await loadFixtureCopyVars(initialize));
    });

    it("should not liquidate if collateral ratio is ok", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1);
        await mint(agentVault, underlyingMinter1, minterAddress1);
        // act
        const promise = assetManager.liquidate(agentVault.address, 500);
        // assert
        await expectRevert.custom(promise, "NotInLiquidation", []);
    });

    it("should not liquidate if agent is in status DESTROYING", async () => {
        // init
        chain.mint(underlyingAgent1, 100);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        // act
        await assetManager.announceDestroyAgent(agentVault.address, { from: agentOwner1 });
        const tx = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer1, 100, null);
        const proof = await attestationProvider.proveBalanceDecreasingTransaction(tx, underlyingAgent1);
        await expectRevert.custom(assetManager.illegalPaymentChallenge(proof, agentVault.address), "ChallengeInvalidAgentStatus", []);
        // assert
        const info = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info.status, 3);
        // Calling start liquidation will revert
        await expectRevert.custom(assetManager.startLiquidation(agentVault.address), "LiquidationNotPossible", [3]);
        // Calling liquidate will revert
        await expectRevert.custom(assetManager.liquidate(agentVault.address, 1, { from: liquidatorAddress1}), "LiquidationNotPossible", [3]);
        // assert
        const info1 = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info1.status, 3);
    });

    it("should not change liquidationStartedAt timestamp when liquidation phase does not change (liquidation -> full_liquidation)", async () => {
        // init
        chain.mint(underlyingAgent1, 200);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1, toWei(3e6));
        await mint(agentVault, underlyingMinter1, minterAddress1);
        // act
        const assetName = await fAsset.symbol();
        await contracts.priceStore.setCurrentPrice(assetName, 4294967295, 0);
        await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetName, 4294967295, 0);

        await assetManager.startLiquidation(agentVault.address);
        const info1 = await assetManager.getAgentInfo(agentVault.address);
        const tx = await wallet.addTransaction(underlyingAgent1, underlyingRedeemer1, 100, null);
        const proof = await attestationProvider.proveBalanceDecreasingTransaction(tx, underlyingAgent1);
        await assetManager.illegalPaymentChallenge(proof, agentVault.address);
        const info2 = await assetManager.getAgentInfo(agentVault.address);
        // assert
        assertWeb3Equal(info1.liquidationStartTimestamp, info2.liquidationStartTimestamp);
        assertWeb3Equal(info1.status, 1);
        assertWeb3Equal(info2.status, 2);
        //Calling start liquidation again won't change anything
        await assetManager.startLiquidation(agentVault.address);
        // assert
        const info3 = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info3.status, 2);
    });

    it("should not revert if calling startLiquidation twice", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1, toWei(3e6));
        const minted = await mint(agentVault, underlyingMinter1, minterAddress1);
        const assetName = await fAsset.symbol();
        // act
        await contracts.priceStore.setCurrentPrice(assetName, toBNExp(3.521, 9), 0);
        await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetName, toBNExp(3.521, 9), 0);

        const res = await assetManager.startLiquidation(agentVault.address);
        const liquidationStartedAt = requiredEventArgs(res, 'LiquidationStarted').timestamp;
        const info1 = await assetManager.getAgentInfo(agentVault.address);
        // liquidator "buys" f-assets
        await fAsset.transfer(liquidatorAddress1, minted.mintedAmountUBA.divn(2), { from: minterAddress1 });
        await assetManager.liquidate(agentVault.address, minted.mintedAmountUBA.divn(2), { from: liquidatorAddress1 });
        await contracts.priceStore.setCurrentPrice(assetName, toBNExp(3.521, 5), 0);

        const liquidationStartedAt2 = await assetManager.startLiquidation.call(agentVault.address);
        await assetManager.startLiquidation(agentVault.address);
        const info2 = await assetManager.getAgentInfo(agentVault.address);
        await assetManager.endLiquidation(agentVault.address);
        const info3 = await assetManager.getAgentInfo(agentVault.address);
        // assert
        assertWeb3Equal(liquidationStartedAt, liquidationStartedAt2);
        assertWeb3Equal(info1.liquidationStartTimestamp, liquidationStartedAt);
        assertWeb3Equal(info1.liquidationStartTimestamp, info2.liquidationStartTimestamp);
        assertWeb3Equal(info1.status, 1);
        assertWeb3Equal(info2.status, 1);
        assertWeb3Equal(info3.status, 0);
    });

    it("should not start liquidation if trusted price is ok for agent", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1, toWei(3e6));
        const minted = await mint(agentVault, underlyingMinter1, minterAddress1);
        const assetName = await fAsset.symbol();
        // act
        await contracts.priceStore.setCurrentPrice(assetName, toBNExp(8, 8), 0);
        await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetName, toBNExp(3, 8), 0);

        await expectRevert.custom(assetManager.startLiquidation(agentVault.address), "LiquidationNotStarted", []);
        const info1 = await assetManager.getAgentInfo(agentVault.address);
        // liquidator "buys" f-assets
        assertWeb3Equal(info1.status, AgentStatus.NORMAL);
    });

    it("should ignore trusted price if it is too old", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1, toWei(3e6));
        const minted = await mint(agentVault, underlyingMinter1, minterAddress1);
        const assetName = await fAsset.symbol();
        // act
        await contracts.priceStore.setCurrentPrice(assetName, toBNExp(8, 8), 0);
        await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetName, toBNExp(3, 8), 10000);
        await assetManager.startLiquidation(agentVault.address);
        const info1 = await assetManager.getAgentInfo(agentVault.address);
        // liquidator "buys" f-assets
        assertWeb3Equal(info1.status, AgentStatus.LIQUIDATION);
    });

    it("should account for reserved and redeeming assets in calculating CR and max liquidation amount", async () => {
        // init
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        await depositAndMakeAgentAvailable(agentVault, agentOwner1, toWei(3e6));
        const crt = await reserveCollateral(agentVault, minterAddress1, 5);
        // change price
        const assetName = await fAsset.symbol();
        await contracts.priceStore.setCurrentPrice(assetName, toBNExp(8, 8), 0);
        await contracts.priceStore.setCurrentPriceFromTrustedProviders(assetName, toBNExp(8, 8), 0);
        // can start liquidation
        await assetManager.startLiquidation(agentVault.address);
        // agent should be in liquidation now, but max liquidation is 0 until the minting is complete
        const info0 = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info0.status, AgentStatus.LIQUIDATION);
        assertWeb3Equal(info0.mintedUBA, 0);
        assertWeb3Equal(info0.maxLiquidationAmountUBA, 0);
        // finish minting now
        await performMinting(crt, underlyingMinter1);
        // now max liquidation should be nonzero and smaller than minted amount
        const info1 = await assetManager.getAgentInfo(agentVault.address);
        assert(toBN(info1.maxLiquidationAmountUBA).gt(BN_ZERO));
        assert(toBN(info1.maxLiquidationAmountUBA).lt(toBN(info1.mintedUBA)));
        // start small redemption
        await redeem(underlyingMinter1, minterAddress1, 2);
        // max liquidated amount should stay the same as long as it is less than the remaining mintedAMG
        const info2 = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info2.maxLiquidationAmountUBA, info1.maxLiquidationAmountUBA);
        assert(toBN(info2.maxLiquidationAmountUBA).gt(BN_ZERO));
        assert(toBN(info2.maxLiquidationAmountUBA).lt(toBN(info2.mintedUBA)));
        // more redemption
        await redeem(underlyingMinter1, minterAddress1, 2);
        // max liquidated amount should now be limited by the mintedAMG
        const info3 = await assetManager.getAgentInfo(agentVault.address);
        assertWeb3Equal(info3.maxLiquidationAmountUBA, info3.mintedUBA);
        assert(toBN(info3.maxLiquidationAmountUBA).lt(toBN(info1.maxLiquidationAmountUBA)));
    });
});
