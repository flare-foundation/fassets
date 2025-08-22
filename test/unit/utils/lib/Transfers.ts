import { expectRevert } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { toBNExp } from "../../../../lib/utils/helpers";
import { MathUtilsMockInstance, TransfersMockInstance } from "../../../../typechain-truffle";

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
        await expectRevert.custom(transfers.transferNAT(mathUtils.address, 1000), "TransferFailed", []);
    });

    it("unguarded transfers should fail", async () => {
        const account = web3.eth.accounts.create();
        await expectRevert.custom(transfers.transferNATNoGuard(account.address, 1000), "ReentrancyGuardRequired", []);
    });

    it("transfers with 0 value should work (but do nothing)", async () => {
        const account = web3.eth.accounts.create();
        await transfers.transferNAT(account.address, 0);
        assertWeb3Equal(await web3.eth.getBalance(account.address), 0);
    });
});
