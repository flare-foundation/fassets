# API reference

## Concepts

#### Asset manager

Asset manager is the main contract in the FAsset system (instance of the `AssetManager` smart contract). For each supported asset type (XRP) there will be one asset manager. Most of the interaction with the FAsset is done through asset manager (minting, redemption, creating and managing agents, etc.).

To each asset manager corresponds an instance of `FAsset` smart contract, which is an ERC20 token that represents the wrapped assets (**FAssets**).

#### Asset manager controller

Asset manager has several settings which can be updated by the governance. However, the update methods cannot be called directly. Instead there is a single asset manager controller contract (instance of `AssetManagerController`), which holds a list of all the asset managers and accepts governance calls for setting updates. It allows batch updates to several asset managers in a single transaction.

An asset manager must be added to an asset manager controller, otherwise all of its methods (creating agents, minting, etc.) are disabled.

#### Agent vault

The contract that holds the agent’s vault collateral; the address of the agent vault identifies the agent in all contract calls. Instance of `AgentVault` smart contract.

#### Agent owner

Agent owner is an external entity, the creator and owner of the agent vault. Manipulation of the agent state (destroy, withdraw, make available etc.) is restricted to the owner.

Agent owner has two addresses on the Flare/Songbird chain: **work address** and **management address**. Work address is expected to perform all automated operations (redemptions, agent vault creation, all operations that require announcement). Management address is mostly used to replace the work address (even though it can in principle also perform all other agent owner operations).

#### Collateral pool

Collateral pool is a contract (instance of `CollateralPool` smart contract), associated to each agent vault, that contains FLR/SGB collateral.  Unlike agent vault, users other than the agent can add FLR/SGB to the collateral pool and get collateral pool tokens as proof of the share in the pool.

#### Collateral pool token

Associated to every collateral pool is a collateral pool token contract (instance of `CollateralPoolToken` smart contract). This is an ERC20 token which proves the collateral provider’s share in the collateral pool. By redeeming collateral pool tokens, the collateral provider obtains back their FLR/SGB share of the collateral and a share of minting fees (in FAssets).

#### Collateral type

Collateral type is a structure that contains an ERC20 token address and information about collateral ratio settings and FTSO symbols for the token. Section “Collateral type settings” below documents all the fields.

#### Asset minting granularity

As a storage optimization, to keep certain values in 64 bit, all underlying amounts (minted value per agent, redemption ticket value etc.) are nominated in the unit **AMG** (**asset minting granularity**). For most non-smart contract chains 1 AMG will be equal to 1 **UBA** (**underlying base amount**, i.e. the smallest unit on the underlying chain). But when 1 UBA is very small, 1 AMG can be bigger - e.g. on Ethereum 1 UBA = 1 wei = 10-18 eth, so we use 1 AMG = 109 wei.

The value of AMG will always be set in such a way that the maximum supply in AMG of this currency can fit into 64 bit, at least for the foreseeable future (e.g. 100 years).

#### BIPS

Many settings and method parameters are in **BIPS**, which means “**basic points**”, i.e. 1/10000 (or 1/100 of a percent). In this way, fractional values can be expressed as integers with good enough precision.

#### Timelock

Certain setting changes can have a devastating impact on the FAsset system. In the unlikely event of the governance takeover by malicious actors, we want to give the FAsset system users time to pull out before the dangerous settings take effect. For this reason all the potentially dangerous settings are **timelocked**, which means that they have to be announced first and executed after a while (e.g. a day later).

Similarly, some setting changes by the agent can have bad effects on the collateral providers, therefore they also need to be timelocked. This timelock may be different then the system timelock.

#### Rate limiting

Some setting changes are less dangerous than the timelocked ones, so the system allows immediate changes. But the rate of change is limited and the change can only be performed once per day. The rate limit typically depends on each setting.

## Settings

### Asset manager settings

Some asset manager settings are immutable, and the others can be changed by the address updater or by the governance through asset manager controller, but with various restrictions. No setting is publicly changeable. For each setting there is an indicator in which way it can be changed:

