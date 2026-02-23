# Liquidation

There are two types of liquidation

- **Unhealthy position liquidation** - when the agent's (either vault or pool) collateral ratio falls below the respective minimal CR, the agent’s position will be liquidated until the collateral ratio reaches safety CR or all backed FAssets get liquidated.

- **Full liquidation** - when the agent makes an illegal payment from the underlying chain address (see “Illegal payment challenges” section below), all the agent backed FAssets get liquidated and the liquidation cannot be stopped.

For both liquidation types, any participant (liquidator) will be encouraged to send in FAssets and get paid with the agent’s collateral. The liquidator will get paid some premium for doing this. Essentially this means the agent is paying some penalty for **NOT** maintaining a healthy position or for illegal activity.

## Liquidation process

Once the liquidation starts, any address (AKA liquidator) can send in FAssets and get paid with a combination of vault and pool collateral at current asset price multiplied by a premium factor (greater than 1). The maximum amount of FAssets that will be accepted is the amount required to make the agent healthy, rounded up to the next lot.

Liquidator premium is a system-defined percentage and it can optionally increase with the duration of the liquidation. The increase is in a few discrete steps - in the initial version it will start at 5%, after 3 minutes increase to 10% and after 6 minutes to 15% at which point it will stop increasing. The premium is also limited to the agent’s total collateral ratio (the amount of vault and pool collateral together, divided by the backed FAsset amount) - but if this is reached, all the agent backed FAssets will be liquidated and all of the agent’s and pool collateral will be paid to the liquidators.

How the liquidation collateral payment is divided between the agent and the pool is the complicated part. There are several things to consider:

1) The one whose collateral ratio caused the liquidation (the agent or the pool) should pay more.
2) However, paying more from the collateral with CR below minimal will prolong the liquidation, burn more FAssets, and release more collateral to the market.
3) The agent keeps the underlying funds on their address, so at least the full value of these funds should be paid in the agent’s collateral, as long as the agent’s CR is above 1.
4) We want to release as little collateral as possible (especially FLR/SGB) to the market to prevent price drops which could lower the CR further and potentially destabilise the system.

The current implementation simply pays a fixed ratio (>= 1.0) of the payment from the agent’s collateral and the rest from the pool collateral. If there is not enough of one kind of collateral, more is paid from the other.

### Preventing or stopping the liquidation

The agent can pull themselves out of liquidation by depositing more collateral or self-closing FAssets, as long as it is enough to reach safety CR. The liquidation can also end if asset/native price change pushes collateral ratio above the safety CR, but when this happens, the agent (or somebody else) must call a trigger to end the liquidation.

It is highly recommended for the agent to track their position and automatically topup or self-close when it nears the liquidation. Otherwise, it becomes the race between liquidators and the agent trying to stop the liquidation. Plus, once the liquidation is triggered, the agent has to reach the higher safety CR.

For full liquidation, there is no way to stop before all assets are liquidated, but the agent can still self-close to avoid paying the liquidation premium.

## Liquidation examples

### Example 1 - small price movement

We assume that the agent is backing 1 fBTC. Minimal CR is 1.3 for vault collateral and 2.5 for pool. Agent is required to hold 0.5 times worth of minted FAssets in collateral pool tokens (equivalently, 20% of pool’s minimal CR must be held by agent). Underlying backing requirement is 100%. Initial price of BTC is $20k.

Before the price changes, 1 fBTC is backed by:

* 1 BTC underlying; ratio = 1 ok
* $26k hUSDC collateral; vault CR = $26k/$20k = **1.3** ok
* $60k FLR collateral; pool CR = $60k/$20k = **3** ok
* $10k of pool collateral belongs to the agent via agent’s collateral pool tokens

Now the price of BTC increases from $20k to $21k. The collateral ratios are now

* Vault CR = $26k/$21k ≈ 1.24 < 1.3 underwater
* Pool CR = $60k/$21k ≈ 2.86 > 2.5 ok

At this point, liquidation can start. The liquidation premium factor is (initially) 1.1, of which 1.0 is paid in vault collateral and 0.1 is paid from pool.

The liquidator sends in $10k worth of fBTC (≈ 0.48 fBTC) and receives $10k worth of hUSDC and $1k worth of FLR.

