import { expectRevert } from "@openzeppelin/test-helpers";
import { toBNExp } from "../../../../lib/utils/helpers";
import { MathUtilsMockInstance, TransfersMockInstance } from "../../../../typechain-truffle";
import { getTestFile } from "../../../../lib/test-utils/test-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";

const MathUtils = artifacts.require("MathUtilsMock");
const Transfers = artifacts.require("TransfersMock");

contract(`Transfers.sol; ${getTestFile(__filename)};  Transfers unit tests`, accounts => {
    let transfers: TransfersMockInstance;
    let mathUtils: MathUtilsMockInstance;

    before(async() => {
        transfers = await Transfers.new();
        await transfers.send(toBNExp(1, 18), { from: accounts[0] });
        mathUtils = await MathUtils.new();
    });

    it("should transferNAT", async () => {
        const account = web3.eth.accounts.create();
        await transfers.transferNAT(account.address, 1000);
        assertWeb3Equal(await web3.eth.getBalance(account.address), 1000);
    });

    it("should fail transferring nat to non-payable contract", async () => {
        await expectRevert(transfers.transferNAT(mathUtils.address, 1000), "transfer failed");
    });

    it("unguarded transfers should fail", async () => {
        const account = web3.eth.accounts.create();
        await expectRevert(transfers.transferNATNoGuard(account.address, 1000), "ReentrancyGuard: guard required");
    });

    it("transfers with 0 value should work (but do nothing)", async () => {
        const account = web3.eth.accounts.create();
        await transfers.transferNAT(account.address, 0);
        assertWeb3Equal(await web3.eth.getBalance(account.address), 0);
    });
});
