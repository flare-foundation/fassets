import { expectRevert } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { abiEncodeCall } from "../../../../lib/utils/helpers";
import { CheckPointHistoryMockInstance } from "../../../../typechain-truffle";

const CheckPointHistoryMock = artifacts.require("CheckPointHistoryMock");

contract(`CheckPointHistory.sol; ${getTestFile(__filename)}`, accounts => {
    // a fresh contract for each test
    let checkPointHistoryMock: CheckPointHistoryMockInstance;

    // Do clean unit tests by spinning up a fresh contract for each test
    beforeEach(async () => {
        checkPointHistoryMock = await CheckPointHistoryMock.new();
    });

    it("Should store value now", async () => {
        // Assemble
        // Act
        await checkPointHistoryMock.writeValue(10);
        // Assert
        const value = await checkPointHistoryMock.valueAtNow();
        assertWeb3Equal(value, 10);
    });

    it("Should store values at checkpoints", async () => {
        const b = [];
        // Assemble
        b[0] = await web3.eth.getBlockNumber();
        await checkPointHistoryMock.writeValue(50);
        b[1] = await web3.eth.getBlockNumber();
        await checkPointHistoryMock.writeValue(10);
        b[2] = await web3.eth.getBlockNumber();
        await checkPointHistoryMock.writeValue(5);
        b[3] = await web3.eth.getBlockNumber();
        // Act
        const balanceAtBlock0 = await checkPointHistoryMock.valueAt(b[0]);
        const balanceAtBlock1 = await checkPointHistoryMock.valueAt(b[1]);
        const balanceAtBlock2 = await checkPointHistoryMock.valueAt(b[2]);
        const balanceAtBlock3 = await checkPointHistoryMock.valueAt(b[3]);
        // Assert
        assertWeb3Equal(balanceAtBlock0, 0);
        assertWeb3Equal(balanceAtBlock1, 50);
        assertWeb3Equal(balanceAtBlock2, 10);
        assertWeb3Equal(balanceAtBlock3, 5);
    });

    it("Should perform O(log(n)) search on checkpoints", async () => {
        // Assemble
        const b: number[] = [];
        for (let i = 0; i < 200; i++) {
            b[i] = await web3.eth.getBlockNumber();
            await checkPointHistoryMock.writeValue(i);
        }
        // Act
        const valueAt = abiEncodeCall(checkPointHistoryMock, (cph) => cph.valueAt(b[100]));
        const gas = await web3.eth.estimateGas({ to: checkPointHistoryMock.address, data: valueAt });
        // Assert
        // This is actually 300000+ if checkpoints specifier is memory vs storage
        assert(gas < 75000);
    });

    it("Should delete old checkpoints", async () => {
        // Assemble
        const b = [];
        for (let i = 0; i < 10; i++) {
            await checkPointHistoryMock.writeValue(i);
            b.push(await web3.eth.getBlockNumber());
        }
        // Act
        const cleanupBlock = b[5];
        for (let i = 0; i < 4; i++) {
            await checkPointHistoryMock.cleanupOldCheckpoints(2, cleanupBlock);
        }
        // Assert
        for (let i = 0; i < 5; i++) {
            await expectRevert.custom(checkPointHistoryMock.valueAt(b[i]), "CheckPointHistoryReadingFromCleanedupBlock", []);
        }
        for (let i = 5; i < 10; i++) {
            const value = await checkPointHistoryMock.valueAt(b[i]);
            assert.equal(value.toNumber(), i);
        }
    });

    it("Delete old checkpoints shouldn't fail with empty history", async () => {
        // Assemble
        const cleanupBlock = await web3.eth.getBlockNumber();
        // Act
        await checkPointHistoryMock.cleanupOldCheckpoints(2, cleanupBlock);
        // Assert
        const value = await checkPointHistoryMock.valueAt(cleanupBlock);
        assert.equal(value.toNumber(), 0);
    });

});