* *[changeable by address updater]* - May change via address updater (the Flare/Songbird system contract that holds all the other system contract addresses).
* *[rate-limited]* -  Can be changed by governance through asset manager controller with rate limiting.
* *[timelocked]* - Can be changed by governance through asset manager controller with timelock.
* *[immutable]* - Can only be set at deploy and cannot change.

#### The full list of all asset manager settings:

**FAsset** *[immutable]* - the address of the FAsset ERC20 token contract managed by this asset manager (instance of `FAsset`).

**assetManagerController** *[changeable by address updater]* - address of the asset manager controller contract (instance of `AssetManagerController`), which is the contract that can change settings of the asset manager.

**priceReader** *[timelocked]* - the contract that reads prices from the FTSO system in an FTSO version independent way.

**agentVaultFactory** *[timelocked]* - factory contract for creating new agent vaults (instance of `IAgentVaultFactory`).

**collateralPoolFactory** *[timelocked]* - factory for creating new agent collateral pools (instance of `ICollateralPoolFactory`).

**collateralPoolTokenFactory** *[timelocked]* - factory for creating new collateral pool tokens (instance of `ICollateralPoolTokenFactory`).

**agentOwnerRegistry** *[timelocked]* - the contract (instance of `IAgentOwnerRegistry`) that contains a list of allowed agent owner's management addresses and mappings from management to work address.

**scProofVerifier** *[timelocked]* - a contract (instance of `ISCProofVerifier`) that verifies and decodes Flare data connector proofs.

**underlyingAddressValidator** *[timelocked]* - validator contract (instance of `IAddressValidator`) for addresses on the underlying chain. Typically, each chain has different rules, so every asset manager will have a different instance of address validator. See section “Address validation” for explanation.

**liquidationStrategy** *[timelocked]* - external (dynamically loaded) library for calculation of liquidation factors (instance of `ILiquidationStrategy`, as library).

**chainId** *[immutable]* - identifier of the underlying chain in the Flare data connector system.

**poolTokenSuffix** *[immutable]* - The suffix to pool token name and symbol that identifies a new vault's collateral pool token. When a vault is created, the owner passes their own suffix which will be appended to this.

**burnAddress** *[immutable]* - the address where burned FLR/SGB is sent.

**assetDecimals** *[immutable]* - same as `assetToken.decimals()`.

**assetMintingDecimals** *[immutable]* - number of decimals of precision of minted amounts. May be less than the asset decimals, if the asset has too many decimals.

**assetUnitUBA** *[immutable]* - how many of the smallest asset amounts (UBA) is in one asset unit value.
Always equal to `10 ** assetToken.decimals()`.
E.g. `1 BTC = 10 ** 8 UBA`.

**assetMintingGranularityUBA** *[immutable]* - the granularity in which lots are measured = the value of AMG (asset minting granularity) in UBA.
Always equal to `10 ** (assetDecimals - assetMintingDecimals)`.
AMG is used internally instead of UBA so that minted quantities fit into 64 bits to reduce storage. So assetMintingGranularityUBA should be set so that the max supply in AMG of this currency in foreseeable time (say 100yr) cannot overflow 64 bits.

**lotSizeAMG** *[timelocked]* - lot size in asset minting granularity. May change, which affects subsequent mintings and redemptions.

**mintingCapAMG** *[rate-limited]* - maximum minted amount of the FAsset. When set to 0, there is no limit. The minting cap is the mechanism that will be enabled initially to limit the possible losses during the beta phase. Later it will be removed or set to a very high value.

**minUnderlyingBackingBIPS** *[timelocked]* - the percentage of backed FAssets that the agent must hold in their underlying address.

**mintingPoolHoldingsRequiredBIPS** *[rate-limited]* - The minimum amount of pool tokens the agent must hold to be able to mint: the NAT value of all backed FAssets together with new ones times this percentage must be smaller than the agent's pool tokens' amount converted to NAT.

**collateralReservationFeeBIPS** *[rate-limited]* - Collateral reservation fee percentage that must be paid by the minter. Payment is in NAT and is proportional to the value of assets to be minted.

