import hre from "hardhat";
import { getProxyImplementationAddress } from "../../../deployment/lib/deploy-utils";
import { ether, expectRevert } from "../../../lib/test-utils/test-helpers";
import { assertWeb3Equal } from "../../../lib/test-utils/web3assertions";
import { filterEvents, requiredEventArgs } from "../../../lib/utils/events/truffle";
import { MintingTagManagerInstance, GovernanceSettingsMockInstance } from "../../../typechain-truffle";

const GovernanceSettingsMock = artifacts.require("GovernanceSettingsMock");
const MintingTagManager = artifacts.require("MintingTagManager");
const MintingTagManagerProxy = artifacts.require("MintingTagManagerProxy");


contract("MintingTagManager", function (accounts) {
    let governanceSettings: GovernanceSettingsMockInstance
    let mintingTagManager: MintingTagManagerInstance;
    const reservationFee = ether("0.1");
    const governance = accounts[0];
    const tagOwner = accounts[1];

    beforeEach(async () => {
        governanceSettings = await GovernanceSettingsMock.new();
        const mintingTagManagerImpl = await MintingTagManager.new();
        const mintingTagManagerProxy = await MintingTagManagerProxy.new(mintingTagManagerImpl.address, governanceSettings.address, governance,
            "FAsset Minting Tag", "FAMT", reservationFee, governance);
        mintingTagManager = await MintingTagManager.at(mintingTagManagerProxy.address);
    });

    it("should have correct initial data", async () => {
        const name = await mintingTagManager.name();
        const symbol = await mintingTagManager.symbol();
        const reservationFeeStored = await mintingTagManager.reservationFeeNATWei();
        assert.equal(name, "FAsset Minting Tag");
        assert.equal(symbol, "FAMT");
        assertWeb3Equal(reservationFeeStored, reservationFee);
    });

    it("should not initialize twice", async () => {
        await expectRevert.custom(
            mintingTagManager.initialize(governanceSettings.address, governance, "FAsset Minting Tag", "FAMT", reservationFee, governance),
            "AlreadyInitialized", []
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

    it("should fail to reserve a minting tag with insufficient payment", async () => {
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
        await mintingTagManager.setMintingRecipient(reserved.tag, newRecipient, { from: tagOwner });
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

    it("should reserve mintings tags for system (with no payment)", async () => {
        const systemAccount = accounts[5];
        const tagToReserve = 1;
        const res = await mintingTagManager.reserveForSystem(systemAccount, 10, { from: governance });
        const reservations = filterEvents(res, "MintingTagReserved");
        assertWeb3Equal(reservations.length, 10);
        for (let i = 0; i < 10; i++) {
            assertWeb3Equal(reservations[i].args.tag, tagToReserve + i);
            assertWeb3Equal(reservations[i].args.owner, systemAccount);
        }
        const nextTag = await mintingTagManager.nextAvailableTag();
        assertWeb3Equal(nextTag, tagToReserve + 10);
    });

    it("should fail to reserve minting tags for system if not governance", async () => {
        const systemAccount = accounts[5];
        await expectRevert.custom(
            mintingTagManager.reserveForSystem(systemAccount, 10, { from: accounts[3] }),
            "OnlyGovernance", []
        );
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
        assert.equal((await mintingTagManager.name()), "FAsset Minting Tag");
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
});
