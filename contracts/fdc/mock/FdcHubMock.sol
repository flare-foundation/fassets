// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@flarenetwork/flare-periphery-contracts/flare/IFdcHub.sol";
import "./FdcRequestFeeConfigurationsMock.sol";


contract FdcHubMock is IFdcHub {
    /// The FDC request fee configurations contract.
    IFdcRequestFeeConfigurations public fdcRequestFeeConfigurations;

    constructor() {
        fdcRequestFeeConfigurations = new FdcRequestFeeConfigurationsMock();
    }

     /**
     * Method to request an attestation.
     * @param _data ABI encoded attestation request
     */
    function requestAttestation(bytes calldata _data) external payable {
        emit AttestationRequest(_data, msg.value);
    }

    /**
     * The offset (in seconds) for the requests to be processed during the current voting round.
     */
    function requestsOffsetSeconds() external pure returns (uint8) {
        return 0;
    }

    /**
     * The FDC inflation configurations contract.
     */
    function fdcInflationConfigurations() external view returns(IFdcInflationConfigurations) {}
}