**underlyingBlocksForPayment** *[timelocked]* - number of underlying blocks that the minter or agent is allowed to pay underlying value. If payment is not reported in that time, minting/redemption can be challenged and default action triggered. CAREFUL: Count starts from the current proved block height, so the minters and agents should make sure that current block height is fresh, otherwise they might not have enough time for payment.

**underlyingSecondsForPayment** *[timelocked]* - minimum time to allow agent to pay for redemption or minter to pay for minting. This is useful for fast chains, when there can be more than one block per second. Redemption/minting payment failure can be called only after underlyingSecondsForPayment have elapsed on the underlying chain. CAREFUL: Count starts from the current proved block timestamp, so the minters and agents should make sure that current block timestamp is fresh, otherwise they might not have enough time for payment. This is partially mitigated by adding local duration since the last block height update to the current underlying block timestamp.

**maxRedeemedTickets** *[rate-limited]* - to prevent unbounded work, the number of tickets redeemed in a single request is limited to this value. Must be at least 1.

**redemptionFeeBIPS** *[rate-limited]* - redemption fee percentage.

**redemptionDefaultFactorAgentC1BIPS** *[rate-limited]* - on redemption underlying payment failure, redeemer is compensated with redemption value converted to collateral, times this redemption failure factor. Expressed in BIPS, e.g. 12000 for factor of 1.2. This is the part of the factor paid from the agent's vault collateral. It will always be at least 100% (=10000 BIPS).

**redemptionDefaultFactorPoolBIPS** *[rate-limited]* - on redemption underlying payment failure, redeemer is compensated with redemption value converted to collateral, times this redemption failure factor. Expressed in BIPS, e.g. 12000 for factor of 1.2. This is the part of the factor paid from pool FLR/SGB collateral.

**confirmationByOthersAfterSeconds** *[rate-limited]* - if the agent or redeemer becomes unresponsive, we still need payment or non-payment confirmations to be presented eventually to properly track the agent's underlying balance. Therefore we allow anybody to confirm payments/non-payments this many seconds after request was made.

**confirmationByOthersRewardUSD5** *[rate-limited]* - the user who makes abandoned redemption confirmations gets rewarded by the following amount, expressed in USD (with 5 decimals).

**paymentChallengeRewardBIPS** *[rate-limited]* - Challenge reward can be composed of two parts - fixed and proportional (any of them can be zero). This is the proportional part (in BIPS).

**paymentChallengeRewardUSD5** *[rate-limited]* - Challenge reward can be composed of two parts - fixed and proportional (any of them can be zero). This is the fixed part (in USD with 5 decimals).

**maxTrustedPriceAgeSeconds** *[rate-limited]* - maximum age that trusted price feed is valid. Otherwise (if there were no trusted votes for that long), ordinary FTSO price feed is used for calculating agent's collateral ratios (see "FTSO and trusted prices" section).

**attestationWindowSeconds** *[rate-limited]* - Maximum time for which it is possible to obtain payment or non-payment proofs from the Flare data connector.

**averageBlockTimeMS** *[rate-limited]* - Average time between two successive blocks on the underlying chain, in milliseconds.

**minUpdateRepeatTimeSeconds** *[timelocked]* - Minimum time after an update of a setting before the same setting can be updated again. This affects both timelocked and rate-limited settings.

**withdrawalWaitMinSeconds** *[rate-limited]* - Agent has to announce any collateral withdrawal or vault destroy and then wait for at least withdrawalWaitMinSeconds. This prevents challenged agents from removing all collateral before challenge can be proved.

**agentExitAvailableTimelockSeconds** *[rate-limited]* - Amount of seconds that have to pass between available list exit announcement and execution.

**agentFeeChangeTimelockSeconds** *[rate-limited]* - Amount of seconds that have to pass between agent fee and poo	l fee share change announcement and execution.

**agentMintingCRChangeTimelockSeconds** *[rate-limited]* - Amount of seconds that have to pass between agent-set minting collateral ratio (vault or pool) change announcement and execution.

