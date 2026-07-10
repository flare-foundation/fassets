# IAssetManager

Asset manager publicly callable methods.

## Methods

### assetManagerController

```solidity
function assetManagerController() external view returns (address)
```

Get the asset manager controller, the only address that can change settings. Asset manager must be attached to the asset manager controller in the system contract registry.

### fAsset

```solidity
function fAsset() external view returns (IERC20)
```

Get the f-asset contract managed by this asset manager instance.

### priceReader

```solidity
function priceReader() external view returns (address)
```

Get the price reader contract used by this asset manager instance.

### lotSize

```solidity
function lotSize() external view returns (uint256 _lotSizeUBA)
```

Return lot size in UBA (underlying base amount - smallest amount on underlying chain, e.g. satoshi).

### assetMintingGranularityUBA

```solidity
function assetMintingGranularityUBA() external view returns (uint256)
```

Return asset minting granularity - smallest unit of f-asset stored internally within this asset manager instance.

### assetMintingDecimals

```solidity
function assetMintingDecimals() external view returns (uint256)
```

Return asset minting decimals - the number of decimals of precision for minting.

### getSettings

```solidity
function getSettings() external view returns (AssetManagerSettings.Data)
```

Get complete current settings.

*Returns:*

- `AssetManagerSettings.Data` — the current settings

### controllerAttached

```solidity
function controllerAttached() external view returns (bool)
```

