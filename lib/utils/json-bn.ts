/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-return */

import BN from "bn.js";
import { readFileSync, writeFileSync } from "fs";
import { BNish, toBN } from "./helpers";

export function jsonBNserializer(this: any, key: string, serializedValue: any) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const value = this[key];
    return BN.isBN(value) ? value.toString(10) : serializedValue;
}

export function jsonBNDeserializer(bnKeys: string[]) {
    return function (key: string, value: any) {
        return bnKeys.includes(key) ? toBN(value as BNish) : value;
    }
}

// JSON.stringify with correct BN hamdling
export function stringifyJson(data: any, indent?: string | number) {
    return JSON.stringify(data, jsonBNserializer, indent);
}

export function parseJson(json: string, bnKeys: string[] = []) {
    return JSON.parse(json, jsonBNDeserializer(bnKeys));
}

export function saveJson(file: string, data: any, indent?: string | number) {
    writeFileSync(file, JSON.stringify(data, jsonBNserializer, indent));
}

export function loadJson(file: string, bnKeys: string[] = []) {
    const buf = readFileSync(file);
    return JSON.parse(buf.toString(), jsonBNDeserializer(bnKeys));
}
