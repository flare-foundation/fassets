# Collateral Pool

Each agent vault has an associated unique collateral pool contract, defined as an instance of `collateralPool`.
This contract is initialized as part of the `createAgentVault` function that creates the Agent Vault.
The collateral pool holds only native token collateral, referred to as *pool collateral*.
The pool collateral is used as an additional source of collateral for [liquidations](Liquidation.md) and failed [redemptions](Redemption.md) at times of rapid price fluctuations.
Each agent's collateral pool is open: any user of Flare can deposit native tokens in to an agent's collateral pool and earn FAsset fees in return.

## Collateral Pool Token
Each collateral pool has its own token contract, an instance of `CollateralPoolToken`.
Collateral pool tokens are proof that an entity has deposited tokens in the collateral pool.
Any Flare user can deposit tokens into the collateral pool, also referred to as entering the collateral pool.
Entities that hold collateral pool tokens are known as *collateral providers*.

### Receiving Collateral Pool Tokens
For an agent $A$, let $A_t$ denote their collateral pool token and $A_P$ their collateral pool.
Furthermore, let $\vert A_t \vert $ denote the total amount of $A_t$ in circulation and $\vert A_{P} \vert$ the total amount of FLR in the agent's collateral pool.
When a user deposits an amount $x$ of Flare tokens into collateral pool $A_P$, they receive an amount $A_P(x)$ of freshly generated pool tokens $A_t$ computed as
$$
A_P(x) = \frac{x \cdot \vert A_t \vert}{\vert A_{P} \vert}
$$
with the quantities $\vert A_t \vert, \vert A_{P} \vert$ determined before the new pool tokens are generated.

Similarly, a user can redeem an amount $y$ of collateral pool tokens at the pool.
When they do so, they receive an amount ${A_P}^{-1}(y)$ of FLR from the collateral pool corresponding to the same formula:
$$
{A_P}^{-1}(y) = \frac{y \cdot \vert A_P \vert}{\vert A_{t} \vert}.
$$
Note that this value is computed dynamically e.g. tokens are redeemed at their current value, not at the value at time of issuance.

### Valuing the Collateral Pool Token
Certain events require the NAT value of an agent's collateral pool token.
In this case, the NAT value $\text{NAT}_{A_p}(x)$ of an amount $x$ of the collateral pool token is simply equal to the value of FLR held as collateral multiplied by the proportion of the pool, e.g.
$$
\text{NAT}(x) = \frac{x}{\vert A_t \vert} \cdot \vert A_P \vert.
$$
Note that when required, this value is calculated dynamically e.g. based on the state of the pool when required rather than historical values.

### Locked and Transferable Tokens
Collateral pool tokens are ERC20 tokens, so they can be transferred and traded. 
However, there are two situations in which the tokens can become non-transferable:

1. When a token is issued to a user entering the pool, it becomes *timelocked* and cannot be transferred. That is, a user depositing an amount $x$ of tokens into $A_P$ at time $T_0$ receives an amount $A_P(x)$ of pool tokens $A_t$ that cannot be traded until time $T_1$. The duration $D =  T_1 - T_0$ of this timelock is a global parameter set by governance.

2. Pool tokens can become *debt-locked*, which makes them non-transferable. More details on debt-locked tokens is given below.

Pool tokens that are neither timelocked nor debt-locked are called *transferable*.

## Sharing Pool FAsset Fees
[Minting](Minting.md) fees, in the form of FAssets, are added to the collateral pool. 
They are shared between collateral providers proportionally to the amount of collateral pool tokens the provider holds.
On exiting the collateral pool, the collateral provider receives its share of the fees.

### Fee Debt
When a user enters a collateral pool which already holds an amount of FAsset fees, the tokens given to the user are assigned a corresponding *FAsset fee debt*, which is subtracted from the fees on exit.
Only the part of the collateral provider’s pool tokens that are free of debt are allowed to be transferred.

This essentially divides the pool tokens held by a collateral provider into two types: *debt-free* tokens that are are fully transferable (unless they are timelocked) and *debt-locked* tokens that are not transferable.
As more fees arrive in the pool, some locked pool tokens become unlocked.
These computations are laid out below.

A collateral provider can pay off the debt by providing the appropriate amount of FAssets to the pool, making all its pool tokens transferable.
On the other hand, if the collateral provider doesn’t intend to transfer the tokens, they can leave the debt or even occasionally withdraw all fees assigned to their tokens without exiting the pool.

### Fee Sharing Computation
For a user $U$ that has deposited collateral in collateral pool $A_P$, let $U(A_t)$ denote the amount of collateral pool tokens held by $U$.
Then let
$$
U(A_P) := \frac{U(A_t)}{\vert A_t \vert}
$$
denote the proportion of the collateral pool tokens owned by $U$.
Define the user's virtual FAsset fees as $U_{\mathrm{virt}}(A_P)$ and denote its free (unlocked) FAsset fees as $U_{\mathrm{free}}(A_P)$, with the user's debt denoted $U_{\mathrm{debt}}(A_P)$.
Let ${\mathrm{fee}}(A_P)$ denote the total FAsset fees assigned to the colleteral pool and ${\mathrm{debt}}(A_P)$ the total FAsset debt in the collateral pool.
Then:
$$
U_{\mathrm{virt}}(A_P) = ({\mathrm{fee}}(A_P) + {\mathrm{debt}}(A_P)) \cdot U(A_P),
$$
and
$$
U_\mathrm{free}(A_P) = U_{\mathrm{virt}}(A_P) - U_{\mathrm{debt}}(A_P).
$$

