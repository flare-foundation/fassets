import BN from "bn.js";

// convert primitive object to normalized form (mostly string)

/**
 * Web3/truffle sometimes returns numbers as BN and sometimes as strings and accepts strings, BN and numbers.
 * This function converts all number formats to string for simpler comparison.
 */
export function web3Normalize(x: unknown) {
    if (x == null)
        return null; // undefined also converted to null
    switch (typeof x) {
        case "boolean":
        case "string":
            return x;
        case "number":
        case "bigint":
            return "" + x;
        case "object":
            if (BN.isBN(x)) {
                return x.toString(10);
            }
            // if (BigNumber.isBigNumber(x)) {
            //     return x.toString();
            // }
            break;
    }
    throw new Error(`Unsupported object type ${typeof x === 'object' ? x.constructor?.name : typeof x}`);
}

/**
 * Web3/truffle sometimes returns numbers as BN and sometimes as strings and accepts strings, BN and numbers.
 * This function converts all number formats to string for simpler comparison.
 * Also converts all struct and array members recursively.
 */
export function web3DeepNormalize<T>(value: T): T {
    function normalizeArray<E>(arr: E[]): E[] {
        const result: E[] = [];
        visited.add(arr);
        for (const v of arr) {
            result.push(normalizeImpl(v));
        }
        visited.delete(arr);
        return result;
    }
    function normalizeObject<E extends object>(obj: E): E {
        if (obj.constructor !== Object) {
            throw new Error(`Unsupported object type ${obj.constructor.name}`);
        }
        const result: Record<string, unknown> = {};
        visited.add(obj);
        for (const [k, v] of Object.entries(obj)) {
            result[k] = normalizeImpl(v);
        }
        visited.delete(obj);
        return result as E;
    }
    function normalizeImpl<E>(obj: E): E {
        if (obj == null) {
            return null as E; // undefined also converted to null
        } else if (visited.has(obj)) {
            throw new Error("Circular structure");
        } else if (typeof obj === "object") {
            if (BN.isBN(obj)) {
                return obj.toString(10) as E;
            // } else if (BigNumber.isBigNumber(obj)) {
            //     return obj.toString();
            } else if (Array.isArray(obj)) {
                return normalizeArray(obj) as E;
            } else {
                return normalizeObject(obj);
            }
        } else {
            return web3Normalize(obj) as E; // normalize as primitive
        }
    }
    const visited = new Set<unknown>();
    return normalizeImpl(value);
}
