// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "../interfaces/IIAssetManager.sol";
import "../library/AgentsCreateDestroy.sol";
import "../library/AgentsExternal.sol";
import "./AssetManagerBase.sol";


contract AgentVaultManagementFacet is AssetManagerBase {
    /**
     * This method fixes the underlying address to be used by given agent owner.
     * A proof of payment (can be minimal or to itself) from this address must be provided,
     * with payment reference being equal to this method caller's address.
     * NOTE: calling this method before `createAgentVault()` is optional on most chains,
     * but is required on smart contract chains to make sure the agent is using EOA address
     * (depends on setting `requireEOAAddressProof`).
     * NOTE: may only be called by a whitelisted agent
     * @param _payment proof of payment on the underlying chain
     */
    function proveUnderlyingAddressEOA(
        IPayment.Proof calldata _payment
    )
        external
    {
        AgentsCreateDestroy.claimAddressWithEOAProof(_payment);
    }

    /**
     * Create an agent.
     * Agent will always be identified by `_agentVault` address.
     * (Externally, same account may own several agent vaults,
     *  but in fasset system, each agent vault acts as an independent agent.)
     * NOTE: may only be called by a whitelisted agent
     * @return _agentVault the new agent vault address
     */
    function createAgentVault(
        IAddressValidity.Proof calldata _addressProof,
        AgentSettings.Data calldata _settings
    )
        external
        onlyAttached
        returns (address _agentVault)
    {
        return AgentsCreateDestroy.createAgentVault(IIAssetManager(address(this)), _addressProof, _settings);
    }

    /**
     * Announce that the agent is going to be destroyed. At this time, agent must not have any mintings
     * or collateral reservations and must not be on the available agents list.
     * NOTE: may only be called by the agent vault owner.
     * @return _destroyAllowedAt the timestamp at which the destroy can be executed
     */
    function announceDestroyAgent(
        address _agentVault
    )
        external
        returns (uint256 _destroyAllowedAt)
    {
        return AgentsCreateDestroy.announceDestroy(_agentVault);
    }

    /**
     * Delete all agent data, selfdestruct agent vault and send remaining collateral to the `_recipient`.
     * Procedure for destroying agent:
     * - exit available agents list
     * - wait until all assets are redeemed or perform self-close
     * - announce destroy (and wait the required time)
     * - call destroyAgent()
     * NOTE: may only be called by the agent vault owner.
     * NOTE: the remaining funds from the vault will be transferred to the provided recipient.
     * @param _agentVault address of the agent's vault to destroy
     * @param _recipient address that receives the remaining funds and possible vault balance
     */
    function destroyAgent(
        address _agentVault,
        address payable _recipient
    )
        external
    {
        AgentsCreateDestroy.destroyAgent(_agentVault, _recipient);
    }

    /**
     * When agent vault, collateral pool or collateral pool token factory is upgraded, new agent vaults
     * automatically get the new implementation from the factory. But the existing agent vaults must
     * be upgraded by their owners using this method.
     * NOTE: may only be called by the agent vault owner.
     * @param _agentVault address of the agent's vault; both vault, its corresponding pool, and
     *  its pool token will be upgraded to the newest implementations
     */
    function upgradeAgentVaultAndPool(
        address _agentVault
    )
        external
        onlyAgentVaultOwner(_agentVault)
    {
        AgentsCreateDestroy.upgradeAgentVaultAndPool(_agentVault);
    }

    /**
     * When agent vault, collateral pool or collateral pool token factory is upgraded, new agent vaults
     * automatically get the new implementation from the factory. The existing vaults can be batch updated
     * by this method.
     * Parameters `_start` and `_end` allow limiting the upgrades to a selection of all agents, to avoid
     * breaking the block gas limit.
     * NOTE: may not be called directly - only through asset manager controller by governance.
     * @param _start the start index of the list of agent vaults (in getAllAgents()) to upgrade
     * @param _end the end index (exclusive) of the list of agent vaults to upgrade;
     *  can be larger then the number of agents, if gas is not an issue
     */
    function upgradeAgentVaultsAndPools(
        uint256 _start,
        uint256 _end
    )
        external
        onlyAssetManagerController
    {
        (address[] memory _agents,) = AgentsExternal.getAllAgents(_start, _end);
        for (uint256 i = 0; i < _agents.length; i++) {
            AgentsCreateDestroy.upgradeAgentVaultAndPool(_agents[i]);
        }
    }
}
