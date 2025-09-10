export interface DiamondCutJsonFacet {
    contract: string;
    methods?: string[]; // expose only the methods with given names
    exposedInterfaces?: string[]; // expose only the methods from these interfaces
}

export interface DiamondCutJsonInit {
    contract: string;
    method: string;
    args?: unknown[];
}

export interface DiamondCutJson {
    diamond: string | string[]; // address(es) of diamond(s) or name(s) in contracts.json
    facets: DiamondCutJsonFacet[];
    autoDeleteMethodsNotInInterface?: string[]; // a list of interfaces; deleted are methods that aren't in any of them
    deleteAllOldMethods?: boolean;
    deleteMethods?: string[];   // full signatures of methods that have been deleted (not replaced), eg. `methodName(uint256,bool)`
    init?: DiamondCutJsonInit;
}

export type DiamondCutJsonSchema = DiamondCutJson & { $schema?: string };
