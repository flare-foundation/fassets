# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
yarn --frozen-lockfile

# Compile contracts (Hardhat)
yarn compile

# Run all Hardhat tests
yarn testHH

# Run unit tests only
yarn test_unit_hh

# Run integration tests only
yarn test_integration_hh

# Run a specific test file
yarn test test/unit/assetManager/someTest.ts

# Run forge tests (all tests in a contract)
forge test --mc <ContractName>

# Run a specific forge test function
forge test --mt <testFunctionName> -vv

# Lint Solidity
yarn lint

# Run ESLint
yarn eslint

# Run Slither static analysis
yarn slither

# Check contract sizes
yarn size

# Generate coverage report
yarn test-with-coverage

# Generate coverage report for a single test file
yarn coverage test/unit/assetManager/someTest.ts
```

## Architecture

FAsset is a system for minting ERC20 tokens backed by non-smart-contract assets (XRP, BTC, etc.) on Flare/Songbird networks. It relies on two Flare-native protocols: **FTSO** (decentralized price feeds) and **FDC** (bridges payment data from connected chains via attestations).

### Diamond Pattern (EIP-2535)

`AssetManager` is the central contract and is implemented as a **Diamond proxy** (`contracts/diamond/implementation/Diamond.sol`). All function calls are delegated via `fallback()` to registered facets. The diamond storage pattern is used extensively — each logical module stores state at a fixed storage slot computed by `keccak256(...)`.

- `contracts/assetManager/implementation/AssetManager.sol` — the diamond proxy entry point
- `contracts/diamond/library/LibDiamond.sol` — diamond storage, cut, and loupe logic
- `contracts/assetManager/library/data/AssetManagerState.sol` — primary state struct stored at `keccak256("fasset.AssetManager.State")`

### Facets

Each facet in `contracts/assetManager/` corresponds to a logical module:

| Facet | Responsibility |
|---|---|
| `CollateralReservationsFacet` | Collateral reservations for minting |
| `MintingFacet` | Minting and self-minting execution |
| `MintingDefaultsFacet` | Handling minting defaults |
| `RedemptionRequestsFacet` | Initiating redemptions, rejecting redemptions with invalid address, agent's self-close |
| `RedemptionConfirmationsFacet` | Confirming redemptions via FDC attestations |
| `RedemptionDefaultsFacet` | Handling defaulted redemptions |
| `LiquidationFacet` | Liquidating undercollateralized agents and agents in full liquidation |
| `ChallengesFacet` | Challenging illegal payments and double payments (triggers full liquidation if successful) |
| `AgentVaultManagementFacet` | Agent creation and destruction |
| `CollateralTypesFacet` | Vault collateral management - adding, removing and updating settings for collateral tokens |
| `SettingsManagementFacet` | Governance-controlled settings updates - all methods are called through AssetManagerController |
| `CoreVaultClientFacet` | Integration with CoreVaultManager |
| `CoreVaultClientSettingsFacet` | Manage settings for `CoreVaultClientFacet` |
| `EmergencyPauseFacet` | Emergency pause mechanism |
| `SystemStateManagementFacet` | Attaching to controller, minting pause |
| `AgentAlwaysAllowedMintersFacet` | Support for agent allowing certain addresses to mint from non-public vault |
| `AgentCollateralFacet` | Deposits and withdrawals to/from agent vault |
| `AgentInfoFacet` | Return detailed info about agent vault |
| `AgentPingFacet` | Sending events to check for agent bots' liveness and receiving replies |
| `AgentSettingsFacet` | Agent owners modifying settings of their vaults |
| `AgentVaultAndPoolSupportFacet` | Internal methods called from agent vault or pool |
| `AssetManagerBase` | Base contract inherited by all facets - mostly modifiers |
| `AssetManagerDiamondCutFacet` | Diamond cut with timelock |
| `AssetManagerInit` | Initializer (not exposed through diamond proxy, only called at initial deploy) |
| `AvailableAgentsFacet` | Reading and updating list of publicly available agents |
| `RedemptionTimeExtensionFacet` | Extend agent's redemption payment time where many redemption requests arrive in short period |
| `SettingsReaderFacet` | Methods to read full asset manager settings structure and some getters for more commonly needed individual settings |
| `SystemInfoFacet` | Reading system state - collateral reservations, redemption queue, redemption requests |
| `UnderlyingBalanceFacet` | Proving topups and withdrawals to/from agent vault underlying address |
| `UnderlyingTimekeepingFacet` | Updating underlying block and timestamp tracking |

Facet implementations live in `contracts/assetManager/facets/` and share business logic libraries in `contracts/assetManager/library/`.

### Key Contracts

- **`AgentVault`** (`contracts/agentVault/implementation/AgentVault.sol`) — holds vault collateral (ERC20) per agent; created by `AgentVaultFactory`
- **`CollateralPool`** (`contracts/collateralPool/implementation/CollateralPool.sol`) — holds WNat (pool collateral); each agent has one; LP tokens are `CollateralPoolToken`
- **`CoreVaultManager`** (`contracts/coreVaultManager/implementation/CoreVaultManager.sol`) — UUPS upgradeable; manages underlying assets held in Core Vault on the underlying chain; reduces collateral requirements
- **`AssetManagerController`** (`contracts/assetManagerController/implementation/AssetManagerController.sol`) — governance-controlled registry; all settings changes to AssetManager are routed through here with timelock
- **`AgentOwnerRegistry`** (`contracts/agentOwnerRegistry/implementation/AgentOwnerRegistry.sol`) — whitelisting of agent owners; maps management address → work address
- **`FAsset`** (via `contracts/fassetToken/`) — the ERC20 f-asset token (e.g., FXRP)
- **`FtsoV2PriceStore`** (via `contracts/ftso/implementation/FtsoV2PriceStore.sol`) — The store for prices from FTSOv2 (prices are obtained externally and added here with proof)

### Library Organization

Business logic is factored into libraries under `contracts/assetManager/library/`:
- `Agents.sol`, `AgentCollateral.sol`, `AgentBacking.sol` — agent state and collateral math
- `Minting.sol`, `Redemptions.sol`, `RedemptionRequests.sol` — core protocol flows
- `Liquidation.sol` — liquidation logic
- `Conversion.sol` — price/unit conversions (AMG ↔ token wei)
- `TransactionAttestation.sol` — FDC attestation verification
- `data/` — storage structs (Agent, Redemption, CollateralReservation, etc.)

### Governance

Governance follows the `GovernedBase` pattern (`contracts/governance/implementation/`). `AssetManagerController`, `CoreVaultManager` and `FtsoV2PriceStore` use UUPS upgradeable proxies. Settings changes and contract/facet upgrading go through a timelock governed by the governance multisig.

### Unit of Accounting

The system uses "UBA" for the minimal unit of underlying assets and "AMG" (Asset Minting Granularity) as an internal unit for the underlying asset amount (amounts in AMG must always fit in 64 bits). Conversions between underlying lots, UBA, AMG, and token wei are done in `Conversion.sol`.

## Test Structure

- `test/unit/` — Hardhat/Truffle unit tests per contract module
- `test/integration/` — Hardhat integration tests
- `test/e2e-simulation/` — randomized long-running FAsset simulation on Hardhat (`yarn test_e2e`)
- `test-forge/` — Foundry tests for `collateralPool`, `coreVaultManager`, `ftso`

Integration tests use support classes from `lib/test-utils/actors` for simplified initialization and multi-step process invocation. See e.g `11-EmergencyPause.ts` or `12-CoreVault.ts` for examples. Attestation proofs are obtained from AttestationHelper. Never modify obtained proofs - it will just make proof invalid (it contains merkle proof of validity).

Forge tests use `lib/forge-std/`. Initialize with `git submodule update --init --recursive` before running `forge build`.

## Deployment

`deployment/` contains TypeScript deployment scripts. Per-network configs are under `deployment/config/<network>/`. Deployed contract addresses are tracked in `deployment/deploys/<network>.json`. The `DEPLOY_PROFILE` env var selects which config to use.

### Networks

- **Flare** (mainnet, chainId 14) and **Songbird** (canary, chainId 19)
- **Coston** (Songbird testnet, chainId 16) and **Coston2** (Flare testnet, chainId 114)

## Audit Scope

The in-scope contracts are under: `agentOwnerRegistry`, `agentVault`, `assetManager`, `assetManagerController`, `collateralPool`, `coreVaultManager`, `diamond`, `fassetToken`, `flareSmartContracts`, `ftso`, `governance`, `userInterfaces`, `utils`. Previous audit reports are in `audit/`.

## Documentation

The complete specification for the system is in the folder `docs/specs`. The documentation is organized by protocol flow (e.g., minting, redemption, liquidation).
