import hre from "hardhat";
import { loadCurrentDeployContracts, runAsyncMain } from "../../lib/deploy-utils";
import { mockSetPrices } from "../utils/mock-set-prices";

// only use on local networks, where FtsoV2PriceStoreMock is deployed instead of FtsoV2PriceStore
runAsyncMain(async () => {
    const contracts = loadCurrentDeployContracts(false);
    await mockSetPrices(hre, contracts);
});
