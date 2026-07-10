# ICollateralPool

## Methods

### enter

```solidity
function enter() external payable returns (uint256 _receivedTokens, uint256 _timelockExpiresAt)
```

Enters the collateral pool by depositing NAT. The tokens have a timelock before which exiting or transferring tokens is not possible. If there are some FAsset fees already in the pool, tokens also have some fee debt, which has to be paid off to make tokens transferable (but they can be redeemed).

### exit

```solidity
function exit(uint256 _tokenShare) external returns (uint256 _natShare)
```

Exits the pool by redeeming the given amount of pool tokens for a share of NAT and f-asset fees. Exiting only returns collateral, the fasset fees must be separately collected by calling `withdrawFees`. Exiting with collateral that lowers pool's collateral ratio below exit CR is not allowed and will revert. In that case, see selfCloseExit.

*Parameters:*

- `_tokenShare` — The amount of pool tokens to be redeemed

### selfCloseExit

```solidity
function selfCloseExit(uint256 _tokenShare, bool _redeemToCollateral, string _redeemerUnderlyingAddress, address payable _executor) external payable
```

Exits the pool by redeeming the given amount of pool tokens and burning f-assets in a way that doesn't endanger the pool collateral ratio. Specifically, if pool's collateral ratio is above exit CR, then the method burns an amount of user's f-assets that do not lower collateral ratio below exit CR. If, on the other hand, collateral pool is below exit CR, then the method burns an amount of user's f-assets that preserve the pool's collateral ratio. The method always burns fassets from user address even if the user has some fasset fees in the pool (those can be collected before using selfCloseExit). F-assets will be redeemed in collateral if their value does not exceed one lot, regardless of  `_redeemToCollateral` value. In case of self-close via redemption, the user can set executor to trigger possible default. In this case, some NAT can be sent with transaction, to pay the executor's fee.

*Parameters:*

- `_tokenShare` — The amount of pool tokens to be liquidated
- `_redeemToCollateral` — Specifies if redeemed f-assets should be exchanged to vault collateral                                      by the agent
- `_redeemerUnderlyingAddress` — Redeemer's address on the underlying chain
- `_executor` — The account that is allowed to execute redemption default

### withdrawFees

```solidity
function withdrawFees(uint256 _amount) external
```

Collect f-asset fees by locking an appropriate ratio of transferable tokens

*Parameters:*

- `_amount` — The amount of f-asset fees to withdraw.                 Must be positive and smaller or equal to the sender's fAsset fees.

### exitTo

```solidity
function exitTo(uint256 _tokenShare, address payable _recipient) external returns (uint256 _natShare)
```

Exits the pool by redeeming the given amount of pool tokens for a share of NAT and f-asset fees. Exiting only returns collateral, the fasset fees must be separately collected by calling `withdrawFees`. Exiting with collateral that lowers pool's collateral ratio below exit CR is not allowed and will revert. In that case, see selfCloseExit.

*Parameters:*

- `_tokenShare` — The amount of pool tokens to be redeemed
- `_recipient` — The address to which NATs and FAsset fees will be transferred

### selfCloseExitTo

```solidity
function selfCloseExitTo(uint256 _tokenShare, bool _redeemToCollateral, address payable _recipient, string _redeemerUnderlyingAddress, address payable _executor) external payable
```

Exits the pool by redeeming the given amount of pool tokens and burning f-assets in a way that doesn't endanger the pool collateral ratio. Specifically, if pool's collateral ratio is above exit CR, then the method burns an amount of user's f-assets that do not lower collateral ratio below exit CR. If, on the other hand, collateral pool is below exit CR, then the method burns an amount of user's f-assets that preserve the pool's collateral ratio. The method always burns fassets from user address even if the user has some fasset fees in the pool (those can be collected before using selfCloseExit). F-assets will be redeemed in collateral if their value does not exceed one lot, regardless of  `_redeemToCollateral` value. In case of self-close via redemption, the user can set executor to trigger possible default. In this case, some NAT can be sent with transaction, to pay the executor's fee.

*Parameters:*

- `_tokenShare` — The amount of pool tokens to be liquidated
- `_redeemToCollateral` — Specifies if redeemed f-assets should be exchanged to vault collateral                                      by the agent
- `_recipient` — The address to which NATs and FAsset fees will be transferred
- `_redeemerUnderlyingAddress` — Redeemer's address on the underlying chain
- `_executor` — The account that is allowed to execute redemption default

### withdrawFeesTo

```solidity
function withdrawFeesTo(uint256 _amount, address _recipient) external
```

Collect f-asset fees by locking an appropriate ratio of transferable tokens

*Parameters:*

- `_amount` — The amount of f-asset fees to withdraw.                      Must be positive and smaller or equal to the sender's fAsset fees.
- `_recipient` — The address to which FAsset fees will be transferred

### payFAssetFeeDebt

```solidity
function payFAssetFeeDebt(uint256 _fassets) external
```

Unlock pool tokens by paying f-asset fee debt

*Parameters:*

- `_fassets` — The amount of debt f-asset fees to pay for

