# Redemption
Redemption is the process by which a user holding FAssets redeems them, returning their FAssets and receiving an equivalent payment in the underlying asset on the source chain.
Any user holding FAssets can start a redemption process.

## Redemption flow
For a user $U$ who wants to redeem an amount $x$ of an FAsset $X$ originating from source chain $C$, the standard redemption process proceeds as follows:

1. The redeemer initiates the redemption process by calling the `redeem` function on the Asset Manager Contract from their Flare address $U_F$, with parameters
   - $\ell$: The amount of [lots](Minting.md#lots-and-dust) of FAsset to redeem, such that $\ell$ lots constitutes $x$ amount of FAsset.
   - $U_C$: The (user) address on $C$ to receive the redeemed assets.
   - $\text{Ex}$: The executor address for the redemption. 
2. The FAsset system selects one or more redemption tickets $t_1, \dots, t_n$ from the front of the redemption FIFO queue. Each ticket $t_i$ specifies an agent $A_i$ and an amount $x_i$. Tickets are selected until either the combined amount of assets stored is sufficient to cover the redemption, $\sum_i^n x_i \geq x$, or until a maximum ticket limit `maxRedeemedTickets` is reached. If this limit is reached, only a [partial redemption](#partial-redemptions) is performed.
3. The user transfers the amount $x$ of FAssets to be redeemed to the Asset Manager contract, which burns the assets. If the redeemer does not own enough FAssets, the redemption fails at this stage.
4. For each agent $A_i$ who owns at least one of the tickets $t_i$, the Asset Manager contract issues a `Redemption Requested` event with the following information:
   - $A_i$: The Agent Vault of the agent who owns the ticket.
   - $U_F$: The redeemer’s address that initiated the redemption.
   - $\text{id}$: A unique ID for the redemption request.
   - $U_C$: The redeemer's underlying address.
   - $x_{A_i}$: The amount to pay, the amount of assets $x_{A_i}' = \sum_{i: A_i = A} x_i$ on all tickets owned by the agent minus some redemption [fee](#redemption-fee).
   - $\text{fee}$: The fee for the redemption.
   - $B_0$: The first underlying block on which the payment can be made.
   - $B_t$: The last underlying block by which the payment must be made.
   - $\text{timestamp}$: The timestamp by which payment must be made.
   - $\text{ref}_i$: The payment reference for this ticket.
   - $\text{Ex}$: The executor address.
   - $\text{ExFee}$: The executor fee in NAT.
5. Each agent $A_i$ pays the redeemer their designated amount $x_{A_i}$ on the underlying chain with the payment reference $\text{ref}_i$ included. Note this payment can be made from any address, not only the agent’s underlying address.
6. Once its payment is finalized, each agent uses the FDC to prove the payment. Once all payments are finalized, the user has successfully redeemed their FAssets. Once each payment proof is presented to the Asset Manager contract, the agent and pool [collateral](Collateral.md) backing the redeemed FAssets is freed.

### Redemption Fee
The redemption fee is charged to the redeemer as a proportion of the redemption amount, so that on redemption of an amount $x$ of FAsset they receive an amount
$$
x \cdot (1 - \text{redemptionFeeBIPS})
$$
of asset $X$ on source chain $C$.
The parameter `redemptionFeeBIPS` is a global parameter set by governance.

Part of this fee is retained by the agent on $C$, with the rest minted into FAssets and deposited into the agent's pool.
The pool’s share of the redemption fee is the same percentage as that of its share of the [minting fee](Minting.md#minting-fees).

### Redemption Failures
Each agent has a limited time to make its redemption payment on the underlying chain, defined by the last block number $B_t$ and $\text{timestamp}$ by which the payment must be made.
If the payment is not made in time, the redeemer can prove non-payment to receive the agent's collateral on Flare.
To do so, the user makes an FDC attestation request with a non-payment attestation type.
Once this proof is validated by the FDC and presented to the Asset Manager contract, the user receives an amount of agent collateral at a small premium above the redemption price.
This must be performed separately by the user for each agent who does not pay.

The premium is determined by `redemptionDefaultFactorVaultCollateralBIPS`, a global parameter set by governance, with the agent receiving
$$
\text{FTSO}_{X, \text{FLR}}(x_{A_i}) \cdot \text{redemptionDefaultFactorVaultCollateralBIPS}
$$
in FLR from the agent collateral, where $\text{FTSO}_{X, \text{FLR}}(x)$ denotes the FTSO price of $x$ of FAsset $X$ in FLR.

### Partial Redemptions
Partial redemptions occur when either the amount of FAssets to be redeemed is greater than the amount stored on the first `maxRedeemedTickets` amount of tickets or there are not enough tickets to cover the redemption in step 2.
In this case, $\sum_i^n x_i < x$, and the redeemer can not redeem the full amount $x$ of FAssets.

Instead, the user redeems the maximum amount $y = \sum_{i = 1}^n {x_i}$ available on the tickets.
Then, in stage 4, alongside the `redemptionRequested` events, the Asset Manager contract releases a `redemptionRequestIncomplete` event with parameters $(U_F, \text{remainingAmount})$, the user address and the amount of unredeemed assets `remainingAmount`$ = y - x$ measured in lots.
Otherwise, the redemption flow is unchanged.
If the user still wishes to redeem further FAssets, they can initiate a fresh redemption request for `remainingAmount`, or some other amount

### Executors

An executor address is included in the first phase of the redemption flow.
This is an address that can trigger the redemption default payment if the agent doesn’t pay, allowing a minting UI to execute redemption default on the users behalf.
If an executor is used, the redeemer includes a redemption fee as part of the request, which is used to compensate the executor.
The size of this fee is agreed between the redeemer and executor off-chain.
Note that the use of executors is optional, and a user not intending to use one can set the executor address to the $0$ address.

## Edge cases

### Unresponsive redeemer
After a redemption failure, it may be the case that the redeemer does not or cannot report the failure.
In this case, the agent itself can present a non-payment proof returning, the collateral plus premium to the redeemer as usual.
This releases the underlying backing collateral and remaining local collateral from the redemption.

### Unresponsive agent
Conversely, it is possible that after a successful payment the agent fails to present the payment proof.
The Asset Manager requires the payment proof to correctly track the agent's balance on the underlying chain.
When enough time has passed after the agent's redemption payment, anyone can call `confirmRedemptionPayment` at the Asset Manager contract with a valid payment proof in return for a reward in the form of vault collateral from the agent’s vault.
The size of the reward is determined by `confirmationByOthersRewardUSD5` and the amount of time by `confirmationByOthersAfterSeconds`, both stored on the Asset Manager contract.

### Expired Proof Time
If no payment or non-payment proof is presented for an agent's redemption payment during the allotted time window (14 days), the agent can trigger a *finish without payment* procedure.
For this, the agent has to present an FDC proof that the proofs are no longer available to `confirmRedemptionWithoutPayment` on the Asset Manager contract, including as argument the redemption ID.
This triggers a procedure as in the case of non-payment, with the redeemer paid in collateral plus premium and the rest of the agent’s collateral released.

### Redemption Time Extension
Since an agent vault has only a single underlying address, there is a limit on the number of transactions that it can pay per minute.
To prevent DDOS attacks, in cases where there are many redemptions to the same agent in a short time period, extra time is added to the window for each redemption.

Each concurrent request adds an additional `redemptionPaymentExtensionSeconds` to the redemption payment time.
The `redemptionPaymentExtensionSeconds` setting is managed separately from other settings by the `RedemptionTimeExtensionFacet`  and can be changed by governance, with rate-limiting constraints.

### Redeemer Blocked by the Stablecoin Operator
If the redemption payment defaults and the redeemer is blocked by the stablecoin operator for the token in which the default payment should be made, the redemption default payment cannot be made in vault collateral.
In this case the default is instead paid to the redeemer in pool collateral, as long as two conditions are met: the agent must have enough pool tokens that can be slashed and the payment must not push the pool into [liquidation](Liquidation.md).

### Rejecting Redemption with Invalid Address
The redemption flow assumes that the redeemer presents a valid underlying address on the source chain.
If this is not the case (e.g. they provide an invalid address) the agent can reject the redemption by presenting an `AddressValidity` proof from the FDC showing that the address is invalid.
On successful rejection, the redemption is considered fulfilled and the agents collateral is released.
This is handled by the `rejectInvalidRedemption` method on the Asset Manager contract.

## Self Close
An agent can self-close their position or part of their position to release their collateral.
The process is similar to a redemption, except that there is no underlying payment:

1. The Agent transfers an amount $x$ of the FAsset to be self-closed from their Flare account to the Asset Manager contract, which burns the assets.
2. The collateral backing those assets is released.
3. The underlying collateral is freed and can later be withdrawn from the underlying address.

Self-closing can also be used by an agent to stop liquidations, since it reduces the amount of FAssets that the agent is backing.
The self-closed amount need not be a whole number of lots and can even be less than one lot.

## Redeem Any Amount
Unlike the ordinary `redeem` call, the `redeemAmount` method allows redeeming any amount of FAssets, not only whole lots.
This is useful for users who want to redeem amounts of FAssets that are not whole number of lots, such as yields.
However, to prevent very small redemptions that would cost agents more than the received fee, no redemption can be smaller than `minimumRedeemAmountUBA`, defined by governance.
Otherwise, the process is the same as in `redeem`.

## Redeem with Tag
The method `redeemWithTag` proceeds similarly to the `redeem` functionality, except that it allows the redeemer to request that an XRP destination tag is added to the redemption payment.
This is useful for users who want to redeem directly to an exchange.
Like `redeemAmount`, it also allows redeeming any amount of FAssets, not only whole lots.

Since redemption with tag requires a new FDC proof type which supports a destination tag, and since the redeem amount is not a whole number of lots, it uses specific methods `redeemWithTag`, `confirmXRPRedemptionPayment`, and `xrpRedemptionPaymentDefault`.
A new event `RedemptionWithTagRequested` is emitted on a successful request for redemption with tag.
Otherwise, it is the same as `redeem`.

Note this method only works on FAssets whose source is the XRP chain.
This is specified on Flare by the flag `redeemWithTagSupported`.
