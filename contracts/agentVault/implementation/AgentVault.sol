// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {IIAgentVault} from "../../agentVault/interfaces/IIAgentVault.sol";
import {IAgentVault} from "../../userInterfaces/IAgentVault.sol";
import {IIAssetManager} from "../../assetManager/interfaces/IIAssetManager.sol";
import {IVPToken} from "@flarenetwork/flare-periphery-contracts/flare/IVPToken.sol";
import {ICollateralPool} from "../../userInterfaces/ICollateralPool.sol";


contract AgentVault is ReentrancyGuard, UUPSUpgradeable, IIAgentVault, IERC165 {
    using SafeERC20 for IERC20;

    IIAssetManager public assetManager; // practically immutable

    bool private initialized;

    IERC20[] private __usedTokens; // only storage placeholder
    mapping(IERC20 => uint256) private __tokenUseFlags; // only storage placeholder
    bool private __internalWithdrawal; // only storage placeholder

    bool private destroyed;
    address private ownerAfterDestroy;

    modifier onlyOwner {
        require(isOwner(msg.sender), "only owner");
        _;
    }

    modifier onlyAssetManager {
        require(msg.sender == address(assetManager), "only asset manager");
        _;
    }

    // Only used in some tests.
    // The implementation in production will always be deployed with address(0) for _assetManager.
    constructor(IIAssetManager _assetManager) {
        initialize(_assetManager);
    }

    function initialize(IIAssetManager _assetManager) public {
        require(!initialized, "already initialized");
        initialized = true;
        assetManager = _assetManager;
    }

    // without "onlyOwner" to allow owner to send funds from any source
    function buyCollateralPoolTokens()
        external payable
    {
        collateralPool().enter{value: msg.value}(0, false);
    }

    function withdrawPoolFees(uint256 _amount, address _recipient)
        external
        onlyOwner
    {
        collateralPool().withdrawFeesTo(_amount, _recipient);
    }

    function redeemCollateralPoolTokens(uint256 _amount, address payable _recipient)
        external
        onlyOwner
        nonReentrant
    {
        ICollateralPool pool = collateralPool();
        assetManager.beforeCollateralWithdrawal(pool.poolToken(), _amount);
        pool.exitTo(_amount, _recipient, ICollateralPool.TokenExitType.MAXIMIZE_FEE_WITHDRAWAL);
    }

    // must call `token.approve(vault, amount)` before for each token in _tokens
    function depositCollateral(IERC20 _token, uint256 _amount)
        external override
        onlyOwner
    {
        _token.safeTransferFrom(msg.sender, address(this), _amount);
        assetManager.updateCollateral(address(this), _token);
    }

    // update collateral after `transfer(vault, some amount)` was called (alternative to depositCollateral)
    function updateCollateral(IERC20 _token)
        external override
        onlyOwner
    {
        assetManager.updateCollateral(address(this), _token);
    }

    function withdrawCollateral(IERC20 _token, uint256 _amount, address _recipient)
        external override
        onlyOwner
        nonReentrant
    {
        // check that enough was announced and reduce announcement (not relevant after destroy)
        if (!destroyed) {
            assetManager.beforeCollateralWithdrawal(_token, _amount);
        }
        // transfer tokens to recipient
        _token.safeTransfer(_recipient, _amount);
    }

    // Allow transferring a token, airdropped to the agent vault, to the owner (management address).
    // Doesn't work for collateral tokens because this would allow withdrawing the locked collateral.
    function transferExternalToken(IERC20 _token, uint256 _amount)
        external override
        onlyOwner
        nonReentrant
    {
        require(destroyed || !assetManager.isLockedVaultToken(address(this), _token), "only non-collateral tokens");
        address ownerManagementAddress = assetManager.getAgentVaultOwner(address(this));
        _token.safeTransfer(ownerManagementAddress, _amount);
    }

    function delegate(IVPToken _token, address _to, uint256 _bips) external override onlyOwner {
        _token.delegate(_to, _bips);
    }

    function undelegateAll(IVPToken _token) external override onlyOwner {
        _token.undelegateAll();
    }

    function revokeDelegationAt(IVPToken _token, address _who, uint256 _blockNumber) external override onlyOwner {
        _token.revokeDelegationAt(_who, _blockNumber);
    }

    function delegateGovernance(IVPToken _token, address _to) external override onlyOwner {
        _token.governanceVotePower().delegate(_to);
    }

    function undelegateGovernance(IVPToken _token) external override onlyOwner {
        _token.governanceVotePower().undelegate();
    }

    /**
     * Used by asset manager when destroying agent.
     * Marks agent as destroyed so that funds can be withdrawn by the agent owner.
     * Note: Can only be called by the asset manager.
     */
    function destroy()
        external override
        onlyAssetManager
        nonReentrant
    {
        destroyed = true;
        ownerAfterDestroy = assetManager.getAgentVaultOwner(address(this));
    }

    // Used by asset manager for liquidation and failed redemption.
    // Is nonReentrant to prevent reentrancy in case the token has receive hooks.
    function payout(IERC20 _token, address _recipient, uint256 _amount)
        external override
        onlyAssetManager
        nonReentrant
    {
        _token.safeTransfer(_recipient, _amount);
    }

    function collateralPool()
        public view
        returns (ICollateralPool)
    {
        return ICollateralPool(assetManager.getCollateralPool(address(this)));
    }

    function isOwner(address _address)
        public view
        returns (bool)
    {
        if (ownerAfterDestroy == address(0)) {
            return assetManager.isAgentVaultOwner(address(this), _address);
        } else {
            return ownerAfterDestroy == _address || assetManager.getWorkAddress(ownerAfterDestroy) == _address;
        }
    }

    /**
     * Implementation of ERC-165 interface.
     */
    function supportsInterface(bytes4 _interfaceId)
        external pure override
        returns (bool)
    {
        return _interfaceId == type(IERC165).interfaceId
            || _interfaceId == type(IAgentVault).interfaceId
            || _interfaceId == type(IIAgentVault).interfaceId;
    }

    ////////////////////////////////////////////////////////////////////////////////////
    // UUPS proxy upgrade

    function implementation() external view returns (address) {
        return _getImplementation();
    }

    /**
     * Upgrade calls can only arrive through asset manager.
     * See UUPSUpgradeable._authorizeUpgrade.
     */
    function _authorizeUpgrade(address /* _newImplementation */)
        internal virtual override
        onlyAssetManager
    {
    }
}
