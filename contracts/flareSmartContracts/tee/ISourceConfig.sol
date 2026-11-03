// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9;

// Vendored from flare-smart-contracts-v2: `contracts/userInterfaces/tee/ISourceConfig.sol`.
// Vendored (instead of imported) until `@flarenetwork/flare-periphery-contracts` exports it. Keep in sync with
// the source.
// DEVIATION FROM THE SOURCE: a TRIMMED copy, holding only what `../interfaces/IForbiddenAddressList.sol` needs - the
// `Network` enum (the return type of `IForbiddenAddressList.getNetwork`). Everything else of the source (the `Source`
// struct, `ChainKind`, the getters and the address validation) is dropped, because FAsset does not use the
// WalletPayments diamond's source configuration. `Network` must stay identical to the source (same members, same
// order).
// Last compared against the source at the owners' `csp-utxo-payments` 28fa8fcd.

/**
 * ISourceConfig interface — per-source configuration of the WalletPayments diamond (trimmed: only `Network`).
 */
interface ISourceConfig {

    /// Deployment environment shared by all sources. `Local` is resolved by each chain profile to its
    /// supported local or non-mainnet domain (for example BTC regtest, XRPL's test-network address bit,
    /// or an EVM local chain).
    enum Network {
        Mainnet,
        Testnet,
        Local
    }
}
