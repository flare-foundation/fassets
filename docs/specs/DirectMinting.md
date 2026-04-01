# Direct minting

In the direct minting the minter simply creates a transaction on the underlying chain (currently, only XRP is supported). The transaction contains either a specially crafted memo field or a tag. If there is a tag, the `MintingTagManager` contract has method `mintingRecipient`, which returns the target address that receives the minted amount.

## Minting tag manager

The contract `MintingTagManager` allows a user to reserve a minting tag and to set minting recipient and executor for this tag. Since there is a limited amount of (XRP) tags available, the user must pay a reservation fee (`reservationFee`) in native currency (FLR/SGB) to avoid using up all tags. At reservation, the user always receives the next available tag. Minting tag manager implements ERC-721 non-fungible token interface, so that reserved minting tags can be transferred (or resold) to another owner.

The owner of the tag can set minting recipient with the method `setMintingRecipient` and the preferred executor with the method `setAllowedExecutor`. If the allowed executor is address zero (default), anybody can execute mintings with this tag. On initial reservation and tag transfer, the recipient is automatically reset to the new owner and the executor is reset to zero address.

## Executors

The minting is triggered by calling method `executeDirectMinting`, which is performed by the *executor*. The executor is paid executor's fee upon successful completion.

The executor can be restricted by the minter in three possible ways, depending if the memo field or tag is used or if the minting is to the smart account:
- For direct minting with tag, the tag manager has methods `setAllowedExecutor` for defining and `allowedExecutor` for reading the executor. If `allowedExecutor` is zero, anybody can execute.
- For direct minting with memo field, a different format is used - instead of 32-byte standard payment reference, the 48-byte format is used - 8-byte prefix (DIRECT_MINTING_EX = 0x4642505266410021), followed by 20-byte recipient address and finally 20-byte executor address.
- For direct minting to smart account, the smart account manager may restrict executor - asset manager passes every request.

If the allowed executor doesn't execute transaction for long enough (setting `othersCanExecuteAfterSeconds`), meaning that current underlying block is that much after the timestamp of the minting payment, then anybody can execute the minting.

For mintings to address (via tag or DIRECT_MINTING_EX memo field), the executor fee is constant and is defined by the setting `directMintingExecutorFeeUBA`. For direct minting to smart account, the executor fee is calculated and charged by the smart account manager.

## Rate limits

To limit the possibility of asset theft if something (e.g. FDC) gets compromised, the direct minting has several rate limits. The total minted amount is limited on hourly and daily basis. The hourly mint amount limit is called `directMintingHourlyLimitUBA` and the daily `directMintingDailyLimitUBA`. Note that rate limiter only throttles mintings, it never prevents them: when the limit is reached, the further mintings are delayed by the time proportional to the accumulated backlog. The backlog decays by one window’s worth of capacity per elapsed window.

Large mintings (above `directMintingLargeMintingThresholdUBA`) are not counted into normal minting quota; instead, every large minting is automatically delayed by `directMintingLargeMintingDelaySeconds`.

When a minting is delayed, instead of `DirectMintingExecuted` event, `DirectMintingDelayed` event  is emitted. It contains field `executionAllowedAt`, which signifies the timestamp when the minting can be executed. The delay is proportional to how much the current requested total minting amount exceeds the limit. Once a minting's `executionAllowedAt` timestamp is reached or the minting is unblocked, the executor can execute the minting again and it will succeed.

If the limit has been reached, the governance can allow all delayed mintings started until certain timestamp to be executed by calling `unblockDirectMintingsUntil`. The timestamp passed to `unblockDirectMintingsUntil` has to be in the past, because it is assumed that the transactions have been manually checked before execution. All the mintings that had been started (i.e. when `DirectMintingDelayed` event was emitted) before that time can now be executed.

If a minting is delayed and has set preferred executor, the time for the preferred executor's exclusive execution right starts counting again when minting is allowed to execute (`executionAllowedAt`). In case of governance unblocking the minting, the `executionAllowedAt` for a minting doesn't change automatically (although the minting can be executed), but it can be reset to the time of unblocking by calling method `markUnblockedDirectMintingAllowed`.
