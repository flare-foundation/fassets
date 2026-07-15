# Minting
Minting is the process by which FAsset representations of external assets are created on the Flare network.
To mint an FAsset, the user must lock the equivalent amount of assets on the source chain at the address of an FAsset [agent](Agents.md). 
This page documents the minting process for an FAsset.

## Minting flow
Any user (referred to as the **minter**) can start a minting operation.
From the user perspective, minting is a three step process: the user first reserves some agent collateral on Flare, then transfers an appropriate amount of funds to the agent's address on the source chain.
Once these stages are completed, the user brings the payment onto Flare using the FDC and receives their FAssets.
Thus, minting creates the user FAssets in return for a payment on the source chain.

Formally, to mint an amount $x$ of an FAsset copy of an asset from chain $C$, the user $U$ completes the following process:

1. The user selects an FAsset agent address $A_C$ from the list of $L_{\mathrm{agents}}$ of FAsset agents.
2. The minter calls `reserveCollateral` on the Asset Manager contract, starting a Collateral Reservation Transaction (CRT), with parameters $\mathrm{CRT}(A_C, l_x, \mathrm{fee}, E)$. The minter includes a collateral reservation fee $\text{CRF}_U(x)$ payment, paid in Flare, as part of the CRT. The CRT returns a reservation id $\text{CR}_\text{id}$. The parameters indicate:
    - $A_C$: The underlying address of the chosen agent.
    - $l_x$: The amount to be minted, denoted in number of required [lots](#lots-and-dust).
    - $\mathrm{fee}$: The maximum minting fee the user will accept, in BIPS (`_maxMintingFeeBIPS`). The transaction reverts if the agent's fee exceeds this.
    - $E$ (optional): An *executor* address which can trigger minting execution once the underlying payment is finalized and proved. If an executor is used, the minter includes an additional FLR payment in its request to compensate the executor.
3. The contract locks an amount $x_{\text{col}}$ of the agent's collateral equal to the amount needed to back the whole minting.
4. In response to a valid CRT, a Collateral Reservation Response (CRR) event, $\mathrm{CRR}(A_C, C_x, C_{\mathrm{fee}}, \mathrm{ref}, t)$ is issued by the Asset Manager contract, which includes:
    - $A_C$: The agent’s address on $C$.
    - $C_x$: The amount of the asset the minter must send to the agent on $C$.
    - $C_{\mathrm{fee}}$: The fee to be paid by the user on $C$ for the payment
    - $\mathrm{ref}$: A *payment reference*, a unique $32$-byte number the minter should include as a memo in their payment on the underlying chain.
    - $t = (B_t, T_t)$: The last underlying block and timestamp by which the user must pay the agent on $C$, both inclusive.
5. Once the CRR is issued, the minter initiates a transaction, denoted $\mathrm{dep}(C_x)$, on $C$ transferring the amount $C_x$ to the agent address $A_C$. Included in this transaction is the payment reference $\text{ref}$. This transaction is referred to as the *deposit*, and must be completed in the timeframe indicated by $t$.
6. Once the deposit is completed, the minter (or executor) submits an attestation request $\mathrm{FDC}(\mathrm{dep}_x)$ to the FDC, returning `proof`, confirming the existence of the transaction $\mathrm{dep}_x$ on $C$.
7. Once the FDC confirms the existence of the deposit transaction, the minter can call the `executeMinting` function at the Asset Manager contract, with inputs (`proof`, $\text{CR}_\text{id})$. This credits the user's account with an amount $x'$ of the FAsset, the minted amount minus a small [fee](#minting-fees). At this stage, minting is completed for the user.
8. Once FAssets are minted, the Asset Manager creates a [redemption ticket](#redemption-tickets) for the minting.
9. Once minting is executed, the minting fee $\text{MF}(x)$ for minting $x$ of the FAsset is split between the agent and the agent's pool:
    - The agent is paid by increasing the free balance on the agent’s underlying address by an amount $\text{MF}_{\mathrm{agent}}(x)$.
    - The pool share gets minted as an amount $\text{MF}_{\mathrm{pool}}(x)$ of FAssets and credited to the collateral pool contract.

## Minting Fees
The amount minted and paid by the user is impacted by minting fees.
The minting user specifies an amount $x$ of FAssets to mint, but must pay a slightly higher amount $C_x$ to pay an agent fee on the chain.
Similarly, they receive an amount $x' < x$ of the FAsset after minting, with the rest deducted to pay the collateral pool.

### Minter Perspective
The rest of this section lays out the fees from the perspective of the agent and its [collateral pool](#collateral-pool), who receive them.
To simplify exposition, this subsection lays out fees from the user perspective.

The user pays fees in two parts: `collateralReservationFeeBIPS` and `feeBIPS`.
Both are expressed as a percentage of the value of $x$ of the asset.
The user first pays the CRF as 
$$
\text{collateralReservationFeeBips} \cdot \text{FTSO}_{X, \text{FLR}}(x)
$$ 
in FLR, where $\text{FTSO}_{X, \text{FLR}}(x)$ denotes the FTSO value of the amount $x$ of asset $X$ in FLR.
Then, they pay an amount $C_x$ on $C$ to the agent and receive an amount $x'$ of FAsset.
The fee $C_x - x'$ as a percentage of the value $x$ is determined by `feeBIPS`, with 
$$
\text{feeBIPS} \cdot x = C_x - x'
$$.
Thus, the total fee paid by the user to mint an amount $x$ of the FAsset is
$$
\text{feeBIPS} \cdot x + \text{collateralReservationFeeBips} \cdot \text{FTSO}_{X, \text{FLR}}(x).
$$

### Fee Parameters
The parameter `collateralReservationFeeBIPS` is a global parameter controlled by governance, the same for all agents.
The current size of the collateral reservation fee can be obtained by calling `collateralReservationFee` on the Asset Manager contract.

Each FAsset agent is free to determine its own fee `feeBIPS`, set as a percentage of the amount of minted assets.
Users can query the agent's fee by calling `getAgentSetting` on the Asset Manager contract, including as arguments the `agentVault` in question and `feeBIPS`.

### Splitting the Fees
Minting fees $\text{MF}(x)$ for an FAsset minting transaction come in two parts: the Collateral Reservation Fee $\text{CRF}(x)$ required to reserve collateral during the minting process, paid in native tokens, and $\text{MFC}(x)$, the *source chain minting fee* on $C$, paid in a mix of the underlying asset and FAsset.
That is,
$$
\text{MF}(x) = \text{CRF}(x) + \text{MFC}(x).
$$
The value and distribution of these fees is laid out below.

### Distributing the Minting Fee
The minting fee $\text{MF}(x)$ is split between the agent and the collateral providers in two parts.
The split is defined by the parameter `poolFeeShareBips`, defining the percentage of the fee that is received by the pool, with the rest going to the agent.
It is set at the initiation of the Agent Vault, and can be queried at the Asset Manager contract by any user calling `getAgentSettings` with input the Agent Vault and `poolFeeShareBIPS`.
The distribution of the two component rewards $\text{CRF}(x)$ and $\text{MFC}(x)$ are distinct, and laid out in their own subsections below.

Fees assigned to the collateral pool are further distributed among collateral providers accordingly to their stake in the pool.
That is, a provider with an amount $p$ of locked collateral in an agent's collateral pool with a total of $\vert A_P \vert$ collateral is entitled to a share
$$
\frac{p}{\vert A_P \vert} \cdot \text{poolFeeShareBIPS}
$$
of the agent's minting rewards.

### Collateral Reservation Fee
The *Collateral Reservation Fee* $\text{CRF}_U(x)$ is paid by the user as part of the collateral reservation request.
At the successful end of the minting or in case of minting payment failure, the CRF is paid to the agent and its pool directly, split according to `poolFeeShareBIPS`.

The CRF is paid in the native FLR and the amount required
$$
\text{CRF}(x) := \text{collateralReservationFeeBips} \cdot \text{FTSO}_{X, \text{FLR}}(x)
$$
is defined as a percentage `collateralReservationFeeBIPS` of the minted value of the amount $x$ of FAsset $X$.

If the actual amount paid $\text{CRF}_U(x)$ in `reserveCollateral` by a minter is greater than the necessary fee $\text{CRF}(x)$, the remaining currency $\text{CRF}_U(x) - \text{CRF}(x)$ is paid as the executor’s fee for handling the minting.
If no executor is used and the CRF is too high, the excess is instead returned to the user.

### The Minting Fee
The source chain minting fee $\text{MFC}(x)$ is paid by the user in a mix of FAsset and underlying asset.
The minting fee is computed as
$$
\text{MFC}(x) = x \cdot \text{feeBIPS}.
$$

The proportion of fees assigned to the pool is defined by the `poolFeeShareBIPS`.
The first part of the fee
$$x \cdot \text{feeBIPS} \cdot \text{poolFeeShareBips}
$$
is deducted from the user's minted FAsset and assigned to the agent's collateral pool.
The rest, 
$$
x \cdot \text{feeBIPS} \cdot (1 - \text{poolFeeShareBips}),
$$
is allocated to the agent, paid in native asset and given to the agent by increasing their free underlying balance.

### Minting failure
To finalize a minting, the minter presents an FDC proof $\mathrm{FDC}(\mathrm{dep}_x)$ of deposit on the source chain.
If this payment was not done in its designated time frame, the minting fails.
It is the minter's responsibility to ensure that the payment is made 
in time according to $t$.

If the minter does not pay on time, the agent can prove non-payment using `mintingPaymentDefault` on the Asset Manager contract, including as argument an FDC attestation `proof` of non-payment and the $\text{CR}_{id}$.
The argument `proof` is obtained from the FDC using a specialized non-payment attestation type.
Once non-payment is proven, the Agent’s collateral that was reserved with the CRT call is freed and the agent receives the collateral reservation fee.

## Edge cases
### Unresponsive minter
After the minter successfully completes the payment on the source chain, they are responsible for the `executeMinting` transaction. 
However, the agent is also able to fulfil this function.
This allows the agent to unlock their collateral reserved for the transaction in cases where the minter becomes unresponsive.
Note in this case the minted FAssets are still sent to the minter account as usual.

### Unsticking the minting
Proofs from the FDC are only available on-chain for approximately 14 days, and can only be made for events that are not too historic.
If neither the minter nor the agent presents a proof of payment or non-payment in a 14 day window after minting is initiated, the process gets stuck and the agent’s collateral remains locked.
The workaround for this (unlikely) scenario proceeds as follows.

1. The agent uses the FDC to prove that payments proofs from the time window when the deposit could have happened are no longer available. 
2. On receipt of this proof, the FAsset system burns the amount of agent’s collateral equivalent to the price of the underlying assets that should have been deposited and then releases the rest of the collateral reserved for the transaction. 

Since the agent's collateral is in a form of stablecoin (or bridged token) it cannot be burnt directly.
Instead, the agent has to provide an equivalent amount of FLR (computed via the FTSO), which is then burnt, with the actual collateral provided back to the agent.

## Self Minting
Self minting refers to a minting where agent is also the minter.
After setting up their vault, an agent can configure whether they want make their collateral available for other users to mint or reserve it for only self minting.
An agent can always be used for self-minting, with self-minting only available from the vault owner address.

The flow for self minting essentially starts from step 6 of the minting flow.
The minting agent performs the following steps:

1. The agent initiates a deposit transaction $\mathrm{dep}(C_x)$ on $C$ transferring the amount $C_x$ to the agent address $A_C$. Note that the transaction is sent from a separate address to the agent address $A_C$.
2. Once the deposit is completed, the agent submits an attestation request $\mathrm{FDC}(\mathrm{dep}_x)$ to the FDC, confirming the existence of the transaction $\mathrm{dep}_x$ on $C$.
3. Once the FDC confirms the existence of the deposit transaction, the agent can call the `executeMinting` function at the asset manager contract, with input only the FDC `proof`. This credits their account with an amount $x$ of the FAsset.
4. Once FAssets are minted, the Asset Manager creates a redemption ticket with the mint amount $x$.

Additionally, self-minting requires that the agent pays only the collateral pool’s share of the minting fees.

Since there is no reservation for self-minting, it could happen that the intended number of lots cannot be minted (e.g. due to a price change or another CRR).
In this case, the agent can self-mint a smaller number of lots (including $0$ lots), with the remainder of the deposited underlying assets added to the agents free underlying balance.

### Mint from free funds
An agent that has free funds on their underlying address can speed up self-minting by instead calling `mintFromFreeUnderlying`, specifying a number $n$ of lots of FAssets.
This call immediately mints the specified number of lots of FAssets, crediting them to the agent, and locking the existing free underlying funds and the agent’s collateral.
Otherwise, the process is the same as self-minting.

## Redemption Tickets
For every minting operation a *redemption ticket* is created.
This ticket stores information containing a unique identifier, the vault of the agent that completed the minting, and the minted amount.
Thus, a ticket $t_i$ is identified by the triplet $(\text{id}, A_v, x_i)$, where $A_v$ is the vault of the agent who completed the minting.
Redemption tickets are ordered in a FIFO queue, used by the system when determining which agent will be [redeemed](Redemption.md) against next.

## Lots and Dust
Every minting and redemption process is performed in a whole number of lots.
A lot is an amount $L$ of an FAsset $X$.
However, certain processes within the FAsset system result in the generation of fractional number of lots (e.g. an amount $L' < L$ of the FAsset):

1) On minting, part of the minting fee is minted to pay the proportion of the fee allocated to the collateral pool. This will typically consist of an amount of the FAsset less than $L$.
2) If the lot size $L$ is changed, redemptions only close an integer number of lots on each redemption ticket. The remainder is left unredeemed.

In such cases the generated fractional amounts of a lot are accounted separately as *dust*.
Dust is unredeemable, but can still be owned by a user.
It can be destroyed in various ways:

- If an agent address owns an amount of dust that exceeds $L$, it can be bundled into a lot (or multiple lots) and converted into a redemption ticket by calling `convertDustToTicket` on the Asset Manager contract, specifying the Agent Vault owning the dust. This call can be performed by any address.
- If the amount of dust $D$ created during a minting exceeds $L$, $\lfloor \frac{D}{L} \rfloor$ bundles of dust of size $L$ are created, with redemption tickets submitted automatically for each of these lots.
- Dust can be self-closed at any time.
- [Liquidation](Liquidation.md) does not need to be executed in a whole number of lots, and thus may clear dust.

## Direct minting
In direct minting the minter mints FAssets without the use of an agent by creating a transaction on the underlying chain.
The transaction contains either a specially crafted memo field or a tag to indicate that it is an FAssets transaction.
If there is a tag, the `MintingTagManager` contract has method `mintingRecipient`, which returns the target address that should receive the minted amount.
Direct minting is currently only supported for XRP. 

### Minting tag manager
The `MintingTagManager` contract allows a user to reserve a minting tag and to set a minting recipient and an executor addresses for this tag.
Since there is a limited amount of (XRP) tags available, the user must pay a reservation fee (`reservationFee`) on Flare in native tokens to reserve one.
At reservation, the user receives the next available tag.
The minting tag manager implements the ERC-721 non-fungible token interface, so that reserved minting tags can be transferred (or resold) to another owner.

The owner of the tag sets a minting recipient with the method `setMintingRecipient` and the preferred executor with the method `setAllowedExecutor`.
If the allowed executor is the zero (default) address, any entity can execute mintings with this tag.
On initial reservation and tag transfer, the recipient is automatically reset to the new owner and the executor is reset to the zero address.

### Executors
A direct minting is triggered by calling method `executeDirectMinting`, which is performed by the *executor*.
The executor is paid an executor's fee upon successful completion.

The permitted executor can be restricted by the minter in three possible ways, depending on the type of direct minting:
- When direct minting with tag, the minting tag manager has methods `setAllowedExecutor` for defining and `allowedExecutor` for reading the executor. If `allowedExecutor` is set to zero, any entity can execute.
- For direct minting with memo field, instead of a $32$-byte standard payment reference, the $48$-byte format is used. In this format, there is an 8$$-byte prefix, followed by a $20$-byte recipient address and finally a $20$-byte executor address.
- For direct minting to a smart account, the smart account manager may restrict the executor directly.

If the allowed executor doesn't execute the transaction in the permitted time window after the initial minting transaction (managed by the function `othersCanExecuteAfterSeconds`), then anybody can execute the minting.

When direct mintings are performed to a specified address, the executor fee is constant, as defined by `directMintingExecutorFeeUBA`.
For direct minting to a smart account, the executor fee is calculated and charged by the smart account manager.

### Rate limits
The direct minting process is restricted by several rate limits:
- The total amount of funds to be directly minted is limited on both an hourly and a daily basis. These amounts are determined by `directMintingHourlyLimitUBA` and `directMintingDailyLimitUBA` respectively. Large mintings, defined as mintings of amounts above `directMintingLargeMintingThresholdUBA`, are not included in these quotas.
- Large mintings are automatically delayed by an amount of time `directMintingLargeMintingDelaySeconds`, with the delay applied cumulatively if there are several large mintings performed concurrently.

These parameters are set by governance, and can be queried on the Asset Manager contract by prepending `get` e.g. calling `getDirectMintingHourlyLimitUBA`.

When the amount of funds minted via direct minting in a given time window reaches its limit further mintings are delayed.
This is implemented by replacing the `DirectMintingExecuted` event with a `DirectMintingDelayed` event.
This event contains a field `executionAllowedAt`, signifying the timestamp at which the minting can be executed.
The size of the delay is proportional to how much the current requested total minting amount exceeds the allowed limit (either hourly or daily).
Once a delayed minting's `executionAllowedAt` timestamp is reached, or the minting is unblocked, the executor can execute the minting as usual.

If a minting limit has been reached, governance can instead unlock delayed mintings initiated before a specified timestamp by calling `unblockDirectMintingsUntil`.
All the mintings initiated before this timestamp (e.g. those mintings whose `DirectMintingDelayed` event was emitted before this) can now be executed.

If a minting is delayed and has a specified preferred executor, the time window in which the preferred executor's has exclusive execution rights begins as soon as the execution is allowed (at `executionAllowedAt`).
In cases where governance unblocked the minting, the `executionAllowedAt` for a minting doesn't change automatically, increasing the exclusive window.
However, in these cases `executionAllowedAt` can be manually reset to the time of unblocking by calling `markUnblockedDirectMintingAllowed`.