**tokenInvalidationTimeMinSeconds** *[timelocked]* - Minimum time from the moment collateral type is deprecated by the governance to when it becomes invalid and the agents still using it as vault collateral get liquidated.

**vaultCollateralBuyForFlareFactorBIPS** *[timelocked]* - On some rare occasions (stuck minting, locked FAssets after termination), the agent has to unlock collateral. For this, part of collateral corresponding to FTSO asset value is burned and the rest is released. However, we cannot burn typical vault collateral (stablecoins), so the agent must buy them for NAT at FTSO price multiplied with this factor (should be a bit above 1) and then we burn the NATs. See section "Unsticking minting".

**buybackCollateralFactorBIPS** *[immutable]* - Ratio at which the agents can buy back their collateral when FAsset is terminated. Typically a bit more than 1 to incentivize agents to buy FAssets and self-close instead.

**liquidationStepSeconds** - The current implementation has time increasing payments. If there was no liquidator for the current liquidation offer, go to the next step of liquidation after this period of time.

**liquidationCollateralFactorBIPS** - Factor with which to multiply the asset price in native currency to obtain the payment to the liquidator. Expressed in BIPS, e.g. `[12000, 16000, 20000]` means that the liquidator will be paid 1.2, 1.6 and 2.0 times the market price of the liquidated assets after each `liquidationStepSeconds`. Values in the array must increase and be greater than 100%.

**liquidationFactorVaultCollateralBIPS** - How much of the liquidation is paid in vault collateral. The remainder will be paid in pool FLR/SGB collateral.

**diamondCutMinTimelockSeconds** - Since diamond cut is a very powerful (and therefore dangerous) operation, the implementation allows for a longer timelock than other governance operations. The timelock used for diamond cuts will be maximum of this value and the timelock in governance settings.

**maxEmergencyPauseDurationSeconds** - The maximum total pause that can be triggered by a non-governance (but governance allowed) caller. The duration count can be reset by the governance or it is reset automatically `emergencyPauseDurationResetAfterSeconds` after the last pause ends.

**emergencyPauseDurationResetAfterSeconds** - The amount of time since the last emergency pause after which the total pause duration counter will reset automatically.

**redemptionPaymentExtensionSeconds** - When there are many redemption requests to an agent in a short time, it may be impossible for the agent to keep up with redemption payments (since consecutive transactions from a single underlying address are much slower than redemption requests that can originate from many addresses). For this reason, each simultaneous request adds this amount of seconds to redemption payment time (cumulative). As time passes without new requests, the redemption payment time slowly diminishes again to the default value.

**cancelCollateralReservationAfterSeconds** - The amount of time after which the collateral reservation can be canceled by the minter if the handshake is not completed.

### Agent settings

There are several parameters that the agent must define at agent vault creation. All settings except `vaultCollateralToken` can be changed later, but the changes must first be announced and then the agent must wait some system-defined time (e.g. 1 day) before the actual change. This time-lock is in place to protect the collateral providers from potential negative effects of the setting changes.

**vaultCollateralToken** - Address of ERC20 token used as agent’s vault collateral. Must be selected from a system defined list (usually it will include USDC, USDT, WETH). Can only be changed if the used token is deprecated.

**poolTokenSuffix** - The suffix that is appended to the pool token name and symbol (after the global asset manager’s pool token suffix) that identifies a new vault's collateral pool token. Must be unique within an asset manager.

**feeBIPS** - Minting fee percentage. Normally charged to minters for publicly available agents, but must be set also for self-minting agents to pay part of it to the collateral pool. Fee is paid in underlying currency along with backing assets.

**poolFeeShareBIPS** - Share of the minting fee that goes to the pool as percentage of the minting fee. This share of fee is minted as FAssets and belongs to the pool.

**mintingVaultCollateralRatioBIPS** - Collateral ratio at which locked collateral and collateral available for minting are calculated (for vault collateral). The agent may set its own value for minting collateral ratio on creation. The value must always be greater than the system minimum collateral ratio for vault collateral.
*Warning: having this and the next value near global min collateral ratio can quickly lead to liquidation for public agents, so it is advisable to set it significantly higher.*

