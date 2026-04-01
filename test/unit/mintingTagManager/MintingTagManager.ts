import hre from "hardhat";
import { getProxyImplementationAddress, ZERO_ADDRESS } from "../../../deployment/lib/deploy-utils";
import { ether, expectEvent, expectRevert, time } from "../../../lib/test-utils/test-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { filterEvents, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { MintingTagManagerInstance, GovernanceSettingsMockInstance } from "../../../typechain-truffle";
import { BNish, MINUTES } from "../../../lib/utils/helpers";

const GovernanceSettingsMock = artifacts.require("GovernanceSettingsMock");
const MintingTagManager = artifacts.require("MintingTagManager");
const MintingTagManagerProxy = artifacts.require("MintingTagManagerProxy");


contract("MintingTagManager", function (accounts) {
    let governanceSettings: GovernanceSettingsMockInstance
    let mintingTagManager: MintingTagManagerInstance;
    const reservationFee = ether("0.1");
    const governance = accounts[0];
    const tagOwner = accounts[1];
    const executor = accounts[5];

    beforeEach(async () => {
        governanceSettings = await GovernanceSettingsMock.new();
        const mintingTagManagerImpl = await MintingTagManager.new();
        const mintingTagManagerProxy = await MintingTagManagerProxy.new(mintingTagManagerImpl.address, governanceSettings.address, governance,
            "Minting Tag Manager", "MTMG", reservationFee, governance, 1);
        mintingTagManager = await MintingTagManager.at(mintingTagManagerProxy.address);
    });

    it("should have correct initial data", async () => {
        const name = await mintingTagManager.name();
        const symbol = await mintingTagManager.symbol();
        const reservationFeeStored = await mintingTagManager.reservationFee();
        assert.equal(name, "Minting Tag Manager");
        assert.equal(symbol, "MTMG");
        assertWeb3Equal(reservationFeeStored, reservationFee);
    });

    it("should not initialize twice", async () => {
        await expectRevert(
            mintingTagManager.initialize(governanceSettings.address, governance, "Minting Tag Manager", "MTMG", reservationFee, governance, 10),
            "Initializable: contract is already initialized"
        );
    });

    it("should reserve a minting tag correctly", async () => {
        const tagToReserve = 1;
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reservation = requiredEventArgs(res, "MintingTagReserved");
        assertWeb3Equal(reservation.tag, tagToReserve);
        assertWeb3Equal(reservation.owner, tagOwner);
        const owner = await mintingTagManager.ownerOf(tagToReserve);
        assertWeb3Equal(owner, tagOwner);
        // recipient should be set to minting tag owner by default
        const recipient = await mintingTagManager.mintingRecipient(tagToReserve);
        assertWeb3Equal(recipient, tagOwner);
    });

    it("should fail to reserve a minting tag with insufficient or too large payment", async () => {
        // reservation fee should not be too small
        await expectRevert.custom(
            mintingTagManager.reserve({ from: tagOwner, value: ether("0.05") }),
            "WrongReservationPaymentAmount", []
        );
        // reservation fee should not be too large
        await expectRevert.custom(
            mintingTagManager.reserve({ from: tagOwner, value: ether("1") }),
            "WrongReservationPaymentAmount", []
        );
    });

    it("should increment nextAvailableTag after reservation", async () => {
        await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const nextTag = await mintingTagManager.nextAvailableTag();
        assertWeb3Equal(nextTag, 2);
    });

    it("should set minting recipient correctly", async () => {
        const newRecipient = accounts[2];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        const resSet = await mintingTagManager.setMintingRecipient(reserved.tag, newRecipient, { from: tagOwner });
        expectEvent(resSet, "RecipientChanged", { tag: reserved.tag, recipient: newRecipient });
        const recipient = await mintingTagManager.mintingRecipient(reserved.tag);
        assertWeb3Equal(recipient, newRecipient);
    });

    it("should fail to set minting recipient if not tag owner", async () => {
        const newRecipient = accounts[2];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        await expectRevert.custom(
            mintingTagManager.setMintingRecipient(reserved.tag, newRecipient, { from: accounts[3] }),
            "OnlyTagOwner", []
        );
    });

    it("setting minting recipient to the same value should be allowed and should not emit event", async () => {
        const newRecipient = accounts[2];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        const resSet = await mintingTagManager.setMintingRecipient(reserved.tag, newRecipient, { from: tagOwner });
        expectEvent(resSet, "RecipientChanged", { tag: reserved.tag, recipient: newRecipient });
        // now set again to the same value, it should not emit event but should succeed
        const resSet2 = await mintingTagManager.setMintingRecipient(reserved.tag, newRecipient, { from: tagOwner });
        expectEvent.notEmitted(resSet2, "RecipientChanged");
        assertWeb3Equal(await mintingTagManager.mintingRecipient(reserved.tag), newRecipient);
    });

    it("should fail to set minting recipient to zero address", async () => {
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        await expectRevert.custom(
            mintingTagManager.setMintingRecipient(reserved.tag, "0x0000000000000000000000000000000000000000", { from: tagOwner }),
            "ZeroAddress", []
        );
    });

    it("should transfer minting tag correctly", async () => {
        const newOwner = accounts[2];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        await mintingTagManager.transfer(newOwner, reserved.tag, { from: tagOwner });
        const owner = await mintingTagManager.ownerOf(reserved.tag);
        assertWeb3Equal(owner, newOwner);
    });

    it("should fail to transfer minting tag if not owner", async () => {
        const newOwner = accounts[2];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        await expectRevert(
            mintingTagManager.transfer(newOwner, reserved.tag, { from: accounts[3] }),
            "ERC721: transfer from incorrect owner"
        );
    });

    it("should update minting recipient after transfer", async () => {
        const newOwner = accounts[2];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        // initial recipient should be tag owner
        let recipient = await mintingTagManager.mintingRecipient(reserved.tag);
        assertWeb3Equal(recipient, tagOwner);
        // transfer the tag
        await mintingTagManager.transfer(newOwner, reserved.tag, { from: tagOwner });
        // recipient should be updated to new owner
        recipient = await mintingTagManager.mintingRecipient(reserved.tag);
        assertWeb3Equal(recipient, newOwner);
    });

    it("should update minting recipient after transfer even if previous owner was not recipient", async () => {
        const newOwner = accounts[2];
        const recipient = accounts[3];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        // set a different recipient
        await mintingTagManager.setMintingRecipient(reserved.tag, recipient, { from: tagOwner });
        // transfer the tag
        await mintingTagManager.transfer(newOwner, reserved.tag, { from: tagOwner });
        // recipient should remain unchanged
        const recipientAfter = await mintingTagManager.mintingRecipient(reserved.tag);
        assertWeb3Equal(recipientAfter, newOwner);
    });

    it("should reserve minting tags sequentially", async () => {
        const numberOfTags = 5;
        for (let i = 1; i <= numberOfTags; i++) {
            const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
            const reservation = requiredEventArgs(res, "MintingTagReserved");
            assertWeb3Equal(reservation.tag, i);
            assertWeb3Equal(reservation.owner, tagOwner);
        }
        const nextTag = await mintingTagManager.nextAvailableTag();
        assertWeb3Equal(nextTag, numberOfTags + 1);
    });

    it("should upgrade the implementation correctly", async () => {
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        await mintingTagManager.setMintingRecipient(reserved.tag, accounts[8], { from: tagOwner });
        // upgrade
        const mintingTagManagerImplV2 = await MintingTagManager.new();
        await mintingTagManager.upgradeTo(mintingTagManagerImplV2.address, { from: governance });
        const implementationAddress = await getProxyImplementationAddress(hre, mintingTagManager.address);
        // data should be preserved after upgrade
        assert.equal(implementationAddress, mintingTagManagerImplV2.address);
        assert.equal((await mintingTagManager.name()), "Minting Tag Manager");
        assert.equal(await mintingTagManager.ownerOf(reserved.tag), tagOwner);
        assert.equal(await mintingTagManager.mintingRecipient(reserved.tag), accounts[8]);
    });

    it("should fail to upgrade the implementation if not governance", async () => {
        const mintingTagManagerImplV2 = await MintingTagManager.new();
        await expectRevert.custom(
            mintingTagManager.upgradeTo(mintingTagManagerImplV2.address, { from: tagOwner }),
            "OnlyGovernance", []
        );
    });

    it("should change reservation fee by governance", async () => {
        const newReservationFee = ether("0.2");
        const res = await mintingTagManager.setReservationFee(newReservationFee, { from: governance });
        expectEvent(res, "ReservationFeeChanged", { reservationFee: newReservationFee });
        const reservationFeeStored = await mintingTagManager.reservationFee();
        assertWeb3Equal(reservationFeeStored, newReservationFee);
    });

    it("should fail to change reservation fee if not governance", async () => {
        const newReservationFee = ether("0.2");
        await expectRevert.custom(mintingTagManager.setReservationFee(newReservationFee, { from: tagOwner }),
            "OnlyGovernance", []);
    });

    it("should change reservation fee recipient by governance", async () => {
        const newRecipient = accounts[4];
        const res = await mintingTagManager.setReservationFeeRecipient(newRecipient, { from: governance });
        expectEvent(res, "ReservationFeeChanged", { recipient: newRecipient });
        const recipientStored = await mintingTagManager.reservationFeeRecipient();
        assertWeb3Equal(recipientStored, newRecipient);
    });

    it("should fail to change reservation fee recipient if not governance", async () => {
        const newRecipient = accounts[4];
        await expectRevert.custom(mintingTagManager.setReservationFeeRecipient(newRecipient, { from: tagOwner }),
            "OnlyGovernance", []);
    });

    async function checkPendingChange(tag: BNish, expectedPending: boolean, expectedExecutor: string, expectedActiveAfterTs: BNish) {
        const { 0: changePending, 1: pendingExecutor, 2: pendingActiveAfterTs } = await mintingTagManager.pendingAllowedExecutorChange(tag);
        assert.equal(changePending, expectedPending);
        assertWeb3Equal(pendingExecutor, expectedExecutor);
        assertWeb3Equal(pendingActiveAfterTs, expectedActiveAfterTs);
    }

    it("should set executor by tag owner and it should activate after delay", async () => {
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        // set executor
        const resEx = await mintingTagManager.setAllowedExecutor(reserved.tag, executor, { from: tagOwner });
        const args = requiredEventArgs(resEx, "AllowedExecutorChangePending");
        assertWeb3Equal(args.tag, reserved.tag);
        assertWeb3Equal(args.executor, executor);
        // executor should not be active immediately
        assertWeb3Equal(await mintingTagManager.allowedExecutor(reserved.tag), ZERO_ADDRESS);
        // there should be a pending change
        await checkPendingChange(reserved.tag, true, executor, args.activeAfterTs);
        // increase time until the change should be active
        await time.increaseTo(args.activeAfterTs);
        // new executor should be active now
        assertWeb3Equal(await mintingTagManager.allowedExecutor(reserved.tag), executor);
        // there should be no pending change now
        await checkPendingChange(reserved.tag, false, ZERO_ADDRESS, 0);
    });

    it("should fail to set executor if not tag owner", async () => {
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        await expectRevert.custom(
            mintingTagManager.setAllowedExecutor(reserved.tag, executor, { from: accounts[3] }),
            "OnlyTagOwner", []
        );
    });

    it("should return empty array for owner with no tags", async () => {
        const tags = await mintingTagManager.reservedTagsForOwner(tagOwner);
        assert.equal(tags.length, 0);
    });

    it("should return single tag for owner with one reservation", async () => {
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        const tags = await mintingTagManager.reservedTagsForOwner(tagOwner);
        assert.equal(tags.length, 1);
        assertWeb3Equal(tags[0], reserved.tag);
    });

    it("should return multiple tags for owner with several reservations", async () => {
        const count = 3;
        const expectedTags: string[] = [];
        for (let i = 0; i < count; i++) {
            const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
            const reserved = requiredEventArgs(res, "MintingTagReserved");
            expectedTags.push(reserved.tag.toString());
        }
        const tags = await mintingTagManager.reservedTagsForOwner(tagOwner);
        assert.equal(tags.length, count);
        for (let i = 0; i < count; i++) {
            assertWeb3Equal(tags[i], expectedTags[i]);
        }
    });

    it("should update reservedTagsForOwner after transfer", async () => {
        const newOwner = accounts[2];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        // before transfer
        let tags = await mintingTagManager.reservedTagsForOwner(tagOwner);
        assert.equal(tags.length, 1);
        assertWeb3Equal(tags[0], reserved.tag);
        let newOwnerTags = await mintingTagManager.reservedTagsForOwner(newOwner);
        assert.equal(newOwnerTags.length, 0);
        // transfer
        await mintingTagManager.transfer(newOwner, reserved.tag, { from: tagOwner });
        // after transfer
        tags = await mintingTagManager.reservedTagsForOwner(tagOwner);
        assert.equal(tags.length, 0);
        newOwnerTags = await mintingTagManager.reservedTagsForOwner(newOwner);
        assert.equal(newOwnerTags.length, 1);
        assertWeb3Equal(newOwnerTags[0], reserved.tag);
    });

    it("should return correct tags for multiple owners", async () => {
        const owner2 = accounts[2];
        const res1 = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const tag1 = requiredEventArgs(res1, "MintingTagReserved").tag;
        const res2 = await mintingTagManager.reserve({ from: owner2, value: reservationFee });
        const tag2 = requiredEventArgs(res2, "MintingTagReserved").tag;
        const res3 = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const tag3 = requiredEventArgs(res3, "MintingTagReserved").tag;
        // tagOwner has tags 1 and 3
        const ownerTags = await mintingTagManager.reservedTagsForOwner(tagOwner);
        assert.equal(ownerTags.length, 2);
        assertWeb3Equal(ownerTags[0], tag1);
        assertWeb3Equal(ownerTags[1], tag3);
        // owner2 has tag 2
        const owner2Tags = await mintingTagManager.reservedTagsForOwner(owner2);
        assert.equal(owner2Tags.length, 1);
        assertWeb3Equal(owner2Tags[0], tag2);
    });

    it("changing executor while a change is pending should not immediately enforce the previous change", async () => {
        const executor2 = accounts[6];
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        // set executor to executor (pending)
        await mintingTagManager.setAllowedExecutor(reserved.tag, executor, { from: tagOwner });
        // active executor should still be zero
        assertWeb3Equal(await mintingTagManager.allowedExecutor(reserved.tag), ZERO_ADDRESS);
        // before the first change activates, change to executor2
        const resEx2 = await mintingTagManager.setAllowedExecutor(reserved.tag, executor2, { from: tagOwner });
        const args2 = requiredEventArgs(resEx2, "AllowedExecutorChangePending");
        assertWeb3Equal(args2.executor, executor2);
        // the active executor should still be zero (not executor!)
        assertWeb3Equal(await mintingTagManager.allowedExecutor(reserved.tag), ZERO_ADDRESS);
        // pending change should now be for executor2
        await checkPendingChange(reserved.tag, true, executor2, args2.activeAfterTs);
        // after the second change's delay, executor2 should be active
        await time.increaseTo(args2.activeAfterTs);
        assertWeb3Equal(await mintingTagManager.allowedExecutor(reserved.tag), executor2);
        await checkPendingChange(reserved.tag, false, ZERO_ADDRESS, 0);
    });

    it("setting same pending executor again resets the delay, but is a no-op once active", async () => {
        const res = await mintingTagManager.reserve({ from: tagOwner, value: reservationFee });
        const reserved = requiredEventArgs(res, "MintingTagReserved");
        // set executor first time
        const resEx1 = await mintingTagManager.setAllowedExecutor(reserved.tag, executor, { from: tagOwner });
        const args1 = requiredEventArgs(resEx1, "AllowedExecutorChangePending");
        await time.deterministicIncrease(1 * MINUTES);   // much less than 10 minutes delay
        // set executor second time before the first change is active — resets the delay
        const resEx2 = await mintingTagManager.setAllowedExecutor(reserved.tag, executor, { from: tagOwner });
        const args2 = requiredEventArgs(resEx2, "AllowedExecutorChangePending");
        // pending change should have a new (later) activeAfterTs
        assert.isTrue(args2.activeAfterTs.gt(args1.activeAfterTs));
        await checkPendingChange(reserved.tag, true, executor, args2.activeAfterTs);
        // increase time until the second change should be active
        await time.increaseTo(args2.activeAfterTs);
        // new executor should be active now
        assertWeb3Equal(await mintingTagManager.allowedExecutor(reserved.tag), executor);
        // set executor again to same value — now it's already active, so it's a no-op
        const resEx3 = await mintingTagManager.setAllowedExecutor(reserved.tag, executor, { from: tagOwner });
        expectEvent.notEmitted(resEx3, "AllowedExecutorChangePending");
        // and there should be no pending change now
        await checkPendingChange(reserved.tag, false, ZERO_ADDRESS, 0);
    });
});
