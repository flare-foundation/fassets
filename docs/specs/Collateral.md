# Collateral

Each asset minted to an agent in the FAsset system is secured by two kinds of collateral:
1. **Vault Collateral**: ERC20 tokens held in the agent vault.
2. **Pool Collateral**: Native FLR tokens held in the [agent pool](CollateralPool.md).

The purpose of the collateral is to ensure that all FAsset [redemptions](Redemption.md) can be paid out in full: in cases where an agent fails to pay out for redeemed FAssets on the underlying chain, its collateral can be used instead.

## Collateral types

### Vault Collateral Types
A collateral type is a structure that contains the address of an ERC20 token contract along with collateral ratio settings (see below) and information required for obtaining necessary asset price details from the FTSO.
These two pieces of information determine how much FAsset can be backed by the collateral.
Each agent must choose a single collateral type and use that as the collateral in its agent vault.
The agent can change the chosen vault collateral type only if the currently used type has been deprecated (see below).

FAsset governance defines the types of tokens that can be used as vault collateral by agents, and is responsible for adding new collateral types.

### Pool Collateral Type
The same collateral type is used for each agent's collateral pool, the native FLR token.
The ERC20 contract for this collateral is always `WNat`.
In the unlikely event that the WNat contract on the Flare chain gets replaced, the pool collateral type is not updated automatically.
Instead, FAsset governance must explicitly set the pool collateral type that will be used for new agents’ collateral pools.

Each pool’s collateral is stored in the current WNat contract and its balance cannot be transferred globally.
Therefore governance (or its executor) must call `upgradeWNatContract` for batches of agents, which transfers each pool’s balance to the new WNat contract.

## Collateral Ratio
The *collateral ratio* (CR) of an agent is the ratio between the value of the agent's collateral and the total value of FAssets backed by the agent.
There are two collateral ratios for each agent, one for the agent’s vault collateral (*vault CR*) and one for the pool FLR collateral (*pool CR*).
The *total CR* is the ratio between all agent collateral and backed FAssets.
The purpose of each CR is to track the amount of collateral an agent has relative to the amount of FAssets it is backing, thus ensuring that assets can be appropriately redeemed.

### Obtaining Prices for CR Calculation
Calculating the various CRs requires converting prices between various token types.
Native currency, vault collateral currency, and other asset prices are obtained on-chain from the FTSO using the `FtsoV2PriceStore` contract.
This defines a function $\text{FTSO}_{X,Y}(n)$, computing the value of $n$ units of asset $X$ in the appropriate amount of asset $Y$.

For collateral types where the FTSO does not store the price pair, the computation is done through the USD price.
For example, if there is no FTSO pair for assets $U, V$, then:
$$
\text{FTSO}_{U,V}(n) = FTSO_{\text{USD}, V}(\text{FTSO}_{U, \text{USD}}(n))
$$
where $\text{FTSO}_{U, \text{USD}}(n)$ denotes the conversion from $n$ units of $U$ to USD.

### Computing the CR
More formally, let $x$ be the total amount of asset $X$ backed by an agent $A$.
Further let $\vert p \vert$ denote the total amount of FLR in the agent's collateral pool and $\vert c \vert$ the total amount of the agent's locked collateral, which is of asset type $C$.
Then:
$$
\text{Vault CR} = \frac{\vert c \vert}{\text{FTSO}_{X, C}(x)} \\

\text{Pool CR} = \frac{\vert p \vert}{\text{FTSO}_{X, \text{FLR}}(x)} \\

\text{Total CR} = \text{Vault CR} + \text{Pool CR}.
$$

### Collateral Ratio Settings
An agent's collateral ratio is used in a variety of ways by the FAssets system to monitor agent participation.
These include:

**Minimal CR**: The minimal CR defines the minimum CR that an agent needs to validly [mint](Minting.md) FAssets.
It is split into a vault and a pool minimal CR.
If either of an agent's CRs falls below the minimal CR, the agent gets liquidated.
The value of each minimal CR is a system parameter per backing currency (ERC20 token), fixed across all agents.

**Safety CR**: The *safety CR* denotes the CR value after which an ongoing [liquidation](Liquidation.md) can cease.
This is a system value that is higher than the minimal CR.
As with the minimal CR, there are separate safety vault and pool CR values.

**Minting CR**: Each agent sets a *minting CR* value for both its vault and pool CRs.
These values restrict the maximum amount the agent can mint at a time: the maximum mint amount the agent supports is bounded so that both its vault and pool CR remain higher than their respective minting CR values.
The minting CR must be higher than the minimal CR.

**Exit CR**: Each agent sets an *exit CR* value for its pool CR.
When a collateral provider redeems tokens, the maximum redemption amount is limited so that the pool CR can not go below the exit CR.
If the pool CR is already below the exit CR, collateral providers can not liquidate.

**Minimum agent pool tokens to mint**: The minimum value of pool tokens an agent must hold to be able to perform a new minting.
The NAT value of all agent backed FAssets together with the new amount to be minted must be smaller than the value of the agent's pool tokens.
This is a system setting defined by governance.