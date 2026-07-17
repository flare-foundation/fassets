# Agents
Agents are the main actors in the FAsset system.
An agent is an off-chain entity (often a bot) who performs redemption payments, adds collateral to the system, and collects fees.
Agents are identified by their *Agent Vault* contract on Flare.

## Agent Vaults
Minters and redeemers do not interact with agents directly.
Instead, they interact with the agent vault through the Asset Manager contract.
An agent vault contract on the Flare (or Songbird) chain is an agent-specific instance of `AgentVault`.
The vault stores information about agent settings and holds the agent's [collateral](Collateral.md).
An external agent can own multiple agent vaults, but these vaults operate independently.
Users e.g. [minters](Minting.md), [redeemers](Redemption.md), and [collateral providers](CollateralPool.md) interact with only a single vault at a time.

### Creation
To create a new agent vault for an FAsset originating from source chain $C$, the agent $A$ must take the following steps:
1. Submit an off-chain request to FAsset governance to add the agent's management address to the `AgentOwnerRegistry` [whitelist](#agent-owner-registry), including the agent's name, description, icon URL, and terms of use URL
2. Associate a work address with the now registered management address.
3. Create an account $A_C$ on source chain $C$.
4. Submit an FDC attestation on Flare for the validity of $A_C$, returning `addressProof`, proof of the correctness of the address.
5. Call `createAgentVault(_addressProof, _settings)` on the Asset Manager contract for the asset, including as arguments the address proof and initial [settings](#agent-settings).
6. Deposit initial vault collateral into the Agent Vault, in the currency determined by the initial settings.
7. Buy [collateral pool tokens](CollateralPool.md) at the Agent Vault using `buyCollateralPoolTokens`. The agent is not able to mint until its [CR](Collateral.md#Collateral-ratio) is high enough.
8. (optional) Call `makeAgentAvailable` on the Asset Manager with the agent vault address to join the list of [publicly available agents](#publicly-available-agents). This step does not need to be completed if the agent only wishes to self-mint.

The address $A_C$ is referred to as the agent's *underlying address*, and is unique and immutably tied to the instance of Agent Vault.
This address must be freshly created, and can only be used for FAsset transactions.

## Vault Collateral
The agent vault contract holds the agent’s *vault collateral* and ensures that it can only be withdrawn when it’s not backing any FAssets.
The vault collateral takes the form of a single ERC20 token from a list of tokens defined by governance.
Typically these would be stablecoins USDC and USDT, but may include other popular tokens such as WETH.

The choice of ERC20 token used for the collateral is set by the agent on creation of the vault.
Different vaults owned by the same agent may use a different token from the list of accepted tokens.

### Deposits and Withdrawal
The agent can deposit collateral using its agent owner address (see below) via the `AgentVault` contract.
To do so, the agent calls the `depositCollateral` function at the `AgentVault`.
This function take as argument (`token`, `amount`), the type and amount of tokens to be deposited.

Similarly, the Agent Vault contract hosts a `withdrawCollateral` function for withdrawing.
This function takes three inputs: (`token`, `amount`, `recipient`).
The third argument, `recipient`, is the receiving address of the withdrawal, which does not need to match the owner address.

## Agent Vault Owner
Each agent vault has an *agent owner address*, an account that controls the vault.
This address is responsible for managing the agent vault settings, confirming redemption payments, and withdrawing funds.
The same owner (address) can manage several agent vaults and create a new agent vault at any time.

The vault owner has a management and a work address.
The *work address* executes operations like paying for redemptions, while the *management address* is fixed and sets the work address.
The management address is set on creation of the agent, and the address must be on the whitelist of allowed agent owners .

## Agent Settings
Each agent's Agent Vault contract stores information about the agent's settings.
To retrieve these settings, users can query the `AssetManager` contract.
There are several functions that return information about the agent.
The function `getAgentInfo` takes as input the agent vault address and returns `AgentInfo` structure with detailed information about the agent.
As well as other fields, this includes key settings that a user wishing to mint with the agent may want:

- `feeBIPS`: The minting fee charged by the agent, in BIPS.
- `minting(Vault/Pool)CollateralRatioBIPS`: The minimal CR set by the agent, below which minting is not possible, in BIPS.
- `freeCollateralLots`: The amount of free collateral owned by the agent, in lots.

Secondly, there exist methods that return specific fields from the `AgentInfo` structure individually:

- `getCollateralPool`: Returns the address of the agent collateral pool.
- `getAgentVaultOwner`: Returns the address of the agent vault owner.
- `getAgentVaultCollateralToken`: Returns the ERC20 token type chosen by the agent for collateral.
- `getAgentFullVaultCollateral`: Returns the amount of collateral (free and locked) deposited in the agent vault.
- `getAgentFullPoolCollateral` Returns the amount of collateral (free and locked) stored in the agent pool.
- `getAgentLiquidationFactorsAndMaxAmount`: Returns the agent's vault and pool liquidation factors (BIPS) and the maximum liquidation amount (UBA).
- `getAgentMinPoolCollateralRatioBIPS`: Returns the minimum CR for the agent pool, in BIPS.
- `getAgentMinVaultCollateralRatioBIPS`: Returns the minimum CR for the agent vault, in BIPS.

Finally, individual settings can be queried using the `getAgentSetting` function, which takes as input the address of the Agent Vault contract and a setting, returning the value of that setting for that agent.
Possible settings include:

- `feeBIPS`: The minting fee charged by the agent.
- `poolFeeShareBIPS`: The share of the minting fees received by the agent pool.
- `redemptionPoolFeeShareBIPS`: The share of the redemption fees received by the agent pool.
- `mintingVaultCollateralRatioBIPS`: The vault minting CR.
- `mintingPoolCollateralRatioBIPS`: The pool minting CR.
- `buyFAssetByAgentFactorBIPS`: The factor by which the price the agent buys FAssets from collateral providers on self-close is multiplied by.
- `poolExitCollateralRatioBIPS`: The pool exit CR.

Note that these lists are not exhaustive, with the `AgentInfo` field containing a large number of other fields.

### Modifying Agent Settings
Initial settings are defined as part of the `createAgentVault` call.
Updating settings can only be done by the agent vault owner address, in a two stage process:

- The agent calls `announceAgentSettingUpdate(_agentVault, _name, _value)` at the Asset Manager contract, announcing the intention to change the setting identified by `name` to the given `value` on their agent vault. This returns a timestamp `updateAllowedAt`defining when the agent may execute the change.
- After time `updateAllowedAt`, the agent calls `executeAgentSettingUpdate(_agentVault, _name)` at the asset manager contract, changing the named setting to the value given in the previous call.

## Agent Owner Registry
The FAsset system is designed in such a way that the agents don’t need to be trusted.
Nonetheless, agent owners are expected to be known and verified parties.
The FAsset contract maintains a whitelist of allowed agent owner management addresses, named the *agent owner registry*.
Agents can be added to or removed from the registry by governance.

An agent’s management address must be in the registry for the agent to be able to create a new agent vault and to mint.
However, this is not necessary for redeeming, so that FAsset holders are able to redeem even if agents are removed from the whitelist.

An entry for an agent owner in the Agent Owner Registry is managed by governance and contains the following information for an Agent Management Address:
- Agent work address
- Agent description
- Agent icon URL
- (Optional) Terms of Use URL.

Optionally, the governance can set a *manager* (typically a smaller multisig) to be able to manage the agent owner registry (adding and removing agents).
If it is not set, only governance can control the registry.

### List of Publicly Available Agents
When an agent is first created, it can only mint for itself.
To allow minting by any user, the agent must be added to the *publicly available agents list*.
The agent can join this list at any time by calling `makeAgentAvailable` on the Asset Manager contract, listing as input the Agent Vault address.
This requires the agent owner to be registered on the `AgentOwnerRegistry` contract.
Agents can leave the list, as explained in more detail below.

### Collateral Pool
Each agent vault has an associated unique *collateral pool* and collateral pool contract.
Collateral pools hold additional collateral in the form of native tokens, referred to as *pool collateral*.
Any user can contribute collateral to an agent's pool in return for a share of the agent's rewards.
More information about collateral pools can be found [here](CollateralPool.md).

### Always-allowed Minters
The FAsset system enables agents to operate a private vault for select users.
This is done through the *always-allowed minters* mechanism.
Addresses on an agent's always-allowed minters list can mint against the agent’s vault even if the agent is not publicly available.

The agent owner can add or remove addresses from their always-allowed minters list using `addAlwaysAllowedMinterForAgent` and `removeAlwaysAllowedMinterForAgent` functions at the Asset Manager contract.
Both functions take as input the address of the `agentVault` and the address of the minter.
A list of always allowed minter can be requested from the same contract using `alwaysAllowedMintersForAgent` function.

## Closing an Agent Vault
Closing an agent vault is an involved process including several wait periods.
This ensures that contributors to the agent's collateral pool can exit in response to a planned closure.
The process for an agent owner to close its vault is described below; all announcements are performed at the Asset Manager contract and require the Agent Vault address as input, with token operations then performed at the relevant `AgentVault` contract.

1. The agent announces an exit from the available agents list by calling `announceExitAvailableAgentList`. This call returns a timestamp $\text{exitAllowedAt}$, that returns the time at which the agent can exit. At time `exitAllowedAt`, the agent leaves the available agents list by calling `exitAvailableAgentList`. Users can no longer mint against the agent.
2. Withdraw all FAsset fees belonging to the agent vault collateral pool tokens.
3. Redeem all remaining agent backed FAssets. The agent can either wait until the assets are redeemed by users or self-close their entire position manually by obtaining enough FAssets. Some amount of self-closing is usually necessary to remove remaining FAsset [dust](Minting.md#lots-and-dust).
4. Announce a withdrawal of all remaining vault collateral by calling `announceVaultCollateralWithdrawal`, including as input the value of remaining assets to withdraw. This returns a time stamp $\text{withdrawalAllowedAt}$ after which the agent can complete the withdrawal by calling `withdrawCollateral` for the stated amount.
5. Announce and then redeem the remaining agent vault pool tokens. Again, this requires an announcement `announceAgentPoolTokenRedemption` including the amount to be redeemed, which returns a timestamp $\text{redemptionAllowedAt}$ after which the redemption is available for the stated amount. This step can be done in parallel with step 4.
6. Announce and then withdraw its underlying assets on the source chain. The announcement uses the `announceUnderlyingWithdrawal` function. The agent is then eligible to withdraw assets on the source chain; once completed, they call `confirmUnderlyingWithdrawal` on the Asset Manager contract, including an FDC proof of the transaction, to confirm the withdrawl.
7. Wait for all remaining holders of the agent's collateral pool tokens to redeem the tokens and exit the pool.
8. Announce and execute the `destroyAgent` command. The announcement `announceDestroyAgent` returns a timestamp `destroyAllowedAt` after which the agent can be destroyed at the Asset Manager contract. This makes agent vault and pool unusable. However, the agent can still withdraw any remaining collateral from the vault.

## Agent Liveness Check
Any Flare user may check liveness of an FAsset agent.
To do so, they call `agentPing`$(\text{agentVault}, \text{query})$ at the Asset Manager contract, which emits an `AgentPing` event.
The agent's bot responds by calling `agentPingResponse`$(\text{agentVault}, \text{query}, \text{response})$), which emits an `AgentPingResponse` event.
The `response` field is a string that provides information about the agent bot; its text structure is defined off-chain.
To prevent DOS-style attacks, agents may opt to only respond to pings from known addresses.

## Underlying Balance Management

### Underlying Top-Ups
An agent can increase its free underlying balance by transferring funds to its registered underlying address using the top-up payment reference derived from the Agent Vault address.
After the payment is finalized, the agent obtains an FDC payment proof and calls `confirmTopupPayment(payment, agentVault)` on the Asset Manager contract.
The Asset Manager verifies the destination and payment reference and adds the received amount to the agent's free underlying balance.
These funds can then be used for operations such as minting from free underlying or to pay underlying transaction fees.

### Underlying Withdrawal
Part of the funds on the underlying address may be withdrawn by the agent.
Such funds can be withdrawn only if the underlying assets are freed up due to actions on Flare.
These actions include receiving minting fees, failed redemptions paid in collateral, liquidated agent assets, and self-closed agent assets

When withdrawal is permitted, it must be announced on the Asset Manager contract by the agent, calling `announceUnderlyingWithdrawal`.
Completed withdrawals must be confirmed on-chain in a two-step process: an FDC proof $\text{payment}$ of the withdrawal transaction is obtained, then used as calldata in the function `confirmUnderlyingWithdrawal` at the Asset Manager contract.
Alternatively a withdrawal can be cancelled at the Asset Manager contract using the `cancelUnderlyingWithdrawal` function.
All functions at the Asset Manager contract take as input the address of the Agent Vault.

If the agent doesn't present the confirmation of withdrawal correctly, anybody can do so after an amount of time determined by `confirmationByOthersAfterSeconds` has passed and receive a reward from the agent's vault.