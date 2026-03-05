// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {AssetManagerBase} from "./AssetManagerBase.sol";
import {IAssetManagerEvents} from "../../userInterfaces/IAssetManagerEvents.sol";
import {IRedeemExtendedSettings} from "../../userInterfaces/IRedeemExtendedSettings.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
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

    // setter

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

    // getters

    function minimumRedeemAmountUBA() external view returns (uint256) {
        return Conversion.convertAmgToUBA(RedemptionRequests.minimumRedeemAmountAMG());
    }
}
