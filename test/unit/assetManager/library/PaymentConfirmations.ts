import { AgentSettings, CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestAgent, createTestCollaterals, createTestContracts, createTestSettings } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { DAYS } from "../../../../lib/utils/helpers";
import { AgentVaultInstance, ERC20MockInstance, FAssetInstance, IIAssetManagerInstance, WNatMockInstance } from "../../../../typechain-truffle";

contract(`PaymentConfirmations.sol; ${getTestFile(__filename)}; PaymentConfirmations basic tests`, accounts => {
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
    // addresses on mock underlying chain can be any string, as long as it is unique
    const underlyingAgent1 = "Agent1";
    const underlyingRandomAddress = "Random";

    function createAgent(owner: string, underlyingAddress: string, options?: Partial<AgentSettings>) {
        const vaultCollateralToken = options?.vaultCollateralToken ?? usdc.address;
        return createTestAgent({ assetManager, settings, chain, wallet, attestationProvider }, owner, underlyingAddress, vaultCollateralToken, options);
    }

    async function agentTopup(agentVault: AgentVaultInstance){
        chain.mint(underlyingRandomAddress, 1);
        const txHash = await wallet.addTransaction(underlyingRandomAddress, underlyingAgent1, 1, PaymentReference.topup(agentVault.address));
        const proof = await attestationProvider.provePayment(txHash, null, underlyingAgent1);
        await assetManager.confirmTopupPayment(proof, agentVault.address, { from: agentOwner1 });
        return proof;
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

    it("should prevent confirming twice", async () => {
        const agentVault = await createAgent(agentOwner1, underlyingAgent1);
        const proof1 = await agentTopup(agentVault);
        // make transaction in the "future" (chains timestamp may differ)
        chain.skipTime(15 * DAYS);
        const proof2 = await agentTopup(agentVault);
        // it should revert confirming twice
        await expectRevert.custom(assetManager.confirmTopupPayment(proof1, agentVault.address, { from: agentOwner1 }), "PaymentAlreadyConfirmed", []);
        await expectRevert.custom(assetManager.confirmTopupPayment(proof2, agentVault.address, { from: agentOwner1 }), "PaymentAlreadyConfirmed", []);
    });
});