Note that FAsset debt is calculated at time of entering the pool and can increase or decrease when the user pays off FAsset fee debt, exits the pool, or withdraws fees.

### Unlocked Tokens Computation
Similarly, a users unlocked collateral pool tokens $U_\mathrm{free}(A_t)$ and locked collateral pool tokens $U_\mathrm{lock}(A_t)$ are computed as 

$$
U_\mathrm{free}(A_t) = U(A_t) \cdot \frac{U_\mathrm{free}(A_P)}{U_\mathrm{virt}(A)},
$$
and
$$
U_\mathrm{lock}(A_t) = U(A_t) \cdot \frac{U_\mathrm{debt}(A_P)}{U_\mathrm{virt}(A_P)}.
$$

These are calculated dynamically: transferable collateral pool tokens increase, and locked tokens decrease, for every minting fee that arrives in the pool.

## Exiting collateral pool (redeeming collateral pool tokens)
A collateral provider can exit the collateral pool by calling the `exit` method on the instance of `collateralPool`.
Upon exit, the system burns the provider’s collateral pool tokens, decreases its FAsset fee debt (possibly negative), and awards the provider the appropriate share of collateral.
The exiting user thus receives its share
$$
U(A_P) \cdot \vert A_P \vert
$$
of the FLR stored in the collateral pool.

### Exit Availability and CRs
A user can only exit if the [collateral ratio](Collateral.md#collateral-ratio) (CR) of the pool is high enough. 
After the exit, the remaining CR must be at least the exit CR, otherwise the exit is not permitted.
That is, a user with an amount $U(A_t)$ collateral pool tokens can only exit if
$$
\frac{\vert A_P \vert - U(A_t)}{\text{FTSO}_{X, \text{FLR}}(x)}
$$
exceeds the exit CR, where $\text{FTSO}_{X, \text{FLR}}(x)$ denotes the FTSO price of the total amount $x$ of FAsset $X$ backed by the agent.

### Self-Close Exits
If the agent's pool CR is below the exit CR, a normal exit from the collateral pool is not possible.
In this case, a user that holds enough FAssets can call the `selfCloseExit` option instead.

This option burns both pool tokens and FAssets owned by the user, then releases the collateral required for exiting and decreases its FAsset fee debt.
The amount of burned FAssets will be such that the pool CR after exit is no lower than before or no lower than the exit CR, whichever is smaller.

That is, a user with an amount $U(A_t)$ of collateral pool tokens from an agent who is backing an amount $x$ of FAsset $X$ can complete a self exit by burning an amount $u$ of FAsset $X$ such that
$$
\frac{\vert A_P \vert - U(A_t)}{\text{FTSO}_{X, \text{FLR}}(x - u)}  \geq \min({\frac{\vert A_P \vert}{\text{FTSO}_{X, \text{FLR}}(x)}}, \text{exitCR}).
$$ 

In the case of a `selfCloseExit`, the user is reimbursed for the burnt assets.
This is handled by a redemption request, created for the value of the burned FAssets via `redeemFromAgent` and called by the `collateralPool` contract as part of the user redemption.
In the case where the user burnt less than a single lot worth of FAsset, the agent buys the underlying funds from the user at the FTSO price instead, multiplied by a factor `buyFAssetByAgentFactorBIPS`, set on a per-agent basis.
This is done via `redeemFromAgentInCollateral`.

Note that redemptions that arise from a self-close exit have slightly different behaviour in case of defaults.
If the agent fails to pay the redemption in underlying currency, the redeemer is only paid from agent’s vault collateral, and not from the collateral pool.
If the amount of funds in the vault collateral is insufficient to cover the redemption, the user's shortfall is not covered.

## Agent’s Stake in Collateral Pool
The agent must have a stake in its own collateral pool, otherwise it is unable to mint FAssets.
The amount of tokens is determined by a system-wide parameter `mintingPoolHoldingsRequiredBips` that is set by governance.
An agent $A$ is only able to perform a minting if the total value of agent backed FAssets (determined using FTSO prices) after the mint multiplied by this percentage is less than the value of the agent's stake in the collateral pool.

That is, an agent can only perform a minting that would leave them with a total amount $x$ of backed FAsset $X$ if the value $\text{NAT}(A_P(A))$ of the agent's stake in its own pool satisfies
$$
\text{FTSO}_{X, \text{FLR}}(x) \cdot \text{mintingPoolHoldingsRequiredBips} < \text{NAT}(A_P(A)).
$$

The agent’s pool tokens remain locked while the agent is backing these FAssets.
If the collateral pool has to pay a penalty accrued by the agent, the agent’s collateral pool tokens are slashed (burned) for the FLR value of the penalty.
The cases when the pool has to pay due to an agent’s fault are:

- Redemption payment failure.
- Liquidation due to the agent's vault CR falling too low.
- Full liquidation due to an agent’s illegal underlying payment.
