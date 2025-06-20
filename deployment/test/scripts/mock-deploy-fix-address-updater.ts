import { FAssetContractStore } from "../../lib/contracts";
import { runAsyncMain } from "../../lib/deploy-utils";
import { executeTimelockedGovernanceCall } from "../../../lib/test-utils/contract-test-helpers";

const AddressUpdaterMock = artifacts.require('AddressUpdaterMock');

runAsyncMain(async () => {
    const contracts = new FAssetContractStore("deployment/deploys/hardhat.json", true);
    const addressUpdater = await AddressUpdaterMock.at(contracts.AddressUpdater.address);
    await executeTimelockedGovernanceCall(addressUpdater, (governance) =>
        addressUpdater.addOrUpdateContractNamesAndAddresses(["AssetManagerController"], [contracts.AssetManagerController!.address], { from: governance }));
});
