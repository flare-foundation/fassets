// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IForbiddenAddressList} from "../../flareSmartContracts/interfaces/IForbiddenAddressList.sol";
import {DirectMinting} from "./DirectMinting.sol";
import {Globals} from "./Globals.sol";


/**
 * The forbidden address checks of every bridge crossing - every flow that moves value between the underlying
 * chain and Flare checks both of its ends here: the underlying address (the payer of an incoming payment, the
 * payee of a redemption) and the Flare address (the minter, the recipient, the executor paid in FAssets, the
 * redeemer). The agents' own addresses - an agent vault's underlying address and its owner's Flare addresses -
 * are not checked: agents are vetted by governance, which whitelists their owners in the agent owner registry.
 *
 * The list is the one `setForbiddenAddressList` names (`DirectMinting.State.forbiddenAddressList`): fsc-v2's
 * `ForbiddenAddressList`. Its maintainers (compliance multisigs) and its governance (without timelock) add
 * addresses at any time; only its governance removes them, with timelock. Two of its lists are read:
 *  - the string list of the asset manager's own chain's source, `AssetManagerSettings.chainId` (`XRP`, `testXRP`),
 *    for underlying addresses, by hash (`isForbiddenHash`): the standard address hash `keccak256(bytes(address))`,
 *    which FDC proofs report and the protocol stores. The list holds each address only in its chain's canonical
 *    form (on XRPL a classic `r…` address), the form these hashes are taken of;
 *  - the one EVM list, for Flare addresses, by `address` (`isForbiddenEvmAddress`): an EVM address is the same holder
 *    on every EVM chain, and an `address` has one value, so there is no form to match and no source id to set.
 * Nothing is forbidden while no list is set; once one is, both sides are checked.
 *
 * The list is read with a STATICCALL (every method here is a view), so the checks open no reentrancy surface; but
 * a reverting list stops every flow that checks it, until a timelocked `setForbiddenAddressList` replaces it. That
 * includes a list that holds no string list under `chainId`: `isForbiddenHash` reverts `UnsupportedSourceId` for a
 * source that is not a BTC or XRP id of the list's kind of network (a mainnet id on a list deployed for
 * Testnet, a `test` id on one for Mainnet; a Local list takes both), so such a list refuses every underlying-side
 * check, whatever the address. The Flare-side checks, on the EVM list, do not depend on the source.
 *
 * The errors are declared here, where they are raised; the compiler lists them in the ABI of every facet that can
 * raise them, so the facets do not re-declare them.
 */
library ForbiddenAddresses {
    /// The underlying address that paid is on the forbidden address list, under this asset manager's source.
    error ForbiddenSourceAddress();
    /// The underlying address a redemption would pay is on the forbidden address list, under this asset
    /// manager's source.
    error ForbiddenRedeemerAddress();
    /// The underlying address a redemption would pay is not in its chain's canonical form, by the forbidden address
    /// list (`isCanonicalAddress`): another spelling (on XRPL an X-address) or no valid address at all.
    error NonCanonicalRedeemerAddress();
    /// The Flare address is on the forbidden address list's EVM list.
    error ForbiddenFlareAddress(address forbiddenAddress);

    /**
     * Revert `ForbiddenSourceAddress` if the underlying address with this standard address hash - the payer of
     * an incoming payment, as an FDC proof reports it (`sourceAddressHash`) - is forbidden.
     */
    function requireSourceAddressAllowed(bytes32 _sourceAddressHash)
        internal view
    {
        require(!isForbiddenUnderlying(_sourceAddressHash), ForbiddenSourceAddress());
    }

    /**
     * Revert `NonCanonicalRedeemerAddress` if the underlying address a redemption would pay is not in its chain's
     * canonical form (`isCanonicalAddress`), and `ForbiddenRedeemerAddress` if it is forbidden. The string is hashed
     * as given (`keccak256(bytes(...))`), as the redemption request stores it and the payment proof reports it.
     * The list holds an address only in its canonical form, so another spelling of a listed address (on XRPL an
     * X-address of a listed classic address) would hash differently and pass; so would one of the agent's address
     * past `CannotRedeemToAgentsAddress`, which hashes the string as given too. Nothing is checked while no list
     * is set.
     */
    function requireRedeemerAddressAllowed(string memory _redeemerUnderlyingAddress)
        internal view
    {
        IForbiddenAddressList list = DirectMinting.getState().forbiddenAddressList;
        if (address(list) == address(0)) return;
        bytes32 sourceId = Globals.getSettings().chainId;
        require(list.isCanonicalAddress(sourceId, _redeemerUnderlyingAddress), NonCanonicalRedeemerAddress());
        require(!list.isForbiddenHash(sourceId, keccak256(bytes(_redeemerUnderlyingAddress))),
            ForbiddenRedeemerAddress());
    }

    /**
     * Revert `ForbiddenFlareAddress` if the Flare address is forbidden.
     */
    function requireFlareAddressAllowed(address _address)
        internal view
    {
        require(!isForbiddenFlare(_address), ForbiddenFlareAddress(_address));
    }

    /**
     * Whether the underlying address with this hash is on the forbidden address list under this asset manager's
     * own chain's source, `AssetManagerSettings.chainId` - the source every payment proof this asset manager takes
     * is verified against (the FDC `sourceId`), and the FDC source id the list is keyed by. An address listed only
     * under another source is not forbidden here. False while no list is set; reverts (`UnsupportedSourceId`,
     * from the list) when the list holds no string list under `chainId`.
     */
    function isForbiddenUnderlying(bytes32 _addressHash)
        internal view
        returns (bool)
    {
        IForbiddenAddressList list = DirectMinting.getState().forbiddenAddressList;
        return address(list) != address(0)
            && list.isForbiddenHash(Globals.getSettings().chainId, _addressHash);
    }

    /**
     * Whether the Flare address is on the forbidden address list's EVM list (`isForbiddenEvmAddress`), the one list
     * of `address` values for every EVM chain, Flare's included. False while no list is set.
     */
    function isForbiddenFlare(address _address)
        internal view
        returns (bool)
    {
        IForbiddenAddressList list = DirectMinting.getState().forbiddenAddressList;
        return address(list) != address(0) && list.isForbiddenEvmAddress(_address);
    }
}
