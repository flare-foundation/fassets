# Upgrading, pausing and winding down

FAsset system is a very complex decentralised system. As such, there are many unexpected situations that can happen. Therefore we must be prepared for various emergency scenarios to prevent the exploits and to allow for possible upgrades.

## Upgrading

There could be two types of situations where the FAsset system has to be upgraded:

* In the event of a bug found in the system.
* When some significant system improvements exist.

All the major components of the FAsset system are implemented as proxies. In this way the contracts can be upgraded without any impact on the users. The agents may need to upgrade the agent bot software before or shortly after the contract upgrade (only when new features are added, for bugfixes the upgrade will be seamless even to the agents).

AssetManagerController, FAsset, AgentVault, CollateralPool and CollateralPoolToken contracts are implemented as ERC-1967 proxies. But AssetManager is implemented as an ERC-2535 diamond proxy - due to its size it had to be split into several smaller contracts.

To safeguard the users, upgrading the asset manager is only possible via a governance call with a timelock that can be longer than the system governance timelock (that’s a configuration option, but it is always at least equal to the system timelock).

### Emergency pause

To prevent too much damage in case of active or imminent exploit or some other serious threat to users’ funds, there is a way to temporarily stop all operations in the FAsset system. To allow faster response and even automated services to detect threats and respond, emergency pause is not a governance call. Instead, the governance assigns one or more addresses that can trigger the emergency pause.

However, to guard the system against complete stop, the emergency pause is only temporary, with system-defined maximal pause time. For instance, the total pause can be at most some system-configured time (e.g. 24 hours) in one week, after which the time count resets and the pause can be triggered again. Of course the system can be unpaused before the maximal time elapses.

### System wind down

FAsset system can be gradually turned off (or wound down) in several steps.

The first step is to the governance call to pause minting. Once the minting pause is triggered, the asset manager can no longer mint new tokens. However, all other operations are still allowed - redeeming existing FAssets, self-closing, liquidating and FAsset transfers still work. Minting pause is reversible.

After that the governance reduces the minimum backing left after transfer to core vault to 0. Now all the agents can transfer all their backing to the core vault and withdraw all their collateral.
