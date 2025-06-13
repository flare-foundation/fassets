// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "../../openzeppelin/security/ReentrancyGuard.sol";
import "../../utils/lib/Transfers.sol";
import "../interfaces/IWNat.sol";
import "../interfaces/IIAgentVault.sol";
import "../interfaces/IIAssetManager.sol";


contract AgentVault is ReentrancyGuard, UUPSUpgradeable, IIAgentVault, IERC165 {
    using SafeERC20 for IERC20;

    IIAssetManager public assetManager; // practically immutable

    bool private initialized;

    // only storage placeholders now
    IERC20[] private __usedTokens;
    mapping(IERC20 => uint256) private __tokenUseFlags;

    bool private internalWithdrawal;

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

    // needed to allow wNat.withdraw() to send back funds, since there is no withdrawTo()
    receive() external payable {
        require(internalWithdrawal, "internal use only");
    }

    // used by asset manager to transfer collateral reservation fee to the agent vault
    function depositNat(IWNat _wNat)
        external payable override
        onlyAssetManager
    {
        _wNat.deposit{value: msg.value}();
        assetManager.updateCollateral(address(this), _wNat);
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

    // Claim delegation rewards. Alternatively, you can set claim executor and then claim directly from RewardManager.
    function claimDelegationRewards(
        IRewardManager _rewardManager,
        uint24 _lastRewardEpoch,
        address payable _recipient,
        IRewardManager.RewardClaimWithProof[] calldata _proofs
    )
        external override
        onlyOwner
        returns (uint256)
    {
        bool shouldWrap = _recipient == address(this);
        return _rewardManager.claim(address(this), _recipient, _lastRewardEpoch, shouldWrap, _proofs);
    }

    function claimAirdropDistribution(
        IDistributionToDelegators _distribution,
        uint256 _month,
        address payable _recipient
    )
        external override
        onlyOwner
        returns(uint256)
    {
        bool shouldWrap = _recipient == address(this);
        return _distribution.claim(address(this), _recipient, _month, shouldWrap);
    }

    function optOutOfAirdrop(IDistributionToDelegators _distribution)
        external override
        onlyOwner
    {
        _distribution.optOutOfAirdrop();
    }

    // Used by asset manager when destroying agent.
    // Completely erases agent vault and transfers all funds to the recipient.
    function destroy(address payable _recipient)
        external override
        onlyAssetManager
        nonReentrant
    {
        destroyed = true;
        ownerAfterDestroy = assetManager.getAgentVaultOwner(address(this));
        // transfer native balance, if any (used to be done by selfdestruct)
        Transfers.transferNATAllowFailure(_recipient, address(this).balance);
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

    // Used by asset manager (only for burn for now).
    // Is nonReentrant to prevent reentrancy, in case this is not the last method called.
    function payoutNAT(IWNat _wNat, address payable _recipient, uint256 _amount)
        external override
        onlyAssetManager
        nonReentrant
    {
        _withdrawWNatTo(_wNat, _recipient, _amount);
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

    function _withdrawWNatTo(IWNat _wNat, address payable _recipient, uint256 _amount) private {
        internalWithdrawal = true;
        _wNat.withdraw(_amount);
        internalWithdrawal = false;
        Transfers.transferNAT(_recipient, _amount);
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
