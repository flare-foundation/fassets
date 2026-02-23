# Tracking balance on the underlying chain

As defined above, an agent is required to keep for each FAsset they are backing, a certain percentage of underlying assets. This is **NOT** enforced by any locking scheme on the underlying chain but rather by balance tracking on the FAsset contract.

Each agent has one dedicated address on an underlying chain. Balance of that address will be tracked. For balance tracking, the system must receive reports per each payment in and out of this address.

Payments received to an agent's address will be part of the minting process and will be updated during the minting flow.

Outgoing payments can be either legal payments, where the agent is sending out funds that they are eligible to send, or illegal payments which should be penalised.

## Challengers

A very important role is the challengers role. They are essential for maintaining the health of the FAsset system. The challenger's role is to monitor the agent’s underlying address and point out illegal operations that can make the agent’s underlying backing too low. Agent's vault collateral will be utilised to reward the challenger that correctly reported an illegal operation. A detailed list of the illegal operations is below.

## Chain fees and the underlying balance

Fees on the underlying chain (known as gas on smart contract chains) can create issues for the system. Part of tracking the agent’s underlying balance involves tracking its spent fees on the underlying chain. Large fee spendings can cause an address to have less assets than it should.

### Underlying balance top-up

An agent must make sure that the payment plus transaction fee for a redemption never makes the balance on the dedicated underlying address less than the required backing for the FAssets. This can be done in two ways

* Redemption can be paid from some other address.
* The agent can top up the underlying address and then send proof of payment, to update the tracked balance. Note that the agent might not have time for this after the redemption starts, so the first option is generally preferable.

### Enforcing the underlying balance

As mentioned, it is rather difficult to enforce an agent to maintain the required balance at any point at time. This will be done utilising external actors named challengers by encouraging them to report illegal outgoing payments.

Once such payment is reported, the agent’s position will be fully liquidated and the challenger will be paid a reward.

### Liquidating a “bad” agent

In the situation of a full liquidation for a bad actor (agent) the following will be done:

* The liquidated agent vault will be locked for future minting so the agent will have to open a new agent vault (with new underlying address) for further mintings.
* Ongoing mintings against this address can continue but the created FAssets for this agent will immediately be added to the liquidation process.
* Ongoing redemptions can continue as usual. New redemptions can still start until all the agent’s redemption tickets get liquidated. Unfortunately, if the agent’s underlying backing is unhealthy, there is a higher chance that the redeemers will be paid in collateral.

This liquidation process will include the same time-increasing premium as described above, but without any stop condition when the agent reaches the safety CR.

### Tracking payments that decrease an underlying agents address

Note that for some chains, tracking transactions that decrease the underlying balance might be difficult. This can mainly happen on smart contract chains, so it shouldn’t be an issue, unless we want to use FAsset for wrapping smart contract chain tokens (which is unlikely, because there exist better bridge designs for such chains).

## Underlying withdrawals

Part of the funds on the underlying address may be legally withdrawn by the agent. Such funds can be obtained in several ways:

* **Minting fees**: A part of a minter's payment is the mint fee in the underlying asset.
* **Failed redemptions**: Assuming some address is backing assets and those assets were redeemed, but the agent failed to pay the redeemer. In this case the redeemer is paid with collateral and the assets can be withdrawn by the agent.
* **Liquidated assets**: assuming the agent's position was partially (or fully) liquidated. The assets on the underlying address are free to be withdrawn.
* **Self-closed assets**: once an agent completes a self-close process, the relevant assets can be withdrawn.

### Underlying withdrawal flow

Before withdrawing underlying assets, the agent must announce a withdrawal (no need to announce a value). This generates a payment reference that has to be used in the withdrawal payment. Afterwards, the agent must present the proof of the payment. If the agent doesn't present the proof, anybody can do it after a while against some reward from the agent's vault. Withdrawal announcement is cleared when the proof is presented.

Only one withdrawal announcement can be active per agent at any time - this is a precaution against the agent overwhelming the balance tracking system with many simultaneous small withdrawals. (This is actually the reason why withdrawal announcements are necessary.)

## Illegal payment challenges

