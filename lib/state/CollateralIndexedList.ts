import { CollateralType, CollateralClass, collateralClass } from "../fasset/AssetManagerTypes";
import { BNish, requireNotNull } from "../utils/helpers";

// this is a superinterface of CollateralType
export interface CollateralTypeId {
    collateralClass: BNish | CollateralClass;
    token: string;
}

export class CollateralIndexedList<T> implements Iterable<T> {
    list: T[] = [];
    index: Map<string, number> = new Map();

    set(token: CollateralTypeId, value: T) {
        const key = collateralTokenKey(token.collateralClass, token.token);
        const index = this.index.get(key);
        if (index) {
            this.list[index] = value;
        } else {
            this.list.push(value);
            this.index.set(key, this.list.length - 1);
        }
    }

    [Symbol.iterator](): Iterator<T> {
        return this.list[Symbol.iterator]();
    }

    get(collateralClass: BNish | CollateralClass, token: string): T;
    get(collateral: CollateralTypeId): T;
    get(cc: any, token?: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        const index = requireNotNull(this.index.get(token ? collateralTokenKey(cc, token) : collateralTokenKey(cc.collateralClass, cc.token)));
        return this.list[index];
    }

    getOptional(collateralClass: BNish | CollateralClass, token: string): T | undefined;
    getOptional(collateral: CollateralTypeId): T | undefined;
    getOptional(cc: any, token?: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        const index = this.index.get(token ? collateralTokenKey(cc, token) : collateralTokenKey(cc.collateralClass, cc.token));
        return index !== undefined ? this.list[index] : undefined;
    }
}

export class CollateralList extends CollateralIndexedList<CollateralType> {
    add(value: CollateralType) {
        this.set(value, value);
    }
}

export function isPoolCollateral(collateral: CollateralType) {
    return collateralClass(collateral.collateralClass) === CollateralClass.POOL && Number(collateral.validUntil) === 0;
}

export function isVaultCollateral(collateral: CollateralType) {
    return collateralClass(collateral.collateralClass) === CollateralClass.VAULT && Number(collateral.validUntil) === 0;
}

export function collateralTokenKey(collateralClass: BNish | CollateralClass, token: string) {
    return `${collateralClass}|${token}`;
}

export function collateralTokensEqual(a: CollateralTypeId, b: CollateralTypeId) {
    return collateralClass(a.collateralClass) === collateralClass(b.collateralClass) && a.token === b.token;
}
