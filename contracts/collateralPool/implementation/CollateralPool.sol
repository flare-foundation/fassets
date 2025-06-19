// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "../../openzeppelin/security/ReentrancyGuard.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Transfers} from "../../utils/library/Transfers.sol";
import {MathUtils} from "../../utils/library/MathUtils.sol";
import {IFAsset} from "../../userInterfaces/IFAsset.sol";
import {IWNat} from "../../flareSmartContracts/interfaces/IWNat.sol";
import {IIAssetManager} from "../../assetManager/interfaces/IIAssetManager.sol";
import {IICollateralPool} from "../../collateralPool/interfaces/IICollateralPool.sol";
import {IICollateralPoolToken} from "../interfaces/IICollateralPoolToken.sol";
import {ICollateralPoolToken} from "../../userInterfaces/ICollateralPoolToken.sol";
import {IRewardManager} from "@flarenetwork/flare-periphery-contracts/flare/IRewardManager.sol";
import {IDistributionToDelegators} from "@flarenetwork/flare-periphery-contracts/flare/IDistributionToDelegators.sol";
import {ICollateralPool} from "../../userInterfaces/ICollateralPool.sol";


//slither-disable reentrancy    // all possible reentrancies guarded by nonReentrant
contract CollateralPool is IICollateralPool, ReentrancyGuard, UUPSUpgradeable, IERC165 {
    using SafeCast for uint256;
    using SafeCast for int256;
    using SafePct for uint256;
    using SafeERC20 for IFAsset;
    using SafeERC20 for IWNat;

    struct AssetData {
        uint256 exitCR;
        uint256 poolTokenSupply;
        uint256 agentBackedFAsset;
        uint256 poolNatBalance;
        uint256 poolFAssetFees;
        uint256 poolVirtualFAssetFees;
        uint256 assetPriceMul;
        uint256 assetPriceDiv;
    }

    uint256 public constant MIN_NAT_TO_ENTER = 1 ether;
    uint256 public constant MIN_TOKEN_SUPPLY_AFTER_EXIT = 1 ether;
    uint256 public constant MIN_NAT_BALANCE_AFTER_EXIT = 1 ether;

    address public agentVault;          // practically immutable because there is no setter
    IIAssetManager public assetManager; // practically immutable because there is no setter
    IFAsset public fAsset;              // practically immutable because there is no setter
    IICollateralPoolToken public token; // only changed once at deploy time

    IWNat public wNat;
    uint32 public exitCollateralRatioBIPS;

    uint32 private __topupCollateralRatioBIPS; // only storage placeholder
    uint16 private __topupTokenPriceFactorBIPS; // only storage placeholder

    bool private internalWithdrawal;
    bool private initialized;

    mapping(address => int256) private _fAssetFeeDebtOf;
    int256 public totalFAssetFeeDebt;
    uint256 public totalFAssetFees;
    uint256 public totalCollateral;

    modifier onlyAssetManager {
        require(msg.sender == address(assetManager), "only asset manager");
        _;
    }

    modifier onlyAgent {
        require(isAgentVaultOwner(msg.sender), "only agent");
        _;
    }

    // Only used in some tests.
    // The implementation in production will always be deployed with all zero addresses and parameters.
    constructor (
        address _agentVault,
        address _assetManager,
        address _fAsset,
        uint32 _exitCollateralRatioBIPS
    ) {
        initialize(_agentVault, _assetManager, _fAsset,
            _exitCollateralRatioBIPS);
    }

    function initialize(
        address _agentVault,
        address _assetManager,
        address _fAsset,
        uint32 _exitCollateralRatioBIPS
    )
        public
    {
        require(!initialized, "already initialized");
        initialized = true;
        // init vars
        agentVault = _agentVault;
        assetManager = IIAssetManager(_assetManager);
        fAsset = IFAsset(_fAsset);
        // for proxy implementation, assetManager will be 0
        wNat = address(assetManager) != address(0) ? assetManager.getWNat() : IWNat(address(0));
        exitCollateralRatioBIPS = _exitCollateralRatioBIPS;
    }

    receive() external payable {
        require(internalWithdrawal, "only internal use");
    }

    function setPoolToken(address _poolToken)
        external
        onlyAssetManager
    {
        require(address(token) == address(0), "pool token already set");
        token = IICollateralPoolToken(_poolToken);
    }

    function setExitCollateralRatioBIPS(uint256 _exitCollateralRatioBIPS)
        external
        onlyAssetManager
    {
        exitCollateralRatioBIPS = _exitCollateralRatioBIPS.toUint32();
    }

    /**
     * @notice Enters the collateral pool by depositing some NAT
     */
    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function enter()
        external payable
        nonReentrant
        returns (uint256, uint256)
    {
        AssetData memory assetData = _getAssetData();
        require(msg.value >= MIN_NAT_TO_ENTER, "amount of nat sent is too low");
        if (assetData.poolTokenSupply == 0) {
            // this conditions are set for keeping a stable token value
            require(msg.value >= assetData.poolNatBalance,
                "if pool has no tokens, but holds collateral, you need to send at least that amount of collateral");
            require(msg.value >= assetData.poolFAssetFees.mulDiv(assetData.assetPriceMul, assetData.assetPriceDiv),
                "If pool has no tokens, but holds f-asset, you need to send at least f-asset worth of collateral");
        }
        // calculate obtained pool tokens and free f-assets
        uint256 tokenShare = _collateralToTokenShare(assetData, msg.value);
        require(tokenShare > 0, "deposited amount results in zero received tokens");
        // calculate and create fee debt
        uint256 feeDebt = assetData.poolTokenSupply > 0 ?
            assetData.poolVirtualFAssetFees.mulDiv(tokenShare, assetData.poolTokenSupply) : 0;
        _createFAssetFeeDebt(msg.sender, feeDebt);
        // deposit collateral
        _depositWNat();
        // mint pool tokens to the sender
        uint256 timelockExp = token.mint(msg.sender, tokenShare);
        // emit event
        emit CPEntered(msg.sender, msg.value, tokenShare, _fAssetFeeDebtOf[msg.sender], timelockExp);
        return (tokenShare, timelockExp);
    }

    /**
     * @notice Exits the pool by liquidating the given amount of pool tokens
     * @param _tokenShare   The amount of pool tokens to be liquidated
     *                      Must be positive and smaller or equal to the sender's token balance
     */
    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function exit(uint256 _tokenShare)
        external
        nonReentrant
        returns (uint256)
    {
        return _exitTo(_tokenShare, payable(msg.sender));
    }

    /**
     * @notice Exits the pool by liquidating the given amount of pool tokens
     * @param _tokenShare   The amount of pool tokens to be liquidated
     *                      Must be positive and smaller or equal to the sender's token balance
     * @param _recipient    The address to which NATs and FAsset fees will be transferred
     */
    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function exitTo(uint256 _tokenShare, address payable _recipient)
        external
        nonReentrant
        returns (uint256)
    {
        return _exitTo(_tokenShare, _recipient);
    }

    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function _exitTo(uint256 _tokenShare, address payable _recipient)
        private
        returns (uint256)
    {
        require(_tokenShare > 0, "token share is zero");
        require(_tokenShare <= token.balanceOf(msg.sender), "token balance too low");
        AssetData memory assetData = _getAssetData();
        _requireMinTokenSupplyAfterExit(assetData, _tokenShare);
        // poolTokenSupply >= _tokenShare > 0
        uint256 natShare = _tokenShare.mulDiv(assetData.poolNatBalance, assetData.poolTokenSupply);
        require(natShare > 0, "amount of sent tokens is too small");
        _requireMinNatSupplyAfterExit(assetData, natShare);
        // special case after termination - we don't care about fees or CR anymore and we must avoid fasset transfer
        if (fAsset.terminated()) {
            token.burn(msg.sender, _tokenShare, true); // when f-asset is terminated all tokens are free tokens
            _withdrawWNatTo(_recipient, natShare);
            return natShare;
        }
        require(_staysAboveCR(assetData, natShare, assetData.exitCR), "collateral ratio falls below exitCR");
        // update the fasset fee debt
        uint256 debtFAssetFeeShare = _tokensToVirtualFeeShare(assetData, _tokenShare);
        if (debtFAssetFeeShare > 0) {
            _deleteFAssetFeeDebt(msg.sender, debtFAssetFeeShare);
        }
        token.burn(msg.sender, _tokenShare, false);
        _withdrawWNatTo(_recipient, natShare);
        // emit event
        emit CPExited(msg.sender, _tokenShare, natShare, 0, _fAssetFeeDebtOf[msg.sender]);
        return natShare;
    }

    /**
     * @notice Exits the pool by liquidating the given amount of pool tokens and redeeming
     *  f-assets in a way that either preserves the pool collateral ratio or keeps it above exit CR
     * @param _tokenShare                   The amount of pool tokens to be liquidated
     *                                      Must be positive and smaller or equal to the sender's token balance
     * @param _redeemToCollateral           Specifies if redeemed f-assets should be exchanged to vault collateral
     *                                      by the agent
     * @param _redeemerUnderlyingAddress    Redeemer's address on the underlying chain
     * @param _executor                     The account that is allowed to execute redemption default
     * @notice F-assets will be redeemed in collateral if their value does not exceed one lot
     * @notice All f-asset fees will be redeemed along with potential additionally required f-assets taken
     *  from the sender's f-asset account
     */
    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function selfCloseExit(
        uint256 _tokenShare,
        bool _redeemToCollateral,
        string memory _redeemerUnderlyingAddress,
        address payable _executor
    )
        external payable
        nonReentrant
    {
        _selfCloseExitTo(_tokenShare, _redeemToCollateral, payable(msg.sender), _redeemerUnderlyingAddress, _executor);
    }

    /**
     * @notice Exits the pool by liquidating the given amount of pool tokens and redeeming
     *  f-assets in a way that either preserves the pool collateral ratio or keeps it above exit CR
     * @param _tokenShare                   The amount of pool tokens to be liquidated
     *                                      Must be positive and smaller or equal to the sender's token balance
     * @param _redeemToCollateral           Specifies if redeemed f-assets should be exchanged to vault collateral
     *                                      by the agent
     * @param _recipient                    The address to which NATs and FAsset fees will be transferred
     * @param _redeemerUnderlyingAddress    Redeemer's address on the underlying chain
     * @param _executor                     The account that is allowed to execute redemption default
     * @notice F-assets will be redeemed in collateral if their value does not exceed one lot
     * @notice All f-asset fees will be redeemed along with potential additionally required f-assets taken
     *  from the sender's f-asset account
     */
    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function selfCloseExitTo(
        uint256 _tokenShare,
        bool _redeemToCollateral,
        address payable _recipient,
        string memory _redeemerUnderlyingAddress,
        address payable _executor
    )
        external payable
        nonReentrant
    {
        require(_recipient != address(0) && _recipient != address(this) && _recipient != agentVault,
            "invalid recipient address");
        _selfCloseExitTo(_tokenShare, _redeemToCollateral, _recipient, _redeemerUnderlyingAddress, _executor);
    }

    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function _selfCloseExitTo(
        uint256 _tokenShare,
        bool _redeemToCollateral,
        address payable _recipient,
        string memory _redeemerUnderlyingAddress,
        address payable _executor
    )
        private
    {
        require(_tokenShare > 0, "token share is zero");
        require(_tokenShare <= token.balanceOf(msg.sender), "token balance too low");
        AssetData memory assetData = _getAssetData();
        uint256 natShare = assetData.poolNatBalance.mulDiv(
            _tokenShare, assetData.poolTokenSupply); // poolTokenSupply >= _tokenShare > 0
        require(natShare > 0, "amount of sent tokens is too small");
        uint256 maxAgentRedemption = assetManager.maxRedemptionFromAgent(agentVault);
        uint256 requiredFAssets = _getFAssetRequiredToNotSpoilCR(assetData, natShare);
        // Rare case: if agent has too many low-valued open tickets they can't redeem the requiredFAssets
        // in one transaction. In that case, we revert and the user should retry with lower amount.
        require(maxAgentRedemption > requiredFAssets, "redemption requires closing too many tickets");
        // require here in case above block changed nat and token share
        _requireMinNatSupplyAfterExit(assetData, natShare);
        _requireMinTokenSupplyAfterExit(assetData, _tokenShare);
        // get owner f-asset fees to be spent (maximize fee withdrawal to cover the potentially necessary f-assets)
        uint256 debtFAssetFeeShare = _tokensToVirtualFeeShare(assetData, _tokenShare);
        // transfer the owner's fassets that will be redeemed
        require(fAsset.allowance(msg.sender, address(this)) >= requiredFAssets, "f-asset allowance too small");
        fAsset.safeTransferFrom(msg.sender, address(this), requiredFAssets);
        // redeem f-assets if necessary
        bool returnFunds = true;
        if (requiredFAssets > 0) {
            if (requiredFAssets < assetManager.lotSize() || _redeemToCollateral) {
                assetManager.redeemFromAgentInCollateral(agentVault, _recipient, requiredFAssets);
            } else {
                returnFunds = _executor == address(0);
                // pass `msg.value` to `redeemFromAgent` for the executor fee if `_executor` is set
                assetManager.redeemFromAgent{ value: returnFunds ? 0 : msg.value }(
                    agentVault, _recipient, requiredFAssets, _redeemerUnderlyingAddress, _executor);
            }
        }
        if (debtFAssetFeeShare > 0) {
            _deleteFAssetFeeDebt(msg.sender, debtFAssetFeeShare);
        }
        token.burn(msg.sender, _tokenShare, false);
        _withdrawWNatTo(_recipient, natShare);
        if (returnFunds) {
            // return any NAT included by mistake back to the sender
            Transfers.transferNAT(payable(msg.sender), msg.value);
        }
        // emit event
        emit CPExited(msg.sender, _tokenShare, natShare, requiredFAssets, _fAssetFeeDebtOf[msg.sender]);
    }

    /**
     * Get the amount of fassets that need to be burned to perform self close exit.
     */
    function fAssetRequiredForSelfCloseExit(uint256 _tokenAmountWei)
        external view
        returns (uint256)
    {
        AssetData memory assetData = _getAssetData();
        uint256 natWei = assetData.poolNatBalance.mulDiv(_tokenAmountWei, assetData.poolTokenSupply);
        return _getFAssetRequiredToNotSpoilCR(assetData, natWei);
    }

    /**
     * @notice Collect f-asset fees by locking free tokens
     * @param _fAssets  The amount of f-asset fees to withdraw
     *                  Must be positive and smaller or equal to the sender's reward f-assets
     */
    function withdrawFees(uint256 _fAssets)
        external
        nonReentrant
    {
        _withdrawFeesTo(_fAssets, msg.sender);
    }

    /**
     * @notice Collect f-asset fees by locking free tokens
     * @param _fAssets      The amount of f-asset fees to withdraw
     *                      Must be positive and smaller or equal to the sender's fAsset fees.
     * @param _recipient    The address to which FAsset fees will be transferred
     */
    function withdrawFeesTo(uint256 _fAssets, address _recipient)
        external
        nonReentrant
    {
        _withdrawFeesTo(_fAssets, _recipient);
    }

    /**
     * @notice Collect f-asset fees by locking free tokens
     * @param _fAssets      The amount of f-asset fees to withdraw
     *                      Must be positive and smaller or equal to the sender's reward f-assets
     * @param _recipient    The address to which NATs and FAsset fees will be transferred
     */
    function _withdrawFeesTo(uint256 _fAssets, address _recipient)
        private
    {
        require(_fAssets > 0, "trying to withdraw zero f-assets");
        AssetData memory assetData = _getAssetData();
        uint256 freeFAssetFeeShare = _fAssetFeesOf(assetData, msg.sender);
        require(_fAssets <= freeFAssetFeeShare, "free f-asset balance too small");
        _createFAssetFeeDebt(msg.sender, _fAssets);
        _transferFAssetTo(_recipient, _fAssets);
        // emit event
        emit CPFeesWithdrawn(msg.sender, _fAssets, _fAssetFeeDebtOf[msg.sender]);
    }

    /**
     * @notice Free debt tokens by paying f-assets
     * @param _fAssets  Amount of payed f-assets
     *                  _fAssets must be positive and smaller or equal to the sender's debt f-assets
     */
    function payFAssetFeeDebt(uint256 _fAssets)
        external
        nonReentrant
    {
        require(_fAssets != 0, "zero f-asset debt payment");
        require(_fAssets.toInt256() <= _fAssetFeeDebtOf[msg.sender], "payment larger than fee debt");
        require(fAsset.allowance(msg.sender, address(this)) >= _fAssets, "f-asset allowance too small");
        _deleteFAssetFeeDebt(msg.sender, _fAssets);
        _transferFAssetFrom(msg.sender, _fAssets);
        // emit event
        emit CPFeeDebtPaid(msg.sender, _fAssets, _fAssetFeeDebtOf[msg.sender]);
    }

    /**
     * @notice Returns the collateral pool token contract used by this contract
     */
    function poolToken() external view returns (ICollateralPoolToken) {
        return token;
    }

    function _collateralToTokenShare(
        AssetData memory _assetData,
        uint256 _collateral
    )
        internal pure
        returns (uint256)
    {
        if (_assetData.poolNatBalance == 0 || _assetData.poolTokenSupply == 0) { // pool is empty
            return _collateral;
        }
        return _assetData.poolTokenSupply.mulDiv(_collateral, _assetData.poolNatBalance);
    }

    // _tokens is assumed to be smaller or equal to _account's token balance
    function _tokensToVirtualFeeShare(
        AssetData memory _assetData,
        uint256 _tokens
    )
        internal pure
        returns (uint256)
    {
        if (_tokens == 0) return 0;
        assert(_tokens <= _assetData.poolTokenSupply);
        // poolTokenSupply >= _tokens AND _tokens > 0 together imply poolTokenSupply != 0
        return _assetData.poolVirtualFAssetFees.mulDiv(_tokens, _assetData.poolTokenSupply);
    }

    function _getFAssetRequiredToNotSpoilCR(
        AssetData memory _assetData,
        uint256 _natShare
    )
        internal pure
        returns (uint256)
    {
        // calculate f-assets required for CR to stay above min(exitCR, poolCR) when taking out _natShare
        // if pool is below exitCR, we shouldn't require it be increased above exitCR, only preserved
        // if pool is above exitCR, we require only for it to stay that way (like in the normal exit)
        if (_staysAboveCR(_assetData, 0, _assetData.exitCR)) {
            // f-asset required for CR to stay above exitCR (might not be needed)
            // solve (N - n) / (p / q (F - f)) >= cr get f = max(0, F - q (N - n) / (p cr))
            return MathUtils.subOrZero(_assetData.agentBackedFAsset, _assetData.assetPriceDiv *
                (_assetData.poolNatBalance - _natShare) * SafePct.MAX_BIPS /
                (_assetData.assetPriceMul * _assetData.exitCR)
            ); // _assetPriceMul > 0, exitCR > 1
        } else {
            // f-asset that preserves pool CR (assume poolNatBalance >= natShare > 0)
            // solve (N - n) / (F - f) = N / F get n = N f / F
            return _assetData.agentBackedFAsset.mulDiv(_natShare, _assetData.poolNatBalance);
        }
    }

    function _staysAboveCR(
        AssetData memory _assetData,
        uint256 _withdrawnNat,
        uint256 _crBIPS
    )
        internal pure
        returns (bool)
    {
        // check (N - n) / (F p / q) >= cr get (N - n) q >= F p cr
        return (_assetData.poolNatBalance - _withdrawnNat) * _assetData.assetPriceDiv >=
            (_assetData.agentBackedFAsset * _assetData.assetPriceMul).mulBips(_crBIPS);
    }

    function _virtualFAssetFeesOf(
        AssetData memory _assetData,
        address _account
    )
        internal view
        returns (uint256)
    {
        uint256 tokens = token.balanceOf(_account);
        return _tokensToVirtualFeeShare(_assetData, tokens);
    }

    function _fAssetFeesOf(
        AssetData memory _assetData,
        address _account
    )
        internal view
        returns (uint256)
    {
        int256 virtualFAssetFees = _virtualFAssetFeesOf(_assetData, _account).toInt256();
        int256 accountFeeDebt = _fAssetFeeDebtOf[_account];
        int256 userFees = virtualFAssetFees - accountFeeDebt;
        // note: rounding errors can make debtFassets larger than virtualFassets by at most one
        // this can happen only when user has no free f-assets (that is why MathUtils.subOrZero)
        // note: rounding errors can make freeFassets larger than total pool f-asset fees by small amounts
        // (The reason for Math.min and Math.positivePart is to restrict to interval [0, poolFAssetFees])
        return Math.min(MathUtils.positivePart(userFees), _assetData.poolFAssetFees);
    }

    function _debtFreeTokensOf(
        AssetData memory _assetData,
        address _account
    )
        internal view
        returns (uint256)
    {
        int256 accountFeeDebt = _fAssetFeeDebtOf[_account];
        if (accountFeeDebt <= 0) {
            // with no debt, all tokens are free
            // this avoids the case where freeFassets == poolVirtualFAssetFees == 0
            return token.balanceOf(_account);
        }
        uint256 virtualFassets = _virtualFAssetFeesOf(_assetData, _account);
        assert(virtualFassets <= _assetData.poolVirtualFAssetFees);
        uint256 freeFassets = MathUtils.positivePart(virtualFassets.toInt256() - accountFeeDebt);
        if (freeFassets == 0) return 0;
        // nonzero divisor: _assetData.poolVirtualFAssetFees >= virtualFassets >= freeFassets > 0
        return _assetData.poolTokenSupply.mulDiv(freeFassets, _assetData.poolVirtualFAssetFees);
    }

    function _getAssetData()
        internal view
        returns (AssetData memory)
    {
        (uint256 assetPriceMul, uint256 assetPriceDiv) = assetManager.assetPriceNatWei();
        return AssetData({
            exitCR: _safeExitCollateralRatioBIPS(),
            poolTokenSupply: token.totalSupply(),
            agentBackedFAsset: assetManager.getFAssetsBackedByPool(agentVault),
            poolNatBalance: totalCollateral,
            poolFAssetFees: totalFAssetFees,
            poolVirtualFAssetFees: _totalVirtualFees(),
            assetPriceMul: assetPriceMul,
            assetPriceDiv: assetPriceDiv
        });
    }

    function _totalVirtualFees()
        internal view
        returns (uint256)
    {
        int256 virtualFees = totalFAssetFees.toInt256() + totalFAssetFeeDebt;
        // Invariant: virtualFees >= 0 always (otherwise the following line will revert).
        // Proof: the places where `totalFAssetFees` and `totalFAssetFeeDebt` change are: `enter`,
        // `exit`/`selfCloseExit`, `withdrawFees` and `payFAssetFeeDebt`.
        // In `withdrawFees` and `payFAssetFeeDebt`, amounts of `totalFAssetFees` and `totalFAssetFeeDebt`
        // change with oposite sign, so virtualFees is unchanged.
        // In `enter`, the `totalFAssetFeeDebt` increases and the other is unchanged, so virtualFees increases.
        // Thus the only place where `totalFAssetFeeDebt` and thus virtualFees decreases is in`exit`/`selfCloseExit`.
        // The decrease there is by `_tokensToVirtualFeeShare()`, which is virtualFees times a factor
        // `tokenShare/totalTokens`, which is checked to be at most 1.
        return virtualFees.toUint256();
    }

    // if governance changes `minPoolCollateralRatioBIPS` it can be higher than `exitCollateralRatioBIPS`
    function _safeExitCollateralRatioBIPS()
        internal view
        returns (uint256)
    {
        uint256 minPoolCollateralRatioBIPS = assetManager.getAgentMinPoolCollateralRatioBIPS(agentVault);
        return Math.max(minPoolCollateralRatioBIPS, exitCollateralRatioBIPS);
    }

    function _requireMinTokenSupplyAfterExit(
        AssetData memory _assetData,
        uint256 _tokenShare
    )
        internal pure
    {
        require(_assetData.poolTokenSupply == _tokenShare ||
            _assetData.poolTokenSupply - _tokenShare >= MIN_TOKEN_SUPPLY_AFTER_EXIT,
            "token supply left after exit is too low and non-zero");
    }

    function _requireMinNatSupplyAfterExit(
        AssetData memory _assetData,
        uint256 _natShare
    )
        internal pure
    {
        require(_assetData.poolNatBalance == _natShare ||
            _assetData.poolNatBalance - _natShare >= MIN_NAT_BALANCE_AFTER_EXIT,
            "collateral left after exit is too low and non-zero");
    }

    ////////////////////////////////////////////////////////////////////////////////////
    // tracking wNat collateral and f-asset fees

    // this is needed to track asset manager's minting fee deposit
    function fAssetFeeDeposited(
        uint256 _amount
    )
        external
        onlyAssetManager
    {
        totalFAssetFees += _amount;
    }

    function _createFAssetFeeDebt(address _account, uint256 _fAssets)
        internal
    {
        int256 fAssets = _fAssets.toInt256();
        _fAssetFeeDebtOf[_account] += fAssets;
        totalFAssetFeeDebt += fAssets;
    }

    // _fAssets should be smaller or equal to _account's f-asset debt
    function _deleteFAssetFeeDebt(address _account, uint256 _fAssets)
        internal
    {
        int256 fAssets = _fAssets.toInt256();
        _fAssetFeeDebtOf[_account] -= fAssets;
        totalFAssetFeeDebt -= fAssets;
    }

    function _transferFAssetFrom(
        address _from,
        uint256 _amount
    )
        internal
    {
        if (_amount > 0) {
            totalFAssetFees += _amount;
            fAsset.safeTransferFrom(_from, address(this), _amount);
        }
    }

    function _transferFAssetTo(
        address _to,
        uint256 _amount
    )
        internal
    {
        if (_amount > 0) {
            totalFAssetFees -= _amount;
            fAsset.safeTransfer(_to, _amount);
        }
    }

    function _transferWNatTo(
        address _to,
        uint256 _amount
    )
        internal
    {
        if (_amount > 0) {
            totalCollateral -= _amount;
            wNat.safeTransfer(_to, _amount);
        }
    }

    function _withdrawWNatTo(
        address payable _recipient,
        uint256 _amount
    )
        internal
    {
        if (_amount > 0) {
            totalCollateral -= _amount;
            internalWithdrawal = true;
            wNat.withdraw(_amount);
            internalWithdrawal = false;
            Transfers.transferNAT(_recipient, _amount);
        }
    }

    function _depositWNat()
        internal
    {
        // msg.value is always > 0 in this contract
        if (msg.value > 0) {
            totalCollateral += msg.value;
            wNat.deposit{value: msg.value}();
            assetManager.updateCollateral(agentVault, wNat);
        }
    }

    ////////////////////////////////////////////////////////////////////////////////////
    // methods for viewing user balances

    /**
     * @notice Returns the sum of the user's reward f-assets and their corresponding f-asset debt
     * @param _account  User address
     */
    function virtualFAssetOf(address _account)
        external view
        returns (uint256)
    {
        AssetData memory assetData = _getAssetData();
        return _virtualFAssetFeesOf(assetData, _account);
    }

    /**
     * @notice Returns user's reward f-assets
     * @param _account  User address
     */
    function fAssetFeesOf(address _account)
        external view
        returns (uint256)
    {
        AssetData memory assetData = _getAssetData();
        return _fAssetFeesOf(assetData, _account);
    }

    /**
     * @notice Returns user's f-asset debt
     * @param _account  User address
     */
    function fAssetFeeDebtOf(address _account)
        external view
        returns (int256)
    {
        return _fAssetFeeDebtOf[_account];
    }

    /**
     * @notice Returns user's debt tokens
     * @param _account  User address
     */
    function debtLockedTokensOf(address _account)
        external view
        returns (uint256)
    {
        AssetData memory assetData = _getAssetData();
        return MathUtils.subOrZero(token.balanceOf(_account), _debtFreeTokensOf(assetData, _account));
    }

    /**
     * @notice Returns user's free tokens
     * @param _account  User address
     */
    function debtFreeTokensOf(address _account)
        external view
        returns (uint256)
    {
        AssetData memory assetData = _getAssetData();
        return _debtFreeTokensOf(assetData, _account);
    }

    ////////////////////////////////////////////////////////////////////////////////////
    // Methods to allow for liquidation/destruction of the pool by AssetManager or agent

    function destroy(address payable _recipient)
        external
        onlyAssetManager
        nonReentrant
    {
        require(token.totalSupply() == 0, "cannot destroy a pool with issued tokens");
        token.destroy(_recipient);
        // transfer native balance as WNat, if any
        Transfers.depositWNat(wNat, _recipient, address(this).balance);
        // transfer untracked f-assets and wNat, if any
        uint256 untrackedWNat = wNat.balanceOf(address(this));
        uint256 untrackedFAsset = fAsset.balanceOf(address(this));
        if (untrackedWNat > 0) {
            wNat.safeTransfer(_recipient, untrackedWNat);
        }
        if (untrackedFAsset > 0) {
            fAsset.safeTransfer(_recipient, untrackedFAsset);
        }
    }

    function depositNat()
        external payable
        onlyAssetManager
    {
        _depositWNat();
    }

    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function payout(
        address _recipient,
        uint256 _amount,
        uint256 _agentResponsibilityWei
    )
        external
        onlyAssetManager
        nonReentrant
    {
        AssetData memory assetData = _getAssetData();
        _transferWNatTo(_recipient, _amount);
        // slash agent vault's pool tokens worth _agentResponsibilityWei in FLR (or less if there is not enough)
        uint256 agentTokenBalance = token.balanceOf(agentVault);
        uint256 maxSlashedTokens = assetData.poolNatBalance > 0 ?
             assetData.poolTokenSupply.mulDiv(_agentResponsibilityWei, assetData.poolNatBalance) : agentTokenBalance;
        uint256 slashedTokens = Math.min(maxSlashedTokens, agentTokenBalance);
        if (slashedTokens > 0) {
            uint256 debtFAssetFeeShare = _tokensToVirtualFeeShare(assetData, slashedTokens);
            _deleteFAssetFeeDebt(agentVault, debtFAssetFeeShare);
            token.burn(agentVault, slashedTokens, true);
            emit CPExited(agentVault, slashedTokens, 0, 0, _fAssetFeeDebtOf[agentVault]);
        }
        emit CPPaidOut(_recipient, _amount, slashedTokens);
    }

    // slither-disable-next-line reentrancy-eth         // guarded by nonReentrant
    function upgradeWNatContract(IWNat _newWNat)
        external
        onlyAssetManager
        nonReentrant
    {
        if (_newWNat == wNat) return;
        // transfer all funds to new WNat
        uint256 balance = wNat.balanceOf(address(this));
        internalWithdrawal = true;
        wNat.withdraw(balance);
        internalWithdrawal = false;
        _newWNat.deposit{value: balance}();
        // set new WNat contract
        wNat = _newWNat;
        assetManager.updateCollateral(agentVault, wNat);
    }

    ////////////////////////////////////////////////////////////////////////////////////
    // Delegation of the pool's collateral and airdrop claiming (same as in AgentVault)

    function delegate(address _to, uint256 _bips) external onlyAgent {
        wNat.delegate(_to, _bips);
    }

    function undelegateAll() external onlyAgent {
        wNat.undelegateAll();
    }

    function delegateGovernance(address _to) external onlyAgent {
        wNat.governanceVotePower().delegate(_to);
    }

    function undelegateGovernance() external onlyAgent {
        wNat.governanceVotePower().undelegate();
    }

    function claimDelegationRewards(
        IRewardManager _rewardManager,
        uint24 _lastRewardEpoch,
        IRewardManager.RewardClaimWithProof[] calldata _proofs
    )
        external
        onlyAgent
        nonReentrant
        returns (uint256)
    {
        uint256 balanceBefore = wNat.balanceOf(address(this));
        _rewardManager.claim(address(this), payable(address(this)), _lastRewardEpoch, true, _proofs);
        uint256 balanceAfter = wNat.balanceOf(address(this));
        uint256 claimed = balanceAfter - balanceBefore;
        totalCollateral += claimed;
        emit CPClaimedReward(claimed, 1);
        return claimed;
    }

    function claimAirdropDistribution(
        IDistributionToDelegators _distribution,
        uint256 _month
    )
        external
        onlyAgent
        nonReentrant
        returns(uint256)
    {
        uint256 balanceBefore = wNat.balanceOf(address(this));
        _distribution.claim(address(this), payable(address(this)), _month, true);
        uint256 balanceAfter = wNat.balanceOf(address(this));
        uint256 claimed = balanceAfter - balanceBefore;
        totalCollateral += claimed;
        emit CPClaimedReward(claimed, 0);
        return claimed;
    }

    function optOutOfAirdrop(
        IDistributionToDelegators _distribution
    )
        external
        onlyAgent
        nonReentrant
    {
        _distribution.optOutOfAirdrop();
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
    { // solhint-disable-line no-empty-blocks
    }

    ////////////////////////////////////////////////////////////////////////////////////
    // The rest

    function isAgentVaultOwner(address _address)
        internal view
        returns (bool)
    {
        return assetManager.isAgentVaultOwner(agentVault, _address);
    }

    /**
     * Implementation of ERC-165 interface.
     */
    function supportsInterface(bytes4 _interfaceId)
        external pure override
        returns (bool)
    {
        return _interfaceId == type(IERC165).interfaceId
            || _interfaceId == type(ICollateralPool).interfaceId
            || _interfaceId == type(IICollateralPool).interfaceId;
    }
}
