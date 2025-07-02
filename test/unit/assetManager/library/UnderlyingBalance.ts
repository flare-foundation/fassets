import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { precomputeContractAddress } from "../../../../lib/test-utils/contract-test-helpers";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestAgent, createTestCollaterals, createTestContracts, createTestSettings } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { findRequiredEvent } from "../../../../lib/utils/events/truffle";
import { randomAddress } from "../../../../lib/utils/helpers";
import { ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";

contract(`UnderlyingBalance.sol; ${getTestFile(__filename)};  UnderlyingBalance unit tests`, accounts => {

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
    const underlyingAgent1 = "Agent1";  // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingRandomAddress = "Random";

    function createAgent(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const vaultCollateralToken = options?.vaultCollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, chain, wallet, attestationProvider }, owner, underlyingAddress, vaultCollateralToken, options);
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

    it("should confirm top up payment", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        chain.mint(underlyingRandomAddress,1000);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, 500, PaymentReference.topup(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        await assetManager.confirmTopupPayment(proof, agentVault.address, { from: agentOwner1 });
    });

    it("should reject confirmation of top up payment if payment is negative", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        chain.mint(underlyingRandomAddress,1000);
        chain.mint(underlyingAgent1,1000);
        const txHash = await wallet.addMultiTransaction({[underlyingAgent1]: 500, [underlyingRandomAddress]: 100}, {[underlyingAgent1]: 450, [underlyingRandomAddress]: 0}, PaymentReference.topup(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        await expectRevert(assetManager.confirmTopupPayment(proof, agentVault.address, { from: agentOwner1 }), "SafeCast: value must be positive");
        const proofIllegal = await attestationProvider.proveBalanceDecreasingTransaction(txHash, underlyingAgent1);
        const res = await assetManager.illegalPaymentChallenge(proofIllegal, agentVault.address);
        findRequiredEvent(res, 'IllegalPaymentConfirmed');
        findRequiredEvent(res, 'FullLiquidationStarted');
    });

    it("should reject confirmation of top up payment - not underlying address", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingRandomAddress, 500, PaymentReference.topup(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingRandomAddress);
        const res = assetManager.confirmTopupPayment(proof, agentVault.address, { from: agentOwner1 });
        await expectRevert.custom(res, "NotUnderlyingAddress", []);
    });
    it("should reject confirmation of top up payment - not a topup payment", async () => {
        chain.mint(underlyingRandomAddress,1000);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, 500, PaymentReference.topup(randomAddress()));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const res = assetManager.confirmTopupPayment(proof, agentVault.address, { from: agentOwner1 });
        await expectRevert.custom(res, "NotATopupPayment", []);
    });
    it("should reject confirmation of top up payment - topup before agent created", async () => {
        chain.mint(underlyingRandomAddress,1000);
        const agentVaultAddressCalc = precomputeContractAddress(contracts.agentVaultFactory.address, 1);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, 500, PaymentReference.topup(agentVaultAddressCalc));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const res =  assetManager.confirmTopupPayment(proof, agentVault.address, { from: agentOwner1 });
        await expectRevert.custom(res, "TopupBeforeAgentCreated", []);
    });
});
