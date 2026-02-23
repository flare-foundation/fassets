# Collateral

Each asset minted to an agent is secured by two kinds of collateral: the agent vault holds ERC20 tokens (stablecoins, wrapped ETH, etc.), called **vault collateral**; and the agent’s collateral pool holds native tokens (FLR / SGB), referred to as **pool collateral**. The purpose of the collateral is to compensate the redeemer in case the agent doesn’t pay for the redeemed FAssets on the underlying chain (see the section “Redemption failure” for details).

## Collateral types

### Vault collateral types

The FAsset governance defines several collateral types that can be used as vault collateral by agents. The types will include the most popular stablecoins (USDC, USDT) and some other highly liquid tokens that exist on the Flare/Songbird chain (e.g. wrapped ETH). Each collateral type is a structure that contains the address of an ERC20 token along with some collateral ratio settings (minimal CR, safety CR) and information needed for obtaining asset/collateral price from the FTSO system (FTSO symbols for asset and collateral price). See the “Collateral type settings” section for the details.

The governance can add new collateral types later or deprecate an existing collateral type. Deprecation means that all agents using this collateral type as vault collateral must switch to some other type before the given deadline, otherwise their collateral is no longer considered valid for securing FAssets (which means they will be liquidated).

An agent must choose one of the collateral types defined in the system and use it as the collateral in the agent vault. The agent can change the chosen vault collateral type, but only if the currently used type has been deprecated.

### Pool collateral type

There is a single collateral type, also defined by governance, which is used to store settings for collateral pool FLR/SGB collateral. The ERC20 contract for this collateral is always `WNat`.

However, it is possible (although not likely) that the WNat contract on the Flare/Songbird chain gets replaced. In this case, the pool collateral type is not updated automatically. Instead, FAsset governance must explicitly set the pool collateral type (possibly with new settings), which will be used for new agents’ collateral pools.

But this isn’t all: every pool’s collateral is stored in the current WNat contract and its balance cannot be transferred globally. Therefore every agent must call the “upgrade pool WNat contract” method, which transfers the pool balance to the new contract and enables the pool to use the new WNat contract.

## Collateral ratio (CR)

**Collateral ratio** (usually shortened to **CR**) is the ratio between the value of a collateral and the total value of agent backed FAssets, based on the current price reported by the FTSO system. There are two collateral ratios for each agent, one for the agent’s vault collateral (**vault CR**) and one for the pool FLR/SGB collateral (**pool CR**).

### Collateral ratio settings

**Minimal CR** (system setting): To make sure there is always enough collateral available for insuring the minted FAsset and compensating for redemption payment failures, the agent and the pool are expected to keep the collateral ratio above some system-defined **minimal CR**. Minimal CR will be different for the agent’s vault collateral (somewhere between 1.2-2.0; can vary between different collateral currencies) and the pool collateral (at least 2.0). In this way the total CR should always be above 3 (more likely above 3.5), which should keep the system adequately collateralized in case of rapid price changes.

**Safety CR** (system setting): If one of the collaterals falls below minimal CR, the agent gets liquidated. Once the offending collateral reaches healthy CR, the liquidation stops. But to prevent the agent going immediately back into liquidation after a minor price change, it is required that CR reaches **safety CR**, which is a bit higher than the minimal CR. Again, there are separate safety CRs for both types of the collateral.

**Minimum agent pool tokens to mint** (system setting): The minimum amount of pool tokens the agent must hold to be able to mint: the NAT value of all backed FAssets together with new ones times this percentage must be smaller than the agent's pool tokens' amount converted to NAT.

**Minting CR** (agent setting): For every minting by an agent, the maximum allowed mint amount is calculated in such a way that both vault CR and pool CR of the agent after the minting remain higher than the respective **minting CR**. Therefore, keeping minting CR well above minimal CR reduces the agent’s risk of liquidation, since it ensures there is always some space for price changes before the CR falls below minimal CR. Minting CR is set by the agent (separately for vault and pool collateral) and must be higher than the respective minimal CR.

**Exit CR** (agent setting): When a collateral provider redeems tokens, the redemption amount is limited in such a way that the pool CR afterwards is higher than the **exit CR** (if pool CR is already below the exit CR, the redemption is not possible; see section “Exiting collateral pool” for details). Exit CR is set by the agent and unlike the other CR settings, it is only for the pool.

### Collateral ratio - numeric example

<table>
<tr><td>Minimal vault CR: 1.5</td><td>Minimal pool CR: 2</td></tr>
<tr><td>Safety vault CR: 1.75</td><td>Safety pool CR: 2.1</td></tr>
<tr><td colspan=2>Minimum agent pool tokens to mint: 0.5</td></tr>
</table>

Agent deposited in their vault 600 USDC. Pool contains 2000 SGB worth $1000, of which the agent deposited 400 SGB.

Agent is minted against 100 XRP worth $50.

The agent’s vault CR is now $600/$50 = 12 and the pool CR is $1000/$50 = 20.

These CR values are only true with the above prices, it means that each price movement will change the agent’s and pool CR.

**What is the maximal amount of  fXRP that can be minted against this agent?**

Minting vault CR is 2, so vault collateral can back $600/2 = $300 = 600 XRP

Minting pool CR is 4, so pool collateral can back $1000/4 = $250 = 500 XRP

Agent’s pool tokens are equal to agent’s stake in the pool, which is 400 SGB = $200, and the ratio needed is 0.5, so the maximum minting according to this is $200/0.5 = $400 = 800 XRP.

The agent can mint the *minimum* of these three values: min(600, 500, 800) = 500 XRP.

**At what XRP price will the agent's position become unhealthy?**

The agent can back up to $600/1.5 = $400 with vault collateral and $1000/2 = $500 with pool collateral. So if 1 XRP is worth more $400/100 = $4, 100 fXRP will be worth more than $400 and the agent's position will become unhealthy. We assume here that the native currency (SGB, FLR) price in USD remains unchanged.

Note that agent’s pool tokens are irrelevant for the agent’s position becoming unhealthy.

**Once the agent's position becomes unhealthy, for which XRP price will it be considered healthy again?**

Since, in the example above, it was vault CR that was unhealthy, the agent has to reach the safety CR for vault collateral.

Vault safety CR is 1.75, which means that the USD value of minted fXRP must fall to $600/1.75 = ~ $342. This means that the XRP price must drop below $3.42.

**Note that an unhealthy position should normally be fixed by one of the following:**

* The Agent sends in more collateral to their vault or someone buys more pool tokens (by depositing FLR/SGB to the collateral pool).
* The Agent self-closes part of their position.
* The Agent’s position is (partially) liquidated.

### Where do we obtain the prices for calculating the CR?

Native currency, vault collateral currency, and asset price are obtained from the FTSO system. There are two ways the prices can be obtained, and the way they are obtained is defined in the collateral type settings:

* For most popular stablecoin collaterals (e.g. USDC and USDT) the FTSO may have a direct price pair asset/stablecoin. In this case, this price is used directly.
* For other collateral types (e.g. FLR or WETH), the FTSO will have two price pairs, based on the same reference currency - typically asset/USD and collateral/USD. The price used will be the quotient of these two prices.

#### FTSO and trusted prices

For detecting whether the agent is in liquidation, we actually use two prices (or pairs of prices) from FTSO: one from all price providers and one from only the trusted price providers. Then we calculate the two collateral ratios and use the one that is higher. This is a precaution against FTSO providers conspiring to push agents into the liquidation.
