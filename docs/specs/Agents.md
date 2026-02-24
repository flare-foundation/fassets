# Agents

Agents are the main actors in the FAsset system. An agent is an off-chain entity (likely a bot) who performs redemption payments, makes sure there is enough collateral in the vault and collects the fees. On the Flare/Songbird chain, the agent has the “agent vault owner” address.

But minters and redeemers never interact with external agents directly. Instead, they interact with the agent vault contract. An external agent can own multiple agent vaults, but from the point of view of minters, redeemers and collateral providers, these vaults are completely independent and they only interact with a single one.

## Agent vault

**Agent vault** contract on the Flare/Songbird chain is an instance of `AgentVault`. The agent vault contract holds the agent’s **vault collateral** and makes sure that it can only be withdrawn when it’s not backing any FAssets. The agent can choose an ERC20 token for vault collateral from several tokens defined by governance - typically these would be stablecoins USDC and USDT, but we may also allow other popular tokens e.g. WETH. There is only one collateral token type in each vault, but different vaults can use different tokens for collateral.

## Agent vault owner

Each agent vault has an **owner**, which is an external account that can manipulate the agent vault settings, confirm redemption payments, withdraw funds etc. The same owner can have several agent vaults and can create a new agent vault at any time (e.g. to use different collateral tokens). Owner has a management and a work address - the **work address** is expected to be used by a server bot to automatically execute operations like paying for redemptions, while the **management address** should only be used when the owner wants to change the work address (the management address can never change and will typically be a multisig). The reason for this is that the hot wallet private key must reside on the agent bot server and is therefore more vulnerable to theft, so the agent is advised to regularly change the private key and the corresponding work address.

## Agent owner registry

Although the FAsset system is designed in such a way that the agents don’t need to be trusted, we will (at least for a while) expect the agent owners to be known and verified parties. For this reason, the FAsset contract maintains a list of allowed agent owner management addresses, named the **agent owner registry**. The agent can be added to or removed from the registry by the governance. The agent’s management address must be in the registry for the agent to be able to create a new agent vault and to mint; it is not necessary for redeeming, since we want the FAsset holders to be able to redeem even if the agents are removed from the whitelist.

The agent owner registry also contains the agent’s **name**, **description**, **icon url** and (optionally) **terms of use url**. These are set by the governance when the agent is added and can be changed later by the governance.

Optionally, the governance can set a **manager** (typically a smaller multisig) to be able to manage the agent owner registry (adding and removing agents). If it is not set, only the governance can do it.

## Always-allowed minters

An agent that is not on the publicly available agents list (or has left it) can still allow specific addresses to mint against their vault. This is done through the **always-allowed minters** mechanism. The agent owner can add or remove addresses from their always-allowed minters list. Addresses on this list can mint against the agent’s vault even if the agent is not publicly available. This allows the agent to operate a private vault with select counterparties.

## Agent’s underlying address

Each agent vault is associated with a single, unique address on the underlying chain (the **agent’s underlying address**), which may not be used for anything other than minting and redeeming.

Warning: The agent’s underlying address must be a new address, otherwise the transactions before the agent was created may trigger a challenge.

## Collateral pool

Each agent vault has an associated unique collateral pool contract (instance of `CollateralPool`). Collateral pool holds only native token (FLR or SGB) collateral (called “**pool collateral**”). The pool collateral is used as an additional source of collateral for liquidations and failed redemptions at the times of rapid price fluctuations.

Anybody can add collateral to the pool and obtain **collateral pool tokens** in return. The collateral pool tokens can later be redeemed for the native collateral and a share of minting fees.

More details are in the collateral pool section below.

## List of publicly available agents

When an agent is first created, it can only mint for itself. To allow minting by any user, the agent must be added to the **publicly available agents list**. The agent can join this list at any time. It can also leave the list, but doing so is subject to a time-lock (explained in the Closing an agent vault section below).

## Creating an agent

The steps involved in creating a new agent vault are as follows:

1) The agent (external) must ask the FAsset governance for their management address to be added to the agent owner registry in order to be allowed in the asset managers. The agent’s name, description, icon url and (optionally) terms of use url have to be provided with the request.
2) The agent associates a work address with their management address.

Now the agent owner can create one or more agent vaults with the following procedure:

3) Execute “create agent vault” operation and provide the initial agent settings (see the section “Agent settings” for details on these). This also creates the collateral pool.
4) The agent deposits vault collateral to their vault (the currency of the vault collateral was provided as one of the settings in the previous step).
5) The agent must also buy some collateral pool tokens. Agents need enough collateral pool tokens to perform minting (system defined percentage of minted amount).
   *Warning:* the agent’s collateral pool tokens cannot be bought directly from the collateral pool as for other collateral providers - they must be bought through a method on agent vault. This is because the owner of the agent’s collateral pool tokens must be the agent’s vault, not the agent owner. See section “Agent’s stake in collateral pool” for details.
6) The agent can announce the existence of the collateral pool (off chain, e.g. in social media), to attract potential participants in the collateral pool.
7) At this point the agent can only self-mint against the new agent vault. To become available for minting by others, they can join the publicly available agents list.

## Closing an agent vault

Because it affects all of the collateral providers, closing an agent vault is a rather lengthy procedure, which requires several announcements and some waiting. The agent owner has to do the following:

1) Exit the available agents list (requires prior announcement). This stops other users minting against that agent, allowing the agent to eventually redeem or self-close all the backed FAssets.
2) Withdraw FAsset fees belonging to agent vault collateral pool tokens (see section “Agent’s stake in collateral pool” for details). This is not strictly necessary, since these fees will be automatically withdrawn in step (5), but can help with self-closing in the next step.
3) Wait for the agent backed FAssets to be redeemed and self-close the rest. Optionally, instead of waiting for redemptions, the agent can self-close their entire position, if they can obtain enough FAssets. However self-closing some amount is always necessary since there will always be some amount of non-redeemable dust (less than 1 lot).
4) Withdraw all the vault collateral, with prior announcement.
5) Redeem the agent vault pool tokens, with prior announcement. This can be done in parallel with step (4).
6) Withdraw the underlying assets, with prior announcement. (Announcement here is still formally needed, though it is irrelevant, since the underlying assets aren’t backing anything any more. To make the underlying address totally free, the vault has to be destroyed, but this requires the following two steps.)

At this point the agent has pulled out all the funds belonging to them. If they want to completely clean up after themselves, they need to perform two more things:

7) Wait for all the remaining collateral providers to redeem their collateral pool tokens (exit from the pool). Note that at this point, self-close exit is not possible anymore, but it is not an issue, since the ordinary exit will always work when there are no backed FAssets (see section “Exiting collateral pool” for explanation).
8) Execute “destroy agent”. This deletes agent vault and collateral pool contracts and all agent related data.

## Agent ping (liveness check)

The FAsset system provides a simple mechanism to check whether an agent bot is live and responsive. Anyone can call `agentPing` for an agent vault with a query value, which emits an `AgentPing` event (however, to avoid DOS-ing agents, the agent bot is advised to only respond to pings from known addresses). The agent's bot is expected to observe these events and respond by calling `agentPingResponse`, which emits an `AgentPingResponse` event. The `agentPingResponse` call can provide some data about the agent bot in the `response` field (e.g. make and version of the agent bot software). This mechanism is purely event-based and has no on-chain state effects - it simply allows monitoring whether an agent's bot infrastructure is operational.
