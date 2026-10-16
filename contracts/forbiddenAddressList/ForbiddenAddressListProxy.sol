// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IGovernanceSettings} from "@flarenetwork/flare-periphery-contracts/flare/IGovernanceSettings.sol";
import {ForbiddenAddressList} from "./ForbiddenAddressList.sol";


contract ForbiddenAddressListProxy is ERC1967Proxy {
    constructor(
        address _implementationAddress,
        IGovernanceSettings _governanceSettings,
        address _initialGovernance
    )
        ERC1967Proxy(_implementationAddress,
            abi.encodeCall(ForbiddenAddressList.initialize, (_governanceSettings, _initialGovernance)))
    {
    }
}
