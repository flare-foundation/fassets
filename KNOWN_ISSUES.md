# Known Issues

### 1. No Slippage Protection in Liquidation Process

There are currently no safeguards to account for slippage during the liquidation process. This can result in liquidators receiving less collateral than expected from vaults or pools, leading to financial losses.

**Risk Assessment:** The FTSO oracle updates prices every 90 seconds and relies on a decentralized set of off-chain data providers, which ensures high reliability and resistance to manipulation.

### 2. Public Factory Access Allows Spoofing

Anyone can call the following factory functions:

-   `AgentVaultFactory.create()`
-   `CollateralPoolFactory.create()`
-   `CollateralPoolTokenFactory.create()`

This allows external actors to deploy their own agent vaults, collateral pools, and pool token contracts. These unauthorized contracts may appear legitimate on-chain, potentially confusing users or chain explorers.

**Risk Assessment:** The official recommendation is that chain explorers and frontends display only those agent vaults and pools that are registered through the official `AssetManager` contract.

### 3. Rounding Side Effects in `convertTokenWeiToAMG`

The `Conversion.sol` contract includes a function `convertAmgToTokenWei` that is vulnerable to rounding errors. Under certain conditions — for example, when token prices drop — the calculation:

`totalAMG * _amgToTokenWeiPrice < AMG_TOKEN_WEI_PRICE_SCALE`

can round to zero. This may cause the `collateralRatioBIPS` to reset to 100%, regardless of the actual amount of minted AMG or the price of the token. As a result, agents may avoid liquidation even when market conditions suggest they should be liquidated.

**Risk Assessment:** Flare Networks governance only whitelist tokens with decimal configurations that prevent meaningful rounding errors.

### 4. No Transfer-Accept Pattern for Work Address Management

A malicious agent could front-run another agent attempting to set their work address by registering that address first. Since a work address can only be associated with one agent at a time, this blocks the legitimate agent from setting it.

**Risk Assessment:** Because agents must be whitelisted, the likelihood of this attack occurring is considered very low.

### 5. Triggering Core Vault Instructions Runs out of Gas

The `CoreVaultManager` contract can hit block gas limit when executing `triggerInstructions`.

**Risk Assessment:** The size of allowed destination addresses will be kept low, at about 5-10.
