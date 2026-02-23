# Core vault

The Core Vault is the FAsset system vault on the underlying network, where the agents can transfer the underlying asset. When the underlying is on the CV, the agent doesn’t need to back it with collateral so they can mint again or decide to withdraw this collateral. When the agent doesn’t have any minted lots or there are more redemptions than mintings, the agent can request the underlying assets to be moved from the CV to the agent. (Note that the assets on CV don’t “belong” to any agent - they can be transferred from one agent and returned to another.)

## Transfer to core vault

* Agent manually requests transfer of the underlying asset on Flare network to the Core Vault
  * There is a system setting that indicates the percentage of “agent’s minting capacity” (calculated from the amount of agent’s collateral) that has to remain on the agent’s address after the transfer - this should ensure redemptions are still possible.
  * Core vault has a predefined address on the underlying chain.
  * Both this fields can be edited by FAsset governance
* Agent creates a redemption request on Flare network
  * The request has the same structure as any other redemption request and follows all of the same reservation rules (rules are here to prevent another tx to use the same collateral).
  * Agent creates the redemption request to the predefined CV address (on the underlying chain).
  * Only flare governance can edit this field. We use the same code as for all other parameter settings.
  * The agent’s collateral is locked at this time.
* Agent send underlying assets to CVs address as a valid payment transaction with FAsset system provided valid transaction reference
* Agent sends the proof of the payment to the system
  * When an agent sends the payment proof to the Fasset system, their collateral is released.
  * This proof can be sent by anyone.
* Unlike ordinary redemption requests, a transfer request never defaults. The agent can either
  * pay and confirm payment, to have the collateral released (confirmation can also be done by 3rd party if the payment was made from the vault address), or
  * After several hours (longer than normal payment time) the time for payment will end and the agent can call redemptionPaymentDefault. However, unlike the ordinary redemptions, no collateral is paid out - instead, a redemption ticket is recreated for the agent (at the end of the queue).
    If the agent doesn’t call default in enough time (confirmationByOthersAfterSeconds since transfer request), anybody can call default and get some reward from the agent’s vault (just like for redemption payment confirmations by others).

## Return from core vault

There are 2 ways agents can get underlying assets back from the CV. One way is the request for return (of the underlying) where the agent locks enough collateral, and the other is by redeeming its own FAssets for the underlying assets, directly from the core vault.

### Request for return process:

* Agent requests return from Core Vault as a special “minting request”
* A collateral reservation is created (like for minting, but with extra flag that it is a CV return transaction)
* An event is triggered by the FAsset system. Those events are consumed by the CV operators that will take action based on the event observed.
* CV transfers the requested amount to the agents underlying address (vault underlying address)
* CV executor (or the agent) presents a proof of payment to the asset manager; at this point a redemption ticket (for internal bookkeeping) is created for the agent. From this point forward the agent can redeem.
* CV has unlimited time to honor the request for return of the underlying assets. We need to make sure this is honored every operation day, since the agent’s collateral is locked.

### Redeeming from core vault directly:

* User A presents its own fXRP, there is a lower bound to how much it can be redeemed directly. The user’s underlying address must be pre-approved by the governance.
* System burns the presented fXRP
* An event is triggered by the FAsset system. This event holds information about the balance of fXRP burned by the user A with a destination of the user’s underlying address.
* CV has unlimited time to honor the redemption directly to agents ower address
* This kind of redemptions have lower priority as the request for return requests.

Direct redemptions can now be done to any user's underlying address, as long as it is pre-approved by the governance.

Sending and receiving to the core vault must be able to be stopped by the governance transaction. This would be used in an event that CV is compromised.

## Technical design for XRP CV

Lets define:

* **L** as “daily liquidity amount”. This is the size in xrp drops that will be escrowed and time locked at a single time.
* **M** as minimal amount that must be kept on the multisig at any point, to be able to honor agents’ request for underlying assets
* **Operation days** as days when we plan for msig members to do the signings. Note that if need be we can always do emergency signing.
* **Msig members** or **Msig signers** as members of the multisig that can sign the transaction
* **Msig executor** as an operator who collects signatures, assembles the transaction and sends it to the xrp ledger
* **Custodian address** is the address controlled by a custodian partner that is considered safe. In our design we use it as a backup.

