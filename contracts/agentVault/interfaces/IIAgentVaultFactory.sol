// SPDX-License-Identifier: MIT
pragma solidity >=0.7.6 <0.9;

import "../../assetManager/interfaces/IIAssetManager.sol";
import "../../utils/interfaces/IUpgradableContractFactory.sol";
import "./IIAgentVault.sol";


/**
 * @title Agent vault factory
 */
interface IIAgentVaultFactory is IUpgradableContractFactory {
    /**
     * @notice Creates new agent vault
     */
    function create(IIAssetManager _assetManager) external returns (IIAgentVault);
}
