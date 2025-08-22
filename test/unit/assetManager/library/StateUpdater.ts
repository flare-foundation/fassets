import { CollateralType } from "../../../../lib/fasset/AssetManagerTypes";
import { PaymentReference } from "../../../../lib/fasset/PaymentReference";
import { testChainInfo } from "../../../../lib/test-utils/actors/TestChainInfo";
import { AssetManagerInitSettings, newAssetManager } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { MockChain, MockChainWallet } from "../../../../lib/test-utils/fasset/MockChain";
import { MockFlareDataConnectorClient } from "../../../../lib/test-utils/fasset/MockFlareDataConnectorClient";
import { expectEvent, time } from "../../../../lib/test-utils/test-helpers";
import { TestSettingsContracts, createTestCollaterals, createTestContracts, createTestSettings } from "../../../../lib/test-utils/test-settings";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { AttestationHelper } from "../../../../lib/underlying-chain/AttestationHelper";
import { FAssetInstance, IIAssetManagerInstance } from "../../../../typechain-truffle";

contract(`StateUpdater.sol; ${getTestFile(__filename)}; StateUpdater basic tests`, accounts => {
    const governance = accounts[10];
    const assetManagerController = accounts[11];
    let contracts: TestSettingsContracts;
    let assetManager: IIAssetManagerInstance;
    let fAsset: FAssetInstance;
    let settings: AssetManagerInitSettings;
    let collaterals: CollateralType[];
    let chain: MockChain;
    let wallet: MockChainWallet;
    let flareDataConnectorClient: MockFlareDataConnectorClient;
    let attestationProvider: AttestationHelper;

    // addresses
    const agentOwner1 = accounts[20];
    const underlyingAgent1 = "Agent1";  // addresses on mock underlying chain can be any string, as long as it is unique

    async function initialize() {
        const ci = testChainInfo.eth;
        contracts = await createTestContracts(governance);
        // create mock chain and attestation provider
        chain = new MockChain(await time.latest());
        wallet = new MockChainWallet(chain);
        flareDataConnectorClient = new MockFlareDataConnectorClient(contracts.fdcHub, contracts.relay, { [ci.chainId]: chain }, 'auto');
        attestationProvider = new AttestationHelper(flareDataConnectorClient, chain, ci.chainId);
        // create asset manager
        collaterals = createTestCollaterals(contracts, ci);
        settings = createTestSettings(contracts, ci);
        [assetManager, fAsset] = await newAssetManager(governance, assetManagerController, ci.name, ci.symbol, ci.decimals, settings, collaterals, ci.assetName, ci.assetSymbol);
        return { contracts, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset };
    }

    beforeEach(async () => {
        ({ contracts, chain, wallet, flareDataConnectorClient, attestationProvider, collaterals, settings, assetManager, fAsset } = await loadFixtureCopyVars(initialize));
    });

    it("update current block - twice", async () => {
        chain.mine(3);  // make sure block no and timestamp change
        chain.mint(underlyingAgent1, 200);
        const txHash = await wallet.addTransaction(underlyingAgent1, underlyingAgent1, 50, PaymentReference.topup(agentOwner1), { maxFee: 100 });
        await attestationProvider.provePayment(txHash, underlyingAgent1, underlyingAgent1);

        const proof = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        const res = await assetManager.updateCurrentBlock(proof);
        expectEvent(res, 'CurrentUnderlyingBlockUpdated', { underlyingBlockNumber: proof.data.requestBody.blockNumber, underlyingBlockTimestamp: proof.data.responseBody.blockTimestamp });

        // when nothing is changed, there should be no event
        const proof2 = await attestationProvider.proveConfirmedBlockHeightExists(Number(settings.attestationWindowSeconds));
        const res2 = await assetManager.updateCurrentBlock(proof2);
        expectEvent.notEmitted(res2, "CurrentUnderlyingBlockUpdated");
    });
});
