import { AssetManagerInitInstance, IIAssetManagerInstance } from "../../typechain-truffle";

type _AssetManagerSettings = Parameters<AssetManagerInitInstance['init']>[2];
export interface AssetManagerSettings extends _AssetManagerSettings {}

export enum CollateralClass {
    POOL = 1,
    VAULT = 2,
}

type _CollateralType = Parameters<AssetManagerInitInstance['init']>[3][0];
export interface CollateralType extends _CollateralType {}

type _AgentSettings = Parameters<IIAssetManagerInstance['createAgentVault']>[1];
export interface AgentSettings extends _AgentSettings {}

// status as returned from GetAgentInfo
export enum AgentStatus {
    NORMAL = 0,             // agent is operating normally
    LIQUIDATION = 1,        // liquidation due to collateral ratio - ends when agent is healthy
    FULL_LIQUIDATION = 2,   // illegal payment liquidation - always liquidates all and then agent must close vault
    DESTROYING = 3,         // agent announced destroy, cannot mint again; all existing mintings have been redeemed before
    DESTROYED = 4,          // agent has been destroyed, cannot do anything except return info
}

type _AgentInfo = Awaited<ReturnType<IIAssetManagerInstance['getAgentInfo']>>;
export interface AgentInfo extends _AgentInfo {}

type _AvailableAgentInfo = Awaited<ReturnType<IIAssetManagerInstance['getAvailableAgentsDetailedList']>>[0][0];
export interface AvailableAgentInfo extends _AvailableAgentInfo {}

export type AgentSetting =
    | "feeBIPS"
    | "poolFeeShareBIPS"
    | "redemptionPoolFeeShareBIPS"
    | "mintingVaultCollateralRatioBIPS"
    | "mintingPoolCollateralRatioBIPS"
    | "buyFAssetByAgentFactorBIPS"
    | "poolExitCollateralRatioBIPS";

type _RedemptionTicketInfo = Awaited<ReturnType<IIAssetManagerInstance['redemptionQueue']>>[0][0];
export interface RedemptionTicketInfo extends _RedemptionTicketInfo {}

export enum CollateralReservationStatus {
    ACTIVE,         // the minting process hasn't finished yet
    SUCCESSFUL,     // the payment has been confirmed and the FAssets minted
    DEFAULTED,      // the payment has defaulted and the agent received the collateral reservation fee
    EXPIRED         // the confirmation time has expired and the agent called unstickMinting
}

export enum RedemptionRequestStatus {
    ACTIVE,                 // waiting for confirmation/default
    DEFAULTED_UNCONFIRMED,  // default called, failed or late payment can still be confirmed
    // final statuses - there can be no valid payment for this redemption anymore
    SUCCESSFUL,             // successful payment confirmed
    DEFAULTED_FAILED,       // payment failed   (default was paid)
    BLOCKED,                // payment blocked
    REJECTED                // redemption request rejected due to invalid redeemer's address
}

// explicit conversions

export function collateralClass(value: BN | number | string) {
    return Number(value) as CollateralClass;
}

export function agentStatus(value: BN | number | string) {
    return Number(value) as AgentStatus;
}

export function collateralReservationStatus(value: BN | number | string) {
    return Number(value) as CollateralReservationStatus;
}

export function redemptionRequestStatus(value: BN | number | string) {
    return Number(value) as RedemptionRequestStatus;
}
