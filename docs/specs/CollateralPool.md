# Collateral pool

Each agent vault has an associated unique collateral pool contract (instance of `CollateralPool`). Collateral pool holds only native token (FLR or SGB) collateral (called “**pool collateral**”). The pool collateral is used as an additional source of collateral for liquidations and failed redemptions at the times of rapid price fluctuations. The collateral pool allows anybody to participate in the FAsset system and earn FAsset fees by depositing FLR or SGB tokens.

## Collateral pool token

Each collateral pool has its own token contract (“**collateral pool token**”), which is an instance of `CollateralPoolToken`. Collateral pool tokens are proof of the collateral provider’s share in the collateral pool. On entering (adding FLR/SGB collateral to the pool) the user receives collateral pool tokens in the amount

*(added collateral) * (currently issued collateral pool tokens) / (collateral in pool)*.

The pool tokens can be later redeemed for FLR/SGB at the ratio expressed by the same formula, but with current values for the total collateral in the pool and the total number of collateral pool tokens.

### Locked and transferable tokens

Collateral pool tokens are ERC20 tokens, so they can be transferred and traded. However, not all the pool tokens are transferable. There are actually two ways the tokens can become non-transferable.

When a token is created by entering the pool it becomes **timelocked**. This means that for some period of time (defined by system governance) this token cannot be redeemed. But, since the tokens are fungible, timelocked tokens must also be non-transferable, otherwise they could be transferred to another account and redeemed from there.

The reason timelocking is needed is that all the income of the pool - like minting fees, airdrops, and FTSO delegation rewards - is distributed between all the tokens that exist at the instant the fee or reward arrives. Without the timelock, the account that executes minting or claim could sandwich the execution between pool enter and exit, extracting a significant share of the income. Timelock doesn’t completely remove the issue, but it mitigates it by making the exploit more risky and expensive - it prevents using a huge flash loan for entering the pool and exposes the rogue user to the risk of exchange rate fluctuations.

The other way pool tokens can be non-transferable is if they are **debt-locked**, which is explained in the following section. The difference with timelocked tokens is that debt-locked tokens can be redeemed.

The tokens that are neither timelocked nor debt-locked are called **transferable** because they can be freely transferred and redeemed.

## Sharing pool FAsset fees

As minting fees (in FAsset) are added to the pool, they are shared between collateral providers, proportionally to the amount of collateral pool tokens the provider holds. On exit, the collateral provider receives the appropriate share of the fees. However, if on entering the pool there are already some FAsset fees held by the pool, the entering user’s tokens are assigned “FAsset fee debt”, and on exit this debt is subtracted from the fees.

Having pool tokens with various amounts of fee debt would make the tokens non-fungible, since they would have different notional values, depending on the amount of the fee debt. Therefore, only the part of the collateral provider’s pool tokens that are “free of debt” are allowed to be transferred.

This essentially divides the pool tokens held by a collateral provider into two types: “**debt-free**” tokens that are free of fee debt and are fully transferable (unless they are timelocked). They are also fully fungible, since they are assigned the full amount of FAsset fees and are therefore all worth the same. The other type are “**debt-locked**” tokens, that carry the fee debt. They are not transferable - they are just proof of ownership of some of the collateral in the pool. As fees arrive in the pool, some locked pool tokens become transferable (but, importantly, not in the other direction).

A collateral provider can pay off the fee debt by bringing the appropriate amount of FAssets to the pool, making all the pool tokens transferable. Such tokens can be swapped and traded. On the other hand, if the collateral provider doesn’t intend to transfer the tokens, they can leave the debt or even occasionally withdraw all the fees assigned to their tokens without exiting the pool.

The second option is especially important for the agents: they need to hold some pool tokens in the vault and cannot exit while they are backing FAssets. But these pool tokens earn FAsset fees - depending on fee sharing settings, it is typically 15-30% of all agent's fees. Since transferability of the agent’s pool tokens is irrelevant anyway, the agents can withdraw the fees at any time without exiting the pool.

The exact formulas for deriving FAsset fee shares are:

`(user’s virtual FAsset) = ((total FAsset in the pool) + (total FAsset debt)) * (user’s collateral pool tokens) / (currently issued collateral pool tokens)`,

`(user’s free FAsset) = (user’s virtual FAsset) - (user’s FAsset debt)`.

Note that *FAsset debt* is calculated at pool entering and can increase or decrease by the user paying off FAsset fee debt, exiting the pool or withdrawing fees. User’s transferable and locked pool tokens are then calculated as:

`(user’s transferable collateral pool tokens) = (user’s collateral pool tokens) * (user’s free FAsset) / (user’s virtual FAsset)`,

`(user’s locked collateral pool tokens) = (user’s collateral pool tokens) * (user’s FAsset debt) / (user’s virtual FAsset)`.

These are more dynamic - transferable collateral pool tokens increase (and locked decrease) for every minting fee that arrives in the pool.

## Exiting collateral pool (redeeming collateral pool tokens)

A collateral provider can exit the collateral pool by calling the `exit` method in the collateral pool. Upon exit, the system burns the provider’s collateral pool tokens, decreases its FAsset fee debt (it may be negative) and awards the provider the appropriate share of collateral.

Normal exit is only possible when the collateral ratio (CR) of the pool is high enough - after the exit, the remaining CR must be at least “**exit CR**” (agent-defined value; must be higher than agent’s minting CR). This limit is in place to prevent the collateral pool exit from lowering the pool CR to dangerous levels.

If the pool is not significantly overcollateralized, its CR is probably below 'exit CR', which makes ordinary exits impossible. In this case, as long as the user holds enough FAssets, there is an option of calling `selfCloseExit`, which, along with pool tokens, burns enough of the user’s FAssets to release collateral required for exiting and decreases its FAsset fee debt. The amount of burned FAssets will be such that the pool CR after exit is no lower than before or no lower than exit CR, whichever is smaller.

Of course, in this case the user must be compensated for the burned FAssets. For this, there are two possibilities: normally, a redemption is created for the value of burned FAssets. But if the user burned less than 1 lot of FAssets, such a redemption would be too expensive for the agent (underlying fees can be high). So in this case (or on user’s explicit request), the agent buys the underlying funds from the user at FTSO price, minus some percentage (defined by the agent).

The redemptions that arise from self-close exit are a bit special: if the agent fails to pay in underlying currency, the redeemer is only paid from agent’s vault collateral, since the pool collateral that should be backing their redeemed FAssets is the one that they have already withdrawn. Therefore, in rare cases the user might get less collateral than in ordinary redemption.

## Agent’s stake in collateral pool

The agent must have a stake in the collateral pool, which means that they must hold the amount of collateral pool tokens proportional (by a system-defined constant) to the backed amount of FAssets. The maximum amount of minting is limited by the amount of agent’s collateral pool tokens. The agent’s pool tokens remain locked (cannot be redeemed or transferred) while the agent is backing these FAssets.

However, unlike collateral ratio, low stake doesn’t trigger liquidation, it only prevents new mintings.  This is because only the total pool stake matters when a redemption in collateral or liquidation payment needs to be made.

If the pool has to pay something due to the agent's fault, the agent’s collateral pool tokens are slashed (burned) for the paid FLR/SGB value, recalculated by the collateral pool price formula. The cases when the pool has to pay something due to the agent’s fault are:

* Redemption payment failure (if there is not enough of the agent’s collateral or if the system is set so that the pool always pays something on redemption failure)
* Liquidation due to low CR of agent’s vault collateral
* Full liquidation due to agent’s illegal underlying payment
