// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {SafePct} from "../../utils/library/SafePct.sol";
import {Transfers} from "../../utils/library/Transfers.sol";
import {AssetManagerState} from "./data/AssetManagerState.sol";
import {Agents} from "./Agents.sol";
import {Agent} from "./data/Agent.sol";
import {CollateralReservation} from "./data/CollateralReservation.sol";
import {Conversion} from "./Conversion.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {Globals} from "./Globals.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";


library Minting {
    using SafePct for uint256;

    error MintingCapExceeded();
    error InvalidCrtId();

    function distributeCollateralReservationFee(
        Agent.State storage _agent,
        uint256 _fee
    )
        internal
    {
        if (_fee == 0) return;
        uint256 poolFeeShare = _fee.mulBips(_agent.poolFeeShareBIPS);
        _agent.collateralPool.depositNat{value: poolFeeShare}();
        Transfers.depositWNat(Globals.getWNat(), Agents.getOwnerPayAddress(_agent), _fee - poolFeeShare);
    }

    function releaseCollateralReservation(
        CollateralReservation.Data storage crt,
        uint256 _crtId
    )
        internal
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        Agent.State storage agent = Agent.get(crt.agentVault);
        uint64 reservationAMG = crt.valueAMG + Conversion.convertUBAToAmg(Minting.calculatePoolFeeUBA(agent, crt));
        agent.reservedAMG = agent.reservedAMG - reservationAMG;
        state.totalReservedCollateralAMG -= reservationAMG;
        delete state.crts[_crtId];
    }

    function getCollateralReservation(
        uint256 _crtId
    )
        internal view
        returns (CollateralReservation.Data storage)
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        require(_crtId > 0 && state.crts[_crtId].valueAMG != 0, InvalidCrtId());
        return state.crts[_crtId];
    }

    function checkMintingCap(
        uint64 _increaseAMG
    )
        internal view
    {
        AssetManagerState.State storage state = AssetManagerState.get();
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        uint256 mintingCapAMG = settings.mintingCapAMG;
        if (mintingCapAMG == 0) return;     // minting cap disabled
        uint256 totalMintedUBA = IERC20(settings.fAsset).totalSupply();
        uint256 totalAMG = state.totalReservedCollateralAMG + Conversion.convertUBAToAmg(totalMintedUBA);
        require(totalAMG + _increaseAMG <= mintingCapAMG, MintingCapExceeded());
    }

    function calculatePoolFeeUBA(
        Agent.State storage _agent,
        CollateralReservation.Data storage _crt
    )
        internal view
        returns (uint256)
    {
        // After an upgrade, poolFeeShareBIPS is stored in the collateral reservation.
        // To allow for backward compatibility, value 0 in this field indicates use of old _agent.poolFeeShareBIPS.
        uint16 storedPoolFeeShareBIPS = _crt.poolFeeShareBIPS;
        uint16 poolFeeShareBIPS = storedPoolFeeShareBIPS > 0 ? storedPoolFeeShareBIPS - 1 : _agent.poolFeeShareBIPS;
        return _calculatePoolFeeUBA(_crt.underlyingFeeUBA, poolFeeShareBIPS);
    }

    function calculateCurrentPoolFeeUBA(
        Agent.State storage _agent,
        uint256 _mintingValueUBA
    )
        internal view
        returns (uint256)
    {
        uint256 mintingFeeUBA = _mintingValueUBA.mulBips(_agent.feeBIPS);
        return _calculatePoolFeeUBA(mintingFeeUBA, _agent.poolFeeShareBIPS);
    }

    function _calculatePoolFeeUBA(
        uint256 _mintingFee,
        uint16 _poolFeeShareBIPS
    )
        private view
        returns (uint256)
    {
        // round to whole number of amg's to avoid rounding errors after minting (minted amount is in amg)
        return Conversion.roundUBAToAmg(_mintingFee.mulBips(_poolFeeShareBIPS));
    }
}