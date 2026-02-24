# Upgrading, pausing and winding down

FAsset system is a very complex decentralized system. As such, there are many unexpected situations that can happen. Therefore we must be prepared for various emergency scenarios to prevent the exploits and to allow for possible upgrades.

## Upgrading

There could be two types of situations where the FAsset system has to be upgraded:

* In the event of a bug found in the system.
* When some significant system improvements exist.

All the major components of the FAsset system are implemented as proxies. In this way the contracts can be upgraded without any impact on the users. The agents may need to upgrade the agent bot software before or shortly after the contract upgrade (only when new features are added, for bugfixes the upgrade will be seamless even to the agents).

AssetManagerController and CoreVaultManager are implemented as ERC-1967 proxies, upgradable by UUPS mechanism. AssetManager is implemented as an ERC-2535 diamond proxy - due to its size it had to be split into several smaller contracts (facets). AgentVault, CollateralPool and CollateralPoolToken instances are created through factory contracts (and are also UUPS proxies).

### Diamond cut timelock

To safeguard the users, upgrading the asset manager (diamond cut) is only possible via a governance call with a timelock that can be configured to be longer than the system governance timelock. The setting `diamondCutMinTimelockSeconds` ensures the timelock used for diamond cuts is always the maximum of this value and the governance system timelock. This gives users time to react to potentially dangerous upgrades.

The diamond cut process is:
1. Governance announces the diamond cut (adding, replacing, or removing facets).
2. After the timelock period elapses, the diamond cut can be executed.
3. The cut adds, replaces, or removes function selectors and their corresponding facet addresses.

## Emergency pause

To prevent too much damage in case of active or imminent exploit or some other serious threat to users' funds, there is a way to temporarily stop operations in the FAsset system. To allow faster response and even automated services to detect threats and respond, emergency pause is not limited to governance. The governance assigns one or more addresses that can trigger the emergency pause.

### Pause levels

The emergency pause has three severity levels:

| Level | Effect |
|---|---|
| **START_OPERATIONS** | Prevents starting new mints, redeems, liquidations, and core vault transfers/returns. Already-started operations can still be completed. |
| **FULL** | Everything from START_OPERATIONS, plus prevents finishing or defaulting already started mints and redeems (and all other publicly available operations in asset manager). |
| **FULL_AND_TRANSFER** | Everything from FULL, plus prevents FAsset token transfers. |

The effective pause level is the maximum of the external pause level (set by authorized addresses) and the governance pause level.

### External pause (non-governance)

External pause is triggered by governance-authorized addresses. To guard the system against a complete stop, the external emergency pause is temporary, with a system-defined maximal total pause duration (`maxEmergencyPauseDurationSeconds`). The total pause duration counter resets automatically after `emergencyPauseDurationResetAfterSeconds` have elapsed since the last pause ended. The governance can also manually reset the duration counter.

### Governance pause

The governance can independently trigger an emergency pause at any level, without the duration limits that apply to external pause. This provides a stronger override mechanism for situations that require extended intervention.

## System wind down

FAsset system can be gradually turned off (or wound down) in two steps.

The first step is to initiate minting pause via the governance call to `pauseMinting`. Once the minting pause is triggered, the asset manager can no longer mint new tokens. However, all other operations are still allowed - redeeming existing FAssets, self-closing, liquidating and FAsset transfers still work. Minting pause is reversible via `unpauseMinting`.

This is followed by a long (several weeks) period when minting is paused, but the redemptions are still possible, to redeem as much of the FAsset as possible.

After that the governance reduces the minimum backing left after transfer to core vault (`minUnderlyingBackingBIPS`) to 0. Now all the agents can transfer all their backing to the core vault and withdraw all their collateral.
