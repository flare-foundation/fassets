import { createHash } from "crypto";
import { toBN } from "../utils/helpers";

/**
 * Real-format underlying addresses for the tests that put an address on the forbidden address list.
 *
 * The mock chains take any string as an address, and so does the tests' `ForbiddenAddressListMock`, but the real list
 * (fsc-v2's `ForbiddenAddressList`) holds an address only in its chain's canonical form and refuses anything else
 * (`NonCanonicalAddress`): a classic `r…` address with a valid checksum on XRPL, a lowercase Bech32 (or Base58)
 * address of the list's network on Bitcoin - regtest on a `Local` list. So the tests list such addresses, which the
 * real list would take too. These helpers derive one from a readable label, deterministically, so a test can write
 * `xrplClassicAddress("Agent1")` where it wrote `"Agent1"`. The addresses are well-formed (XRPL: Base58Check with the
 * XRPL alphabet; Bitcoin: BIP-173 Bech32, or BIP-350 Bech32m above witness version 0); nobody holds their keys.
 */

const XRPL_ALPHABET = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz";
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function sha256(data: Buffer): Buffer {
    return createHash("sha256").update(data).digest();
}

/** A 20-byte id (an XRPL account id, a P2WPKH program) derived from a label. */
function labelId(label: string): Buffer {
    return sha256(Buffer.from(label, "utf8")).subarray(0, 20);
}

function base58Encode(bytes: Buffer, alphabet: string): string {
    let value = toBN("0x" + (bytes.length > 0 ? bytes.toString("hex") : "0"));
    let encoded = "";
    while (!value.isZero()) {
        encoded = alphabet[value.modn(58)] + encoded;
        value = value.divn(58);
    }
    for (const byte of bytes) {
        if (byte !== 0) break;
        encoded = alphabet[0] + encoded;
    }
    return encoded;
}

/** The XRPL classic address of a 20-byte account id: Base58Check (XRPL alphabet) of `0x00 ‖ accountId`. */
export function xrplClassicAddressOfAccountId(accountId: Buffer): string {
    if (accountId.length !== 20) throw new Error("xrplClassicAddressOfAccountId: the account id is 20 bytes");
    const payload = Buffer.concat([Buffer.from([0]), accountId]);
    const checksum = sha256(sha256(payload)).subarray(0, 4);
    return base58Encode(Buffer.concat([payload, checksum]), XRPL_ALPHABET);
}

/** A valid XRPL classic address (`r…`) derived from `label`. */
export function xrplClassicAddress(label: string): string {
    return xrplClassicAddressOfAccountId(labelId(label));
}

function bech32Polymod(values: number[]): number {
    let checksum = 1;
    for (const value of values) {
        const top = checksum >>> 25;
        checksum = (((checksum & 0x1ffffff) << 5) ^ value) >>> 0;
        for (let i = 0; i < 5; i++) {
            if ((top >>> i) & 1) checksum = (checksum ^ BECH32_GENERATOR[i]) >>> 0;
        }
    }
    return checksum;
}

function convertBits(data: Buffer, fromBits: number, toBits: number): number[] {
    let accumulator = 0;
    let bits = 0;
    const result: number[] = [];
    const maxValue = (1 << toBits) - 1;
    for (const value of data) {
        accumulator = (accumulator << fromBits) | value;
        bits += fromBits;
        while (bits >= toBits) {
            bits -= toBits;
            result.push((accumulator >>> bits) & maxValue);
        }
    }
    if (bits > 0) result.push((accumulator << (toBits - bits)) & maxValue);
    return result;
}

/**
 * The SegWit address of a witness program, lowercase: Bech32 (BIP-173) for version 0, Bech32m (BIP-350) above.
 */
export function segwitAddress(hrp: string, witnessVersion: number, program: Buffer): string {
    const data = [witnessVersion, ...convertBits(program, 8, 5)];
    const hrpExpanded = [...hrp].map(c => c.charCodeAt(0) >> 5).concat([0], [...hrp].map(c => c.charCodeAt(0) & 31));
    const constant = witnessVersion === 0 ? 1 : 0x2bc830a3;
    const polymod = (bech32Polymod([...hrpExpanded, ...data, 0, 0, 0, 0, 0, 0]) ^ constant) >>> 0;
    const checksum = Array.from({ length: 6 }, (_, i) => (polymod >>> (5 * (5 - i))) & 31);
    return hrp + "1" + [...data, ...checksum].map(value => BECH32_CHARSET[value]).join("");
}

/** A valid Bitcoin regtest P2WPKH address (`bcrt1q…`, lowercase) derived from `label`. */
export function btcRegtestAddress(label: string): string {
    return segwitAddress("bcrt", 0, labelId(label));
}