Now, the agent is backing ≈ 0.52 fBTC and it is backed by:

* 1 BTC underlying; ratio ≈ **1.92** ok
* $16k hUSDC collateral; vault CR = $16k/$11k ≈ **1.45** ok
* $59k FLR collateral; pool CR = $59k/$11k ≈ **5.36** ok
* $9k of pool collateral belongs to the agent, because $1k of the agent’s collateral pool tokens was burned to compensate the other collateral providers for the lost collateral due to vault collateral liquidation (burning $1k of agent’s collateral pool tokens causes that the FLR price of one collateral pool token stays the same after the liquidation)

If the safety vault CR is 1.45 or less, the agent is now out of liquidation. However, if the safety CR > 1.45, the liquidation would continue.

Note that quite a large proportion of backed fBTC got burned, almost 50%. This depends on the safety CR setting - with safety CR of 1.4 we would need to burn 40% and with (lowest possible) safety CR of 1.3, we would need to burn only 20% (but would risk going back to liquidation after smallest further price movement).

### Example 2 - large price m ovement

With the same initial assumptions as before, assume now that the price of BTC jumps from $20k to $30k. Then no partial amount of liquidation can bring the agent back to safety (even if the safety CR is 1.3), so all the agent-backed FAssets have to be liquidated.

The liquidator will have to send in 1 fBTC, for which they would receive $26k worth of hUSDC and $7k worth of FLR. Note that in this case the total payment is still 1.1*$30k=$33k, but the proportion of FLR payment is higher than before, since there was not enough hUSDC collateral.

After total liquidation the agent will be backing 0 fBTC and the backing collateral will be:

* 1 BTC underlying
* $0 hUSDC collateral
* $53k FLR collateral
* only $3k of pool collateral still belongs to the agent, the rest was burned

### Example 3 - skyfall

In certain (unlikely) scenarios, the price of asset versus vault collateral and FLR might jump so high that the total CR (= vault CR + pool CR) is less than 1. The payments for liquidations are designed in such a way that at most (total CR * liquidated amount) get paid out, in order to not lower the total CR after the liquidation. So in this case, the liquidator would receive less than the worth of burned FAssets, which no liquidator would want to do, therefore the liquidations would stop.

In a future version we might allow “partial liquidations”: even if total CR is less than 1, the system would still pay out 1.1 times the FAsset worth. This would use up all the collateral before all the FAsset are burned, leaving “bad debt” in the system.

For example, if hypothetically BTC price jumps from $20k to $100k, total CR in the above setting becomes ($26k+$60k)/$100k = 0.86. Paying liquidators at premium factor 1.1, the maximum liquidation that can be covered is ($26k+$60k)/$100k/1.1 = 0.78 fBTC. So 0.22 fBTC would remain in the system with no collateral backing.

## Liquidation triggers

Liquidation is triggered by external actors such as the liquidators / challengers. Without external triggers the liquidation will not start. External triggers are required for:

* Triggering liquidation start for an agent - this is actually triggered automatically by the first liquidation, but can also be done with a separate method. A reason why the liquidator would want to trigger liquidation mode separately is in order to wait for a better premium.
* Turning off the liquidation state for an agent (in some cases; see below).
* For full liquidation, there is no need for special triggers, since liquidation start is triggered automatically when the proof of illegal activity is presented.

### Remove an agent from liquidation state

Once the agent liquidation state is set, it will remain so until set to false.

The liquidation state flag can be set to false with the following triggers / conditions:

* A liquidation makes the agent’s position healthy again (sets the CR above safety CR).
* The agent deposits more collateral which sets its CR above the safety CR.
* The agent does a self-close operation which sets its CR above the safety CR.
* The agent or someone on their behalf sets the liquidation state to false, after the price has moved so that the agent's position is healthy again (above safety CR).

### Agent has to be very attentive to their state

With this design one can imagine this flow:

* Agent’s CR moves below min CR.
* The agent's liquidation state is set.
* Price movements move the agent’s CR back above safety CR, so no liquidation can happen.
* After 10-20 minutes or more, the price again fluctuates and the agent's CR is back below min CR.
* The agent can now be liquidated with the max premium since the time stamp for the start of the liquidation state is many minutes back.

This flow demonstrates why the agent should turn their liquidation flag off as soon as possible.
