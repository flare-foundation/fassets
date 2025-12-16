// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;
pragma abicoder v2;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ICollateralPoolToken is IERC20 {

    /**
     * Returns the address of the collateral pool that issued this token.
     */
    function collateralPool()
        external view
        returns (address);

    /**
     * Returns the amount of tokens that are cannot be transferred.
     * These are tokens that are either timelocked or locked due to fasset fee debt.
     * @param _account user's account address
     */
    function lockedBalanceOf(address _account)
        external view
        returns (uint256);

    /**
     * Returns the amount of tokens that can be transferred.
     * These are tokens that are neither timelocked neither locked due to fasset fee debt.
     * @param _account user's account address
     */
    function transferableBalanceOf(address _account)
        external view
        returns (uint256);

    /**
     * Returns the amount of account's tokens that are locked due to account's fasset fee debt.
     * @param _account user's account address
     */
    function debtLockedBalanceOf(address _account)
        external view
        returns (uint256);

    /**
     * Returns the amount of account's tokens that are not locked due to account's fasset fee debt.
     * @param _account user's account address
     */
    function debtFreeBalanceOf(address _account)
        external view
        returns (uint256);

    /**
     * Returns the amount of account's tokens that are timelocked.
     * @param _account user's account address
     */
    function timelockedBalanceOf(address _account)
        external view
        returns (uint256);

    /**
     * Returns the amount of account's tokens that are not timelocked.
     * @param _account user's account address
     */
    function nonTimelockedBalanceOf(address _account)
        external view
        returns (uint256);
}
