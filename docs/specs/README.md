# Summary
The FAssets protocol is Flare's native protocol for minting on-chain representations of assets from external chains.
By owning FAsset copies of assets from non-smart contract chains, Flare's users are able to harvest the benefits of Flare's DeFi infrastructure, for example by staking them in lending protocols.
FAssets are backed by a system of users known as *agents*, posting collateral that backs FAsset operation in return for fees.

This documentation describes the FAsset system in detail: the minting and redeeming process by which assets enter and leave Flare, the agents and their collateral that insures the system, and technical information regarding the security of the protocol.
The information is organized into the following files:

- [Introduction](Introduction.md)
- [Agents](Agents.md)
- [Collateral Pool](CollateralPool.md)
- [Collateral](Collateral.md)
- [Minting](Minting.md)
- [Redemption](Redemption.md)
- [Failed and Blocked Payments](FailedAndBlockedPayments.md)
- [Tracking the Underlying Chain](TrackingUnderlyingChain.md)
- [Liquidation](Liquidation.md)
- [Core Vault](CoreVault.md)
- [Upgrading, Pausing, and Winding down](PauseAndUpgrade.md)

Additionally, API references for the various smart contracts may be found at:

- [IAgentVault](api/IAgentVault.md)
- [IAssetManager](api/IAssetManager.md)
- [ICollateralPool](api/ICollateralPool.md)
- [ICollateralPoolToken](api/ICollateralPoolToken.md)
- [IFAsset](api/IFAsset.md)
- [IMintingTagManager](api/IMintingTagManager.md)