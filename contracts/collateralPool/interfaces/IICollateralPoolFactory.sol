// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import "../../assetManager/interfaces/IIAssetManager.sol";
import "../../utils/interfaces/IUpgradableContractFactory.sol";
import "./IICollateralPool.sol";


/**
 * @title Collateral pool factory
 */
interface IICollateralPoolFactory is IUpgradableContractFactory {
    /**
     * @notice Creates new collateral pool
     */
    function create(
        IIAssetManager _assetManager,
        address _agentVault,
        AgentSettings.Data memory _settings
    ) external
        returns (IICollateralPool);
}
