# ICollateralPoolToken

## Methods

### collateralPool

```solidity
function collateralPool() external view returns (address)
```

Returns the address of the collateral pool that issued this token.

### lockedBalanceOf

```solidity
function lockedBalanceOf(address _account) external view returns (uint256)
```

Returns the amount of tokens that are cannot be transferred. These are tokens that are either timelocked or locked due to fasset fee debt.

*Parameters:*

- `_account` — user's account address

### transferableBalanceOf

```solidity
function transferableBalanceOf(address _account) external view returns (uint256)
```

Returns the amount of tokens that can be transferred. These are tokens that are neither timelocked neither locked due to fasset fee debt.

*Parameters:*

- `_account` — user's account address

### debtLockedBalanceOf

```solidity
function debtLockedBalanceOf(address _account) external view returns (uint256)
```

Returns the amount of account's tokens that are locked due to account's fasset fee debt.

*Parameters:*

- `_account` — user's account address

### debtFreeBalanceOf

```solidity
function debtFreeBalanceOf(address _account) external view returns (uint256)
```

Returns the amount of account's tokens that are not locked due to account's fasset fee debt.

*Parameters:*

- `_account` — user's account address

### timelockedBalanceOf

```solidity
function timelockedBalanceOf(address _account) external view returns (uint256)
```

Returns the amount of account's tokens that are timelocked.

*Parameters:*

- `_account` — user's account address

### nonTimelockedBalanceOf

```solidity
function nonTimelockedBalanceOf(address _account) external view returns (uint256)
```

Returns the amount of account's tokens that are not timelocked.

*Parameters:*

- `_account` — user's account address

### allowance

```solidity
function allowance(address owner, address spender) external view returns (uint256)
```

Returns the remaining number of tokens that `spender` will be allowed to spend on behalf of `owner` through {transferFrom}. This is zero by default. This value changes when {approve} or {transferFrom} are called.

### approve

```solidity
function approve(address spender, uint256 amount) external returns (bool)
```

Sets `amount` as the allowance of `spender` over the caller's tokens. Returns a boolean value indicating whether the operation succeeded. IMPORTANT: Beware that changing an allowance with this method brings the risk that someone may use both the old and the new allowance by unfortunate transaction ordering. One possible solution to mitigate this race condition is to first reduce the spender's allowance to 0 and set the desired value afterwards: https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729 Emits an {Approval} event.

### balanceOf

```solidity
function balanceOf(address account) external view returns (uint256)
```

Returns the amount of tokens owned by `account`.

### totalSupply

```solidity
function totalSupply() external view returns (uint256)
```

Returns the amount of tokens in existence.

### transfer

```solidity
function transfer(address to, uint256 amount) external returns (bool)
```

Moves `amount` tokens from the caller's account to `to`. Returns a boolean value indicating whether the operation succeeded. Emits a {Transfer} event.

### transferFrom

```solidity
function transferFrom(address from, address to, uint256 amount) external returns (bool)
```

Moves `amount` tokens from `from` to `to` using the allowance mechanism. `amount` is then deducted from the caller's allowance. Returns a boolean value indicating whether the operation succeeded. Emits a {Transfer} event.

## Events

### Approval

```solidity
event Approval(address indexed owner, address indexed spender, uint256 value)
```

Emitted when the allowance of a `spender` for an `owner` is set by a call to {approve}. `value` is the new allowance.

### Transfer

```solidity
event Transfer(address indexed from, address indexed to, uint256 value)
```

Emitted when `value` tokens are moved from one account (`from`) to another (`to`). Note that `value` may be zero.
