// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";
import {MintingTagManager} from "./MintingTagManager.sol";


contract MintingTagManagerProxy is ERC1967Proxy {
    constructor(
        address _implementationAddress,
        IGovernanceSettings _governanceSettings,
        address _initialGovernance,
        string memory _name,
        string memory _symbol,
        uint256 _reservationFeeNATWei,
        address payable _reservationFeeRecipient
    )
        ERC1967Proxy(_implementationAddress,
            abi.encodeCall(
                MintingTagManager.initialize, (
                    _governanceSettings, _initialGovernance,
                    _name, _symbol, _reservationFeeNATWei, _reservationFeeRecipient
                )
            )
        )
    {
    }
}
