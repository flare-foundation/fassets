# Failed and blocked payments
Certain chains record and charge for failed transactions.
Payment failures can either be attributed to the sender (**failed payment**) or the receiver (**blocked payment**).
The FAsset system requires a mechanism to analyze the reason that a payment failed to issue appropriate sanctions or mitigations.

## Failed Payments in Minting
If a [minting](Minting.md) payment fails due to the sender, the agent simply ignores the payment and the minter must reinitiate minting with a new collateral reservation.
Minting payments do not fail due to the receiver; the FAsset system requires an FDC `AddressValidity` proof for the underlying address in `createAgentVault` calls.

## Failed Payments in Redemptions
If a [redemption](Redemption.md) payment fails due to the sender, the redeemer follows the defaulted redemption flow, reporting the payment default and getting paid in agent [collateral](Collateral.md) plus premium. 

However the agent must still present the failed payment proof from its underlying address to account for its gas fees.
If the agent doesn’t report an outgoing payment within the allocated time window, anybody can report the payment in return for a reward paid in vault collateral from the agent’s vault.
Note that the agent can also present the failed payment proof without waiting for the redeemer to initiate a default payment, automatically triggering the default process.

If payment fails (is blocked) due to the receiver, the FDC payment proof for the payment will have the status `blocked`.
In this case, the agent is entitled to keep both the collateral and the underlying assets.
Similarly, agents can reject a redemption to an invalid address by presenting an `addressValidity` proof from the FDC demonstrating that the address is invalid.