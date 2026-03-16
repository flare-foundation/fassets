// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {CoreVaultManager} from "../../../contracts/coreVaultManager/implementation/CoreVaultManager.sol";
import {CoreVaultManagerProxy} from "../../../contracts/coreVaultManager/implementation/CoreVaultManagerProxy.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";
import {CoreVaultManagerHandler} from "./CoreVaultManagerHandler.t.sol";

// solhint-disable func-name-mixedcase
contract CoreVaultManagerTest is Test {

    CoreVaultManager private coreVaultManager;
    CoreVaultManager private coreVaultManagerImpl;
    CoreVaultManagerProxy private coreVaultManagerProxy;

    address private fdcVerificationMock;

    address private governance;
    address private addressUpdater;

    bytes32[] private contractNameHashes;
    address[] private contractAddresses;

    bytes32 private chainId = "0x72";
    address private assetManager;
    string private custodianAddress;
    string private coreVaultAddress;

    CoreVaultManagerHandler private handler;

    function setUp() public {
        assetManager = makeAddr("assetManager");
        custodianAddress = "custodianAddress";
        coreVaultAddress = "coreVaultAddress";
        governance = makeAddr("governance");
        addressUpdater = makeAddr("addressUpdater");
        fdcVerificationMock = makeAddr("fdcVerificationMock");

        coreVaultManagerImpl = new CoreVaultManager();
        coreVaultManagerProxy = new CoreVaultManagerProxy(
            address(coreVaultManagerImpl),
            IGovernanceSettings(makeAddr("governanceSettings")),
            governance,
            addressUpdater,
            assetManager,
            chainId,
            custodianAddress,
            coreVaultAddress,
            0
        );
        coreVaultManager = CoreVaultManager(address(coreVaultManagerProxy));

        contractNameHashes = new bytes32[](2);
        contractAddresses = new address[](2);
        contractNameHashes[0] = keccak256(abi.encode("AddressUpdater"));
        contractNameHashes[1] = keccak256(abi.encode("FdcVerification"));
        contractAddresses[0] = address(addressUpdater);
        contractAddresses[1] = fdcVerificationMock;
        vm.prank(addressUpdater);
        coreVaultManager.updateContractAddresses(contractNameHashes, contractAddresses);

        vm.prank(governance);
        coreVaultManager.updateSettings(3600, 1000, 500, 10);

        handler = new CoreVaultManagerHandler(
            coreVaultManager,
            governance,
            assetManager,
            chainId,
            coreVaultAddress
        );

        targetContract(address(handler));
        bytes4 [] memory selectors = new bytes4[](4);
        selectors[0] = handler.confirmPayment.selector;
        selectors[1] = handler.requestTransferFromCoreVault.selector;
        selectors[2] = handler.triggerInstructions.selector;
        selectors[3] = handler.setEscrowsFinished.selector;

        targetSelector(
            FuzzSelector({
                addr: address(handler),
                selectors: selectors
            })
        );
    }

    function fuzz_confirmPayment(uint128 _receivedAmount, bytes32 _transactionId) public {
        vm.assume(_receivedAmount > 0);

        // First call
        uint128 initialFunds = coreVaultManager.availableFunds();
        vm.prank(assetManager);
        coreVaultManager.confirmPayment(_transactionId, int256(uint256(_receivedAmount)));
        assertEq(coreVaultManager.availableFunds(), initialFunds + _receivedAmount);
        assertTrue(coreVaultManager.confirmedPayments(_transactionId));

        // Second call (same transactionId) should revert
        vm.prank(assetManager);
        vm.expectRevert();
        coreVaultManager.confirmPayment(_transactionId, int256(uint256(_receivedAmount)));
    }

    function invariant_fundsAccounting() public {
        uint256 totalRequests = coreVaultManager.totalRequestAmountWithFee();
        uint128 available = coreVaultManager.availableFunds();
        uint128 escrowed = coreVaultManager.escrowedFunds();
        uint128 setEscrowsFinishedAmount = handler.setEscrowsFinishedAmount();
        assertGe(available + escrowed + setEscrowsFinishedAmount, totalRequests, "Funds insufficient for requests");

        assertEq(
            available,
            handler.getAvailableFunds(),
            "availableFunds should match contract state"
        );
    }
}