# Core Vault
The Core Vault (CV) is an FAsset system vault operated on an underlying chain and storing funds in the form of the underlying asset.
A CV serves only a single chain.
Funds stored in the CV do not need to be fully [collateralized](Collateral.md): thus, the CV improves liquidity of the FAsset system and eases demands on the agents.

FAsset agents can transfer funds to the CV, and funds stored in the CV do not need to be backed with additional collateral.
This frees up agent collateral for additional minting or withdrawal.
When an agent doesn’t have any minted lots, or when there are more [redemptions](Redemption.md) than [mintings](Minting.md), the agent can request that the underlying assets are returned from the CV to the agent.
Additionally, in certain contexts users can directly redeem from the CV.

## Transfer to Core Vault
An agent can transfer funds to the CV at any time.
Transfers to the CV are implemented as redemptions, with the beneficiary being the CV address.
They are initiated on Flare, with the corresponding transfer performed on the source chain.
To transfer funds from their underlying address to the CV, an agent follows the following process:

1. The agent calls `transferToCoreVault` on the Asset Manager contract on the Flare network, with inputs $(A_C, x)$ specifying the amount $x$ of funds to transfer and receiving agent address on source chain $C$. 
2. The FAsset system creates a specialized redemption request for the transfer. This redemption specifies the amount of funds $x$ to be transferred and locks the corresponding agent collateral on Flare. A payment reference $\mathrm{ref}$ is generated in this step in line with a standard redemption request.
3. The agent transfers the amount $x$ of funds to the CV address on $C$, including $\mathrm{ref}$ as a payment reference.
4. The agent submits an attestation request to the FDC proving the existence of the payment on $C$. The FDC returns a `proof` of the payment.
5. The agent calls `confirmRedemptionPayment` on the Asset Manager contract including as arguments (`proof`, $\mathrm{ref})$. At this stage, the transfer is completed and the agent's collateral is released.

Note that the agent can only initialize a transfer of size $x$ if its remaining funds as a percentage of backed FAssets after the transfer exceed a system parameter `minUnderlyingBackingBIPS` and its total funds exceeds `minimumAmountLeftUBA`.
Additionally, the maximum amount that can be transferred is bounded by `maximumTransferUBA` 
These parameters can be queried on the Asset Manager contract by calling `maximumTransferToCoreVault`.