Core vault is a classic multisig address setup by flare on the XRPL. The setup is as follows:

1. The core vault's underlying address must be new; otherwise, someone could send previous transactions to confirmPayment to increase availableFunds.
2. Flare generates a secure private key that will be a msig account (address that belongs to this private key will be the **Msig address)**.
3. Flare funds this address with a few XRP (at least 20).
4. Flare sets up a signer list (SignerListSet transaction type) with adding **Msig members** list with equal weight (1).
5. Flare disables master key (AccountSet transaction type) so only msig signers can transact.

The msig address will only do 2 types of transactions: Payment transaction back to agents addresses, and EschrowCreate transactions, which creates an escrow.

We create escrow transactions in order to minimize the amount of xrp that can be spent by the multisig at any given time to reduce the risk. We do that by time locking the funds in the escrow with a safe custodian address as a destination. Until the deadline time only the safe custodian will get access to held funds if preimages are released, otherwise the funds are returned to the multisig address after the time period has passed. Escrows are created such that on each operation day, one lot of size L is released. Preimages are secrets, that when presented escrow transactions can be finalised and funds get immediately transferred to custodian account.

### Payment transaction:

Payment transactions will be of classic transactions that will look something like that

    {
        Account: 'rf7duEoHnFve36dMN6c6NvvP4FChFMake8',
        Amount: '10000000',
        Destination: 'r3EdgnFGdF8tcRrkhjGFvpu9r19Bry6cfm',
        Fee: '40',
        Memos: [ { Memo: { MemoData: '4865...6C64' } } ],
        Sequence: 4558233,
        SigningPubKey: '',
        TransactionType: 'Payment'
    }

Where “Account” is the multisig account and the rest of the fields are filled in by the API according to the event and state of the XRPL. Members of the multisig must validate that the data emitted by the smart contract are within the pre-distributed rules. Especially that the amount is within the limit and that the destination address is on the approved list.

