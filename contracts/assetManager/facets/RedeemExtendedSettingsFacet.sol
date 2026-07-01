// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {IRedeemExtendedSettings} from "../../userInterfaces/IRedeemExtendedSettings.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SafePct} from "../../utils/library/SafePct.sol";
import {Globals} from "../library/Globals.sol";
import {Conversion} from "../library/Conversion.sol";
import {RedemptionRequests} from "../library/RedemptionRequests.sol";
import {AssetManagerSettings} from "../../userInterfaces/data/AssetManagerSettings.sol";
import {GovernedProxyImplementation} from "../../governance/implementation/GovernedProxyImplementation.sol";
import {SettingsUpdater} from "../library/SettingsUpdater.sol";


contract RedeemExtendedSettingsFacet is AssetManagerBase, GovernedProxyImplementation, IRedeemExtendedSettings {
    using SafeCast for uint256;

    error ValueTooBig();
    error IncreaseTooBig();

    modifier rateLimited() {
        SettingsUpdater.checkEnoughTimeSinceLastUpdate();
        _;
    }

    // setters

    function setMinimumRedeemAmountUBA(uint256 _valueUBA)
        external
        onlyGovernance
        rateLimited
    {
        AssetManagerSettings.Data storage settings = Globals.getSettings();
        // validate
        uint64 valueAMG = Conversion.convertUBAToAmg(_valueUBA);
        require(valueAMG <= settings.lotSizeAMG * uint256(10), ValueTooBig());
        uint64 currentAMG = RedemptionRequests.getSettings().minimumRedeemAmountAMG;
        require(valueAMG <= currentAMG * uint256(4) + settings.lotSizeAMG, IncreaseTooBig());
        // update
        RedemptionRequests.getSettings().minimumRedeemAmountAMG = valueAMG;
        emit IAssetManagerEvents.SettingChanged("minimumRedeemAmountUBA", _valueUBA);
    }

    function setSystemRedemptionFeeBIPS(uint256 _feeBIPS)
        external
        onlyGovernance
        rateLimited
    {
        RedemptionRequests.Settings storage settings = RedemptionRequests.getSettings();
        // validate
        require(_feeBIPS < SafePct.MAX_BIPS, ValueTooBig());
        require(_feeBIPS <= uint256(settings.systemRedemptionFeeBIPS) * 4 + 100, IncreaseTooBig());
        // update
        settings.systemRedemptionFeeBIPS = _feeBIPS.toUint16();
        emit IAssetManagerEvents.SettingChanged("systemRedemptionFeeBIPS", _feeBIPS);
    }

    function setSystemRedemptionFeeReceiver(address _receiver)
        external
        onlyGovernance
        rateLimited
    {
        // update (zero address is allowed - it disables the system redemption fee)
        RedemptionRequests.getSettings().systemRedemptionFeeReceiver = _receiver;
        // not really a contract, but the ContractChanged event works for any address
        emit IAssetManagerEvents.ContractChanged("systemRedemptionFeeReceiver", _receiver);
    }

    // getters

    function minimumRedeemAmountUBA() external view returns (uint256) {
        return Conversion.convertAmgToUBA(RedemptionRequests.minimumRedeemAmountAMG());
    }

    function systemRedemptionFeeBIPS() external view returns (uint256) {
        return RedemptionRequests.getSettings().systemRedemptionFeeBIPS;
    }

    function systemRedemptionFeeReceiver() external view returns (address) {
        return RedemptionRequests.getSettings().systemRedemptionFeeReceiver;
    }

    function effectiveSystemRedemptionFeeBIPS() external view returns (uint256) {
        RedemptionRequests.Settings storage settings = RedemptionRequests.getSettings();
        // a zero fee receiver disables the system redemption fee
        return settings.systemRedemptionFeeReceiver != address(0) ? settings.systemRedemptionFeeBIPS : 0;
    }
}