**mintingPoolCollateralRatioBIPS** - Collateral ratio at which locked collateral and collateral available for minting are calculated (for pool collateral). The agent may set its own value for minting collateral ratio on creation. The value must always be greater than the system minimum collateral ratio for pool collateral.

**buyFAssetByAgentFactorBIPS** - The factor set by the agent to multiply the price at which agent buys FAssets from collateral providers on self-close exit (when requested or the redeemed amount is less than 1 lot).

**poolExitCollateralRatioBIPS** - The minimum collateral ratio above which a staker can exit the pool  (this is CR that must be left after exit). The setting value must be higher than the system minimum collateral ratio for pool collateral.

### Collateral type settings

Most settings are immutable, except for the three collateral ratio settings, which can be changed by the governance (with timelock) and `validUntil`, which must be 0 when the collateral type is added, but is set to invalidation time (in future), when the collateral type is deprecated.

**collateralClass** - Can be `VAULT` or `POOL` and identifies whether this collateral type can be used as agent’s vault collateral or as pool FLR/SGB collateral. There will be several collateral types with class `VAULT`, but only one (non-deprecated) with class `POOL`. For changes on collateral type (changing collateral ratios, deprecating), the collateral type is identified by the pair (`collateralClass, token`).

**token** - The ERC20 token contract for this collateral type. For changes on collateral type (changing collateral ratios, deprecating), the collateral type is identified by the pair (`collateralClass, token`).

**decimals** - Same as `token.decimals()`, but since ERC20 standard doesn't guarantee the existence of `decimals()` method, it must be defined in the collateral settings.

**validUntil** - Collateral token invalidation time. When this is nonzero, this collateral type has been deprecated. When nonzero and `timestamp > validUntil`, the collateral is invalid and any agent still holding this collateral token will be liquidated. This value must be 0 when collateral type is added.

**directPricePair** - When `true`, the FTSO with symbol `assetFtsoSymbol` returns asset price relative to this token (such FTSO's will probably exist for major stablecoins). When `false`, the FTSOs with symbols assetFtsoSymbol and `tokenFtsoSymbol` give asset and token price relative to the same reference currency and the asset/token price is calculated as their ratio.

**assetFtsoSymbol** - FTSO symbol for the asset price. Depending on the `directPricePair` setting, it can be relative to this token or to the reference currency.

**tokenFtsoSymbol** - FTSO symbol for this token in reference currency. Used for asset/token price calculation when `directPricePair` is `false`. Otherwise it is irrelevant to asset/token price calculation, but if it is nonempty, it is still used in calculation of challenger and confirmation rewards (otherwise the system assumes it approximates the value of USD and pays directly the USD amount in vault collateral).

**minCollateralRatioBIPS** - Minimum collateral ratio for healthy agents.

**safetyMinCollateralRatioBIPS** - Minimum collateral ratio required to get an agent out of liquidation. Will always be greater than `minCollateralRatioBIPS`.

## Public methods and events

Public methods of the FAsset system are documented in interface files available on GitHub in directory [https://github.com/flare-labs-ltd/fassets/tree/main/contracts/userInterfaces](https://github.com/flare-labs-ltd/fassets/tree/main/contracts/userInterfaces).

In particular, the following important contracts are documented there:

### Asset manager

Public methods of asset manager contract are listed and documented in the file [https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/IAssetManager.sol](https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/IAssetManager.sol)

All asset manager events are documented in the file
[https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/IAssetManagerEvents.sol](https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/IAssetManagerEvents.sol)

Agent vault methods (only useful for agents) are documented in
[https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/IAgentVault.sol](https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/IAgentVault.sol)

### Collateral pool

Public collateral pool methods and events are documented in the file
[https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/ICollateralPool.sol](https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/ICollateralPool.sol)

And the collateral pool token methods are in
[https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/ICollateralPoolToken.sol](https://github.com/flare-labs-ltd/fassets/blob/main/contracts/userInterfaces/ICollateralPoolToken.sol)
