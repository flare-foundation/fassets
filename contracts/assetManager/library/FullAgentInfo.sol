// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {Liquidation} from "./Liquidation.sol";
import {Agent} from "./data/Agent.sol";
import {AgentInfo} from "../../userInterfaces/data/AgentInfo.sol";


library FullAgentInfo {

    function getAgentStatus(
        Agent.State storage _agent
    )
        internal view
        returns (AgentInfo.Status)
    {
        Agent.Status status = _agent.status;
        if (status == Agent.Status.NORMAL) {
            return AgentInfo.Status.NORMAL;
        } else if (status == Agent.Status.LIQUIDATION) {
            Agent.LiquidationPhase phase = Liquidation.currentLiquidationPhase(_agent);
            return phase == Agent.LiquidationPhase.CCB ? AgentInfo.Status.CCB : AgentInfo.Status.LIQUIDATION;
        } else if (status == Agent.Status.FULL_LIQUIDATION) {
            return AgentInfo.Status.FULL_LIQUIDATION;
        } else {
            assert (status == Agent.Status.DESTROYING);
            return AgentInfo.Status.DESTROYING;
        }
    }
}
