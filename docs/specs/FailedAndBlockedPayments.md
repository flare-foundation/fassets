# Failed and blocked payments

Certain chains record and charge for the failed transactions. Sometimes, the transaction failure can be attributed to the sender (**failed payment**) and sometimes to the receiver of the payment (**blocked payment**). Blocking payments can serve as a type of attack on the FAsset participants, so it is essential for the FAsset system to correctly analyze reasons for failed payments, otherwise a receiver of a payment can block a payment to their address on the underlying chain and block valid operations.

## Failed payments in minting

If payment fails due to the sender, the agent simply ignores the payment and the minter must try again with a new collateral reservation.

There cannot be any blocked payments for minting - the agent must prove that the underlying address is a valid destination address before creating the agent vault.

## Failed payments in redemptions

If payment fails due to the sender, the redeemer can call the payment default (same as if the payment didn’t happen) and gets paid in collateral with premium. However, if the payment was made from the agent’s underlying address, the agent must still present the failed payment proof to properly account for gas fees. If the agent doesn’t report an outgoing payment within some time (e.g. 6 hours), anybody can report the payment and get some reward, paid in vault collateral from the agent’s vault.

The agent can also present the failed payment proof without waiting for the redeemer to call the default. This triggers the default automatically. Due to technical reasons we cannot allow the agent to retry the failed payment.

If payment fails due to the receiver (blocked payment), the Flare data connector payment proof will have status “blocked”. When the agent presents such proof to the system, their obligation is considered fulfilled and they can keep both the collateral and the underlying assets.

## Address validation

If the underlying address has invalid format or checksum, the payments to that address fail without leaving any trace. This is an issue for minting and redemption, since the redeemer can provide the agent with an invalid redemption address, upon which the agent’s payment fails. Because there is no trace of the payment being blocked, the redeemer can thus force the agent to pay in collateral with premium. A similar issue is if the agent provides invalid address, in which case the minter’s payment fails without a trace and the agent collects the collateral reservation fee.

For this reason the FAsset system requires an FDC `AddressValidity` proof for the underlying address in `createAgentVault` calls.

Additionally, a malicious redeemer could send invalid underlying address as a target of redemption. For this case, the agent can reject the redemption by presenting an `AddressValidity` proof from the FDC (see "Rejecting redemption with invalid address" in the Redemption section).
