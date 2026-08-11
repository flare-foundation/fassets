import { expect, assert } from "chai";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { BN_TEN, toBN } from "../../../../lib/utils/helpers";
import { MathUtilsMockInstance } from "../../../../typechain-truffle";
import { expectRevert } from "../../../../lib/test-utils/test-helpers";

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
    const MAX_UINT_32 = toBN(1).shln(32).subn(1);

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

    it("should bound value correctly", async () => {
        expect(Number(await mathUtils.bound(5, 1, 10))).to.equals(5);
        expect(Number(await mathUtils.bound(0, 1, 10))).to.equals(1);
        expect(Number(await mathUtils.bound(11, 1, 10))).to.equals(10);
    });

    it("should rescale correctly - basic", async () => {
        const value = MAX_UINT_32.muln(2);
        const { 0: rescaled, 1: scaleDec } = await mathUtils.rescale(value, MAX_UINT_32);
        // console.log(`scaleDec=${scaleDec} value=${value} rescaled=${rescaled}`);
        assert.isTrue(rescaled.lte(MAX_UINT_32));
        assert.isTrue(scaleDec.eqn(1));
    });

    const MAX_SCALE_DEC = 78;

    it("should rescale correctly", async () => {
        const threshold = MAX_UINT_32;
        const values = [toBN(1), toBN(25), toBN(1325), toBN(123456789), toBN(1e9), toBN(4123456789), MAX_UINT_32];
        let seed = 1;
        for (const baseVal of values) {
            let value = baseVal;
            for (let i = 0; ; i++) {
                const { 0: rescaled, 1: scaleDec } = await mathUtils.rescale(value, threshold);
                const scalingFactor = BN_TEN.pow(scaleDec);
                const approx = rescaled.mul(scalingFactor);
                const diff = value.sub(approx).abs();
                const relDiff = Number(diff) / Number(value);
                // console.log(`scaleDec=${scaleDec} value=${value} diff=${diff} rel=${relDiff}`);
                assert.isTrue(rescaled.lte(threshold));
                assert.isTrue(scaleDec.gten(0));
                assert.isTrue(scaleDec.gten(i - 10));
                assert.isTrue(scaleDec.lten(MAX_SCALE_DEC));
                assert.isTrue(scalingFactor.eqn(1) || scalingFactor.lt(value));
                assert.isTrue(diff.gten(0));
                assert.isTrue(diff.lte(scalingFactor));
                assert.isTrue(value.gt(threshold) || scaleDec.eqn(0));   // no scaling should happen if value is below threshold
                assert.isTrue(value.gt(threshold) || diff.eqn(0));   // diff should be 0 if value is below threshold
                assert.isTrue(relDiff < 1e-9);
                //
                seed = (seed * 34241 + 1) & 0xffffff;
                value = value.muln(10).addn(seed % 10);
                if (value.gt(MAX_UINT_256)) break;
            }
        }
    });

    it("should rescale correctly - no remainder", async () => {
        const threshold = MAX_UINT_32;
        const values = [toBN(1), toBN(25), toBN(1325), toBN(123456789), toBN(1e9), toBN(4123456789), MAX_UINT_32];
        for (const baseVal of values) {
            let value = baseVal;
            for (let i = 0; ; i++) {
                const { 0: rescaled, 1: scaleDec } = await mathUtils.rescale(value, threshold);
                const scalingFactor = BN_TEN.pow(scaleDec);
                const approx = rescaled.mul(scalingFactor);
                const diff = value.sub(approx).abs();
                // console.log(`scaleDec=${scaleDec} value=${value} diff=${diff}`);
                assert.isTrue(rescaled.lte(threshold));
                assert.isTrue(scaleDec.gten(0));
                assert.isTrue(scaleDec.gten(i - 10));
                assert.isTrue(scaleDec.lten(MAX_SCALE_DEC));
                assert.isTrue(scalingFactor.eqn(1) || scalingFactor.lt(value));
                assert.isTrue(value.gt(threshold) || scaleDec.eqn(0));   // no scaling should happen if value is below threshold
                assert.isTrue(diff.eqn(0));
                //
                value = value.muln(10);
                if (value.gt(MAX_UINT_256)) break;
            }
        }
    });

    it("should rescale correctly - zero case", async () => {
        const { 0: rescaled, 1: scaleDec } = await mathUtils.rescale(0, MAX_UINT_32);
        assert.isTrue(rescaled.eqn(0));
        assert.isTrue(scaleDec.eqn(0));
    });

    it("should fail rescale if maxValue is zero", async () => {
        await expectRevert.custom(mathUtils.rescale(30, 0), "RescaleToZero", []);
    });
});
