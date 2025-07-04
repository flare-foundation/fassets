import { globSync } from "glob";
import { readFileSync } from "node:fs";
import { runAsyncMain } from "../../lib/deploy-utils";

function abiToString(abi: AbiItem) {
    const args = abi.inputs!.map(it => `${it.internalType} ${it.name}`);
    return `${abi.name}(${args.join(", ")})`;
}

runAsyncMain(async () => {
    const files = globSync('artifacts/!(build-info)/**/+([a-zA-Z0-9_]).json')

    for (const file of files) {
        const artifact = JSON.parse(readFileSync(file, { encoding: "utf-8" }));
        if (artifact.bytecode === "0x") continue;   // interface
        const contractName = artifact.contractName as string;
        for (const item of artifact.abi as AbiItem[]) {
            if (item.inputs) {
                const sig = web3.eth.abi.encodeFunctionSignature(item);
                console.log(`${sig}  ${contractName}  ${item.type}  ${abiToString(item)}`);
            } else {
                console.log(`----------  ${contractName}  ${item.type}  ${JSON.stringify(item)}`);
            }
        }
    }
});
