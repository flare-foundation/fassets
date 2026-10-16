import hre from "hardhat";
import { getProxyImplementationAddress } from "../../../deployment/lib/deploy-utils";
import { GENESIS_GOVERNANCE_ADDRESS } from "../../../lib/test-utils/constants";
import { expectEvent, expectRevert } from "../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { erc165InterfaceId, ZERO_BYTES32 } from "../../../lib/utils/helpers";
import { ForbiddenAddressListInstance, GovernanceSettingsMockInstance } from "../../../typechain-truffle";

const GovernanceSettingsMock = artifacts.require("GovernanceSettingsMock");
const ForbiddenAddressList = artifacts.require("ForbiddenAddressList");
const ForbiddenAddressListProxy = artifacts.require("ForbiddenAddressListProxy");

contract(`ForbiddenAddressList.sol; ${getTestFile(__filename)}; Forbidden address list tests`, accounts => {
    const governance = accounts[10];
    const other = accounts[20];
    let governanceSettings: GovernanceSettingsMockInstance;
    let forbiddenAddressList: ForbiddenAddressListInstance;

    function addressHash(address: string) {
        return web3.utils.keccak256(address);
    }

    // reads the whole list by paging through it
    async function readWholeList(pageSize: number) {
        const result: string[] = [];
        let cursor = ZERO_BYTES32;
        while (true) {
            const page = await forbiddenAddressList.getList(cursor, pageSize);
            result.push(...page);
            if (page.length < pageSize) break;
            cursor = addressHash(page[page.length - 1]);
        }
        return result;
    }

    async function assertList(expected: string[]) {
        assertWeb3Equal(await forbiddenAddressList.getLength(), expected.length);
        assert.deepEqual(await forbiddenAddressList.getList(ZERO_BYTES32, expected.length + 10), expected);
        assert.deepEqual(await readWholeList(1), expected);
        assert.deepEqual(await readWholeList(3), expected);
    }

    beforeEach(async () => {
        governanceSettings = await GovernanceSettingsMock.new();
        await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
        const impl = await ForbiddenAddressList.new();
        const proxy = await ForbiddenAddressListProxy.new(impl.address, governanceSettings.address, governance);
        forbiddenAddressList = await ForbiddenAddressList.at(proxy.address);
    });

    describe("initialization", () => {
        it("should be empty after deploy", async () => {
            assertWeb3Equal(await forbiddenAddressList.governance(), governance);
            await assertList([]);
        });

        it("should not initialize twice", async () => {
            await expectRevert.custom(forbiddenAddressList.initialize(governanceSettings.address, governance),
                "GovernedAlreadyInitialized", []);
        });

        it("should not initialize the implementation", async () => {
            const impl = await ForbiddenAddressList.new();
            await expectRevert.custom(impl.initialize(governanceSettings.address, governance),
                "GovernedAlreadyInitialized", []);
        });

        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as "IERC165");
            const IForbiddenAddressList = artifacts.require("IForbiddenAddressList");
            const iERC165 = await IERC165.at(forbiddenAddressList.address);
            const iForbiddenAddressList = await IForbiddenAddressList.at(forbiddenAddressList.address);
            assert.isTrue(await forbiddenAddressList.supportsInterface(erc165InterfaceId(iERC165.abi)));
            assert.isTrue(await forbiddenAddressList.supportsInterface(erc165InterfaceId(iForbiddenAddressList.abi)));
            assert.isFalse(await forbiddenAddressList.supportsInterface("0xFFFFFFFF"));
        });
    });

    describe("adding and removing", () => {
        it("should add addresses and emit events", async () => {
            const res = await forbiddenAddressList.addForbiddenAddresses(["rAddr1", "rAddr2"], { from: governance });
            expectEvent(res, "ForbiddenAddressAdded", { underlyingAddress: "rAddr1" });
            expectEvent(res, "ForbiddenAddressAdded", { underlyingAddress: "rAddr2" });
            await assertList(["rAddr1", "rAddr2"]);
            assert.isTrue(await forbiddenAddressList.isForbidden("rAddr1"));
            assert.isTrue(await forbiddenAddressList.isForbidden("rAddr2"));
            assert.isFalse(await forbiddenAddressList.isForbidden("rAddr3"));
            assert.isTrue(await forbiddenAddressList.isForbiddenHash(addressHash("rAddr1")));
            assert.isFalse(await forbiddenAddressList.isForbiddenHash(addressHash("rAddr3")));
            assert.isFalse(await forbiddenAddressList.isForbiddenHash(ZERO_BYTES32));
        });

        it("address matching is exact (case sensitive)", async () => {
            await forbiddenAddressList.addForbiddenAddresses(["rAddr1"], { from: governance });
            assert.isFalse(await forbiddenAddressList.isForbidden("raddr1"));
            assert.isFalse(await forbiddenAddressList.isForbidden("rAddr1 "));
        });

        it("adding already forbidden address is skipped", async () => {
            await forbiddenAddressList.addForbiddenAddresses(["rAddr1", "rAddr2"], { from: governance });
            const res = await forbiddenAddressList.addForbiddenAddresses(["rAddr2", "rAddr3", "rAddr3"], { from: governance });
            const added = res.logs.filter(log => log.event === "ForbiddenAddressAdded");
            assert.equal(added.length, 1);
            expectEvent(res, "ForbiddenAddressAdded", { underlyingAddress: "rAddr3" });
            await assertList(["rAddr1", "rAddr2", "rAddr3"]);
        });

        it("should not add empty address", async () => {
            await expectRevert.custom(forbiddenAddressList.addForbiddenAddresses(["rAddr1", ""], { from: governance }),
                "EmptyAddress", []);
            await assertList([]);
        });

        it("should remove addresses from head, middle and tail and keep order", async () => {
            await forbiddenAddressList.addForbiddenAddresses(["a1", "a2", "a3", "a4", "a5"], { from: governance });
            // middle
            const res = await forbiddenAddressList.removeForbiddenAddresses(["a3"], { from: governance });
            expectEvent(res, "ForbiddenAddressRemoved", { underlyingAddress: "a3" });
            assert.isFalse(await forbiddenAddressList.isForbidden("a3"));
            await assertList(["a1", "a2", "a4", "a5"]);
            // head
            await forbiddenAddressList.removeForbiddenAddresses(["a1"], { from: governance });
            await assertList(["a2", "a4", "a5"]);
            // tail
            await forbiddenAddressList.removeForbiddenAddresses(["a5"], { from: governance });
            await assertList(["a2", "a4"]);
            // add after removal goes to the end
            await forbiddenAddressList.addForbiddenAddresses(["a6", "a1"], { from: governance });
            await assertList(["a2", "a4", "a6", "a1"]);
            // remove all
            await forbiddenAddressList.removeForbiddenAddresses(["a1", "a2", "a4", "a6"], { from: governance });
            await assertList([]);
            // list works after becoming empty
            await forbiddenAddressList.addForbiddenAddresses(["a7"], { from: governance });
            await assertList(["a7"]);
        });

        it("removing address that is not forbidden is skipped", async () => {
            await forbiddenAddressList.addForbiddenAddresses(["rAddr1"], { from: governance });
            const res = await forbiddenAddressList.removeForbiddenAddresses(["rAddr2", "", "rAddr1", "rAddr1"], { from: governance });
            const removed = res.logs.filter(log => log.event === "ForbiddenAddressRemoved");
            assert.equal(removed.length, 1);
            expectEvent(res, "ForbiddenAddressRemoved", { underlyingAddress: "rAddr1" });
            await assertList([]);
        });

        it("random sequence of adds and removes should match the model", async () => {
            // deterministic pseudo-random generator
            let seed = 12345;
            const random = (n: number) => {
                seed = (seed * 1103515245 + 12345) % 2147483648;
                return seed % n;
            };
            const pool = Array.from({ length: 12 }, (_, i) => `rAddress${i}`);
            const model: string[] = [];
            for (let step = 0; step < 25; step++) {
                const batch = Array.from({ length: 1 + random(4) }, () => pool[random(pool.length)]);
                if (random(2) === 0) {
                    await forbiddenAddressList.addForbiddenAddresses(batch, { from: governance });
                    for (const address of batch) {
                        if (!model.includes(address)) model.push(address);
                    }
                } else {
                    await forbiddenAddressList.removeForbiddenAddresses(batch, { from: governance });
                    for (const address of batch) {
                        const index = model.indexOf(address);
                        if (index >= 0) model.splice(index, 1);
                    }
                }
                await assertList(model);
                for (const address of pool) {
                    assert.equal(await forbiddenAddressList.isForbidden(address), model.includes(address));
                }
            }
        });

        it("only governance can add or remove addresses", async () => {
            await expectRevert.custom(forbiddenAddressList.addForbiddenAddresses(["rAddr1"], { from: other }),
                "OnlyGovernance", []);
            await forbiddenAddressList.addForbiddenAddresses(["rAddr1"], { from: governance });
            await expectRevert.custom(forbiddenAddressList.removeForbiddenAddresses(["rAddr1"], { from: other }),
                "OnlyGovernance", []);
        });

        it("adding and removing is not timelocked in production mode", async () => {
            await forbiddenAddressList.switchToProductionMode({ from: governance });
            const addRes = await forbiddenAddressList.addForbiddenAddresses(["rAddr1"], { from: governance });
            expectEvent(addRes, "ForbiddenAddressAdded", { underlyingAddress: "rAddr1" });
            assert.isTrue(await forbiddenAddressList.isForbidden("rAddr1"));
            const removeRes = await forbiddenAddressList.removeForbiddenAddresses(["rAddr1"], { from: governance });
            expectEvent(removeRes, "ForbiddenAddressRemoved", { underlyingAddress: "rAddr1" });
            assert.isFalse(await forbiddenAddressList.isForbidden("rAddr1"));
        });
    });

    describe("listing", () => {
        beforeEach(async () => {
            await forbiddenAddressList.addForbiddenAddresses(["a1", "a2", "a3", "a4", "a5"], { from: governance });
        });

        it("should page through the list using the cursor", async () => {
            assert.deepEqual(await forbiddenAddressList.getList(ZERO_BYTES32, 2), ["a1", "a2"]);
            assert.deepEqual(await forbiddenAddressList.getList(addressHash("a2"), 2), ["a3", "a4"]);
            assert.deepEqual(await forbiddenAddressList.getList(addressHash("a4"), 2), ["a5"]);
            assert.deepEqual(await forbiddenAddressList.getList(addressHash("a5"), 2), []);
        });

        it("zero max length returns empty list", async () => {
            assert.deepEqual(await forbiddenAddressList.getList(ZERO_BYTES32, 0), []);
            assert.deepEqual(await forbiddenAddressList.getList(addressHash("a2"), 0), []);
        });

        it("paging continues correctly when addresses other than the cursor are removed", async () => {
            const page1 = await forbiddenAddressList.getList(ZERO_BYTES32, 2);
            assert.deepEqual(page1, ["a1", "a2"]);
            await forbiddenAddressList.removeForbiddenAddresses(["a1", "a3"], { from: governance });
            assert.deepEqual(await forbiddenAddressList.getList(addressHash(page1[1]), 2), ["a4", "a5"]);
        });

        it("should revert when the cursor is not in the list", async () => {
            await expectRevert.custom(forbiddenAddressList.getList(addressHash("unknown"), 2), "InvalidCursor", []);
            await forbiddenAddressList.removeForbiddenAddresses(["a2"], { from: governance });
            await expectRevert.custom(forbiddenAddressList.getList(addressHash("a2"), 2), "InvalidCursor", []);
        });
    });

    describe("upgrade", () => {
        it("should upgrade the implementation and preserve the list", async () => {
            await forbiddenAddressList.addForbiddenAddresses(["a1", "a2", "a3"], { from: governance });
            await forbiddenAddressList.removeForbiddenAddresses(["a2"], { from: governance });
            const implV2 = await ForbiddenAddressList.new();
            await forbiddenAddressList.upgradeTo(implV2.address, { from: governance });
            assert.equal(await getProxyImplementationAddress(hre, forbiddenAddressList.address), implV2.address);
            await assertList(["a1", "a3"]);
            assert.isTrue(await forbiddenAddressList.isForbidden("a3"));
        });

        it("only governance can upgrade", async () => {
            const implV2 = await ForbiddenAddressList.new();
            await expectRevert.custom(forbiddenAddressList.upgradeTo(implV2.address, { from: other }),
                "OnlyGovernance", []);
        });
    });
});
