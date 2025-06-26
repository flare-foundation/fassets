// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {CoreVaultManager} from "../../../contracts/coreVaultManager/implementation/CoreVaultManager.sol";
import {IPayment} from "@flarenetwork/flare-periphery-contracts/flare/IFdcVerification.sol";
import {IPaymentVerification} from "@flarenetwork/flare-periphery-contracts/flare/IPaymentVerification.sol";

contract CoreVaultManagerHandler is Test {
    CoreVaultManager public coreVaultManager;
    address public fdcVerificationMock;
    address public governance;
    address public assetManager;
    bytes32 public chainId;
    string public coreVaultAddress;
    bytes32 public coreVaultAddressHash;
    string[] public allowedDestinations;
    uint128 public availableFunds; // ghost variable to available funds

    constructor(
        CoreVaultManager _coreVaultManager,
        address _fdcVerificationMock,
        address _governance,
        address _assetManager,
        bytes32 _chainId,
        string memory _coreVaultAddress
    ) {
        coreVaultManager = _coreVaultManager;
        fdcVerificationMock = _fdcVerificationMock;
        governance = _governance;
        assetManager = _assetManager;
        chainId = _chainId;
        coreVaultAddress = _coreVaultAddress;
        coreVaultAddressHash = keccak256(bytes(_coreVaultAddress));

        allowedDestinations.push("destination1");
        vm.prank(governance);
        coreVaultManager.addAllowedDestinationAddresses(allowedDestinations);

        address[] memory triggeringAccounts = new address[](1);
        triggeringAccounts[0] = address(this);
        vm.prank(governance);
        coreVaultManager.addTriggeringAccounts(triggeringAccounts);

        bytes32[] memory preimageHashes = new bytes32[](10);
        for (uint256 i = 0; i < preimageHashes.length; i++) {
            preimageHashes[i] = keccak256(abi.encodePacked("preimage", i));
        }
        vm.prank(governance);
        coreVaultManager.addPreimageHashes(preimageHashes);
    }

    function confirmPayment(uint128 _receivedAmount, bytes32 _transactionId) public {
        _receivedAmount = uint128(bound(_receivedAmount, 1, type(uint128).max / 2));

        // Construct a valid IPayment.Proof
        IPayment.Proof memory proof;
        proof.data.responseBody.status = 0;
        proof.data.sourceId = chainId;
        proof.data.responseBody.receivingAddressHash = coreVaultAddressHash;
        proof.data.responseBody.receivedAmount = int256(uint256(_receivedAmount));
        proof.data.requestBody.transactionId = _transactionId;

        vm.mockCall(
            fdcVerificationMock,
            abi.encodeWithSelector(IPaymentVerification.verifyPayment.selector, proof),
            abi.encode(true)
        );

        uint128 availableBefore = coreVaultManager.availableFunds();
        uint128 increaseAmount = coreVaultManager.confirmedPayments(_transactionId) ? 0 : _receivedAmount;
        if (!coreVaultManager.confirmedPayments(_transactionId)) {
            availableFunds += _receivedAmount;
        }
        coreVaultManager.confirmPayment(proof);
        assertEq(availableBefore + increaseAmount, coreVaultManager.availableFunds());
    }

    function requestTransferFromCoreVault(
        uint256 _destIndex,
        bytes32 _paymentReference,
        uint128 _amount,
        bool _cancelable
    ) public {
        _amount = uint128(bound(_amount, 1, type(uint128).max / 2));
        _destIndex = bound(_destIndex, 0, allowedDestinations.length - 1);
        string memory destination = allowedDestinations[_destIndex];

        (, , , uint128 fee) = coreVaultManager.getSettings();
        uint256 totalRequestAmount = coreVaultManager.totalRequestAmountWithFee() + _amount + fee;
        if (totalRequestAmount > coreVaultManager.availableFunds() + coreVaultManager.escrowedFunds()) {
            vm.warp(block.timestamp + 1);
            confirmPayment(uint128(totalRequestAmount * 2), keccak256(abi.encodePacked(block.timestamp)));
        }

        vm.prank(assetManager);
        coreVaultManager.requestTransferFromCoreVault(destination, _paymentReference, _amount, _cancelable);
    }

    function triggerInstructions() public {
        if (
            coreVaultManager.getCancelableTransferRequests().length == 0 &&
            coreVaultManager.getNonCancelableTransferRequests().length == 0
        ) {
            vm.warp(block.timestamp + 1);
            requestTransferFromCoreVault(0, keccak256(abi.encodePacked(block.timestamp)), 1000, true);
        }

        uint128 preAvailable = coreVaultManager.availableFunds();

        vm.prank(address(this));
        coreVaultManager.triggerInstructions();

        uint128 postAvailable = coreVaultManager.availableFunds();
        uint128 fundsMoved = preAvailable - postAvailable;
        availableFunds -= fundsMoved;
    }

    function setEscrowsFinished(bytes32 _preimageHash) public {
        CoreVaultManager.Escrow[] memory escrows = coreVaultManager.getUnprocessedEscrows();
        if (escrows.length == 0) {
            triggerInstructions();
            escrows = coreVaultManager.getUnprocessedEscrows();
        }

        CoreVaultManager.Escrow memory escrow = coreVaultManager.getEscrowByPreimageHash(_preimageHash);

        if (block.timestamp < escrow.expiryTs) {
            vm.warp(escrow.expiryTs + 1);
        }

        uint128 preAvailable = coreVaultManager.availableFunds();
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = _preimageHash;
        vm.prank(governance);
        coreVaultManager.setEscrowsFinished(hashes);

        uint128 postAvailable = coreVaultManager.availableFunds();
        uint128 fundsAvailableDiff = postAvailable - preAvailable;
        availableFunds -= fundsAvailableDiff;
    }

    function getAvailableFunds() external view returns (uint128) {
        return availableFunds;
    }
}