import { testDeployGovernanceSettings } from "../../../../lib/test-utils/contract-test-helpers";
import { expectEvent, expectRevert, time } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { findRequiredEvent } from "../../../../lib/utils/events/truffle";
import { abiEncodeCall } from "../../../../lib/utils/helpers";
import { GovernedWithTimelockMockInstance } from "../../../../typechain-truffle";

const GovernedWithTimelockMock = artifacts.require("GovernedWithTimelockMock");

const GOVERNANCE_SETTINGS_ADDRESS = "0x1000000000000000000000000000000000000007";

contract(`GovernedWithTimelock.sol; ${getTestFile(__filename)}; GovernedWithTimelock unit tests`, accounts => {
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
        await time.deterministicIncrease(3600);
        const execRes = await mock.executeGovernanceCall(encodedCall, { from: executor });
        expectEvent(execRes, "TimelockedGovernanceCallExecuted", { encodedCallHash });
        assertWeb3Equal(await mock.a(), 15);
    });

    it("cannot execute before time", async () => {
        const res = await mock.changeA(15, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3000);  // should be 3600
        await expectRevert.custom(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "TimelockNotAllowedYet", []);
        assertWeb3Equal(await mock.a(), 0);
    });

    it("must use valid calldata to execute", async () => {
        const res = await mock.changeA(15, { from: governance });
        findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3600);  // should be 3600
        const useCallData = abiEncodeCall(mock, (m) => m.changeA(16));
        await expectRevert.custom(mock.executeGovernanceCall(useCallData, { from: executor }),
            "TimelockInvalidSelector", []);
        assertWeb3Equal(await mock.a(), 0);
    });

    it("cannot execute same timelocked method twice", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3600);
        const execRes = await mock.executeGovernanceCall(encodedCall, { from: executor });
        expectEvent(execRes, "TimelockedGovernanceCallExecuted", { encodedCallHash });
        assertWeb3Equal(await mock.a(), 10);
        // shouldn't execute again
        await expectRevert.custom(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "TimelockInvalidSelector", []);
        assertWeb3Equal(await mock.a(), 10);
    });

    it("passes reverts correctly", async () => {
        const res = await mock.changeWithRevert(15, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3600);
        await expectRevert(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "this is revert");
        assertWeb3Equal(await mock.a(), 0);
    });

    it("can cancel timelocked call", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3600);
        const cancelRes = await mock.cancelGovernanceCall(encodedCall, { from: governance });
        expectEvent(cancelRes, "TimelockedGovernanceCallCanceled", { encodedCallHash });
        // shouldn't execute after cancel
        await expectRevert.custom(mock.executeGovernanceCall(encodedCall, { from: executor }),
            "TimelockInvalidSelector", []);
        assertWeb3Equal(await mock.a(), 0);
    });

    it("cannot cancel an already executed timelocked call", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3600);
        const execRes = await mock.executeGovernanceCall(encodedCall, { from: executor });
        expectEvent(execRes, "TimelockedGovernanceCallExecuted", { encodedCallHash });
        // shouldn't execute after cancel
        await expectRevert.custom(mock.cancelGovernanceCall(encodedCall, { from: governance }),
            "TimelockInvalidSelector", []);
        assertWeb3Equal(await mock.a(), 10);
    });

    it("require governance - deployment phase", async () => {
        const mockDeployment = await GovernedWithTimelockMock.new(GOVERNANCE_SETTINGS_ADDRESS, initialGovernance);
        await expectRevert.custom(mockDeployment.changeA(20), "OnlyGovernance", []);
    });

    it("only governance can call a governance call with timelock", async () => {
        await expectRevert.custom(mock.changeA(20), "OnlyGovernance", []);
    });

    it("only governance can call a governance call an immediate governance call", async () => {
        await expectRevert.custom(mock.changeB(20), "OnlyGovernance", []);
    });

    it("only an executor can execute a timelocked call", async () => {
        const res = await mock.changeA(15, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3600);
        await expectRevert.custom(mock.executeGovernanceCall(encodedCall, { from: accounts[5] }), "OnlyExecutor", []);
    });

    it("only governance can cancel a timelocked call", async () => {
        const res = await mock.increaseA(10, { from: governance });
        const { encodedCall, encodedCallHash } = findRequiredEvent(res, 'GovernanceCallTimelocked').args;
        await time.deterministicIncrease(3600);
        await expectRevert.custom(mock.cancelGovernanceCall(encodedCall, { from: executor }),
            "OnlyGovernance", []);
    });
});
