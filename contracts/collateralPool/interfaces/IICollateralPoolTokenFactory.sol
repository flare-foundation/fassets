// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import "../../utils/interfaces/IUpgradableContractFactory.sol";
import "./IICollateralPool.sol";


/**
 * @title Collateral pool token factory
 */
interface IICollateralPoolTokenFactory is IUpgradableContractFactory {
    /**
     * @notice Creates new collateral pool token
     */
    function create(
        IICollateralPool pool,
        string memory _systemSuffix,
        string memory _agentSuffix
    ) external
        returns (address);
}
