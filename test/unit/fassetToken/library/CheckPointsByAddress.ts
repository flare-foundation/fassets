import { expectRevert } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { ZERO_ADDRESS } from "../../../../lib/utils/helpers";
import { CheckPointsByAddressMockInstance } from "../../../../typechain-truffle";

const CheckPointsByAddressMock = artifacts.require("CheckPointsByAddressMock");

contract(`CheckPointsByAddress.sol; ${getTestFile(__filename)}`, accounts => {
    // a fresh contract for each test
    let checkPointsByAddressMock: CheckPointsByAddressMockInstance;

    // Do clean unit tests by spinning up a fresh contract for each test
    beforeEach(async () => {
        checkPointsByAddressMock = await CheckPointsByAddressMock.new();
    });

    it("Should store value now for address 1", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        // Act
        const value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        // Assert
        assertWeb3Equal(value, 10);
    });

    it("Should store historic value for address 1", async () => {
        const b = [];

        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        b[0] = await web3.eth.getBlockNumber();
        // Act
        await checkPointsByAddressMock.writeValue(accounts[1], 20);
        // Assert
        const value = await checkPointsByAddressMock.valueOfAt(accounts[1], b[0]);
        assertWeb3Equal(value, 10);
    });

    it("Should store value now for different addresses", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        await checkPointsByAddressMock.writeValue(accounts[2], 20);
        // Act
        const address1Value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        const address2Value = await checkPointsByAddressMock.valueOfAtNow(accounts[2]);
        // Assert
        assertWeb3Equal(address1Value, 10);
        assertWeb3Equal(address2Value, 20);
    });

    it("Should store value history for different addresses", async () => {
        const b = [];

        // Assemble
        b[0] = await web3.eth.getBlockNumber();
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        b[1] = await web3.eth.getBlockNumber();
        await checkPointsByAddressMock.writeValue(accounts[2], 20);
        b[2] = await web3.eth.getBlockNumber();
        await checkPointsByAddressMock.writeValue(accounts[1], 30);
        b[3] = await web3.eth.getBlockNumber();
        await checkPointsByAddressMock.writeValue(accounts[2], 40);
        b[4] = await web3.eth.getBlockNumber();
        // Act
        const block0Address1Value = await checkPointsByAddressMock.valueOfAt(accounts[1], b[0]);
        const block1Address1Value = await checkPointsByAddressMock.valueOfAt(accounts[1], b[1]);
        const block2Address1Value = await checkPointsByAddressMock.valueOfAt(accounts[1], b[2]);
        const block3Address1Value = await checkPointsByAddressMock.valueOfAt(accounts[1], b[3]);
        const block4Address1Value = await checkPointsByAddressMock.valueOfAt(accounts[1], b[4]);
        const block0Address2Value = await checkPointsByAddressMock.valueOfAt(accounts[2], b[0]);
        const block1Address2Value = await checkPointsByAddressMock.valueOfAt(accounts[2], b[1]);
        const block2Address2Value = await checkPointsByAddressMock.valueOfAt(accounts[2], b[2]);
        const block3Address2Value = await checkPointsByAddressMock.valueOfAt(accounts[2], b[3]);
        const block4Address2Value = await checkPointsByAddressMock.valueOfAt(accounts[2], b[4]);
        // Assert
        assertWeb3Equal(block0Address1Value, 0);
        assertWeb3Equal(block1Address1Value, 10);
        assertWeb3Equal(block2Address1Value, 10);
        assertWeb3Equal(block3Address1Value, 30);
        assertWeb3Equal(block4Address1Value, 30);
        assertWeb3Equal(block0Address2Value, 0);
        assertWeb3Equal(block1Address2Value, 0);
        assertWeb3Equal(block2Address2Value, 20);
        assertWeb3Equal(block3Address2Value, 20);
        assertWeb3Equal(block4Address2Value, 40);
    });

    it("Should transmit value now between addresses", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        await checkPointsByAddressMock.writeValue(accounts[2], 20);
        // Act
        await checkPointsByAddressMock.transmit(accounts[2], accounts[1], 20);

        // Assert
        const address1Value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        const address2Value = await checkPointsByAddressMock.valueOfAtNow(accounts[2]);
        assertWeb3Equal(address1Value, 30);
        assertWeb3Equal(address2Value, 0);
    });

    it("Should transmit value now between addresses", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        await checkPointsByAddressMock.writeValue(accounts[2], 20);
        // Act
        await checkPointsByAddressMock.transmit(accounts[2], accounts[1], 20);
        // Assert
        const address1Value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        const address2Value = await checkPointsByAddressMock.valueOfAtNow(accounts[2]);
        assertWeb3Equal(address1Value, 30);
        assertWeb3Equal(address2Value, 0);
    });

    it("Should not transmit zero value between addresses", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        await checkPointsByAddressMock.writeValue(accounts[2], 20);
        // Act
        await checkPointsByAddressMock.transmit(accounts[2], accounts[1], 0);
        // Assert
        const address1Value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        const address2Value = await checkPointsByAddressMock.valueOfAtNow(accounts[2]);
        assertWeb3Equal(address1Value, 10);
        assertWeb3Equal(address2Value, 20);
    });

    it("Should not transmit zero value between addresses", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 10);
        await checkPointsByAddressMock.writeValue(accounts[2], 20);
        // Act
        await checkPointsByAddressMock.transmit(accounts[2], accounts[1], 0);
        // Assert
        const address1Value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        const address2Value = await checkPointsByAddressMock.valueOfAtNow(accounts[2]);
        assertWeb3Equal(address1Value, 10);
        assertWeb3Equal(address2Value, 20);
    });

    it("Should mint for transmit from zero address", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 20);
        // Act
        await checkPointsByAddressMock.transmit(ZERO_ADDRESS, accounts[1], 10);
        // Assert
        const address1Value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        assertWeb3Equal(address1Value.toNumber(), 30);
        const address0Value = await checkPointsByAddressMock.valueOfAtNow(ZERO_ADDRESS);
        assertWeb3Equal(address0Value.toNumber(), 0);
    });

    it("Should burn for transmit to zero address", async () => {
        // Assemble
        await checkPointsByAddressMock.writeValue(accounts[1], 20);
        // Act
        await checkPointsByAddressMock.transmit(accounts[1], ZERO_ADDRESS, 5);
        // Assert
        const address1Value = await checkPointsByAddressMock.valueOfAtNow(accounts[1]);
        assertWeb3Equal(address1Value.toNumber(), 15);
        const address0Value = await checkPointsByAddressMock.valueOfAtNow(ZERO_ADDRESS);
        assertWeb3Equal(address0Value.toNumber(), 0);
    });

    it("Should delete old checkpoints", async () => {
        // Assemble
        const b = [];
        for (let i = 0; i < 10; i++) {
            await checkPointsByAddressMock.writeValue(accounts[1], i);
            b.push(await web3.eth.getBlockNumber());
        }
        // Act
        const cleanupBlock = b[5];
        for (let i = 0; i < 4; i++) {
            await checkPointsByAddressMock.cleanupOldCheckpoints(accounts[1], 2, cleanupBlock);
        }
        // Assert
        for (let i = 0; i < 5; i++) {
            await expectRevert.custom(checkPointsByAddressMock.valueOfAt(accounts[1], b[i]), "CheckPointHistoryReadingFromCleanedupBlock", []);
        }
        for (let i = 5; i < 10; i++) {
            const value = await checkPointsByAddressMock.valueOfAt(accounts[1], b[i]);
            assertWeb3Equal(value.toNumber(), i);
        }
    });

    it("Delete old checkpoints ignored for zero address", async () => {
        // Assemble
        const cleanupBlock = await web3.eth.getBlockNumber();
        // Act
        const res = await checkPointsByAddressMock.cleanupOldCheckpoints(ZERO_ADDRESS, 2, cleanupBlock);
        // Assert
        assert.notEqual(res, null);
    });

});
