import { runDeployScript } from "../../lib/deploy-scripts";

runDeployScript(async ({ hre, artifacts, contracts }) => {
    const AgentOwnerRegistry = artifacts.require("AgentOwnerRegistry");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const agentOwnerRegistry = await AgentOwnerRegistry.at(contracts.getAddress("AgentOwnerRegistry"));

    // await agentOwnerRegistry.whitelistAndDescribeAgent("0x0e99603F99935766e717f96DAf05475E973d8722", "Oracle-daemon", "Oracle-daemon agent",
    //     "https://raw.githubusercontent.com/TowoLabs/ftso-signal-providers/master/assets/0xfe532cB6Fb3C47940aeA7BeAd4d61C5e041D950e.png", "");
    // await agentOwnerRegistry.whitelistAndDescribeAgent("0x986a7acAc1EF0Fd09C37bFb4E70A37351e29BD55", "White Knight", "Liquidating with good intentions",
    //     "https://raw.githubusercontent.com/TowoLabs/ftso-signal-providers/master/assets/0xfe532cB6Fb3C47940aeA7BeAd4d61C5e041D950e.png", "");
});
