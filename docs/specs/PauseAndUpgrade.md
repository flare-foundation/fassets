# Upgrading, Pausing and Winding down
The FAsset system supports mechanisms for upgrading, pausing, and winding down.
These mechanisms are documented in this file.

## Upgrading

There are two types of situations where the FAsset system may need to be upgraded:

- A bug is found in the system.
- An improvement to the system is developed.

All major components of the FAsset system are implemented as proxies.
In this way, the FAsset contracts can be upgraded without any impact on the users.
On the other hand, agents may need to upgrade agent bot software before or shortly after the contract upgrade to maintain compatibility.

Specifically, the `AssetManagerController` and `CoreVaultManager` are implemented as ERC-1967 proxies, upgradable by the UUPS mechanism.
`AssetManager` is implemented as an ERC-2535 diamond proxy; due to its size it is split into several smaller contracts (facets).
Individual `AgentVault`, `CollateralPool`, and `CollateralPoolToken` instances are created through factory contracts and are also UUPS proxies.

### Diamond Cut Timelock
To safeguard users, upgrading the Asset Manager (diamond cut) is only possible via a governance call with a configurable timelock.
The setting `diamondCutMinTimelockSeconds` ensures the timelock used for diamond cuts is always the maximum of this value and the governance system timelock.
This gives users time to react to upgrades, for example by withdrawing from the system.

The diamond cut process is:
1. Governance announces the planned diamond cut (e.g. adding, replacing, or removing facets). The timelock period is initialized
2. During the timelock period, no changes to the diamond cut occur and users can react to the upcoming update.
3. After the timelock expires, the diamond cut occurs: the cut adds, replaces, or removes function selectors and their corresponding facet addresses.

## Emergency Pause
To handle instances where a bug or exploit is found, the FAsset system supports an emergency pause.
Triggering an emergency pause is not limited to governance: instead, governance assigns one or more addresses that can trigger an emergency pause.

### Pause levels

The emergency pause mechanism has three severity levels:

| Level | Effect |
|---|---|
| **START_OPERATIONS** | Prevents starting new [mints](Minting.md), [redeems](Redemption.md), [liquidations](Liquidation.md), [colateral pool](CollateralPool.md) provider operations, and [core vault](CoreVault.md) transfers/returns. Operations that have already started can still be completed. |
| **FULL** | Includes all restrictions from START_OPERATIONS, and prevents finishing or defaulting already started mints, redeems, and all other publicly available operations from the Asset Manager contract. |
| **FULL_AND_TRANSFER** | Includes all restrictions from FULL, and prevents FAsset token transfers. |

The effective pause level is the maximum of the external pause level and the governance pause level described below.

### External pause (non-Governance)
An external pause is a pause triggered by a governance-authorized address that is not governance itself.
To guard the system against such an address acting maliciously, the external emergency pause is temporary, with a system defined maximal total pause duration (`maxEmergencyPauseDurationSeconds`).

The total pause duration counter resets automatically after `emergencyPauseDurationResetAfterSeconds` have elapsed since the last pause ended.
Additionally, governance can also manually reset the duration counter.

### Governance pause
FAsset governance can independently trigger an emergency pause at any level, and may do so without the duration limits that apply to external pauses.
This provides a stronger override mechanism for situations that require extended intervention.

## System wind down
The FAsset system can be gradually turned off (or wound down) in two steps.

The first step is to initiate a minting pause.
Governance initializes this by calling `pauseMinting`.
Once the minting pause is triggered, the Asset Manager can no longer mint new tokens through agents.
However, other operations are still allowed: existing FAssets can be redeemed, and agents can still self-close or liquidate their position.
At this stage, FAsset transfers still work as usual.
A minting pause is reversible via `unpauseMinting`.
Note that a minting pause does not apply to direct minting.

The duration of a minting pause is expected to be relatively long (e.g. a few weeks), leaving a period where redemptions are still possible and users can remove FAssets from the system.
After this time, the governance reduces the minimum backing requirement after transfer to core vault (`minUnderlyingBackingBIPS`) to $0$.
Once this is set to $0$, all remaining agents can transfer all their backing to the core vault and withdraw all their collateral, thus exiting the system.
Once all agents have left the system, it is effectively wound down.