Any challenger can report illegal payments from an underlying address and get paid in return. The underlying chains have many payment types and more types might be added. To reduce complexity on the Flare data connector, not all payment types are supported. This means a challenger can not report any illegal payment. Instead the challenger can report any activity on an underlying address, even if the details (amount etc) of the Tx can’t be reported. To support this each chain will have two types of proofs. Payment proof will include detailed data while illegal activity proof will only include the Tx hash and source address (but if the Tx  is actually a legal payment, it will also contain the payment reference and amount, to prevent punishing legal payments).

### Illegal payment penalty

An illegal payment will trigger full agent liquidation - that is a type of liquidation that cannot be stopped and when it is finished. The agent can still escape paying the liquidation premium by self-closing (see below), but the agent’s vault remains unusable and has to be closed. Of course the agent can then open a new vault with a different underlying address.

## Challenge types

There are 3 challenge types. Why? The challenge system takes care that all minted FAssets are always backed by the assets on the agent’s underlying address in the required percentage. What can a bad agent do to remove those assets? An obvious way is to simply create a payment out of the address. Therefore we make sure that all outpayments correspond to active redemptions (or announced withdrawals) by checking the payment reference (*illegal payment challenge*).

The agent could try to avoid this check by using a valid payment reference, but using it multiple times. Each transaction separately would look legal, so we need the *double payment challenge*.

Third problem is that we cannot exactly prescribe in advance the amount paid from the underlying address. The reason for this are transaction fees (gas), which are unpredictable and can be quite high. Instead of inventing an artificial limit, we allow redemption payment to consume the redemption value plus the free underlying balance. And if there are several not-yet-confirmed redemptions, they can all together consume the sum of their redemption values plus free balance (which has to be split between them). So the third challenge type catches one or more valid payments which together make the *free underlying balance negative*.

Please note that there is no challenge against a wrong destination address in the redemption payment. Since FAssets were burned at the start of the redemption process, they don’t need backing anymore. Such transactions will simply be recognised as failed redemption payments and the redeemer will be able to present the non-payment proof and get paid in collateral with premium (just as if the agent didn’t pay at all, which we cannot prevent).

### Illegal payment

Simple “illegal payment” is a payment from the agent’s underlying address without a payment reference or with a payment reference that doesn’t correspond to any open redemption or announced withdrawal.

#### Illegal payment flow

1) Challenger proves the illegal payment on the Flare data connector.
2) Challenger presents the proof to the asset manager contract. This triggers:
   * A vault collateral payment of reward from the agent’s vault to the challenger’s address.
   * The agent's state for this address is set to full liquidation state.

### Double payment

An agent might try to abuse a redemption request to pay to the redeemer and - with the same payment reference - to pay something to the agent's own address (or even to pay the redeemer twice if they are redeeming against themselves). This would normally be detected after one payment is reported, since then the request is deleted and the other payment becomes illegal, but this may take time if the agent delays with the confirmation. Double payment challenge  allows catching this scenario as soon as the payments are finalised.

#### Double payment flow

1) Challenger detects two (seemingly legal) payments from the same agent’s underlying address and with equal payment reference, and proves them on the Flare data connector.
2) Challenger presents the two proofs to the asset manager contract and triggers reward payment and full agent liquidation.

### Payments make free underlying balance negative

It can happen that one or several otherwise legal payments make the balance on the agent’s underlying address too small, or equivalently make the free underlying balance negative. As with double payment challenge, this would normally be detected after all payments are confirmed, but in this way it can be caught as soon as the payments are finalised.

#### Payments make free underlying balance negative flow

1) Challenger detects on or multiple legal payments from the same agent’s underlying address whose outgoing amount together exceeds the sum of all redemption values plus the total free balance. Challenger proves them all on the Flare data connector.
2) Challenger presents all proofs to the asset manager contract which checks that the transactions are from the agent’s underlying address, that they have not been confirmed yet, and that their total really makes the free balance negative. Then it triggers reward payment and full agent liquidation.

In theory, there could be too many payments in parallel, so that presenting them all would burn more gas then the block limit. However, each one requires a different payment reference, so there should be so many active redemptions (which is very unlikely) and there can only be one unconfirmed announced withdrawal at a time.
