import { expect } from "chai";
import { MathUtilsMockInstance } from "../../../../typechain-truffle";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { toBN } from "../../../../lib/utils/helpers";

const MathUtils = artifacts.require("MathUtilsMock");

contract(`MathUtils.sol; ${getTestFile(__filename)};  MathUtils unit tests`, accounts => {
    let mathUtils: MathUtilsMockInstance;
    before(async() => {
        mathUtils = await MathUtils.new();
    });

    it("should calculate correctly - round up", async () => {
        const result = await mathUtils.roundUp(21, 4);
        expect(result.toNumber()).to.equals(24);
    });

    it("should calculate correctly - no rounding", async () => {
        const result = await mathUtils.roundUp(20, 4);
        expect(result.toNumber()).to.equals(20);
    });

    it("should calculate correctly - sub or zero (positive result)", async () => {
        const result = await mathUtils.subOrZero(20, 4);
        expect(result.toNumber()).to.equals(16);
    });

    it("should calculate correctly - sub or zero (positive result)", async () => {
        const result = await mathUtils.subOrZero(4, 20);
        expect(result.toNumber()).to.equals(0);
    });

    it("should calculate correctly - positive part", async () => {
        const result = await mathUtils.positivePart(5);
        expect(result.toNumber()).to.equals(5);
});

    it("should calculate correctly - positive part", async () => {
        const result = await mathUtils.positivePart(-5);
        expect(result.toNumber()).to.equals(0);
    });

    const MAX_INT_256 = toBN(1).shln(255).sub(toBN(1));
    const MAX_UINT_256 = toBN(1).shln(256).sub(toBN(1));

    it("should calculate correctly - mixedLTE (int <= uint)", async () => {
        expect(await mathUtils.mixedLTE_iu(-5, 1)).to.equals(true);
        expect(await mathUtils.mixedLTE_iu(1, 5)).to.equals(true);
        expect(await mathUtils.mixedLTE_iu(5, 1)).to.equals(false);
        expect(await mathUtils.mixedLTE_iu(0, 1)).to.equals(true);
        expect(await mathUtils.mixedLTE_iu(-1, 0)).to.equals(true);
        expect(await mathUtils.mixedLTE_iu(MAX_INT_256.neg(), 0)).to.equals(true);
        expect(await mathUtils.mixedLTE_iu(MAX_INT_256, 0)).to.equals(false);
        expect(await mathUtils.mixedLTE_iu(MAX_INT_256.neg(), MAX_UINT_256)).to.equals(true);
    });

    it("should calculate correctly - mixedLTE (uint <= int)", async () => {
        expect(await mathUtils.mixedLTE_ui(1, -1)).to.equals(false);
        expect(await mathUtils.mixedLTE_ui(1, 5)).to.equals(true);
        expect(await mathUtils.mixedLTE_ui(5, 1)).to.equals(false);
        expect(await mathUtils.mixedLTE_ui(0, 1)).to.equals(true);
        expect(await mathUtils.mixedLTE_ui(0, -3)).to.equals(false);
        expect(await mathUtils.mixedLTE_ui(0, MAX_INT_256.neg())).to.equals(false);
        expect(await mathUtils.mixedLTE_ui(0, MAX_INT_256)).to.equals(true);
        expect(await mathUtils.mixedLTE_ui(MAX_UINT_256, MAX_INT_256.neg())).to.equals(false);
    });
});
