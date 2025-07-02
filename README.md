<p align="left">
  <a href="https://flare.network/" target="blank"><img src="https://content.flare.network/Flare-2.svg" width="410" height="106" alt="Flare Logo" /></a>
</p>

# FAsset

Solidity contracts for *Flare Foundation* FAsset system.

## Overview

The FAsset contracts are used to mint assets on top of Flare (or Songbird). The system is designed to handle chains which don’t have (full) smart contract capabilities, although it can also work for smart contract chains. Initially, FAsset system will support XRP assets. At a later date BTC, DOGE, add tokens from other blockchains will be added.

The minted FAssets are secured by collateral, which is in the form of ERC20 tokens on Flare/Songbird chain and native tokens (FLR/SGB). The collateral is locked in contracts that guarantee that minted tokens can always be redeemed for underlying assets or compensated by collateral. Underlying assets can also be transferred to Core Vault, a vault on the underlying network. When the underlying is on the Core Vault, the agent doesn’t need to back it with collateral so they can mint again or decide to withdraw this collateral.


Two novel protocols, available on Flare and Songbird blockchains, enable the FAsset system to operate:

- **FTSO** contracts which provide decentralized price feeds for multiple tokens.
- Flare’s **FDC**, which bridges payment data from any connected chain.


## Development and contribution

If you're interested in contributing, please see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

If you have found a possible vulnerability please see [SECURITY.md](./SECURITY.md)