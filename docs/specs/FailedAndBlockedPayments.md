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

## Forbidden Addresses
Some addresses are known to hold stolen or sanctioned funds, and value from or to them must not cross the bridge.
For this, governance points the Asset Manager to a forbidden address list on Flare (`setForbiddenAddressList`), to which compliance maintainers can add addresses at any time; only the list's governance removes them, with a timelock.
The list holds underlying addresses per source chain, only in the chain's canonical form (on XRPL a classic address), and one list of EVM addresses, used for Flare addresses.
While no list is set, nothing is checked.

The list is checked wherever value crosses between the underlying chain and Flare:
- [Direct minting](Minting.md#direct-minting) refuses a forbidden payment source, recipient or executor.
- Agent minting refuses a forbidden minter at the collateral reservation, and `executeMinting` refuses a payment from a forbidden source or for a minter listed later; the agent can then release the reservation's collateral by presenting the payment proof (`releaseMintingWithForbiddenPayment`).
- Self-minting, top-ups, confirmations of closed minting payments and Core Vault donations refuse a forbidden payment source.
- Every redemption, the direct redemption from the Core Vault and the collateral pool's self-close exit to the underlying chain refuse a forbidden redeemer or underlying address.

The agents' own addresses are not checked, as agents are vetted by governance. Neither are internal moves of the FAsset ERC-20 token or the protocol's own funds or burns that pay nothing on the underlying chain.