When `controllerAttached` is true, asset manager has been added to the asset manager controller. This is required for the asset manager to be operational (create agent and minting don't work otherwise).

### emergencyPaused

```solidity
function emergencyPaused() external view returns (bool)
```

If true, the system is in emergency pause mode and most operations (mint, redeem, liquidate) are disabled.

### emergencyPauseLevel

```solidity
function emergencyPauseLevel() external view returns (EmergencyPause.Level)
```

Emergency pause level defines which operations are paused: NONE - pause is not active, START_OPERATIONS - prevent starting mint, redeem, liquidation (start/liquidate) and core vault transfer/return, FULL - everything from START_OPERATIONS, plus prevent finishing or defaulting already started mints and redeems, FULL_AND_TRANSFER - everything from FULL, plus prevent FAsset transfers.

### emergencyPausedUntil

```solidity
function emergencyPausedUntil() external view returns (uint256)
```

The time when emergency pause mode will end automatically.

### mintingPaused

```solidity
function mintingPaused() external view returns (bool)
```

True if the asset manager is paused. In the paused state, minting is disabled, but all other operations (e.g. redemptions, liquidation) still work. Paused asset manager can be later unpaused.

### updateCurrentBlock

```solidity
function updateCurrentBlock(IConfirmedBlockHeightExists.Proof _proof) external
```

Prove that a block with given number and timestamp exists and update the current underlying block info if the provided data is higher. This method should be called by minters before minting and by agent's regularly to prevent current block being too outdated, which gives too short time for minting or redemption payment.

NOTE: anybody can call.

NOTE: the block/timestamp will only be updated if it is strictly higher than the current value. For mintings and redemptions we also add the duration from the last update (on this chain) to compensate for the time that passed since the last update. This mechanism can be abused by providing old block proof as fresh, which will distort the compensation accounting. Due to monotonicity such an attack will only work if there was no block update for some time. Therefore it is enough to have at least one honest current block updater regularly providing updates to avoid this issue.

*Parameters:*

- `_proof` — proof that a block with given number and timestamp exists

### currentUnderlyingBlock

```solidity
function currentUnderlyingBlock() external view returns (uint256 _blockNumber, uint256 _blockTimestamp, uint256 _lastUpdateTs)
```

Get block number and timestamp of the current underlying block known to the f-asset system.

*Returns:*

- `_blockNumber` — current underlying block number tracked by asset manager
- `_blockTimestamp` — current underlying block timestamp tracked by asset manager
- `_lastUpdateTs` — the timestamp on this chain when the current underlying block was last updated

### getCollateralType

```solidity
function getCollateralType(CollateralType.Class _collateralClass, IERC20 _token) external view returns (CollateralType.Data)
```

Get collateral  information about a token.

### getCollateralTypes

```solidity
function getCollateralTypes() external view returns (CollateralType.Data[])
```

Get the list of all available tokens used for collateral.

### createAgentVault

```solidity
function createAgentVault(IAddressValidity.Proof _addressProof, AgentSettings.Data _settings) external returns (address _agentVault)
```

Create an agent vault. The agent will always be identified by `_agentVault` address. (Externally, one account may own several agent vaults,  but in fasset system, each agent vault acts as an independent agent.)

NOTE: may only be called by an agent on the allowed agent list. Can be called from the management or the work agent owner address.

*Returns:*

- `_agentVault` — new agent vault address

### announceDestroyAgent

```solidity
function announceDestroyAgent(address _agentVault) external returns (uint256 _destroyAllowedAt)
```

Announce that the agent is going to be destroyed. At this time, the agent must not have any mintings or collateral reservations and must not be on the available agents list.

NOTE: may only be called by the agent vault owner.

*Returns:*

- `_destroyAllowedAt` — the timestamp at which the destroy can be executed

### destroyAgent

```solidity
function destroyAgent(address _agentVault, address payable _recipient) external
```

Delete all agent data, self destruct agent vault and send remaining collateral to the `_recipient`. Procedure for destroying agent: - exit available agents list - wait until all assets are redeemed or perform self-close - announce destroy (and wait the required time) - call destroyAgent()

NOTE: may only be called by the agent vault owner.

NOTE: the remaining funds from the vault will be transferred to the provided recipient.

*Parameters:*

- `_agentVault` — address of the agent's vault to destroy
- `_recipient` — address that receives the remaining funds and possible vault balance

### upgradeAgentVaultAndPool

```solidity
function upgradeAgentVaultAndPool(address _agentVault) external
```

When agent vault, collateral pool or collateral pool token factory is upgraded, new agent vaults automatically get the new implementation from the factory. But the existing agent vaults must be upgraded by their owners using this method.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — address of the agent's vault; both vault, its corresponding pool, and  its pool token will be upgraded to the newest implementations

### isPoolTokenSuffixReserved

```solidity
function isPoolTokenSuffixReserved(string _suffix) external view returns (bool)
```

Check if the collateral pool token has been used already by some vault.

*Parameters:*

- `_suffix` — the suffix to check

### announceAgentSettingUpdate

```solidity
function announceAgentSettingUpdate(address _agentVault, string _name, uint256 _value) external returns (uint256 _updateAllowedAt)
```

Due to the effect on the pool, all agent settings are timelocked. This method announces a setting change. The change can be executed after the timelock expires.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address
- `_name` — setting name, same as for `getAgentSetting`
- `_value`

*Returns:*

- `_updateAllowedAt` — the timestamp at which the update can be executed

### executeAgentSettingUpdate

```solidity
function executeAgentSettingUpdate(address _agentVault, string _name) external
```

Due to the effect on the pool, all agent settings are timelocked. This method executes a setting change after the timelock expires.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address
- `_name` — setting name, same as for `getAgentSetting`

### announceVaultCollateralWithdrawal

```solidity
function announceVaultCollateralWithdrawal(address _agentVault, uint256 _valueNATWei) external returns (uint256 _withdrawalAllowedAt)
```

The agent is going to withdraw `_valueNATWei` amount of collateral from the agent vault. This has to be announced and the agent must then wait `withdrawalWaitMinSeconds` time. After that time, the agent can call `withdrawCollateral(_vaultCollateralToken, _valueNATWei)` on the agent vault.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address
- `_valueNATWei` — the amount to be withdrawn

*Returns:*

- `_withdrawalAllowedAt` — the timestamp when the withdrawal can be made

### announceAgentPoolTokenRedemption

```solidity
function announceAgentPoolTokenRedemption(address _agentVault, uint256 _valuePoolTokenWei) external returns (uint256 _redemptionAllowedAt)
```

Agent is going to withdraw `_valuePoolTokenWei` of pool tokens from the agent vault and redeem them for NAT from the collateral pool. This has to be announced and the agent must then wait `withdrawalWaitMinSeconds`. After that time, the agent can call redeemCollateralPoolTokens(_valuePoolTokenWei) on agent vault.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address
- `_valuePoolTokenWei` — the amount to be withdrawn

*Returns:*

- `_redemptionAllowedAt` — the timestamp when the redemption can be made

### confirmTopupPayment

```solidity
function confirmTopupPayment(IPayment.Proof _payment, address _agentVault) external
```

When the agent tops up his underlying address, it has to be confirmed by calling this method, which updates the underlying free balance value.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_payment` — proof of the underlying payment; must include payment      reference of the form `0x4642505266410011000...0<agents_vault_address>`
- `_agentVault` — agent vault address

### announceUnderlyingWithdrawal

```solidity
function announceUnderlyingWithdrawal(address _agentVault) external
```

Announce withdrawal of underlying currency. In the event UnderlyingWithdrawalAnnounced the agent receives payment reference, which must be added to the payment, otherwise it can be challenged as illegal. Until the announced withdrawal is performed and confirmed or canceled, no other withdrawal can be announced.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address

### confirmUnderlyingWithdrawal

```solidity
function confirmUnderlyingWithdrawal(IPayment.Proof _payment, address _agentVault) external
```

Agent must provide confirmation of performed underlying withdrawal, which updates free balance with used gas and releases announcement so that a new one can be made. If the agent doesn't call this method, anyone can call it after a time (`confirmationByOthersAfterSeconds`).

NOTE: may only be called by the owner of the agent vault   except if enough time has passed without confirmation - then it can be called by anybody.

*Parameters:*

- `_payment` — proof of the underlying payment
- `_agentVault` — agent vault address

### cancelUnderlyingWithdrawal

```solidity
function cancelUnderlyingWithdrawal(address _agentVault) external
```

Cancel ongoing withdrawal of underlying currency. Needed in order to reset announcement timestamp, so that others cannot front-run the agent at `confirmUnderlyingWithdrawal` call. This could happen if withdrawal would be performed more than `confirmationByOthersAfterSeconds` seconds after announcement.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address

### getAllAgents

```solidity
function getAllAgents(uint256 _start, uint256 _end) external view returns (address[] _agents, uint256 _totalLength)
```

Get (a part of) the list of all active (not destroyed) agents. The list must be retrieved in parts since retrieving the whole list can consume too much gas for one block.

*Parameters:*

- `_start` — first index to return from the available agent's list
- `_end` — end index (one above last) to return from the available agent's list

### getAgentInfo

```solidity
function getAgentInfo(address _agentVault) external view returns (AgentInfo.Info)
```

Return detailed info about an agent, typically needed by a minter.

*Parameters:*

- `_agentVault` — agent vault address

*Returns:*

- `AgentInfo.Info` — structure containing agent's minting fee (BIPS), min collateral ratio (BIPS),      and current free collateral (lots)

### getAgentSetting

```solidity
function getAgentSetting(address _agentVault, string _name) external view returns (uint256)
```

Get agent's setting by name. This allows reading individual settings.

*Parameters:*

- `_agentVault` — agent vault address
- `_name` — setting name, one of: `feeBIPS`, `poolFeeShareBIPS`, `redemptionPoolFeeShareBIPS`,  `mintingVaultCollateralRatioBIPS`, `mintingPoolCollateralRatioBIPS`,`buyFAssetByAgentFactorBIPS`,  `poolExitCollateralRatioBIPS`

### getCollateralPool

```solidity
function getCollateralPool(address _agentVault) external view returns (address)
```

Returns the collateral pool address of the agent identified by `_agentVault`.

### getAgentVaultOwner

```solidity
function getAgentVaultOwner(address _agentVault) external view returns (address _ownerManagementAddress)
```

Return the management address of the owner of the agent identified by `_agentVault`.

### getAgentVaultCollateralToken

```solidity
function getAgentVaultCollateralToken(address _agentVault) external view returns (IERC20)
```

Return vault collateral ERC20 token chosen by the agent identified by `_agentVault`.

### getAgentFullVaultCollateral

```solidity
function getAgentFullVaultCollateral(address _agentVault) external view returns (uint256)
```

Return full vault collateral (free + locked) deposited in the vault `_agentVault`.

### getAgentFullPoolCollateral

```solidity
function getAgentFullPoolCollateral(address _agentVault) external view returns (uint256)
```

Return full pool NAT collateral (free + locked) deposited in the vault `_agentVault`.

### getAgentLiquidationFactorsAndMaxAmount

```solidity
function getAgentLiquidationFactorsAndMaxAmount(address _agentVault) external view returns (uint256 liquidationPaymentFactorVaultBIPS, uint256 liquidationPaymentFactorPoolBIPS, uint256 maxLiquidationAmountUBA)
```

Return the current liquidation factors and max liquidation amount of the agent identified by `_agentVault`.

### getAgentMinPoolCollateralRatioBIPS

```solidity
function getAgentMinPoolCollateralRatioBIPS(address _agentVault) external view returns (uint256)
```

Return the minimum collateral ratio of the pool collateral owned by vault `_agentVault`.

### getAgentMinVaultCollateralRatioBIPS

```solidity
function getAgentMinVaultCollateralRatioBIPS(address _agentVault) external view returns (uint256)
```

Return the minimum collateral ratio of the vault collateral owned by vault `_agentVault`.

### makeAgentAvailable

```solidity
function makeAgentAvailable(address _agentVault) external
```

Add the agent to the list of publicly available agents. Other agents can only self-mint.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address

### announceExitAvailableAgentList

```solidity
function announceExitAvailableAgentList(address _agentVault) external returns (uint256 _exitAllowedAt)
```

Announce exit from the publicly available agents list.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address

*Returns:*

- `_exitAllowedAt` — the timestamp when the agent can exit

### exitAvailableAgentList

```solidity
function exitAvailableAgentList(address _agentVault) external
```

Exit the publicly available agents list.

NOTE: may only be called by the agent vault owner and after announcement.

*Parameters:*

- `_agentVault` — agent vault address

### getAvailableAgentsList

```solidity
function getAvailableAgentsList(uint256 _start, uint256 _end) external view returns (address[] _agents, uint256 _totalLength)
```

Get (a part of) the list of available agents. The list must be retrieved in parts since retrieving the whole list can consume too much gas for one block.

*Parameters:*

- `_start` — first index to return from the available agent's list
- `_end` — end index (one above last) to return from the available agent's list

### getAvailableAgentsDetailedList

```solidity
function getAvailableAgentsDetailedList(uint256 _start, uint256 _end) external view returns (AvailableAgentInfo.Data[] _agents, uint256 _totalLength)
```

Get (a part of) the list of available agents with extra information about agents' fee, min collateral ratio and available collateral (in lots). The list must be retrieved in parts since retrieving the whole list can consume too much gas for one block.

NOTE: agent's available collateral can change anytime due to price changes, minting, or changes in agent's min collateral ratio, so it is only to be used as an estimate.

*Parameters:*

- `_start` — first index to return from the available agent's list
- `_end` — end index (one above last) to return from the available agent's list

### reserveCollateral

```solidity
function reserveCollateral(address _agentVault, uint256 _lots, uint256 _maxMintingFeeBIPS, address payable _executor) external payable returns (uint256 _collateralReservationId)
```

Before paying underlying assets for minting, minter has to reserve collateral and pay collateral reservation fee. Collateral is reserved at ratio of agent's agentMinCollateralRatio to requested lots NAT market price. The minter receives instructions for underlying payment (value, fee and payment reference) in event CollateralReserved. Then the minter has to pay `value + fee` on the underlying chain. If the minter pays the underlying amount, minter obtains f-assets. The collateral reservation fee is split between the agent and the collateral pool.

NOTE: the owner of the agent vault must be in the AgentOwnerRegistry.

NOTE: if the underlying block isn't updated regularly, it can happen that there is not enough time for the underlying payment. Therefore minters have to verify the current underlying before minting and, if needed, update it by calling `updateCurrentBlock`.

*Parameters:*

- `_agentVault` — agent vault address
- `_lots` — the number of lots for which to reserve collateral
- `_maxMintingFeeBIPS` — maximum minting fee (BIPS) that can be charged by the agent - best is just to      copy current agent's published fee; used to prevent agent from front-running reservation request      and increasing fee (that would mean that the minter would have to pay raised fee or forfeit      collateral reservation fee)
- `_executor` — the account that is allowed to execute minting (besides minter and agent)

### collateralReservationFee

```solidity
function collateralReservationFee(uint256 _lots) external view returns (uint256 _reservationFeeNATWei)
```

Return the collateral reservation fee amount that has to be passed to the `reserveCollateral` method.

NOTE: the amount paid may be larger than the required amount, but the difference is not returned. It is advised that the minter pays the exact amount, but when the amount is so small that the revert would cost more than the lost difference, the minter may want to send a slightly larger amount to compensate for the possibility of a FTSO price change between obtaining this value and calling `reserveCollateral`.

*Parameters:*

- `_lots` — the number of lots for which to reserve collateral

*Returns:*

- `_reservationFeeNATWei` — the amount of reservation fee in NAT wei

### collateralReservationInfo

```solidity
function collateralReservationInfo(uint256 _collateralReservationId) external view returns (CollateralReservationInfo.Data)
```

Returns the data about the collateral reservation for an ongoing minting. Note: once the minting is executed or defaulted, the collateral reservation is deleted and this method fails.

*Parameters:*

- `_collateralReservationId` — the collateral reservation id, as used for executing or defaulting the minting

### executeMinting

```solidity
function executeMinting(IPayment.Proof _payment, uint256 _collateralReservationId) external
```

After obtaining proof of underlying payment, the minter calls this method to finish the minting and collect the minted f-assets.

NOTE: may only be called by the minter (= creator of CR, the collateral reservation request),   the executor appointed by the minter, or the agent owner (= owner of the agent vault in CR).

*Parameters:*

- `_payment` — proof of the underlying payment (must contain exact `value + fee` amount and correct      payment reference)
- `_collateralReservationId` — collateral reservation id

### mintingPaymentDefault

```solidity
function mintingPaymentDefault(IReferencedPaymentNonexistence.Proof _proof, uint256 _collateralReservationId) external
```

When the time for the minter to pay the underlying amount is over (i.e. the last underlying block has passed), the agent can declare payment default. Then the agent collects the collateral reservation fee (it goes directly to the vault), and the reserved collateral is unlocked.

NOTE: The attestation request must be done with `checkSourceAddresses=false`.

NOTE: may only be called by the owner of the agent vault in the collateral reservation request.

*Parameters:*

- `_proof` — proof that the minter didn't pay with correct payment reference on the underlying chain
- `_collateralReservationId` — id of a collateral reservation created by the minter

### confirmClosedMintingPayment

```solidity
function confirmClosedMintingPayment(IPayment.Proof _payment, uint256 _collateralReservationId) external
```

The minter can make several mistakes in the underlying payment: - the payment is too late and is already defaulted before executing - the payment is too small so executeMinting reverts - the payment is performed twice In all of these cases the paid amount ends up on the agent vault's underlying account, but it is not confirmed and therefore the agent cannot withdraw it without triggering full liquidation (of course the agent can legally withdraw it once the vault is closed). This method enables the agent to confirm such payments, converting the deposited amount to agent's free underlying.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_payment` — proof of the underlying payment (must have correct payment reference)
- `_collateralReservationId` — collateral reservation id

### unstickMinting

```solidity
function unstickMinting(IConfirmedBlockHeightExists.Proof _proof, uint256 _collateralReservationId) external payable
```

If a collateral reservation request exists for more than 24 hours, payment or non-payment proof are no longer available. In this case the agent can call this method, which burns reserved collateral at market price and releases the remaining collateral (CRF is also burned).

NOTE: may only be called by the owner of the agent vault in the collateral reservation request.

NOTE: the agent (management address) receives the vault collateral and NAT is burned instead. Therefore      this method is `payable` and the caller must provide enough NAT to cover the received vault collateral      amount multiplied by `vaultCollateralBuyForFlareFactorBIPS`.

*Parameters:*

- `_proof` — proof that the attestation query window can not not contain      the payment/non-payment proof anymore
- `_collateralReservationId` — collateral reservation id

### selfMint

```solidity
function selfMint(IPayment.Proof _payment, address _agentVault, uint256 _lots) external
```

Agent can mint against himself. This is a one-step process, skipping collateral reservation and collateral reservation fee payment. Moreover, the agent doesn't have to be on the publicly available agents list to self-mint.

NOTE: may only be called by the agent vault owner.

NOTE: the caller must be a whitelisted agent.

*Parameters:*

- `_payment` — proof of the underlying payment; must contain payment reference of the form      `0x4642505266410012000...0<agent_vault_address>`
- `_agentVault` — agent vault address
- `_lots` — number of lots to mint

### mintFromFreeUnderlying

```solidity
function mintFromFreeUnderlying(address _agentVault, uint64 _lots) external
```

If an agent has enough free underlying, they can mint immediately without any underlying payment. This is a one-step process, skipping collateral reservation and collateral reservation fee payment. Moreover, the agent doesn't have to be on the publicly available agents list to self-mint.

NOTE: may only be called by the agent vault owner.

NOTE: the caller must be a whitelisted agent.

*Parameters:*

- `_agentVault` — agent vault address
- `_lots` — number of lots to mint

### redeem

```solidity
function redeem(uint256 _lots, string _redeemerUnderlyingAddressString, address payable _executor) external payable returns (uint256 _redeemedAmountUBA)
```

Redeem (up to) `_lots` lots of f-assets. The corresponding amount of the f-assets belonging to the redeemer will be burned and the redeemer will get paid by the agent in underlying currency (or, in case of agent's payment default, by agent's collateral with a premium).

NOTE: in some cases not all sent f-assets can be redeemed (either there are not enough tickets or more than a fixed limit of tickets should be redeemed). In this case only part of the approved assets are burned and redeemed and the redeemer can execute this method again for the remaining lots. In such a case the `RedemptionRequestIncomplete` event will be emitted, indicating the number of remaining lots. Agent receives redemption request id and instructions for underlying payment in RedemptionRequested event and has to pay `value - fee` and use the provided payment reference.

NOTE: if the underlying block isn't updated regularly, it can happen that there is no time for underlying payment. Since the agents cannot know when the next redemption will happen, they should regularly update the underlying time by obtaining fresh proof of latest underlying block and calling `updateCurrentBlock`.

*Parameters:*

- `_lots` — number of lots to redeem
- `_redeemerUnderlyingAddressString` — the address to which the agent must transfer underlying amount
- `_executor` — the account that is allowed to execute redemption default (besides redeemer and agent)

*Returns:*

- `_redeemedAmountUBA` — the actual redeemed amount; may be less than requested if there are not enough      redemption tickets available or the maximum redemption ticket limit is reached

### rejectInvalidRedemption

```solidity
function rejectInvalidRedemption(IAddressValidity.Proof _proof, uint256 _redemptionRequestId) external
```

If the redeemer provides invalid address, the agent should provide the proof of address invalidity from the Flare data connector. With this, the agent's obligations are fulfilled and they can keep the underlying.

NOTE: may only be called by the owner of the agent vault in the redemption request

NOTE: also checks that redeemer's address is normalized, so the redeemer must normalize their address,   otherwise it will be rejected!

*Parameters:*

- `_proof` — proof that the address is invalid
- `_redemptionRequestId` — id of an existing redemption request

### confirmRedemptionPayment

```solidity
function confirmRedemptionPayment(IPayment.Proof _payment, uint256 _redemptionRequestId) external
```

After paying to the redeemer, the agent must call this method to unlock the collateral and to make sure that the redeemer cannot demand payment in collateral on timeout. The same method must be called for any payment status (SUCCESS, FAILED, BLOCKED). In case of FAILED, it just releases the agent's underlying funds and the redeemer gets paid in collateral after calling redemptionPaymentDefault. In case of SUCCESS or BLOCKED, remaining underlying funds and collateral are released to the agent. If the agent doesn't confirm payment in enough time (several hours, setting `confirmationByOthersAfterSeconds`), anybody can do it and get rewarded from the agent's vault.

NOTE: may only be called by the owner of the agent vault in the redemption request   except if enough time has passed without confirmation - then it can be called by anybody

*Parameters:*

- `_payment` — proof of the underlying payment (must contain exact `value - fee` amount and correct      payment reference)
- `_redemptionRequestId` — id of an existing redemption request

### redemptionPaymentDefault

```solidity
function redemptionPaymentDefault(IReferencedPaymentNonexistence.Proof _proof, uint256 _redemptionRequestId) external
```

If the agent doesn't transfer the redeemed underlying assets in time (until the last allowed block on the underlying chain), the redeemer calls this method and receives payment in collateral (with some extra). The agent can also call default if the redeemer is unresponsive, to payout the redeemer and free the remaining collateral.

NOTE: The attestation request must be done with `checkSourceAddresses=false`.

NOTE: may only be called by the redeemer (= creator of the redemption request),   the executor appointed by the redeemer,   or the agent owner (= owner of the agent vault in the redemption request)

*Parameters:*

- `_proof` — proof that the agent didn't pay with correct payment reference on the underlying chain
- `_redemptionRequestId` — id of an existing redemption request

### finishRedemptionWithoutPayment

```solidity
function finishRedemptionWithoutPayment(IConfirmedBlockHeightExists.Proof _proof, uint256 _redemptionRequestId) external
```

If the agent hasn't performed the payment, the agent can close the redemption request to free underlying funds. It can be done immediately after the redeemer or agent calls `redemptionPaymentDefault`, or this method can trigger the default payment without proof, but only after enough time has passed so that attestation proof of non-payment is not available any more.

NOTE: may only be called by the owner of the agent vault in the redemption request.

*Parameters:*

- `_proof` — proof that the attestation query window can not not contain      the payment/non-payment proof anymore
- `_redemptionRequestId` — id of an existing, but already defaulted, redemption request

### redemptionRequestInfo

```solidity
function redemptionRequestInfo(uint256 _redemptionRequestId) external view returns (RedemptionRequestInfo.Data)
```

Returns the data about an ongoing redemption request. Note: once the redemptions is confirmed, the request is deleted and this method fails. However, if there is no payment and the redemption defaults, the method works and returns status DEFAULTED.

*Parameters:*

- `_redemptionRequestId` — the redemption request id, as used for confirming or defaulting the redemption

### selfClose

```solidity
function selfClose(address _agentVault, uint256 _amountUBA) external returns (uint256 _closedAmountUBA)
```

Agent can "redeem against himself" by calling `selfClose`, which burns agent's own f-assets and unlocks agent's collateral. The underlying funds backing the f-assets are released as agent's free underlying funds and can be later withdrawn after announcement.

NOTE: may only be called by the agent vault owner.

*Parameters:*

- `_agentVault` — agent vault address
- `_amountUBA` — amount of f-assets to self-close

*Returns:*

- `_closedAmountUBA` — the actual self-closed amount, may be less than requested if there are not enough      redemption tickets available or the maximum redemption ticket limit is reached

### redemptionQueue

```solidity
function redemptionQueue(uint256 _firstRedemptionTicketId, uint256 _pageSize) external view returns (RedemptionTicketInfo.Data[] _queue, uint256 _nextRedemptionTicketId)
```

Return (part of) the redemption queue.

*Parameters:*

- `_firstRedemptionTicketId` — the ticket id to start listing from; if 0, starts from the beginning
- `_pageSize` — the maximum number of redemption tickets to return

*Returns:*

- `_queue` — the (part of) the redemption queue; maximum length is _pageSize
- `_nextRedemptionTicketId` — works as a cursor - if the _pageSize is reached and there are more tickets,  it is the first ticket id not returned; if the end is reached, it is 0

### agentRedemptionQueue

```solidity
function agentRedemptionQueue(address _agentVault, uint256 _firstRedemptionTicketId, uint256 _pageSize) external view returns (RedemptionTicketInfo.Data[] _queue, uint256 _nextRedemptionTicketId)
```

Return (part of) the redemption queue for a specific agent.

*Parameters:*

- `_agentVault` — the agent vault address of the queried agent
- `_firstRedemptionTicketId` — the ticket id to start listing from; if 0, starts from the beginning
- `_pageSize` — the maximum number of redemption tickets to return

*Returns:*

- `_queue` — the (part of) the redemption queue; maximum length is _pageSize
- `_nextRedemptionTicketId` — works as a cursor - if the _pageSize is reached and there are more tickets,  it is the first ticket id not returned; if the end is reached, it is 0

### convertDustToTicket

```solidity
function convertDustToTicket(address _agentVault) external
```

Due to the minting pool fees or after a lot size change by the governance, it may happen that less than one lot remains on a redemption ticket. This is named "dust" and can be self closed or liquidated, but not redeemed. However, after several additions, the total dust can amount to more than one lot. Using this method, the amount, rounded down to a whole number of lots, can be converted to a new redemption ticket.

NOTE: we do NOT check that the caller is the agent vault owner, since we want to allow anyone to convert dust to tickets to increase asset fungibility.

NOTE: dust above 1 lot is actually added to ticket at every minting, so this function need only be called when the agent doesn't have any minting.

*Parameters:*

- `_agentVault` — agent vault address

### consolidateSmallTickets

```solidity
function consolidateSmallTickets(uint256 _firstTicketId) external
```

If lot size is increased, there may be many tickets less than one lot in the queue. In extreme cases, this could prevent redemptions, if there weren't any tickets above 1 lot among the first `maxRedeemedTickets` tickets. To fix this, call this method. It converts small tickets to dust and when the dust exceeds one lot adds it to the ticket.

NOTE: this method can be called by the governance or its executor.

*Parameters:*

- `_firstTicketId` — if nonzero, the ticket id of starting ticket; if zero, the starting ticket will   be the redemption queue's first ticket id.   When the method finishes, it emits RedemptionTicketsConsolidated event with the nextTicketId   parameter. If it is nonzero, the method should be invoked again with this value as _firstTicketId.

### startLiquidation

```solidity
function startLiquidation(address _agentVault) external returns (uint256 _liquidationStartTs)
```

Checks that the agent's collateral is too low and if true, starts agent's liquidation. If the agent is already in liquidation, returns the timestamp when liquidation started.

*Parameters:*

- `_agentVault` — agent vault address

*Returns:*

- `_liquidationStartTs` — timestamp when liquidation started

### liquidate

```solidity
function liquidate(address _agentVault, uint256 _amountUBA) external returns (uint256 _liquidatedAmountUBA, uint256 _amountPaidVault, uint256 _amountPaidPool)
```

Burns up to `_amountUBA` f-assets owned by the caller and pays the caller the corresponding amount of native currency with premium (premium depends on the liquidation state). If the agent isn't in liquidation yet, but satisfies conditions, automatically puts the agent in liquidation status.

*Parameters:*

- `_agentVault` — agent vault address
- `_amountUBA` — the amount of f-assets to liquidate

*Returns:*

- `_liquidatedAmountUBA` — liquidated amount of f-asset
- `_amountPaidVault` — amount paid to liquidator (in agent's vault collateral)
- `_amountPaidPool` — amount paid to liquidator (in NAT from pool)

### endLiquidation

```solidity
function endLiquidation(address _agentVault) external
```

When the agent's collateral reaches the safe level during liquidation, the liquidation process can be stopped by calling this method. Full liquidation (i.e. the liquidation triggered by illegal underlying payment) cannot be stopped.

NOTE: anybody can call.

NOTE: if the method succeeds, the agent's liquidation has ended.

*Parameters:*

- `_agentVault` — agent vault address

### illegalPaymentChallenge

```solidity
function illegalPaymentChallenge(IBalanceDecreasingTransaction.Proof _payment, address _agentVault) external
```

Called with a proof of payment made from the agent's underlying address, for which no valid payment reference exists (valid payment references are from redemption and underlying withdrawal announcement calls). On success, immediately triggers full agent liquidation and rewards the caller.

*Parameters:*

- `_payment` — proof of a transaction from the agent's underlying address
- `_agentVault` — agent vault address

### doublePaymentChallenge

```solidity
function doublePaymentChallenge(IBalanceDecreasingTransaction.Proof _payment1, IBalanceDecreasingTransaction.Proof _payment2, address _agentVault) external
```

Called with proofs of two payments made from the agent's underlying address with the same payment reference (each payment reference is valid for only one payment). On success, immediately triggers full agent liquidation and rewards the caller.

*Parameters:*

- `_payment1` — proof of first payment from the agent's underlying address
- `_payment2` — proof of second payment from the agent's underlying address
- `_agentVault` — agent vault address

### freeBalanceNegativeChallenge

```solidity
function freeBalanceNegativeChallenge(IBalanceDecreasingTransaction.Proof[] _payments, address _agentVault) external
```

Called with proofs of several (otherwise legal) payments, which together make the agent's underlying free balance negative (i.e. the underlying address balance is less than the total amount of backed f-assets). On success, immediately triggers full agent liquidation and rewards the caller.

*Parameters:*

- `_payments` — proofs of several distinct payments from the agent's underlying address
- `_agentVault` — agent vault address

### addAlwaysAllowedMinterForAgent

```solidity
function addAlwaysAllowedMinterForAgent(address _agentVault, address _minter) external
```

### agentPing

```solidity
function agentPing(address _agentVault, uint256 _query) external
```

Used for liveness checks, simply emits AgentPing event.

*Parameters:*

- `_agentVault` — the agent vault whose owner bot to ping
- `_query` — off-chain defined id of the query

### agentPingResponse

```solidity
function agentPingResponse(address _agentVault, uint256 _query, string _response) external
```

Used for liveness checks, the bot's response to AgentPing event. Simply emits AgentPingResponse event identifying the owner.

NOTE: may only be called by the agent vault owner

*Parameters:*

- `_agentVault` — the pinged agent vault
- `_query` — repeated `_query` from the agentPing
- `_response` — response data to the query

### alwaysAllowedMintersForAgent

```solidity
function alwaysAllowedMintersForAgent(address _agentVault) external view returns (address[])
```

### cancelReturnFromCoreVault

```solidity
function cancelReturnFromCoreVault(address _agentVault) external
```

Before the return request is processed, it can be cancelled, releasing the agent's reserved collateral.

*Parameters:*

- `_agentVault` — the agent vault address

### confirmCoreVaultDonation

```solidity
function confirmCoreVaultDonation(IXRPPayment.Proof _payment) external
```

Confirm a donation payment made to the core vault underlying address.

*Parameters:*

- `_payment` — FDC payment proof

### confirmReturnFromCoreVault

```solidity
function confirmReturnFromCoreVault(IPayment.Proof _payment, address _agentVault) external
```

Confirm the payment from core vault to the agent's underlying address. This adds the reserved funds to the agent's backing.

*Parameters:*

- `_payment` — FDC payment proof
- `_agentVault` — the agent vault address

### confirmXRPRedemptionPayment

```solidity
function confirmXRPRedemptionPayment(IXRPPayment.Proof _payment, uint256 _redemptionRequestId) external
```

After paying to the redeemer, the agent must call this method to unlock the collateral and to make sure that the redeemer cannot demand payment in collateral on timeout. The same method must be called for any payment status (SUCCESS, FAILED, BLOCKED). In case of FAILED, it just releases agent's underlying funds and the redeemer gets paid in collateral after calling redemptionPaymentDefault. In case of SUCCESS or BLOCKED, remaining underlying funds and collateral are released to the agent. If the agent doesn't confirm payment in enough time (several hours, setting confirmationByOthersAfterSeconds), anybody can do it and get rewarded from agent's vault.

NOTE: the only difference between this method and `confirmRedemptionPayment` is that this one accepts   IXRPPayment proof type and supports destination tags.

NOTE: may only be called by the owner of the agent vault in the redemption request   except if enough time has passed without confirmation - then it can be called by anybody

*Parameters:*

- `_payment` — proof of the underlying payment (must contain exact `value - fee` amount and correct      payment reference)
- `_redemptionRequestId` — id of an existing redemption request

### coreVaultAvailableAmount

```solidity
function coreVaultAvailableAmount() external view returns (uint256 _immediatelyAvailableUBA, uint256 _totalAvailableUBA)
```

Returns the amount available on the core vault - this is the maximum amount that can be returned to agent or redeemed directly from the core vault.

*Returns:*

- `_immediatelyAvailableUBA` — the amount on the core vault operating account - returns and redemptions within this amount will be paid out quickly
- `_totalAvailableUBA` — the total amount on the core vault, including all escrows

### directMintingDelayState

```solidity
function directMintingDelayState(bytes32 _transactionId) external view returns (IDirectMinting.DirectMintingDelayState _delayState, uint256 _allowedAt, uint256 _startedAt)
```

Gets the delay state of a direct minting.

*Parameters:*

- `_transactionId` — the direct minting underlying payment transaction id

*Returns:*

- `_delayState` — the delay state of the direct minting
- `_allowedAt` — the timestamp at which the minting can be executed
- `_startedAt` — the timestamp at which the minting was started

### directMintingPaymentAddress

```solidity
function directMintingPaymentAddress() external view returns (string)
```

Gets the payment address to which the underlying assets must be sent for direct minting.

### effectiveSystemRedemptionFeeBIPS

```solidity
function effectiveSystemRedemptionFeeBIPS() external view returns (uint256)
```

The system redemption fee in BIPS that is actually charged, taking the fee receiver into account. Equals `systemRedemptionFeeBIPS()` when a fee receiver is set (`systemRedemptionFeeReceiver()` is nonzero), and zero otherwise (a zero receiver disables the system redemption fee).

### executeDirectMinting

```solidity
function executeDirectMinting(IXRPPayment.Proof _payment) external payable
```

Executes minting directly, without a collateral reservation. The payment must be made to the fAsset Core Vault's XRP address.

*Parameters:*

- `_payment` — the XRP payment proof data

### executeDirectMintingWithData

```solidity
function executeDirectMintingWithData(IXRPPayment.Proof _payment, bytes _data) external payable
```

Executes minting directly, without a collateral reservation. The payment must be made to the fAsset Core Vault's XRP address.

NOTE: unlike `executeDirectMinting`, this form is only allowed for minting to smart accounts.

*Parameters:*

- `_payment` — the XRP payment proof data
- `_data` — additional data sent to the smart account manager NOTE: parameter `_data` is checked to match hash defined in `_payment.firstMemoData`, so it cannot be used to pass arbitrary data. However, the checking is done on the smart accounts side, not in the asset manager.

### facetAddress

```solidity
function facetAddress(bytes4 _functionSelector) external view returns (address facetAddress_)
```

Gets the facet that supports the given selector.

If facet is not found return address(0).

*Parameters:*

- `_functionSelector` — The function selector.

*Returns:*

- `facetAddress_` — The facet address.

### facetAddresses

```solidity
function facetAddresses() external view returns (address[] facetAddresses_)
```

Get all the facet addresses used by a diamond.

*Returns:*

- `facetAddresses_` — facetAddresses_

### facetFunctionSelectors

```solidity
function facetFunctionSelectors(address _facet) external view returns (bytes4[] facetFunctionSelectors_)
```

Gets all the function selectors supported by a specific facet.

*Parameters:*

- `_facet` — The facet address.

*Returns:*

- `facetFunctionSelectors_` — facetFunctionSelectors_

### facets

```solidity
function facets() external view returns (IDiamondLoupe.Facet[] facets_)
```

Gets all facet addresses and their four byte function selectors.

*Returns:*

- `facets_` — Facet

### getCoreVaultDonationTag

```solidity
function getCoreVaultDonationTag() external view returns (uint256)
```

### getCoreVaultManager

```solidity
function getCoreVaultManager() external view returns (address)
```

### getCoreVaultMinimumAmountLeftBIPS

```solidity
function getCoreVaultMinimumAmountLeftBIPS() external view returns (uint256)
```

### getCoreVaultMinimumRedeemLots

```solidity
function getCoreVaultMinimumRedeemLots() external view returns (uint256)
```

### getCoreVaultNativeAddress

```solidity
function getCoreVaultNativeAddress() external view returns (address)
```

### getCoreVaultRedemptionFeeBIPS

```solidity
function getCoreVaultRedemptionFeeBIPS() external view returns (uint256)
```

### getCoreVaultTransferDefaultPenaltyBIPS

```solidity
function getCoreVaultTransferDefaultPenaltyBIPS() external view returns (uint256)
```

### getCoreVaultTransferTimeExtensionSeconds

```solidity
function getCoreVaultTransferTimeExtensionSeconds() external view returns (uint256)
```

### getDirectMintingDailyLimitUBA

```solidity
function getDirectMintingDailyLimitUBA() external view returns (uint256)
```

### getDirectMintingDailyLimiterState

```solidity
function getDirectMintingDailyLimiterState() external view returns (uint64 _windowStartTimestamp, uint64 _mintedInCurrentWindow)
```

### getDirectMintingExecutorFeeUBA

```solidity
function getDirectMintingExecutorFeeUBA() external view returns (uint256)
```

### getDirectMintingFeeBIPS

```solidity
function getDirectMintingFeeBIPS() external view returns (uint256)
```

### getDirectMintingFeeReceiver

```solidity
function getDirectMintingFeeReceiver() external view returns (address)
```

### getDirectMintingHourlyLimitUBA

```solidity
function getDirectMintingHourlyLimitUBA() external view returns (uint256)
```

### getDirectMintingHourlyLimiterState

```solidity
function getDirectMintingHourlyLimiterState() external view returns (uint64 _windowStartTimestamp, uint64 _mintedInCurrentWindow)
```

### getDirectMintingLargeMintingDelaySeconds

```solidity
function getDirectMintingLargeMintingDelaySeconds() external view returns (uint256)
```

### getDirectMintingLargeMintingThresholdUBA

```solidity
function getDirectMintingLargeMintingThresholdUBA() external view returns (uint256)
```

### getDirectMintingMinimumFeeUBA

```solidity
function getDirectMintingMinimumFeeUBA() external view returns (uint256)
```

### getDirectMintingOthersCanExecuteAfterSeconds

```solidity
function getDirectMintingOthersCanExecuteAfterSeconds() external view returns (uint256)
```

### getDirectMintingsUnblockUntilTimestamp

```solidity
function getDirectMintingsUnblockUntilTimestamp() external view returns (uint256)
```

### getMintingTagManager

```solidity
function getMintingTagManager() external view returns (address)
```

### getSmartAccountManager

```solidity
function getSmartAccountManager() external view returns (address)
```

### markUnblockedDirectMintingAllowed

```solidity
function markUnblockedDirectMintingAllowed(bytes32 _transactionId) external
```

This method is not strictly necessary to allow an unblocked delayed minting to be executed. However, if the minter has set an allowed executor, it has the exclusive right to execute minting for fixed time after the minting is allowed to execute. This method makes sure that the exclusive period begins from the moment the minting was unblocked, not from later allowedAt.

NOTE: this method is intentionally callable by anybody, not just allowed executor - it is in the interest of other executors to call it as soon as mintings are unblocked by the governance.

*Parameters:*

- `_transactionId` — transaction id of the delayed minting to mark as allowed

### maximumTransferToCoreVault

```solidity
function maximumTransferToCoreVault(address _agentVault) external view returns (uint256 _maximumTransferUBA, uint256 _minimumLeftAmountUBA)
```

Return the maximum amount that can be transferred and the minimum amount that has to remain on the agent vault's underlying address.

*Parameters:*

- `_agentVault` — the agent vault address

*Returns:*

- `_maximumTransferUBA` — maximum amount that can be transferred
- `_minimumLeftAmountUBA` — the minimum amount that has to remain on the agent vault's underlying address  after the transfer

### minimumRedeemAmountUBA

```solidity
function minimumRedeemAmountUBA() external view returns (uint256)
```

Minimum amount in UBA for redemption with tag. Redemption with tag requests with smaller amount will be rejected.

### redeemAmount

```solidity
function redeemAmount(uint256 _amountUBA, string _redeemerUnderlyingAddressString, address payable _executor) external payable returns (uint256 _redeemedAmountUBA)
```

Redeem (up to) `_amountUBA` FAssets. Like `redeem`, but accepts an arbitrary amount in UBA instead of whole lots. Like `redeem`, does not require a destination tag.

NOTE: in some cases not all sent FAssets can be redeemed (either there are not enough tickets or more than a fixed limit of tickets should be redeemed). In this case only part of the approved assets are burned and redeemed and the redeemer can execute this method again for the remaining amount. In such a case the `RedemptionAmountIncomplete` event will be emitted, indicating remaining amount. Agent receives redemption request id and instructions for underlying payment in RedemptionRequested event and has to pay `value - fee` and use the provided payment reference.

*Parameters:*

- `_amountUBA` — amount of redeemer's FAssets that will be burned; this is NOT the amount of assets      that will be received by the redeemer - the redemption fee will be subtracted
- `_redeemerUnderlyingAddressString` — the address to which the agent must transfer underlying amount
- `_executor` — the account that is allowed to execute redemption default (besides redeemer and agent)

*Returns:*

- `_redeemedAmountUBA` — the actual redeemed amount; may be less than requested if there are not enough      redemption tickets available or the maximum redemption ticket limit is reached

### redeemFromCoreVault

```solidity
function redeemFromCoreVault(uint256 _lots, string _redeemerUnderlyingAddress) external
```

Directly redeem from core vault by a user holding FAssets. This is like ordinary redemption, but the redemption time is much longer (a day or more) and there is no possibility of redemption default.

*Parameters:*

- `_lots` — the number of lots, must be larger than `coreVaultMinimumRedeemLots` setting
- `_redeemerUnderlyingAddress` — the underlying address to which the assets will be redeemed;      must have been added to the `allowedDestinations` list in the core vault manager by      the governance before the redemption request.

### redeemWithTag

```solidity
function redeemWithTag(uint256 _amountUBA, string _redeemerUnderlyingAddressString, address payable _executor, uint256 _destinationTag) external payable returns (uint256 _redeemedAmountUBA)
```

Redeem (up to) `_amountUBA` f-assets. The corresponding amount of the f-assets belonging to the redeemer will be burned and the redeemer will get paid by the agent in underlying currency (or, in case of agent's payment default, by agent's collateral with a premium).

NOTE: in some cases not all sent f-assets can be redeemed (either there are not enough tickets or more than a fixed limit of tickets should be redeemed). In this case only part of the approved assets are burned and redeemed and the redeemer can execute this method again for the remaining amount. In such a case the `RedemptionAmountIncomplete` event will be emitted, indicating the remaining amount. Agent receives redemption request id and instructions for underlying payment in RedemptionRequested event and has to pay `value - fee` and use the provided payment reference.

NOTE: if the underlying block isn't updated regularly, it can happen that there is no time for underlying payment. Since the agents cannot know when the next redemption will happen, they should regularly update the underlying time by obtaining fresh proof of latest underlying block and calling `updateCurrentBlock`.

*Parameters:*

- `_amountUBA` — amount of redeemer's FAssets that will be burned; this is NOT the amount of assets      that will be received by the redeemer - the redemption fee will be subtracted
- `_redeemerUnderlyingAddressString` — the address to which the agent must transfer underlying amount
- `_executor` — the account that is allowed to execute redemption default (besides redeemer and agent)
- `_destinationTag` — the destination tag that is required in the redemption payment (only for XRP;      it must fit in 32 bits for now)

*Returns:*

- `_redeemedAmountUBA` — the actual redeemed amount; may be less than requested if there are not enough      redemption tickets available or the maximum redemption ticket limit is reached

### redeemWithTagSupported

```solidity
function redeemWithTagSupported() external view returns (bool)
```

If false, calling `redeemWithTag` will revert. For now, only XRP chain supports destination tags, so this flag will be true only on XRP network.

### redemptionPaymentExtensionSeconds

```solidity
function redemptionPaymentExtensionSeconds() external view returns (uint256)
```

### redemptionRequestInfoExt

```solidity
function redemptionRequestInfoExt(uint256 _redemptionRequestId) external view returns (RedemptionRequestInfo.DataExt)
```

Returns the data about an ongoing redemption request. Note: once the redemptions is confirmed, the request is deleted and this method fails. However, if there is no payment and the redemption defaults, the method works and returns status DEFAULTED. Note: this method adds redemptionWithTag specific fields to the data returned by `redemptionRequestInfo`.

*Parameters:*

- `_redemptionRequestId` — the redemption request id, as used for confirming or defaulting the redemption

### removeAlwaysAllowedMinterForAgent

```solidity
function removeAlwaysAllowedMinterForAgent(address _agentVault, address _minter) external
```

### requestReturnFromCoreVault

```solidity
function requestReturnFromCoreVault(address _agentVault, uint256 _lots) external
```

Request that core vault transfers funds to the agent's underlying address, which makes them available for redemptions. This method reserves agent's collateral. This may be sent by an agent when redemptions dominate mintings, so that the agents are empty but want to earn from redemptions.

NOTE: only agent vault owner can call

NOTE: there can be only one active return request (until it is confirmed or cancelled).

*Parameters:*

- `_agentVault` — the agent vault address
- `_lots` — number of lots (same lots as for minting and redemptions)

### setCoreVaultManager

```solidity
function setCoreVaultManager(address _coreVaultManager) external
```

### setCoreVaultMinimumAmountLeftBIPS

```solidity
function setCoreVaultMinimumAmountLeftBIPS(uint256 _minimumAmountLeftBIPS) external
```

### setCoreVaultMinimumRedeemLots

```solidity
function setCoreVaultMinimumRedeemLots(uint256 _minimumRedeemLots) external
```

### setCoreVaultNativeAddress

```solidity
function setCoreVaultNativeAddress(address payable _nativeAddress) external
```

### setCoreVaultRedemptionFeeBIPS

```solidity
function setCoreVaultRedemptionFeeBIPS(uint256 _redemptionFeeBIPS) external
```

### setCoreVaultTransferDefaultPenaltyBIPS

```solidity
function setCoreVaultTransferDefaultPenaltyBIPS(uint256 _transferDefaultPenaltyBIPS) external
```

### setCoreVaultTransferTimeExtensionSeconds

```solidity
function setCoreVaultTransferTimeExtensionSeconds(uint256 _transferTimeExtensionSeconds) external
```

### setDirectMintingDailyLimitUBA

```solidity
function setDirectMintingDailyLimitUBA(uint256 _dailyLimitUBA) external
```

### setDirectMintingExecutorFee

```solidity
function setDirectMintingExecutorFee(uint256 _executorFeeUBA) external
```

### setDirectMintingFee

```solidity
function setDirectMintingFee(uint256 _mintingFeeBIPS, uint256 _minimumMintingFeeUBA) external
```

### setDirectMintingFeeReceiver

```solidity
function setDirectMintingFeeReceiver(address _mintingFeeReceiver) external
```

### setDirectMintingHourlyLimitUBA

```solidity
function setDirectMintingHourlyLimitUBA(uint256 _hourlyLimitUBA) external
```

### setDirectMintingLargeMintingThrottling

```solidity
function setDirectMintingLargeMintingThrottling(uint256 _largeMintingThresholdUBA, uint256 _largeMintingDelaySeconds) external
```

### setDirectMintingOthersCanExecuteAfterSeconds

```solidity
function setDirectMintingOthersCanExecuteAfterSeconds(uint256 _seconds) external
```

### setMinimumRedeemAmountUBA

```solidity
function setMinimumRedeemAmountUBA(uint256 _valueUBA) external
```

Set the minimum amount in UBA for redemption with tag. Redemption with tag requests with smaller amount will be rejected.

NOTE: may only be called by the governance.

*Parameters:*

- `_valueUBA` — the new minimum redeem with tag amount in UBA;      must be at most 10 lots (in UBA)

### setMintingTagManager

```solidity
function setMintingTagManager(address _mintingTagManager) external
```

### setRedemptionPaymentExtensionSeconds

```solidity
function setRedemptionPaymentExtensionSeconds(uint256 _value) external
```

### setSmartAccountManager

```solidity
function setSmartAccountManager(address _smartAccountManager) external
```

### setSystemRedemptionFeeBIPS

```solidity
function setSystemRedemptionFeeBIPS(uint256 _feeBIPS) external
```

Set the part of the redemption value, in BIPS, that is charged as the system redemption fee. Setting it to zero disables the system redemption fee.

NOTE: may only be called by the governance.

*Parameters:*

- `_feeBIPS` — the new system redemption fee in BIPS; must be less than 10000

### setSystemRedemptionFeeReceiver

```solidity
function setSystemRedemptionFeeReceiver(address _receiver) external
```

Set the address to which the system redemption fee is re-minted. Setting it to zero address disables the system redemption fee.

NOTE: may only be called by the governance.

*Parameters:*

- `_receiver` — the new system redemption fee receiver

### supportsInterface

```solidity
function supportsInterface(bytes4 interfaceId) external view returns (bool)
```

Returns true if this contract implements the interface defined by `interfaceId`. See the corresponding https://eips.ethereum.org/EIPS/eip-165#how-interfaces-are-identified[EIP section] to learn more about how these ids are created. This function call must use less than 30 000 gas.

### systemRedemptionFeeBIPS

```solidity
function systemRedemptionFeeBIPS() external view returns (uint256)
```

The part of the redemption value, in BIPS, that is charged as a system fee at the creation of every redemption request (except for the transfers to the core vault). The fee is subtracted from the redemption value and re-minted to the system redemption fee receiver. If zero, no system redemption fee is charged.

### systemRedemptionFeeReceiver

```solidity
function systemRedemptionFeeReceiver() external view returns (address)
```

The address to which the system redemption fee is re-minted. If zero, no system redemption fee is charged.

### transferToCoreVault

```solidity
function transferToCoreVault(address _agentVault, uint256 _amountUBA) external
```

Agent can transfer their backing to core vault. They then get a redemption requests which the owner pays just like any other redemption request. After that, the agent's collateral is released.

NOTE: only agent vault owner can call

*Parameters:*

- `_agentVault` — the agent vault address
- `_amountUBA` — the amount to transfer to the core vault

### unblockDirectMintingsUntil

```solidity
function unblockDirectMintingsUntil(uint256 _timestamp) external
```

Unblocks direct mintings until the given timestamp.

NOTE: only governance can call this function.

*Parameters:*

- `_timestamp` — the timestamp until which direct mintings are unblocked

### xrpRedemptionPaymentDefault

```solidity
function xrpRedemptionPaymentDefault(IXRPPaymentNonexistence.Proof _proof, uint256 _redemptionRequestId) external
```

If the agent doesn't transfer the redeemed underlying assets in time (until the last allowed block on the underlying chain), the redeemer calls this method and receives payment in collateral (with some extra). The agent can also call default if the redeemer is unresponsive, to payout the redeemer and free the remaining collateral.

NOTE: the only difference between this method and `redemptionPaymentDefault` is that this one accepts   IXRPPayment proof type and supports destination tags.

NOTE: may only be called by the redeemer (= creator of the redemption request),   the executor appointed by the redeemer,   or the agent owner (= owner of the agent vault in the redemption request)

*Parameters:*

- `_proof` — proof that the agent didn't pay with correct payment reference on the underlying chain
- `_redemptionRequestId` — id of an existing redemption request

## Events

### AgentAvailable

```solidity
event AgentAvailable(address indexed agentVault, uint256 feeBIPS, uint256 mintingVaultCollateralRatioBIPS, uint256 mintingPoolCollateralRatioBIPS, uint256 freeCollateralLots)
```

Agent was added to the list of available agents and can accept collateral reservation requests.

### AgentCollateralTypeChanged

```solidity
event AgentCollateralTypeChanged(address indexed agentVault, uint8 collateralClass, address token)
```

Agent or agent's collateral pool has changed token contract.

### AgentDestroyAnnounced

```solidity
event AgentDestroyAnnounced(address indexed agentVault, uint256 destroyAllowedAt)
```

Agent has announced destroy (close) of agent vault and will be able to perform destroy after the timestamp `destroyAllowedAt`.

### AgentDestroyed

```solidity
event AgentDestroyed(address indexed agentVault)
```

Agent has destroyed (closed) the agent vault.

### AgentPing

```solidity
event AgentPing(address indexed agentVault, address indexed sender, uint256 query)
```

Agent bot liveness check.

*Parameters:*

- `agentVault` — the agent vault whose owner bot to ping
- `sender` — the account that triggered ping; helps bot decide whether it is important to answer
- `query` — off-chain defined id of the query

### AgentPingResponse

```solidity
event AgentPingResponse(address indexed agentVault, address indexed owner, uint256 query, string response)
```

Response to agent bot liveness check.

*Parameters:*

- `agentVault` — the pinged agent vault
- `owner` — owner of the agent vault (management address)
- `query` — repeated `query` from the AgentPing event
- `response` — response data to the query

### AgentSettingChangeAnnounced

```solidity
event AgentSettingChangeAnnounced(address indexed agentVault, string name, uint256 value, uint256 validAt)
```

Agent has initiated setting change (fee or some agent collateral ratio change). The setting change can be executed after the timestamp `validAt`.

### AgentSettingChanged

```solidity
event AgentSettingChanged(address indexed agentVault, string name, uint256 value)
```

Agent has executed setting change (fee or some agent collateral ratio change).

### AgentVaultCreated

```solidity
event AgentVaultCreated(address indexed owner, address indexed agentVault, IAssetManagerEvents.AgentVaultCreationData creationData)
```

A new agent vault was created.

### AvailableAgentExitAnnounced

```solidity
event AvailableAgentExitAnnounced(address indexed agentVault, uint256 exitAllowedAt)
```

Agent exited from available agents list. The agent can exit the available list after the timestamp `exitAllowedAt`.

### AvailableAgentExited

```solidity
event AvailableAgentExited(address indexed agentVault)
```

Agent exited from available agents list.

### CollateralRatiosChanged

```solidity
event CollateralRatiosChanged(uint8 collateralClass, address collateralToken, uint256 minCollateralRatioBIPS, uint256 safetyMinCollateralRatioBIPS)
```

System defined collateral ratios for the token have changed (minimal and safety collateral ratio).

### CollateralReservationDeleted

```solidity
event CollateralReservationDeleted(address indexed agentVault, address indexed minter, uint256 indexed collateralReservationId, uint256 reservedAmountUBA)
```

Both minter and agent failed to present any proof within attestation time window, so the agent called `unstickMinting` to release reserved collateral.

### CollateralReserved

```solidity
event CollateralReserved(address indexed agentVault, address indexed minter, uint256 indexed collateralReservationId, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, string paymentAddress, bytes32 paymentReference, address executor, uint256 executorFeeNatWei)
```

Minter reserved collateral, paid the reservation fee, and is expected to pay the underlying funds. Agent's collateral was reserved.

### CollateralTypeAdded

```solidity
event CollateralTypeAdded(uint8 collateralClass, address token, uint256 decimals, bool directPricePair, string assetFtsoSymbol, string tokenFtsoSymbol, uint256 minCollateralRatioBIPS, uint256 safetyMinCollateralRatioBIPS)
```

New collateral token has been added.

### ConfirmedClosedMintingPayment

```solidity
event ConfirmedClosedMintingPayment(address indexed agentVault, bytes32 transactionHash, uint256 depositedUBA)
```

Emitted when a late or too small payment for an already defaulted or expired minting is confirmed. It is equivalent to agent performing underlying topup.

### ContractChanged

```solidity
event ContractChanged(string name, address value)
```

A contract in the settings has changed.

### CoreVaultFundsAdded

```solidity
event CoreVaultFundsAdded(uint256 amountUBA)
```

Funds have been added to the core vault operating account.

### CoreVaultRedemptionRequested

```solidity
event CoreVaultRedemptionRequested(address indexed redeemer, string paymentAddress, bytes32 paymentReference, uint256 valueUBA, uint256 feeUBA)
```

Redemption was requested from a core vault. Can only be redeemed to a payment address from to the `allowedDestinations` list in the core vault manager.

### CurrentUnderlyingBlockUpdated

```solidity
event CurrentUnderlyingBlockUpdated(uint256 underlyingBlockNumber, uint256 underlyingBlockTimestamp, uint256 updatedAt)
```

Current underlying block number or timestamp has been updated.

### DirectMintingDelayed

```solidity
event DirectMintingDelayed(bytes32 transactionId, uint256 amount, uint256 executionAllowedAt)
```

### DirectMintingExecuted

```solidity
event DirectMintingExecuted(bytes32 transactionId, address targetAddress, address executor, uint256 mintedAmountUBA, uint256 mintingFeeUBA, uint256 executorFeeUBA)
```

### DirectMintingExecutedToSmartAccount

```solidity
event DirectMintingExecutedToSmartAccount(bytes32 transactionId, string sourceAddress, address executor, uint256 mintedAmountUBA, uint256 mintingFeeUBA, bytes memoData)
```

### DirectMintingPaymentTooSmallForFee

```solidity
event DirectMintingPaymentTooSmallForFee(bytes32 transactionId, uint256 receivedAmountUBA, uint256 minimumMintingFeeUBA)
```

### DirectMintingsUnblocked

```solidity
event DirectMintingsUnblocked(uint256 startedUntilTimestamp)
```

### DuplicatePaymentConfirmed

```solidity
event DuplicatePaymentConfirmed(address indexed agentVault, bytes32 transactionHash1, bytes32 transactionHash2)
```

Two transactions with the same payment reference, both from the agent's underlying address, were proved. Whole agent's position goes into liquidation. The challenger is rewarded from the agent's collateral.

### DustChanged

```solidity
event DustChanged(address indexed agentVault, uint256 dustUBA)
```

Due to lot size change, some dust was created for this agent during redemption. Value `dustUBA` is the new amount of dust. Dust cannot be directly redeemed, but it can be self-closed or liquidated and if it accumulates to more than 1 lot, it can be converted to a new redemption ticket.

### EmergencyPauseCanceled

```solidity
event EmergencyPauseCanceled()
```

Emergency pause was canceled.

### EmergencyPauseTotalDurationReset

```solidity
event EmergencyPauseTotalDurationReset()
```

Emergency pause total duration was reset by the governance.

### EmergencyPauseTriggered

```solidity
event EmergencyPauseTriggered(EmergencyPause.Level externalLevel, uint256 externalPausedUntil, EmergencyPause.Level governanceLevel, uint256 governancePausedUntil)
```

Emergency pause was triggered.

### FullLiquidationStarted

```solidity
event FullLiquidationStarted(address indexed agentVault, uint256 timestamp)
```

Agent entered liquidation state due to illegal payment. Full liquidation will always liquidate the whole agent's position and the agent can never use the same vault and underlying address for minting again.

### IllegalPaymentConfirmed

```solidity
event IllegalPaymentConfirmed(address indexed agentVault, bytes32 transactionHash)
```

An unexpected transaction from the agent's underlying address was proved. Whole agent's position goes into liquidation. The challenger is rewarded from the agent's collateral.

### LargeDirectMintingDelayed

```solidity
event LargeDirectMintingDelayed(bytes32 transactionId, uint256 amount, uint256 executionAllowedAt)
```

### LiquidationEnded

```solidity
event LiquidationEnded(address indexed agentVault)
```

Agent exited liquidation state as agent's position was healthy again and not in full liquidation.

### LiquidationPerformed

```solidity
event LiquidationPerformed(address indexed agentVault, address indexed liquidator, uint256 valueUBA, uint256 paidVaultCollateralWei, uint256 paidPoolCollateralWei)
```

Some of the agent's position was liquidated, by burning liquidator's fassets. Liquidator was paid in collateral with extra. The corresponding amount of underlying currency, held by the agent, is released and the agent can withdraw it (after underlying withdrawal announcement).

### LiquidationStarted

```solidity
event LiquidationStarted(address indexed agentVault, uint256 timestamp)
```

Agent entered liquidation state due to unhealthy position. The liquidation ends when the agent is again healthy or the agent's position is fully liquidated.

### MintingExecuted

```solidity
event MintingExecuted(address indexed agentVault, uint256 indexed collateralReservationId, uint256 mintedAmountUBA, uint256 agentFeeUBA, uint256 poolFeeUBA)
```

Minter paid underlying funds in time and received the fassets. The agent's collateral is locked.

### MintingPaused

```solidity
event MintingPaused(bool paused)
```

Minting was paused/unpaused by the governance.

### MintingPaymentDefault

```solidity
event MintingPaymentDefault(address indexed agentVault, address indexed minter, uint256 indexed collateralReservationId, uint256 reservedAmountUBA)
```

Minter failed to pay underlying funds in time. Collateral reservation fee was paid to the agent. Reserved collateral was released.

### PoolTokenRedemptionAnnounced

```solidity
event PoolTokenRedemptionAnnounced(address indexed agentVault, uint256 amountWei, uint256 withdrawalAllowedAt)
```

Agent has announced a withdrawal of collateral and will be able to redeem the announced amount of pool tokens after the timestamp `withdrawalAllowedAt`. If withdrawal was canceled (announced with amount 0), amountWei and withdrawalAllowedAt are zero.

### RedeemedInCollateral

```solidity
event RedeemedInCollateral(address indexed agentVault, address indexed redeemer, uint256 redemptionAmountUBA, uint256 paidVaultCollateralWei)
```

Due to self-close exit, some of the agent's backed fAssets were redeemed, but the redemption was immediately paid in collateral so no redemption process is started.

### RedemptionAmountIncomplete

```solidity
event RedemptionAmountIncomplete(address indexed redeemer, uint256 remainingAmountUBA)
```

In case there were not enough tickets or more than allowed number would have to be redeemed, only partial redemption is done and the `remainingAmountUBA` of the fassets are returned to the redeemer. Emitted by `redeemWithTag` and `redeemAmount`.

### RedemptionDefault

```solidity
event RedemptionDefault(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, uint256 redemptionAmountUBA, uint256 redeemedVaultCollateralWei, uint256 redeemedPoolCollateralWei)
```

The time for redemption payment is over and payment proof was not provided. Redeemer was paid in the collateral (with extra). The rest of the agent's collateral is released. The corresponding amount of underlying currency, held by the agent, is released and the agent can withdraw it (after underlying withdrawal announcement).

### RedemptionPaymentBlocked

```solidity
event RedemptionPaymentBlocked(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, uint256 redemptionAmountUBA, int256 spentUnderlyingUBA)
```

Agent provided the proof that redemption payment was attempted, but failed due to the redeemer's address being blocked (or burning more than allowed amount of gas). Redeemer is not paid and all of the agent's collateral is released. The underlying currency is also released to the agent.

### RedemptionPaymentFailed

```solidity
event RedemptionPaymentFailed(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, int256 spentUnderlyingUBA, string failureReason)
```

Agent provided the proof that redemption payment was attempted, but failed due to his own error. Also triggers payment default, unless the redeemer has done it already.

### RedemptionPerformed

```solidity
event RedemptionPerformed(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, bytes32 transactionHash, uint256 redemptionAmountUBA, int256 spentUnderlyingUBA)
```

Agent provided proof of redemption payment. Agent's collateral is released.

### RedemptionPoolFeeMinted

```solidity
event RedemptionPoolFeeMinted(address indexed agentVault, uint256 indexed requestId, uint256 poolFeeUBA)
```

At the end of a successful redemption, part of the redemption fee is re-minted as FAssets and paid to the agent's collateral pool as fee.

### RedemptionRejected

```solidity
event RedemptionRejected(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, uint256 redemptionAmountUBA)
```

Agent rejected the redemption payment because the redeemer's address is invalid.

### RedemptionRequestIncomplete

```solidity
event RedemptionRequestIncomplete(address indexed redeemer, uint256 remainingLots)
```

In case there were not enough tickets or more than allowed number would have to be redeemed, only partial redemption is done and the `remainingLots` lots of the fassets are returned to the redeemer.

### RedemptionRequested

```solidity
event RedemptionRequested(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, string paymentAddress, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, bytes32 paymentReference, address executor, uint256 executorFeeNatWei)
```

Redeemer started the redemption process and provided fassets. The amount of fassets corresponding to valueUBA was burned. Several RedemptionRequested events are emitted, one for every agent redeemed against (but multiple tickets for the same agent are combined). The agent's collateral is still locked.

### RedemptionTicketCreated

```solidity
event RedemptionTicketCreated(address indexed agentVault, uint256 indexed redemptionTicketId, uint256 ticketValueUBA)
```

Redemption ticket with given value was created (when minting was executed).

### RedemptionTicketDeleted

```solidity
event RedemptionTicketDeleted(address indexed agentVault, uint256 indexed redemptionTicketId)
```

Redemption ticket was deleted.

### RedemptionTicketUpdated

```solidity
event RedemptionTicketUpdated(address indexed agentVault, uint256 indexed redemptionTicketId, uint256 ticketValueUBA)
```

Redemption ticket value was changed (partially redeemed).

*Parameters:*

- `agentVault`
- `redemptionTicketId`
- `ticketValueUBA` — the ticket value after update

### RedemptionTicketsConsolidated

```solidity
event RedemptionTicketsConsolidated(uint256 firstTicketId, uint256 nextTicketId)
```

Method `consolidateSmallTickets` has finished.

*Parameters:*

- `firstTicketId` — first handled ticket id (different from the method param _firstTicketId if it was 0).
- `nextTicketId` — the first remaining (not handled) ticket id, or 0 if the end of queue was reached.

### RedemptionWithTagRequested

```solidity
event RedemptionWithTagRequested(address indexed agentVault, address indexed redeemer, uint256 indexed requestId, string paymentAddress, uint256 valueUBA, uint256 feeUBA, uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp, bytes32 paymentReference, address executor, uint256 executorFeeNatWei, uint256 destinationTag)
```

Redeemer started the redemption with tag process and provided fassets. The amount of fassets corresponding to valueUBA was burned. Several RedemptionWithTagRequested events are emitted, one for every agent redeemed against. (but multiple tickets for the same agent are combined). The agent's collateral is still locked. Such request can only be confirmed with `confirmXRPRedemptionPayment`.

### ReturnFromCoreVaultCancelled

```solidity
event ReturnFromCoreVaultCancelled(address indexed agentVault, uint256 indexed requestId)
```

The agent has cancelled the return request.

### ReturnFromCoreVaultConfirmed

```solidity
event ReturnFromCoreVaultConfirmed(address indexed agentVault, uint256 indexed requestId, uint256 receivedUnderlyingUBA, uint256 remintedUBA)
```

The payment from core vault to the agent's underlying address has been confirmed.

### ReturnFromCoreVaultRequested

```solidity
event ReturnFromCoreVaultRequested(address indexed agentVault, uint256 indexed requestId, bytes32 paymentReference, uint256 valueUBA)
```

The agent has requested return of some of the underlying from the core vault to the agent's underlying address.

### SelfClose

```solidity
event SelfClose(address indexed agentVault, uint256 valueUBA)
```

Agent self-closed valueUBA of backing fassets.

### SelfMint

```solidity
event SelfMint(address indexed agentVault, bool mintFromFreeUnderlying, uint256 mintedAmountUBA, uint256 depositedAmountUBA, uint256 poolFeeUBA)
```

Agent performed self minting, either by executing selfMint with underlying deposit or by executing mintFromFreeUnderlying (in this case, `mintFromFreeUnderlying` is true and `depositedAmountUBA` is zero).

### SettingArrayChanged

```solidity
event SettingArrayChanged(string name, uint256[] value)
```

A setting has changed.

### SettingChanged

```solidity
event SettingChanged(string name, uint256 value)
```

A setting has changed.

### SystemRedemptionFeePaid

```solidity
event SystemRedemptionFeePaid(address indexed agentVault, uint256 indexed requestId, uint256 feeUBA)
```

At the creation of a redemption request, the system redemption fee part of the redemption value was re-minted as FAssets to the system redemption fee receiver and the redemption value was lowered by the fee amount.

### TransferToCoreVaultDefaulted

```solidity
event TransferToCoreVaultDefaulted(address indexed agentVault, uint256 indexed transferRedemptionRequestId, uint256 remintedUBA)
```

Agent has cancelled transfer to the core vault without paying. The amount of `valueUBA` has been re-minted./

### TransferToCoreVaultStarted

```solidity
event TransferToCoreVaultStarted(address indexed agentVault, uint256 indexed transferRedemptionRequestId, uint256 valueUBA)
```

Agent has requested transfer of (some of) their backing to the core vault.

### TransferToCoreVaultSuccessful

```solidity
event TransferToCoreVaultSuccessful(address indexed agentVault, uint256 indexed transferRedemptionRequestId, uint256 valueUBA)
```

The transfer of underlying to the core vault was successfully completed.

### UnderlyingBalanceChanged

```solidity
event UnderlyingBalanceChanged(address indexed agentVault, int256 underlyingBalanceUBA)
```

Emitted whenever the tracked underlying balance changes.

### UnderlyingBalanceTooLow

```solidity
event UnderlyingBalanceTooLow(address indexed agentVault, int256 balance, uint256 requiredBalance)
```

Agent's underlying balance became lower than required for backing f-assets (either through payment or via a challenge. Agent goes to a full liquidation. The challenger is rewarded from the agent's collateral.

### UnderlyingBalanceToppedUp

```solidity
event UnderlyingBalanceToppedUp(address indexed agentVault, bytes32 transactionHash, uint256 depositedUBA)
```

Emitted when the agent tops up the underlying address balance.

### UnderlyingWithdrawalAnnounced

```solidity
event UnderlyingWithdrawalAnnounced(address indexed agentVault, uint256 indexed announcementId, bytes32 paymentReference)
```

Part of the balance in the agent's underlying address is "free balance" that the agent can withdraw. It is obtained from minting / redemption fees and self-closed fassets. Some of this amount should be left for paying redemption (and withdrawal) gas fees, and the rest can be withdrawn by the agent. However, withdrawal has to be announced, otherwise it can be challenged as illegal payment. Only one announcement can exist per agent - agent has to present payment proof for withdrawal before starting a new one.

### UnderlyingWithdrawalCancelled

```solidity
event UnderlyingWithdrawalCancelled(address indexed agentVault, uint256 indexed announcementId)
```

After announcing legal underlying withdrawal agent can cancel ongoing withdrawal. The reason for doing that would be in resetting announcement timestamp due to any problems with underlying withdrawal - in order to prevent others to confirm withdrawal before agent and get some of his collateral.

### UnderlyingWithdrawalConfirmed

```solidity
event UnderlyingWithdrawalConfirmed(address indexed agentVault, uint256 indexed announcementId, int256 spentUBA, bytes32 transactionHash)
```

After announcing legal underlying withdrawal and creating transaction, the agent must confirm the transaction. This frees the announcement so the agent can create another one. If the agent doesn't confirm in time, anybody can confirm the transaction after several hours. Failed payments must also be confirmed.

### VaultCollateralWithdrawalAnnounced

```solidity
event VaultCollateralWithdrawalAnnounced(address indexed agentVault, uint256 amountWei, uint256 withdrawalAllowedAt)
```

Agent has announced a withdrawal of collateral and will be able to withdraw the announced amount after timestamp `withdrawalAllowedAt`. If withdrawal was canceled (announced with amount 0), amountWei and withdrawalAllowedAt are zero.
