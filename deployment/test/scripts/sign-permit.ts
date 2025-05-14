import { Permit, signPermit } from "../../../lib/utils/erc20permits";
import { web3DeepNormalize } from "../../../lib/utils/web3normalize";
import { runDeployScript } from "../../lib/deploy-scripts";
import { requiredEnvironmentVariable } from "../../lib/deploy-utils";

runDeployScript(async ({ hre, artifacts, contracts }) => {
    const privateKey = requiredEnvironmentVariable("PERMIT_PRIVATE_KEY");
    const tokenName = requiredEnvironmentVariable("TOKEN");
    const amount = requiredEnvironmentVariable("AMOUNT");
    const spender = requiredEnvironmentVariable("SPENDER");

    const FAsset = artifacts.require("FAsset");
    const token = await FAsset.at(contracts.getAddress(tokenName));

    const owner = hre.web3.eth.accounts.privateKeyToAccount(privateKey).address;
    const nonce = await token.nonces(owner);

    const permit: Permit = {
        owner: owner,
        spender: spender,
        nonce: nonce,
        value: hre.web3.utils.toBN(amount),
        deadline: hre.web3.utils.toBN("1000000000000"),
    };

    console.log(JSON.stringify(web3DeepNormalize(permit), null, 4));

    const signature = await signPermit(token, privateKey, permit);

    console.log(JSON.stringify(signature, null, 4));
});