The multisig member need to sign the provided transaction (the JSON) and send the signed transaction back to Flare in the following format:

    {
        Account: 'rf7duEoHnFve36dMN6c6NvvP4FChFMake8',
        Amount: '10000000',
        Destination: 'r3EdgnFGdF8tcRrkhjGFvpu9r19Bry6cfm',
        Fee: '40',
        Memos: [ { Memo: { MemoData: '4865...6C64' } } ],
        Sequence: 4558233,
        SigningPubKey: '',
        TransactionType: 'Payment',
        Signers: [
            {
            Signer: {
                SigningPubKey: 'EDB008B227BC77A36C8FDB533DBA3C27F35C2342D373494EE59E043049C953411C',
                TxnSignature: '30AADEC442DED826567AE5966D1C289679EB8E10CA3E4FFAC38B1E6A9378AD5892744B6FF9FBBCD9598EA77D6994C8737D1B214ADF10A4A39ADA4234BED0970B',
                Account: 'rJWKdxqYJ1ojqaDFXW5fpfros5E6VB6cNy'
            }
        }
    ]

### Escrow transactions:

The escrow’s Destination is a safe custodian address. The escrow lots expiration times are set so that every day of operation, one escrow lot of size L is released. The escrows all have a hash condition, so that flare can present preimages and trigger the transfer to the custodian wallet immediately. Preimages are held by a trusted party at flare than can in an emergency quickly reveal them. If preimages are revealed by accident, the custodian address would get all the funds, and no funds are lost. If this was to happen, we would need a custodian to send funds back to the multisig and escrow the funds with new preimages.

An example of such transaction looks something like that

    {
        Account: 'rf7duEoHnFve36dMN6c6NvvP4FChFMake8',
        TransactionType": "EscrowCreate",
        Amount: '300000000',
        Destination: 'r3EdgnFGdF8tcRrkhjGFvpu9r19Bry6cfm',
        CancelAfter: 533257958,
        Condition: "A0258020E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855810100",
    }

Where Destination must always be the custodian’s cold wallet address. The Cancel after must be within the predefined date ranges and validated that the date is what we expect it is in a standard datetime format. The amount must always be one lot. Conditions will also be from a predefined array.

CancelAfter dates must always be the next available date time that falls on the operation day at 9.00 CEST. With that on each operation day one lol is released from the escrow.

The signer must sign and provide the signatures along with the original fields, similar to payment transaction response.

Note that funds to be released back to the multisig address, EscrowCancel transaction must be signed and transmitted. This can be done by anyone. The executor will be able to do this before transmitting any other transaction, to make sure msig address has sufficient funds.

### Instruction sourcing

For members of msig to know what transactions to sign, we use a smart contract that can:

* Hold a sequence of transactions signed by msig
* Knows underlying address of custodian wallet
* Has access to FAsset agents list
* Can emit an escrow time lock command for msig members to sign
* Can emit a payment transaction command for returning the assets to agents

All commands emitted must be within the scope of predefined rules, and each member of msig must be checked before signing, to make sure they follow the pre-distributed rules and are to the predefined addresses that were shared by flare.

All transactions are also checked by the executor before being executed.

If any member of msig or executor spots the problem, we must go to red alert mode and have a call asap. All members of the call must turn on the camera for at least a few min to make sure noone is compromised.

### Transaction collection and execution

Members of the multisig will be given access to the API together with the implementation and are encouraged (will be required after a while) to run their own version, so that they can independently (via their own RPC) verify the transactions that need to be signed.

Members of the multisig must send the signed transactions to the backend that also collects the events emitted by the contract and generates the transactions accordingly. If the signed transactions deposited by the signers don't match the ones backend is expecting, an alert is triggered and all members of the multisig must evaluate why there is a mismatch (red alert).

Once the sufficient number of signatures are collected, an alert is triggered so a member of the execution group checks the transaction again, and runs a script that assembles the transaction and sends it to the xrpl mempool.

The assembler and execution backend is developed by flare and externally audited. Even if the backend is exploited, signatures from the members of the multisig are generated and created independently so the wrong transaction cant be executed on the xrpl.

### Security assessment:

In normal operation, one escrow expires to the main msig per operation day. This limits the amount released from CV to approximately 1 L per operation day. That limits the amount to 1L + what agents transferred to CV since the last operation day. Note that as soon as M + L tokens are available on CV, an escrowCreate event is triggered. If there is more than V assets not escrowed we must go into red alert and trigger the escrow manually.

If a critical attack (one that cannot be quickly resolved) is detected, including when the keys are stolen, the preimages are published and all the escrows are released to the custodian.

Preimages must be accessible quickly, as they only trigger the safe mode. Once the problem is resolved, the custodian has funds and a new msig must be created to be used by CV.

## Red alert mode

*Red alert mode* is triggered when we believe there is a bug or a misunderstanding in the system. All members of the multisig must be alerted and the designated Flare response team must immediately start looking into the problem. All signing is stopped and for signing to continue a meeting must be called where members are presented by a bug/issue report and signing is restored. The meeting must be with cameras enabled (at least for a few minutes). Note that a response team must be able to use preimages if they deem it necessary.

The Flare response team will have access to the preimages so it can send funds to the custodian. Signers must get confirmation and further instruction from the official contact person at Flare. This confirmation must be a unique predefined order of events that only the contact person at Flare, their replacement and msig signer know. There must be a way for the response team to pause all CV interactions within the FAsset system. To turn this back on, a regular FAsset governance call is required.

The most likely transaction that will be triggered in red alert is a Payment transaction sending all remaining funds within the msig address to the predefined custodian address.

Red alert mode is triggered manually by Flare response team members that are on duty. They can do that based on monitoring inputs and or communication channels with msig members.
