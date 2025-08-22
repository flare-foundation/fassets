import { AssertionError } from "chai";
import { BNish, toBN } from "../utils/helpers";
import { web3DeepNormalize, web3Normalize } from "../utils/web3normalize";

// Web3 returns struct results as union of array and struct, but later methods interpet it as an array.
// So this method just extracts all non-array properties.
export function web3ResultStruct<T extends object>(value: T): T {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
        if (!/^\d+$/.test(key)) {
            result[key] = obj[key];
        }
    }
    return result as T;
}

export function assertWeb3Equal(actual: unknown, expected: unknown, message?: string) {
    assert.strictEqual(web3Normalize(actual), web3Normalize(expected), message);
}

const comparisonValues = { '==': [0], '!=': [-1, 1], '===': [0], '!==': [-1, 1], '<': [-1], '>': [1], '<=': [-1, 0], '>=': [0, 1] };

export function assertWeb3Compare(actual: BNish, comparison: keyof typeof comparisonValues, expected: BNish, message?: string) {
    const cmp = toBN(actual).cmp(toBN(expected));
    if (!comparisonValues[comparison].includes(cmp)) {
        const cmpConvert = { '-1': 'the first is smaller', '0': 'they are equal', '1': 'the first is greater'};
        message ??= `Expected ${actual} ${comparison} ${expected}, but ${cmpConvert[cmp]}`;
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw new AssertionError(message, { actual: String(actual), expected: String(expected), showDiff: true });
    }
}

export function assertWeb3DeepEqual(actual: unknown, expected: unknown, message?: string) {
    assert.deepStrictEqual(web3DeepNormalize(actual), web3DeepNormalize(expected), message);
}

export function assertWeb3ArrayEqual(actual: unknown[], expected: unknown[], message?: string) {
    assert.equal(actual.length, expected.length, message ?? `Expected array length ${actual.length} to equal ${expected.length}`);
    const an: unknown[] = web3DeepNormalize(actual);
    const bn: unknown[] = web3DeepNormalize(expected);
    for (let i = 0; i < an.length; i++) {
        assert.equal(an[i], bn[i], message ?? `Expected ${actual[i]} to equal ${expected[i]} at index ${i}`);
    }
}

export function assertWeb3SetEqual(actual: unknown[] | Iterable<unknown>, expected: unknown[] | Iterable<unknown>, message?: string) {
    const aset = new Set(web3DeepNormalize(actual));
    const bset = new Set(web3DeepNormalize(expected));
    for (const elt of aset) {
        assert.isTrue(bset.has(elt), message ?? `Element ${elt} missing in second set`);
    }
    for (const elt of bset) {
        assert.isTrue(aset.has(elt), message ?? `Element ${elt} missing in first set`);
    }
}
