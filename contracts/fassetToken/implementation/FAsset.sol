// SPDX-License-Identifier: MIT
pragma solidity 0.7.6;

import { IERC165, IERC20, IVPToken, IIVPToken, IICleanable, VPToken }
    from "../../../flattened/FlareSmartContracts.sol";
import "../interfaces/IFAsset.sol";


contract FAsset is IFAsset, VPToken, IERC165 {
    /**
     * Get the asset manager, corresponding to this fAsset.
     * fAssets and asset managers are in 1:1 correspondence.
     */
    address public override assetManager;

    /**
     * Nonzero if f-asset is terminated (in that case its value is terminate timestamp).
     * Stopped f-asset can never be re-enabled.
     *
     * When f-asset is terminated, no transfers can be made anymore.
     * This is an extreme measure to be used as an optional last phase of asset manager upgrade,
     * when the asset manager minting has already been paused for a long time but there still exist
     * unredeemable f-assets, which at this point are considered unrecoverable (lost wallet keys etc.).
     * In such case, the f-asset contract is terminated and then agents can buy back their collateral at market rate
     * (i.e. they burn market value of backed f-assets in collateral to release the rest of the collateral).
     */
    uint64 public terminatedAt = 0;

    /**
     * The name of the underlying asset.
     */
    string public override assetName;

    /**
     * The symbol of the underlying asset.
     */
    string public override assetSymbol;

    modifier onlyAssetManager {
        require(msg.sender == assetManager, "only asset manager");
        _;
    }

    constructor(
        address _governance,
        string memory _name,
        string memory _symbol,
        string memory _assetName,
        string memory _assetSymbol,
        uint8 _decimals
    )
        VPToken(_governance, _name, _symbol)
    {
        _setupDecimals(_decimals);
        assetName = _assetName;
        assetSymbol = _assetSymbol;
    }

    /**
     * Set asset manager contract this can be done only once and must be just after deploy
     * (otherwise nothing can be minted).
     */
    function setAssetManager(address _assetManager)
        external
        onlyGovernance
    {
        require(_assetManager != address(0), "zero asset manager");
        require(assetManager == address(0), "cannot replace asset manager");
        assetManager = _assetManager;
    }

    /**
     * Mints `_amount` od fAsset.
     * Only the assetManager corresponding to this fAsset may call `mint()`.
     */
    function mint(address _owner, uint256 _amount)
        external override
        onlyAssetManager
    {
        _mint(_owner, _amount);
    }

    /**
     * Burns `_amount` od fAsset.
     * Only the assetManager corresponding to this fAsset may call `burn()`.
     */
    function burn(address _owner, uint256 _amount)
        external override
        onlyAssetManager
    {
        _burn(_owner, _amount);
    }

    /**
     * Stops all transfers by setting `terminated` flag to true.
     * Only the assetManager corresponding to this fAsset may call `terminate()`.
     * Stop is irreversible.
     */
    function terminate()
        external override
        onlyAssetManager
    {
        if (terminatedAt == 0) {
            terminatedAt = uint64(block.timestamp);    // safe, block timestamp can never exceed 64bit
        }
    }

    /**
     * True if f-asset is terminated.
     */
    function terminated()
        external view override
        returns (bool)
    {
        return terminatedAt != 0;
    }


    /**
     * Prevent transfer if f-asset is terminated.
     */
    function _beforeTokenTransfer(
        address _from,
        address _to,
        uint256 _amount
    )
        internal
        override (VPToken)
    {
        require(terminatedAt == 0, "f-asset terminated");
        require(_from == address(0) || balanceOf(_from) >= _amount, "f-asset balance too low");
        VPToken._beforeTokenTransfer(_from, _to, _amount);
    }

    /**
     * Implementation of ERC-165 interface.
     */
    function supportsInterface(bytes4 _interfaceId)
        external pure override
        returns (bool)
    {
        return _interfaceId == type(IERC165).interfaceId
            || _interfaceId == type(IERC20).interfaceId
            || _interfaceId == type(IVPToken).interfaceId
            || _interfaceId == type(IFAsset).interfaceId
            || _interfaceId == type(IIVPToken).interfaceId
            || _interfaceId == type(IICleanable).interfaceId;
    }
}
