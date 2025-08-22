import { expectRevert, time } from '../../../../lib/test-utils/test-helpers';
import { getTestFile } from '../../../../lib/test-utils/test-suite-helpers';
import { assertWeb3Equal } from '../../../../lib/test-utils/web3assertions';
import { toBN } from '../../../../lib/utils/helpers';
import { CheckPointableMockInstance } from '../../../../typechain-truffle';

const CheckPointable = artifacts.require("CheckPointableMock");

contract(`CheckPointable.sol; ${getTestFile(__filename)}; CheckPointable unit tests`, accounts => {
    // contains a fresh contract for each test
    let checkPointable: CheckPointableMockInstance;

    // Do clean unit tests by spinning up a fresh contract for each test
    beforeEach(async () => {
        checkPointable = await CheckPointable.new();
    });

    it("Should store historic balance for address", async () => {
        const b = [];
        // Assemble
        await checkPointable.mintForAtNow(accounts[1], 10);
        b[0] = await web3.eth.getBlockNumber();
        await checkPointable.mintForAtNow(accounts[1], 20);
        // Act
        const value = await checkPointable.balanceOfAt(accounts[1], b[0]);
        // Assert
        assertWeb3Equal(value, 10);
    });

    it("Should store historic supply", async () => {
        const b = [];
        // Assemble
        await checkPointable.mintForAtNow(accounts[1], 10);
        await checkPointable.mintForAtNow(accounts[2], 20);
        b[0] = await web3.eth.getBlockNumber();
        await checkPointable.burnForAtNow(accounts[2], 10);
        // Act
        const value = await checkPointable.totalSupplyAt(b[0]);
        // Assert
        assertWeb3Equal(value, 30);
    });

    it("Should transmit value now for historic retrieval", async () => {
        const b = [];
        // Assemble
        await checkPointable.mintForAtNow(accounts[1], 10);
        await checkPointable.mintForAtNow(accounts[2], 20);
        // Act
        await checkPointable.transmitAtNow(accounts[2], accounts[1], 10);
        b[0] = await web3.eth.getBlockNumber();
        await checkPointable.burnForAtNow(accounts[2], 10);
        b[1] = await web3.eth.getBlockNumber();
        // Assert
        const account2PastValue = await checkPointable.balanceOfAt(accounts[2], b[0]);
        const account2Value = await checkPointable.balanceOfAt(accounts[2], b[1]);
        assertWeb3Equal(account2PastValue, 10);
        assertWeb3Equal(account2Value, 0);
    });

    it("Should set cleanup block", async () => {
        // Assemble
        await time.advanceBlock();
        const blk = await web3.eth.getBlockNumber();
        await time.advanceBlock();
        // Act
        await checkPointable.setCleanupBlockNumber(blk);
        // Assert
        const cleanblk = await checkPointable.getCleanupBlockNumber();
        assert.equal(cleanblk.toNumber(), blk);
    });

    it("Should check cleanup block validity", async () => {
        // Assemble
        await time.advanceBlock();
        const blk = await web3.eth.getBlockNumber();
        await time.advanceBlock();
        // Act
        await checkPointable.setCleanupBlockNumber(blk);
        // Assert
        await expectRevert.custom(checkPointable.setCleanupBlockNumber(blk - 1), "CleanupBlockNumberMustNeverDecrease", []);
        const blk2 = await web3.eth.getBlockNumber();
        await expectRevert.custom(checkPointable.setCleanupBlockNumber(blk2 + 1), "CleanupBlockMustBeInThePast", []);
    });

    it("Should cleanup history", async () => {
        // Assemble
        await checkPointable.mintForAtNow(accounts[1], 100);
        await time.advanceBlock();
        const blk1 = await web3.eth.getBlockNumber();
        await checkPointable.transmitAtNow(accounts[1], accounts[2], toBN(10), { from: accounts[1] });
        const blk2 = await web3.eth.getBlockNumber();
        // Act
        await checkPointable.setCleanupBlockNumber(toBN(blk2));
        await checkPointable.transmitAtNow(accounts[1], accounts[2], toBN(10), { from: accounts[1] });
        const blk3 = await web3.eth.getBlockNumber();
        // Assert
        // should fail at blk1
        await expectRevert.custom(checkPointable.balanceOfAt(accounts[1], blk1),
                "CheckPointableReadingFromCleanedupBlock", []);
        // and work at blk2
        const value = await checkPointable.balanceOfAt(accounts[1], blk2);
        assert.equal(value.toNumber(), 90);
        const value2 = await checkPointable.balanceOfAt(accounts[1], blk3);
        assert.equal(value2.toNumber(), 80);
    });

});
