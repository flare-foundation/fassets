import { expectEvent, expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { toBN } from "../../../../lib/utils/helpers";
import { CustomErrorMockInstance, ERC20MockInstance } from "../../../../typechain-truffle";

const ERC20Mock = artifacts.require("ERC20Mock");
const CustomErrorMock = artifacts.require("CustomErrorMock");

contract(`test-helpers.ts; ${getTestFile(__filename)}; Test library helpers unit tests`, accounts => {
    let token: ERC20MockInstance;

    // Do clean unit tests by spinning up a fresh contract for each test
    beforeEach(async () => {
        token = await ERC20Mock.new("Test Token", "TTOK");
    });

    describe("testing expectRevert", () => {
        it("should pass with error with message", async () => {
            await expectRevert(token.withdraw(1000), "ERC20: burn amount exceeds balance");
        });

        it("should pass with error with partial message", async () => {
            await expectRevert(token.withdraw(1000), "amount exceeds balance");
        });

        it("should pass with error with unspecified message", async () => {
            await expectRevert.unspecified(token.withdraw(1000));
        });

        it("should fail if there is no error - with message check", async () => {
            try {
                await expectRevert(token.deposit({ from: accounts[1], value: toBN(100) }), "ERC20: burn amount exceeds balance");
            } catch (error) {
                assert.isTrue(error instanceof Error && error.message.includes("Expected an exception but none was received"));
                return;
            }
            assert.fail("error not detected");
        });

        it("should fail if there is no error - with unspecified message", async () => {
            try {
                await expectRevert.unspecified(token.deposit({ from: accounts[1], value: toBN(100) }));
            } catch (error) {
                assert.isTrue(error instanceof Error && error.message.includes("Expected an exception but none was received"));
                return;
            }
            assert.fail("error not detected");
        });

        it("should fail if the error has wrong message", async () => {
            try {
                await expectRevert(token.withdraw(1000), "wrong message");
            } catch (error) {
                assert.isTrue(error instanceof Error && error.message.includes("Wrong kind of exception received"));
                return;
            }
            assert.fail("error not detected");
        });
    });

    describe("testing expectRevert.custom", () => {
        let errorMock: CustomErrorMockInstance;

        beforeEach(async () => {
            errorMock = await CustomErrorMock.new();
        });

        it("should succeed checking for error without args", async () => {
            await expectRevert.custom(errorMock.emitErrorWithoutArgs(), "ErrorWithoutArgs", []);
        });

        it("should succeed checking for error with args", async () => {
            await expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "ErrorWithArgs", [123, "amount too low"]);
            await expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "ErrorWithArgs", [toBN(123), "amount too low"]);
        });

        it("should succeed checking for error by name only", async () => {
            await expectRevert.custom(errorMock.emitErrorWithoutArgs(), "ErrorWithoutArgs");
            await expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "ErrorWithArgs");
        });

        it("should fail checking for error with wrong name", async () => {
            await expectRevert(
                expectRevert.custom(errorMock.emitErrorWithoutArgs(), "UnknownError"),
                "Wrong kind of exception received");
            await expectRevert(
                expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "UnknownError"),
                "Wrong kind of exception received");
            await expectRevert(
                expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "UnknownError", []),
                "Wrong kind of exception received");
        });

        it("should fail checking for error with wrong args", async () => {
            await expectRevert(
                expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "ErrorWithArgs", []),
                "Wrong kind of exception received");
            await expectRevert(
                expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "ErrorWithArgs", [123, "amount too high"]),
                "Wrong kind of exception received");
            await expectRevert(
                expectRevert.custom(errorMock.emitErrorWithArgs(123, "amount too low"), "ErrorWithArgs", [125, "amount too low"]),
                "Wrong kind of exception received");
        });

        it("should not match by type with with string error messages, but should match plain string", async () => {
            await expectRevert(errorMock.emitErrorWithString(), "string type error");
            await expectRevert(
                expectRevert.custom(errorMock.emitErrorWithString(), "Error", ["string type error"]),
                "Wrong kind of exception received");
        });
    })

    describe("testing expectEvent", () => {
        it("should succeed if event found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            expectEvent(response, "Transfer");
        });

        it("should fail if event name not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            assert.throws(() => expectEvent(response, "Approval"), /No 'Approval' events found/);
        });

        it("should succeed if event with correct args found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            expectEvent(response, "Transfer", { value: 100 });
        });

        it("should fail if event arg not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
            assert.throws(() => expectEvent(response, "Transfer", { amount: "50" } as any), /Event argument 'amount' not found/);
        });

        it("should fail if event arg has wrong value", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            assert.throws(() => expectEvent(response, "Transfer", { value: 50 }), /expected event argument 'value' to have value 50 but got 100/);
        });

        it("notEmitted should succeed if event not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            expectEvent.notEmitted(response, "Approval");
        });

        it("notEmitted should fail if event was found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            assert.throws(() => expectEvent.notEmitted(response, "Transfer"), /Unexpected event 'Transfer' was found/);
        });
    });

    describe("testing expectEvent (in transaction)", () => {
        it("should succeed if event found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectEvent.inTransaction(response.tx, token, "Transfer");
        });

        it("should fail if event name not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectRevert(
                expectEvent.inTransaction(response.tx, token, "Approval"),
                `No 'Approval' events found`);
        });

        it("should succeed if event with correct args found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectEvent.inTransaction(response.tx, token, "Transfer", { value: 100 });
        });

        it("should fail if event arg not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectRevert(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
                expectEvent.inTransaction(response.tx, token, "Transfer", { amount: "50" } as any),
                `Event argument 'amount' not found`);
        });

        it("should fail if event arg has wrong value", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectRevert(
                expectEvent.inTransaction(response.tx, token, "Transfer", { value: 50 }),
                `expected event argument 'value' to have value 50 but got 100`);
        });

        it("notEmitted should succeed if event not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectEvent.notEmitted.inTransaction(response.tx, token, "Approval");
        });

        it("notEmitted should fail if event was found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectRevert(
                expectEvent.notEmitted.inTransaction(response.tx, token, "Transfer"),
                `Unexpected event 'Transfer' was found`);
        });
    });
});
