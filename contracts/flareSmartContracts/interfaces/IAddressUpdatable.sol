// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;


interface IAddressUpdatable {
    /**
     * Return the address updater managing this contract.
     */
    function getAddressUpdater()
        external view
        returns (address);
}
