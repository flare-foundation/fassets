import { GENESIS_GOVERNANCE_ADDRESS } from "../../../../lib/test-utils/constants";
import { expectEvent, expectRevert } from "../../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { ZERO_ADDRESS } from "../../../../lib/utils/helpers";
import { GovernanceSettingsMockInstance, GovernedMockInstance } from "../../../../typechain-truffle";

const Governed = artifacts.require("GovernedMock");
const GovernanceSettings = artifacts.require("GovernanceSettingsMock");

contract(`Governed.sol; ${getTestFile(__filename)}; Governed unit tests`, accounts => {
    const initialGovernance = accounts[1];
    const productionGovernance = accounts[2];
    const productionExecutor = accounts[3];

    // contains a fresh contract for each test
    let governed: GovernedMockInstance;
    let governanceSettings: GovernanceSettingsMockInstance;

    async function initialize() {
        governanceSettings = await GovernanceSettings.new();
        await governanceSettings.initialise(productionGovernance, 10, [productionGovernance, productionExecutor], { from: GENESIS_GOVERNANCE_ADDRESS });
        governed = await Governed.new(governanceSettings.address, initialGovernance);
        return { governanceSettings, governed };
    }

    beforeEach(async () => {
        ({ governanceSettings, governed } = await loadFixtureCopyVars(initialize));
    });

    describe("initialise", () => {
        it("Should only initialize with non-zero governance", async () => {
            // Assemble
            // Act
            const promise = Governed.new(governanceSettings.address, ZERO_ADDRESS);
            // Assert
            await expectRevert.custom(promise, "GovernedAddressZero", []);
        });

        it("Should only be initializable once", async () => {
            // Assemble
            // Act
            const initPromise = governed.initialize(governanceSettings.address, productionGovernance);
            // Assert
            await expectRevert.custom(initPromise, "GovernedAlreadyInitialized", []);
            // Original governance should still be set
            const currentGovernance = await governed.governance();
            assert.equal(currentGovernance, initialGovernance);
        });
    });

    describe("switch to production", () => {
        it("Should switch to production", async () => {
            // Assemble
            // Act
            const tx = await governed.switchToProductionMode({ from: initialGovernance });
            // Assert
            const currentGovernance = await governed.governance();
            assert.equal(currentGovernance, productionGovernance);
            expectEvent(tx, "GovernedProductionModeEntered", { governanceSettings: governanceSettings.address });
        });

        it("Should reject switch if not from governed address", async () => {
            // Assemble
            // Act
            const promiseTransfer = governed.switchToProductionMode({ from: accounts[3] });
            // Assert
            await expectRevert.custom(promiseTransfer, "OnlyGovernance", []);
        });

        it("Should not switch to production twice", async () => {
            // Assemble
            await governed.switchToProductionMode({ from: initialGovernance });
            // Act
            const promiseTransfer1 = governed.switchToProductionMode({ from: initialGovernance });
            // Assert
            await expectRevert.custom(promiseTransfer1, "OnlyGovernance", []);
            // Act
            const promiseTransfer2 = governed.switchToProductionMode({ from: productionGovernance });
            // Assert
            await expectRevert.custom(promiseTransfer2, "AlreadyInProductionMode", []);
        });

        it("Should have new governance parameters after switching", async () => {
            // Assemble
            const startGovernance = await governed.governance();
            const startProductionMode = await governed.productionMode();
            // Act
            const tx = await governed.switchToProductionMode({ from: initialGovernance });
            // Assert
            const newGovernance = await governed.governance();
            const newProductionMode = await governed.productionMode();
            //
            assert.equal(startGovernance, initialGovernance);
            assert.equal(startProductionMode, false);
            assert.equal(newGovernance, productionGovernance);
            assert.equal(newProductionMode, true);
        });
    });
});
