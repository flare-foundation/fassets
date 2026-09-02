export type FtsoV2FeedSource = "scaling" | "fastUpdates";

export interface FtsoV2Feed {
    feedId: string;
    symbol: string;
    feedDecimals: number;
    source?: FtsoV2FeedSource;
}

export interface FtsoV2PriceStoreParameters {
    $schema?: string;
    contractName: string;
    firstVotingRoundStartTs: number;
    votingEpochDurationSeconds: number;
    trustedProviders: string[];
    trustedProvidersThreshold: number;
    maxSpreadBIPS: number;
    minTurnoutBIPS: number;
    feeds: FtsoV2Feed[];
}
