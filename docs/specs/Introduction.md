# Introduction

## Overview

The FAsset contracts are used to mint representations of assets from other XRP chain on Flare (or Songbird). The original assets are deposited to the address of an agent and can later be redeemed. The minted FAssets are secured by collateral, which is in the form of ERC20 tokens on Flare/Songbird chain and native tokens (FLR on Flare, SGB on Songbird). The collateral is locked in contracts that guarantee that minted tokens can always be either redeemed for underlying assets or compensated by collateral.

Two novel protocols, available on Flare and Songbird blockchains, enable the FAsset system to operate:

* **FTSO** contracts which provide decentralised price feeds for multiple tokens.
* Flare’s **Flare data connector**, which bridges payment data from any connected chain.

## Off chain Actors and their roles

The main actors in the FAsset system are the **agents**. They provide infrastructure for holding  the underlying assets (XRP) that back the corresponding FAssets and for paying them out upon redemptions. They are responsible for paying back the underlying assets on redemption. As insurance for that, they provide collateral in the form of stablecoins or some other highly liquid tokens e.g. wrapped ETH.

Each agent has an associated **collateral pool**, which provides further collateral in the form of native tokens (FLR or SGB). Anybody can add collateral to the collateral pool and receive **collateral pool tokens** in return. Collateral pool tokens give the collateral provider the right to get back the deposited collateral and to earn part of the minting fees.

F-assets are created by minting. The **minter** deposits underlying assets to the agent’s address and, after proving the deposit, receives an equivalent amount of FAssets (ERC20 wrappers for the underlying currency), minus the minting fee (which is split between the agent and the collateral pool; the pool receives fees as FAssets).

On redemption, the **redeemer** provides FAssets and receives from the agent equivalent amount of underlying assets. If the agent fails to pay the underlying assets in time, the contract pays the redeemer from the agent’s (or pool) collateral in the value of the redeemed FAssets with premium. To make sure this is always possible, even after rapid price changes, the total collateral is some factor higher than the value of the backed FAssets.

When, due to price changes, the one or both of the collaterals becomes lower than required, the agent is automatically put in liquidation mode. When this happens, **liquidators** can send  FAssets into the system and get paid with collateral, in the value of sent FAssets plus some premium. The sent FAssets are burned, which reduces the amount the agent’s collateral is backing.

An agent is expected to hold the deposited underlying assets at all times. Since a contract on the Flare/Songbird chain cannot monitor the agent’s underlying address, the **challengers** perform this task. When they detect an illegal transaction from the agent’s underlying address, they provide the proof to the system and get some reward from the agent. At that point, all the agent backed FAssets are put into liquidation mode and this agent cannot mint any more.

## Code architecture

The FAsset system is implemented as two contracts per asset: the asset manager contract and the FAsset token contract. Per each agent there are three more contracts: the agent vault contract, the collateral pool contract, and the corresponding collateral pool token contract.

The asset manager contract has minting / burning rights on the FAsset token contract and also controls the transfer of collateral tokens from the agent's vault and collateral pool. Most of the user interactions (minting, redeeming, etc.) go through the asset manager, except for collateral providers that interact directly with the collateral pool.

## Terminology

#### Underlying chain / underlying address / underlying currency

In the context of this document we use **underlying chains** or **underlying addresses** to describe the chains that are connected to this chain. So an underlying chain could is XRP. Analogously, the **underlying address** would be the XRP address and so forth. For the currency on the underlying chain that gets wrapped to FAssets, we use terms **underlying currency** or **underlying assets**.

#### Native chain and SGB / FLR

The FAsset solution is planned to run both on the Songbird chain and on Flare. Thus when we use SGB or FLR as examples it should be seen as synonyms.  We call the Songbird/Flare chain the **native chain** and SGB/FLR the **native currency**.

#### Collateral

Each minted asset (fXrp) is backed by two kinds of collateral: the agent vault holds ERC20 tokens (stablecoins, wrapped ETH, etc.), called **vault collateral**; and the agent’s collateral pool holds native tokens (FLR / SGB), referred to as **pool collateral**. The FAsset system is designed in such a way that at all times the backing collateral should be worth more than the backed asset.

#### Collateral ratio

The ratio between the collateral value and the FAsset value is called **collateral ratio** (**CR**) and is used many times throughout this document. There are two collateral ratios corresponding to the two collateral kinds, **vault CR** and **pool CR**.

For example, for backing 100$ of fXRP the agent will need at least 150$ of USDC (or some other stablecoins) in the agent’s vault and 200$ of FLR in the collateral pool. In this case, the vault CR is 1.5 and the pool CR is 2.0.

#### Payment reference

One other very important building block for enabling the FAsset system to operate, is the payment reference. Each payment done on other chains must have a **payment reference**, which is a 32 byte value attached to the payment (e.g. a memo field). Payment references help differentiate payments from other transactions, keep payments non-reusable and allow for proving non-payment.

Payments that involve two actors (minter/agent or redeemer/agent) will have unique payment reference based on unique minting or redemption id, to also enable proving non-payment. Other payments (e.g. self-minting or underlying address topup) will have payment reference that is based on agent vault address (which, along with tracking used payments, is enough to prove payment non-reusability).

#### Lots

To prevent situations where the underlying transaction fees are higher than minting/redemption fees and to avoid having a large number of very small redemption tickets, all minting and redemptions must be in a whole number of lots. Lots will be defined by governance and will be quite large, e.g. the equivalent of 1000 USD or more. (*Note that examples in this document are usually NOT using lots*.)

The lot size can be updated over time to reflect price fluctuations of the underlying asset. It can only be modified by a governance call and only by a limited amount in one day.
