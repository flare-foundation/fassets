# Liquidation
Liquidation is the process by which FAssets backed by a misbehaving [agent](Agents.md) are removed from the system.
Holders of FAssets that are removed during liquidation are reimbursed with a proportion of the agent's [collateral](Collateral.md).
There are two types of liquidation:

- **Unhealthy position liquidation**: When an agent's vault or pool [CR](Collateral.md#Collateral-ratio) falls below the respective minimal CR, the agent backed FAssets are liquidated until the CR reaches the safety CR or all backed FAssets get liquidated. An agent whose CR is too low is referred to as unhealthy.

- **Full liquidation** : When an agent makes an illegal payment from its underlying chain address (see below), all its backed FAssets get liquidated.

Liquidation in the FAsset system is based on user participation.
Participants, known as liquidators, send in FAssets in exchange for part of the agent’s collateral.
They receive a premium on top of FAsset's value for this exchange, effectively punishing the agent for its behaviour.

## Liquidation Process
Once an agent is in liquidation, any address (liquidator) can send in FAssets backed by this agent and get paid with a combination of vault and [pool collateral](CollateralPool.md) at the current asset price multiplied by a premium factor.
The liquidator premium is a system-defined percentage, and increases with the duration of the liquidation.
The maximum amount of FAssets that can be liquidated in this way is the amount required to make the agent healthy, rounded up to the next lot.

### Liquidation Settings
Formally, liquidation is defined by a trio of parameters stored on the Asset Manager Settings contract:

- `liquidationCollateralFactorBIPS`: An array of factor BIPS defining the percentage premium received as liquidation transactions at each stage of liquidation.
- `liquidationFactorVaultCollateralBIPS`: An array of factor BIPS defining the percentage of liquidation payouts that derive from the agent's vault collateral; the remainder is taken from the pool collateral.
- `liquidationStepSeconds`: An integer $n$ defining the length of each stage of liquidation.

Note if either the agent or pool collateral is insufficient to pay their share of a payout, any required excess is taken from the other side.

### Liquidation Payments
When a liquidator returns an amount $x$ of an FAsset $X$ backed by an agent $A$ who has been in liquidation for time $t$ seconds due to an unhealthy pool CR, they receive:
$$
L(A, x, t) = \min \lbrace x \cdot p_t, (\text{Pool Safety CR} - \text{Pool CR}) \cdot {\text{FTSO}_{X, \text{FLR}}(x)} \rbrace.
$$
where $p_t$ denotes the $\lfloor \dfrac{t}{n} \rfloor$ entry of `liquidationCollateralFactorBIPS`, the value of the premium after time $t$.
The proportion of this that is received from the vault is defined by the the $\lfloor \dfrac{t}{n} \rfloor$ entry of `liquidationFactorVaultCollateralBIPS`, with the rest coming from the collateral pool.

Similarly for an agent with an unhealthy vault CR and asset type $C$ in the vault, the liquidator receives:
$$
\min \lbrace x \cdot p_t, (\text{Vault Safety CR} - \text{Vault CR}) \cdot {\text{FTSO}_{X, C}(x)} \rbrace
$$
with the split the same as above.

## Liquidation Triggers
Liquidation is not triggered automatically if an agent misbehaves or becomes unhealthy, as the system does not constantly [track](TrackingUnderlyingChain.md) all agents.
Instead, it is triggered by external actors, either liquidators or challengers.
External triggers are required for:

* Triggering liquidation start for an agent: This is triggered by and user calling `startLiquidation`or `liquidate` on the Asset Manager contract.
* Turning off the liquidation state for an agent: This is achieved by calling `endLiquidation` (see below).

Note that for full liquidation, there is no specific function call, since full liquidation is triggered automatically by the challenge system when a valid proof of illegal activity is presented.

### Ending a Liquidation
Agents in liquidation can only exit liquidation by returning to a healthy state.
The agent must first return their defective CR above the safety CR, either by depositing more collateral or self-closing backed FAssets.
Additionally, agents can return to safety due to changes in the FTSO prices of various assets.
In this case, the agent (or some other entity) calls `endLiquidation` on the Asset Manager contract, which confirms that the agent is no longer unhealthy then ends liquidation.

Formally, the liquidation state is ended in the following cases; note that in the first four cases contract logic automatically ends liquidation, whereas the final case is manual:

1. A liquidation returns the agents CR above the safety CR.
2. The agent deposits additional collateral, after which its CR is above the safety CR.
3. The agent performs a self-close operation, after which its CR is above the safety CR.
4. A redemption or a transfer to the [Core Vault](CoreVault.md) releases enough of the agent's locked collateral to return its CR above the safety CR.
5. The agent, or someone on their behalf, calls `endLiquidation` after an FTSO asset price move has returned the agent's CR above the safety CR.

Full liquidation cannot be halted until all assets are liquidated; however, an agent in full liquidation can still self-close assets to avoid paying the liquidation premium.

### FTSO and Trusted Prices
For detecting whether an agent is in liquidation two prices (or pairs) from the FTSO are used: the usual pair from the FTSO providers and an additional pair computed from submissions only from designated trusted price providers.
These providers are selected by governance.
Then, the price from which the agent's CR is higher is used in detecting liquidation.
The maximum age for trusted prices is defined by `maxTrustedPriceAgeSeconds`; if there have been no trusted votes for that long, the ordinary FTSO price feed is used instead.
