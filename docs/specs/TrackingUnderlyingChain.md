# Tracking Requirements
The FAsset system requires tracking of events on supported underlying chains and Flare itself.
Source chain events are tracked by the FAsset contracts using FDC proofs of transactions and block heights.
Additionally, actions that are forbidden within FAssets are monitored and demonstrated by the FDC.

## Underlying Block Tracking
The FAsset system tracks the current block number and timestamp of the underlying chain for an FAsset type.
Tracking is not automatic, and is done at the Asset Manager contract.

The tracker can be read via `currentUnderlyingBlock`.
If the stored `currentUnderlyingBlock` value is not up to date, any user can call `updateCurrentBlock` at the Asset Manager contract with a `ConfirmedBlockHeightExists` proof from the FDC to update the tracker.
The `ConfirmedBlockHeightExists` proof contains the new value for the tracker.
The above functions are permissionless and may be called by any user.

## Underlying Balance and Enforcement
FAsset agents must make sure that any payment performed on the underlying chain does not take their balance below the allowed minimum or take their [collateral ratios](Collateral.md#collateral-ratio) out of allowed ranges.
This includes payments in the form of gas or other transaction fees.
To ensure that agents do not allow their underlying address to go below the required balance, a system of external actors named [challengers](#challengers) are encouraged to track illegal payments from agent addresses.
When an illegal payment that would result in an agent having too little balance remaining is detected, challengers report it on Flare using the FDC and the agent's position is fully [liquidated](Liquidation.md).

## Challengers
Challengers are entities whose role is to monitor each agent’s underlying address and detect illegal operations.
Any challenger can report illegal payments from any agent's underlying address to the Asset Manager contract.
The challenge must include an FDC proof of the illegal activity to be successful, with the mechanics of the FDC responsible for validation.
When a challenger successfully demonstrates that an agent has acted illegally, part of the agent's vault [collateral](Collateral.md) will be utilized to reward the challenger.
A detailed list of the illegal operations is given below.

### Challenge types
There are three types of challenges:
- **Illegal Payment Challenge**: When an outgoing payment from an agent's underlying address does not correspond to an active [redemption](Redemption.md) with appropriate payment reference.
- **Double Payment Challenge**: When an agent uses the same payment reference for multiple outgoing payments from its underlying address.
- **Free Underlying Balance Negative Challenge**: When an agent transaction makes its underlying balance too low (typically as a result of gas fees or many redemptions in a short time window).

Correspondingly, challengers flag these illegal actions at the Asset Manager contract via the following calls:

- `illegalPaymentChallenge(payment, agentVault)`
- `doublePaymentChallenge(payment1, payment2, agentVault)`
- `freeBalanceNegativeChallenge(payments, agentVault)`

where each `payment` is an FDC proof of the payment and `agentVault` is the vault address of the agent that has behaved illegally.

### Challenge Result
Once a challenge has been made successfully at the Asset Manager contract, two events are triggered.
Firstly, the agent's on-chain address enters full liquidation.
Secondly, the challenger address is paid a reward from the agent's vault.