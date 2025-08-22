import { expectRevert } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { toBN } from "../../../../lib/utils/helpers";
import { SafeMath64MockInstance } from "../../../../typechain-truffle";

const SafeMath64 = artifacts.require("SafeMath64Mock");

contract(`SafeMath64.sol; ${getTestFile(__filename)};  SafeMath64 unit tests`, accounts => {
    let safeMath64: SafeMath64MockInstance;
    const MAX_UINT64 = toBN(2).pow(toBN(64));
    const MAX_INT64 = toBN(2).pow(toBN(63));

    before(async() => {
        safeMath64 = await SafeMath64.new();
    });

    it("should revert if negative number ot overflow", async () => {
        const resN = safeMath64.toUint64(-1);
        await expectRevert.custom(resN, "NegativeValue", []);
        const resO = safeMath64.toUint64(MAX_UINT64);
        await expectRevert.custom(resO, "ConversionOverflow", []);
    });

    it("should revert if overflow", async () => {
        const res = safeMath64.toInt64(MAX_INT64);
        await expectRevert.custom(res, "ConversionOverflow", []);
    });

    it("should successfully return", async () => {
        await safeMath64.toUint64(MAX_UINT64.subn(1));
        await safeMath64.toInt64(MAX_INT64.subn(1));
    });
});
