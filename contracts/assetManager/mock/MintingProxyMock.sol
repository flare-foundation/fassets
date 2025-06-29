// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../../userInterfaces/IAssetManager.sol";
import "../../userInterfaces/IFAsset.sol";


contract MintingProxyMock {
    using SafeERC20 for IERC20;

    IAssetManager private assetManager;
    address private operator;
    address private agentVault;
    mapping (uint256 reservationId => address minter) private reservations;

    constructor(
        IAssetManager _assetManager,
        address _agentVault,
        address _operator
    ) {
        assetManager = _assetManager;
        agentVault = _agentVault;
        operator = _operator;
    }

    receive() external payable {
        // needed in case some fees get returned
    }

    function reserveCollateral(
        uint256 _lots,
        uint256 _maxMintingFeeBIPS
    )
        external
    {
        uint256 reservationId = assetManager.reserveCollateral(agentVault, _lots, _maxMintingFeeBIPS,
            payable(address(0)), new string[](0));
        reservations[reservationId] = msg.sender;
    }

    function executeMinting(
        IPayment.Proof calldata _payment,
        uint256 _collateralReservationId
    )
        external
    {
        require(msg.sender == operator, "only operator");
        address minter = reservations[_collateralReservationId];
        require(minter != address(0), "invalid reservation id");
        delete reservations[_collateralReservationId];
        CollateralReservationInfo.Data memory reservationInfo =
            assetManager.collateralReservationInfo(_collateralReservationId);
        assetManager.executeMinting(_payment, _collateralReservationId);
        uint256 mintedAmountUBA = reservationInfo.valueUBA;
        assetManager.fAsset().safeTransfer(minter, mintedAmountUBA);
    }

    function mintingFeeBIPS()
        external view
        returns (uint256)
    {
        AgentInfo.Info memory agentInfo = assetManager.getAgentInfo(agentVault);
        return agentInfo.feeBIPS;
    }
}