import { expect } from "chai";
import { expectRevert } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { toBN } from "../../../../lib/utils/helpers";
import { SafePctMockInstance } from "../../../../typechain-truffle/SafePctMock";

const SafePct = artifacts.require("SafePctMock");

contract(`SafePct.sol; ${getTestFile(__filename)};  SafePct unit tests`, accounts => {
    let safePct: SafePctMockInstance;
    before(async() => {
        safePct = await SafePct.new();
    });

    it("should calculate correctly", async () => {
        const result = await safePct.mulDiv(2, 3, 4);
        expect(result.toNumber()).to.equals(1);
    });

    it("should calculate correctly - first factor equals 0", async () => {
        const result = await safePct.mulDiv(0, 3, 4);
        expect(result.toNumber()).to.equals(0);
    });

    it("should calculate correctly - second factor equals 0", async () => {
        const result = await safePct.mulDiv(2, 0, 4);
        expect(result.toNumber()).to.equals(0);
    });

    it("should revert - division by 0", async () => {
        const tx = safePct.mulDiv(2, 3, 0);
        await expectRevert.custom(tx, "DivisionByZero", []);
    });

    it("should calculate correctly - no overflow", async () => {
        const result = await safePct.mulDiv(toBN(2).pow(toBN(225)), toBN(2).pow(toBN(225)), toBN(2).pow(toBN(200)));
        expect(result.eq(toBN(2).pow(toBN(250)))).to.be.true;
    });
});
