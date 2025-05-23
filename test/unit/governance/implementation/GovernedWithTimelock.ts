import { expectEvent, expectRevert } from "@openzeppelin/test-helpers";
import { findRequiredEvent } from "../../../../lib/utils/events/truffle";
import { GovernedWithTimelockMockInstance } from "../../../../typechain-truffle";
import { testDeployGovernanceSettings } from "../../../utils/contract-test-helpers";
import { deterministicTimeIncrease, getTestFile } from "../../../utils/test-helpers";
import { assertWeb3Equal } from "../../../utils/web3assertions";
import { abiEncodeCall } from "../../../../lib/utils/helpers";

const GovernedWithTimelockMock = artifacts.require("GovernedWithTimelockMock");

const GOVERNANCE_SETTINGS_ADDRESS = "0x1000000000000000000000000000000000000007";

contract(`GovernedWithTimelock.sol; ${getTestFile(__filename)}; GovernedWithTimelock unit tests`, async accounts => {
    const initialGovernance = accounts[10];
    const governance = accounts[11];
    const executor = accounts[12];

    let mock: GovernedWithTimelockMockInstance;

    before(async() => {
        await testDeployGovernanceSettings(governance, 3600, [governance, executor]);
    });

    beforeEach(async () => {
        mock = await GovernedWithTimelockMock.new(GOVERNANCE_SETTINGS_ADDRESS, initialGovernance);
        await mock.switchToProductionMode({ from: initialGovernance });
    });

    it("allow direct changes in deployment phase", async () => {
        const mockDeployment = await GovernedWithTimelockMock.new(GOVERNANCE_SETTINGS_ADDRESS, initialGovernance);
        await mockDeployment.changeA(15, { from: initialGovernance });
        assertWeb3Equal(await mockDeployment.a(), 15);
    });

    it("no effect immediately", async () => {
        await mock.changeA(15, { from: governance });
        assertWeb3Equal(await mock.a(), 0);
    });

    it("can execute after time", async () => {
        const res = await mock.changeA(15, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);
        const execRes = await mock.executeGovernanceCall(encodedCall, { from: executor });
        expectEvent(execRes, "TimelockedGovernanceCallExecuted", { encodedCallHash });
        assertWeb3Equal(await mock.a(), 15);
    });

    it("cannot execute before time", async () => {
        const res = await mock.changeA(15, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3000);  // should be 3600
        await expectRevert(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "timelock: not allowed yet");
        assertWeb3Equal(await mock.a(), 0);
    });

    it("must use valid calldata to execute", async () => {
        const res = await mock.changeA(15, { from: governance });
        findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);  // should be 3600
        const useCallData = abiEncodeCall(mock, (m) => m.changeA(16));
        await expectRevert(mock.executeGovernanceCall(useCallData, { from: executor }),
            "timelock: invalid selector");
        assertWeb3Equal(await mock.a(), 0);
    });

    it("cannot execute same timelocked method twice", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);
        const execRes = await mock.executeGovernanceCall(encodedCall, { from: executor });
        expectEvent(execRes, "TimelockedGovernanceCallExecuted", { encodedCallHash });
        assertWeb3Equal(await mock.a(), 10);
        // shouldn't execute again
        await expectRevert(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "timelock: invalid selector");
        assertWeb3Equal(await mock.a(), 10);
    });

    it("passes reverts correctly", async () => {
        const res = await mock.changeWithRevert(15, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);
        await expectRevert(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "this is revert");
        assertWeb3Equal(await mock.a(), 0);
    });

    it("can cancel timelocked call", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);
        const cancelRes = await mock.cancelGovernanceCall(encodedCall, { from: governance });
        expectEvent(cancelRes, "TimelockedGovernanceCallCanceled", { encodedCallHash });
        // shouldn't execute after cancel
        await expectRevert(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "timelock: invalid selector");
        assertWeb3Equal(await mock.a(), 0);
    });

    it("cannot cancel an already executed timelocked call", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);
        const execRes = await mock.executeGovernanceCall(encodedCall, { from: executor });
        expectEvent(execRes, "TimelockedGovernanceCallExecuted", { encodedCallHash });
        // shouldn't execute after cancel
        await expectRevert(mock.cancelGovernanceCall(encodedCall, { from: governance }),
            "timelock: invalid selector");
        assertWeb3Equal(await mock.a(), 10);
    });

    it("require governance - deployment phase", async () => {
        const mockDeployment = await GovernedWithTimelockMock.new(GOVERNANCE_SETTINGS_ADDRESS, initialGovernance);
        await expectRevert(mockDeployment.changeA(20), "only governance");
    });

    it("only governance can call a governance call with timelock", async () => {
        await expectRevert(mock.changeA(20), "only governance");
    });

    it("only governance can call a governance call an immediate governance call", async () => {
        await expectRevert(mock.changeB(20), "only governance");
    });

    it("only an executor can execute a timelocked call", async () => {
        const res = await mock.changeA(15, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);
        await expectRevert(mock.executeGovernanceCall(encodedCall, { from: accounts[5] }), "only executor");
    });

    it("only governance can cancel a timelocked call", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await deterministicTimeIncrease(3600);
        await expectRevert(mock.cancelGovernanceCall(encodedCall, { from: executor }),
            "only governance");
    });
});
