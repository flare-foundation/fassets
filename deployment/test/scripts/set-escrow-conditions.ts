import { readFileSync } from "fs";
import { runDeployScript } from "../../lib/deploy-scripts";
import { requiredEnvironmentVariable, waitFinalize } from "../../lib/deploy-utils";
import assert from "assert";

runDeployScript(async ({ hre, artifacts, contracts, deployer }) => {
    const filename = requiredEnvironmentVariable("ESCROW_CONDITIONS");
    const fassetSymbol = requiredEnvironmentVariable("FASSET");
    const chunkSize = 50;

    const CoreVaultManager = artifacts.require("CoreVaultManager");
    const coreVaultManager = await CoreVaultManager.at(contracts.getAddress(`CoreVaultManager_${fassetSymbol}`));

    const data = JSON.parse(readFileSync(filename).toString()) as string[];
    const list = data.map(s => {
        if (!s.startsWith("0x")) s = "0x" + s;
        assert(/^0x[0-9a-fA-F]{64}$/.test(s));
        return s;
    });

    for (let i = 0; i < list.length; i += chunkSize) {
        const end = Math.min(i + chunkSize, list.length);
        console.log(`Adding conditions ${i} to ${end} of ${list.length}`)
        const chunk = list.slice(i, end);
        await waitFinalize(hre, deployer, () => coreVaultManager.addPreimageHashes(chunk, { from: deployer }));
    }
});
