# Introduction

## Overview
The FAsset contracts are used to [mint](Minting.md) representations of assets from non-smart contract chains on Flare (or Songbird). 
These representations are ERC20 wrappers for the underlying asset, typically tokens (e.g. XRP, BTC, DOGE) from a source chain.
While minted as FAssets, the original assets are locked on their source chain at designated [agent](Agents.md) addresses.
These agents hold the original asset and support [redemptions](Redemption.md), returning it to users who wish to close an FAsset position.
The minted FAssets are secured by agent [collateral](Collateral.md) in the form of both ERC20 and native tokens on Flare (or Songbird).
The collateral is locked in contracts that guarantee that minted tokens can always be either redeemed for underlying assets or compensated by collateral.

Two enshrined protocols, available on both Flare and Songbird, enable the FAsset system:

* **FTSO** (Flare Time Series Oracle) contracts provide decentralized price feeds for multiple tokens.
* **FDC** (Flare Data Connector) bridges payment data from source chains via consensus among Flare's data providers.

## Off-chain Actors and their Roles
### Agents
The main actors in the FAsset system are **agents**.
They host accounts on source chains that hold mirrored assets, allowing users to exit the system by exchanging FAssets for the originals.
In return, they are rewarded with [fees](Minting.md#minting-fees) for their participation in the system.

To insure the assets they hold, agents lock collateral on Flare in the form of stablecoins or other highly liquid tokens.
Additionally, each agent has an associated **collateral pool**, providing further collateral in the form of native tokens (FLR or SGB).
Any Flare user can lock FLR in an agent's [collateral pool](CollateralPool.md), further collateralizing FAssets backed by the agent.
In return, the user receives **collateral pool tokens**, granting the holder the right to a proportion of the agent's minting fees.
The agents combined collateral is required to be higher than the total value of the assets it is securing.

### Users: Minting and Redeeming
FAssets are created by minting.
A Flare user, known as the **minter**, mints deposits underlying assets to the agent’s address on the source chain.
In return, they receive an equivalent amount of FAssets on Flare, minus a small minting fee.
This process is referred to as minting.

Redemption is the process by which an FAsset is destroyed and the underlying asset on the source chain returned to the user.
To redeem an asset, a **redeemer** submits FAssets on Flare to be burnt and receives the equivalent amount of underlying assets on the source chain.
An agent is selected to perform the redemption, transferring the original asset to the user.
If the agent fails to pay the user, the FAssets contracts on Flare pay out the redemption instead, sourcing funds from the agent’s collateral or collateral pool.

### Monitors
FAsset agents must hold deposited assets at all times, and are not permitted to release them for any reason other than user redemptions.
Since a contract on Flare cannot directly monitor the agent’s activity on other chains, entities known as **challengers** perform this task.
Challengers are responsible for monitoring FAsset activities on other chains: if a challenger detects an illegal transaction from an agent, they flag this in return for a reward.
Once an illegal transaction is flagged, the agent is barred from further FAsset participation and all agent-backed assets are liquidated.

## Code Architecture
The FAsset system is implemented on a per asset basis: for each asset type (e.g. XRP, BTC), individual FAsset contracts support the corresponding FAsset (e.g. FXRP, FTBC).
There are two contracts per asset: the **Asset Manager contract** and the **FAsset token contract**.
Similarly, each agent address is specific to a single FAsset, and requires three contracts.
The **Agent Vault contract**, the **Collateral Pool contract**, and the corresponding **Collateral Pool Token contract**.
Additionally, certain assets have a **Core Vault Manager** contract, managing additional assets held in a multisig-controlled core vault on the underlying chain.
Currently, only XRP has a Core Vault Manager contract.

The Asset Manager Contract functions as the central hub for an asset: it controls minting and burning rights on the FAsset token contract and also controls the transfer of collateral tokens from the agents' vaults and collateral pools.
It is also responsible for most user interactions (e.g. minting and redeeming).
The asset manager contract is implemented as an **EIP-2535 Diamond proxy**, split into multiple facets due to its size.

Settings for multiple asset manager contracts are managed by a single **Asset Manager Controller** contract, which holds a list of all asset managers and routes governance functions.

## Terminology

### Native chain and FLR / SGB
The FAsset protocol is built for both Flare and Songbird.
In this documentation, the deployment on Flare will be referred to.
Any reference to Flare, rather than Songbird, should be understood to apply to both the Flare and Songbird FAsset deployments; parameters may differ between the two.
The Flare (or Songbird) chain is known as the **native chain** and FLR/SGB the **native currency**.


### Underlying Chain / Address / Currency
In the context of this document, **underlying chain** is used to describe chains that are connected to Flare as part of the FAsset system.
Analogously, an **underlying address** is an address on the underlying chain.
When an asset from an underlying chain gets wrapped as an FAsset, **underlying currency** or **underlying assets** is used to describe it.
For example, the underlying chain could refer to the XRP ledger, the underlying address an address on the ledger, and XRP the underlying currency.

### Collateral
Each minted asset (e.g. FXRP) is backed by two kinds of collateral: the agent vault holds ERC20 tokens (stablecoins, wrapped ETH, etc.), called **vault collateral**, and the agent’s collateral pool holds native tokens referred to as **pool collateral**.

### Collateral Ratio
The ratio between the collateral value stored by an agent and the FAsset value backed by an agent is called the **[collateral ratio](Collateral.md#collateral-ratio)** (**CR**) and is used throughout this documentation.
There are two collateral ratios corresponding to the two collateral types, **vault CR** and **pool CR**.

For example, to back 100 USD worth of FXRP the agent may have 150 XRP of USDC in the agent’s vault and 200 USD of FLR in its collateral pool.
In this case, the agent's vault CR is 1.5 and pool CR is 2.0.

### Payment Reference
Each payment done on a source chain must have a **payment reference**, a $32$-byte value attached to the payment.
Payment references help differentiate payments from other transactions, prevent re-use of payments, and allow for proving non-payment.

### Lots
Minting and redemption operations must be done in batches containing a whole number of **lots**.
A lot is a bundle of a certain amount of an asset/FAsset.
Lots will be defined by governance and will be quite large, e.g. the equivalent of 1000 USD or more.
This prevents situations where the underlying transaction fees are too high relative to the size of the transaction.

The lot size can be updated over time to reflect price fluctuations of the underlying asset.
It is modified by a governance call through the AssetManagerController contract.