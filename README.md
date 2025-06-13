<p align="left">
  <a href="https://flare.network/" target="blank"><img src="https://content.flare.network/Flare-2.svg" width="410" height="106" alt="Flare Logo" /></a>
</p>

# FAsset

Solidity contracts for *Flare Foundation* FAsset system.

## Development and contribution

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Overview

The FAsset contracts are used to mint assets on top of Flare (or Songbird). The system is designed to handle chains which don’t have (full) smart contract capabilities, although it can also work for smart contract chains. Initially, FAsset system will support assets XRP, BTC, DOGE, and LTC. Later we might add other blockchains.

The minted FAssets are secured by collateral, which is in the form of ERC20 tokens on Flare/Songbird chain and native tokens (FLR/SGB). The collateral is locked in contracts that guarantee that minted tokens can always be redeemed for underlying assets or compensated by collateral.

Two novel protocols, available on Flare and Songbird blockchains, enable the FAsset system to operate:

- **FTSO** contracts which provide decentralised price feeds for multiple tokens.
- Flare’s **FDC**, which bridges payment data from any connected chain.
