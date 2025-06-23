import { expectEvent, expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { toBN } from "../../../../lib/utils/helpers";
import { ERC20MockInstance } from "../../../../typechain-truffle";

const ERC20Mock = artifacts.require("ERC20Mock");

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
            try {
                await expectEvent.inTransaction(response.tx, token, "Approval");
            } catch (error) {
                assert(error instanceof Error);
                assert.match(error.message, /No 'Approval' events found/);
                return;
            }
            assert.fail("should not reach here");
        });

        it("should succeed if event with correct args found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectEvent.inTransaction(response.tx, token, "Transfer", { value: 100 });
        });

        it("should fail if event arg not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            try {
                await expectEvent.inTransaction(response.tx, token, "Transfer", { amount: "50" } as any);
            } catch (error) {
                assert(error instanceof Error);
                assert.match(error.message, /Event argument 'amount' not found/);
                return;
            }
            assert.fail("should not reach here");
        });

        it("should fail if event arg has wrong value", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            try {
                await expectEvent.inTransaction(response.tx, token, "Transfer", { value: 50 });
            } catch (error) {
                assert(error instanceof Error);
                assert.match(error.message, /expected event argument 'value' to have value 50 but got 100/);
                return;
            }
            assert.fail("should not reach here");
        });

        it("notEmitted should succeed if event not found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            await expectEvent.notEmitted.inTransaction(response.tx, token, "Approval");
        });

        it("notEmitted should fail if event was found", async () => {
            const response = await token.deposit({ from: accounts[1], value: toBN(100) });
            try {
                await expectEvent.notEmitted.inTransaction(response.tx, token, "Transfer");
            } catch (error) {
                assert(error instanceof Error);
                assert.match(error.message, /Unexpected event 'Transfer' was found/);
                return;
            }
            assert.fail("should not reach here");
        });
    });
});