### claimAirdropDistribution

```solidity
function claimAirdropDistribution(IDistributionToDelegators _distribution, uint256 _month) external returns (uint256 _claimedAmount)
```

Claim airdrops earned by holding wrapped native tokens in the pool.

NOTE: only the owner of the pool's corresponding agent vault may call this method.

*Parameters:*

- `_distribution` — the airdrop distribution contract
- `_month` — the month for which the claim is made

### optOutOfAirdrop

```solidity
function optOutOfAirdrop(IDistributionToDelegators _distribution) external
```

Opt out of airdrops for wrapped native tokens in the pool.

NOTE: only the owner of the pool's corresponding agent vault may call this method.

*Parameters:*

- `_distribution` — the airdrop distribution contract

### delegate

```solidity
function delegate(address _to, uint256 _bips) external
```

Delegate WNat vote power for the wrapped native tokens held in this vault.

NOTE: only the owner of the pool's corresponding agent vault may call this method.

*Parameters:*

- `_to` — the address to which the delegation goes (the delegatee)
- `_bips` — the delegation share (to be spent between at most two delegatees)

### undelegateAll

```solidity
function undelegateAll() external
```

Clear all WNat delegations.

### claimDelegationRewards

```solidity
function claimDelegationRewards(IRewardManager _rewardManager, uint24 _lastRewardEpoch, RewardsV2Interface.RewardClaimWithProof[] _proofs) external returns (uint256 _claimedAmount)
```

Claim the rewards earned by delegating the vote power for the pool.

NOTE: only the owner of the pool's corresponding agent vault may call this method.

*Parameters:*

- `_rewardManager` — the reward manager contract address
- `_lastRewardEpoch` — all unclaimed epochs until this one will be claimed
- `_proofs` — the proofs of the collateral pool's claims

### poolToken

```solidity
function poolToken() external view returns (ICollateralPoolToken)
```

Get the ERC20 pool token used by this collateral pool

### agentVault

```solidity
function agentVault() external view returns (address)
```

Get the vault of the agent that owns this collateral pool

### exitCollateralRatioBIPS

```solidity
function exitCollateralRatioBIPS() external view returns (uint32)
```

Get the exit collateral ratio in BIPS This is the collateral ratio below which exiting the pool is not allowed

### totalCollateral

```solidity
function totalCollateral() external view returns (uint256)
```

Return total amount of collateral in the pool. This can be different to WNat.balanceOf(poolAddress), because the collateral has to be tracked to prevent unexpected deposit type of attacks on the pool.

### fAssetFeesOf

```solidity
function fAssetFeesOf(address _account) external view returns (uint256)
```

Returns the f-asset fees belonging to this user. This is the amount of f-assets the user can withdraw by burning transferable pool tokens.

*Parameters:*

- `_account` — User address

### totalFAssetFees

```solidity
function totalFAssetFees() external view returns (uint256)
```

Returns the total f-asset fees in the pool. This can be different to FAsset.balanceOf(poolAddress), because the collateral has to be tracked to prevent unexpected deposit type of attacks on the pool.

### fAssetFeeDebtOf

```solidity
function fAssetFeeDebtOf(address _account) external view returns (int256)
```

Returns the user's f-asset fee debt. This is the amount of f-assets the user has to pay to make all pool tokens transferable. The debt is created on entering the pool if the user doesn't provide the f-assets corresponding to the share of the f-asset fees already in the pool.

*Parameters:*

- `_account` — User address

### totalFAssetFeeDebt

```solidity
function totalFAssetFeeDebt() external view returns (int256)
```

Returns the total f-asset fee debt for all users.

### fAssetRequiredForSelfCloseExit

```solidity
function fAssetRequiredForSelfCloseExit(uint256 _tokenAmountWei) external view returns (uint256)
```

Get the amount of fassets that need to be burned to perform self close exit.

## Events

### CPEntered

```solidity
event CPEntered(address indexed tokenHolder, uint256 amountNatWei, uint256 receivedTokensWei, uint256 timelockExpiresAt)
```

### CPExited

```solidity
event CPExited(address indexed tokenHolder, uint256 burnedTokensWei, uint256 receivedNatWei)
```

### CPSelfCloseExited

```solidity
event CPSelfCloseExited(address indexed tokenHolder, uint256 burnedTokensWei, uint256 receivedNatWei, uint256 closedFAssetsUBA)
```

### CPFeeDebtPaid

```solidity
event CPFeeDebtPaid(address indexed tokenHolder, uint256 paidFeesUBA)
```

### CPFeesWithdrawn

```solidity
event CPFeesWithdrawn(address indexed tokenHolder, uint256 withdrawnFeesUBA)
```

### CPFeeDebtChanged

```solidity
event CPFeeDebtChanged(address indexed tokenHolder, int256 newFeeDebtUBA)
```

### CPPaidOut

```solidity
event CPPaidOut(address indexed recipient, uint256 paidNatWei, uint256 burnedTokensWei)
```

### CPClaimedReward

```solidity
event CPClaimedReward(uint256 amountNatWei, uint8 rewardType)
```