### Defaulted Transfers
Defaults in CV transfers are handled differently to ordinary redemption defaults.
If the agent fails to pay in the allotted time period (a window of several hours), the agent defaults and calls `redemptionPaymentDefault`.
Since the redemption has no redeemer, no collateral is paid out.
Instead, a [redemption ticket](Minting.md#redemption-tickets) $(\text{id}, A_v, x)$ is created for the agent at the end of the redemption queue, where $A_v$ is the agent's vault.
If the agent fails to call this function in the allotted time window, any one can call the default and be rewarded from the agent vault as usual.

## CV Transactions
There are two mechanisms by which agents can receive underlying asset from the CV:

- Locking additional collateral on Flare.
- Redeeming FAssets at the CV.

To receive funds by locking collateral, the agent files a request for return of the underlying asset, locks collateral on Flare, and receives the asset in exchange.
To receive funds via redemption, the agent simply redeems its own FAssets in exchange from the underlying assets directly from the CV.
However, direct redemptions from the CV are only available to users whose underlying address is included in the `allowedDestinations` list in the `CoreVaultManager` contract, a list of addresses pre-approved by governance.

These processes are laid out in more detail below.

### Request for Return
1. The agent calls `requestReturnFromCoreVault` on Flare, including as arguments $(A_v, \ell)$, the agent vault address and the number of lots $\ell$ to return.
2. A corresponding collateral reservation is created and an amount of agent collateral sufficient to back $\ell$ lots of the underyling asset is locked.
3. The request is forwarded to the Core Vault Manager, which may merge it with other pending requests to the same agent.
4. The request is processed by the CV triggering address calling `triggerInstructions`, which updates CV accounting and triggers a `TransferRequest` event. These events are consumed by the CV operators who will take action based on the event observed.
5. The CV transfers $\ell$ lots to agent’s underlying address $A_C$.
6. The agent (or any entity) presents a proof of payment to the Asset Manager contract via `confirmCoreVaultReturnPayment`, with the proof obtained via the FDC.
7. A redemption ticket $(\text{id}, A_v, x)$ is created for the agent, and the agent can redeem FAssets

Note that before the return request is processed, the agent can cancel it via `cancelReturnFromCoreVault` at the Core Vault Manager contract, releasing the reserved collateral.

### Redeeming from the CV directly
1. The user calls `redeemFromCoreVault` on the Asset Manager contract, including as arguments $(\ell, U_C)$ the number of lots to redeem and user's underlying address on $C$.  
2. The FAsset system burns $\ell$ lots of the user's FAssets. If the user does not have enough FAssets to cover this burn, the redemption fails at this stage.
3. A `CoreVaultRedemptionRequested` event is triggered, containing the triplet $(\ell, U_C, \text{ref})$ storing the redemption information and a unique payment reference.
4. The request is forwarded to the Core Vault Manager contract. At this stage, the redemption request may be batched together with other open requests to the same address. Nominally, the CV has unlimited time to honor redemptions, facilitating this batching.
5. The CV transfers an amount $(\ell \cdot \ell_x) \cdot (1 - \text{redemptionFeeBIPS})$ of the asset to $U_C$ on $C$. Here, $\ell_x$ is the number of units of the asset $x$ in a lot and `redemptionFeeBIPS` defines the redemption fee.

The value $\ell$ must exceed an amount `minimumRedeemLots`, stored on the CV contract, unless the total funds in the CV is below this bound. 

Direct sending and receiving to the CV can be halted by governance at any time: the Core Vault Manager has an emergency pause mechanism, which can be used in the event of a CV compromise.


## Technical Specifications of the XRP CV
Currently, the only deployed CV handles FXRP.
The FXRP CV is implemented as a multisig address on XRPL.
The master key transaction type is disabled on the CV account, so that all transactions require the multisig signers. 
The CV supports two types of transactions: payment transactions to agent addresses, and `EscrowCreate` transactions which create escrows.

### Payment Transactions
Payment transactions are standard XRP transactions that must be signed by the multisig holders.
They support the payment types listed above.
Multisig signers are responsible for validating that the transaction data emitted by CV smart contracts is valid; that the amount is within allowed limits and that the destination address is approved. 
Assuming the checks pass, multisig members sign the transaction and send the signed transaction back to Flare.

### Escrow Transactions
Escrows are created to rate limit the release of funds.
Funds are held in escrow and returned to the CV periodically, only released in case of emergency.
The escrows have a hash condition, so that Flare can present preimages (secret values authorized to trigger escrow transactions) and trigger the transfer to the custodian wallet immediately.
Preimages are held by a trusted party at Flare that can reveal them in case of emergency.

Each escrow holds a lot of size $L$ of an asset, time locked with a safe custodian address as the destination.
Thus, an escrow $e_i$ stores $(L, t_i, \text{Cust}_i)$, defining the amount of funds, expiry time, and custodian address.
At expiry time $t_i$, the funds are returned to the CV.
However, if the appropriate preimages are released before expiry, then the custodian receives the funds.
The release takes the form of a signed `EscrowCancel` transaction holding the preimages.
A single escrows is created each operation day, so that each day at least one expiry $t_i$ is reached.

### Instruction Sourcing
Members of the multisig are informed on what transactions to sign by a smart contract on Flare.
This contract:

- Holds a sequence of transactions to be signed.
- Knows the underlying address of the custodian wallet.
- Has access to the FAsset agents list.
- Can emit an escrow time lock command for multisig members to sign.
- Can emit payment transaction commands.

All commands emitted by this contract are within scope of predefined rules.
All transactions are checked by both members of the multisig and the executor before being executed.
If any of these entities spots a problem, the system enters [(]red alert mode](#red-alert-mode) and operations are halted.

### Transaction collection and execution
Members of the multisig must send the signed transactions to the backend that collects the events emitted by the contract and generates the transactions accordingly.
If the signed transactions deposited by the signers don't match what the backend is expecting, the system enters red alert mode.

Once a sufficient number of signatures are collected for a transaction, a notification is triggered.
On this trigger, a member of the execution group runs a script that assembles the transaction and sends it to the XRPL mempool.
The assembler and execution backend is developed by Flare.

### Security
During normal operation of the XRP CV, one escrow of size $L$ expires to the main multisig per operation day.
This limits the amount released from the CV per operation day to $1L$ plus the amount that agents transferred to the CV since the last operation day.
Note that as soon as $M + L$ tokens are available on CV, an `escrowCreate` event is triggered, where $M$ denotes the minimum amount of funds allowed in the CV.
If there is more than a maximum amount $V$ of assets in the CV that are not escrowed the system goes into red alert mode, and more escrows are triggered manually.

If a critical attack is detected, such as if keys are stolen, the preimages for escrows are published and the funds are released to the custodian address.
Once the problem is resolved, a new multisig must be created to be used by CV.

## Red Alert Mode
*Red alert mode* is triggered in cases where the system detects an issue.Red alert mode is triggered manually by Flare response team members that are on duty, either in response to rogue inputs to the CV or communications with multisig members.

When red alert mode triggers, all members of the multisig are alerted and the Flare response team investigates the issue.
All signing operations are stopped, and do not resume until a meeting is called to discuss an incident report with multisig members.
Assuming such a meeting is successful, signing can resume.

Note that the response team must be able to use preimages if they deem it necessary.
Thus, they have access to the preimages to trigger releasing funds to the custodian.
The response team is also able to pause all CV interactions within the FAsset system.
To turn this back on, an FAsset governance call is required.