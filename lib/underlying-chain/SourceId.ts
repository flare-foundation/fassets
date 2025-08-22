import { encodeAttestationName } from "@flarenetwork/js-flare-common";

export type SourceId = string;

export namespace SourceId {
    export const XRP = encodeAttestationName("XRP");            // 0x5852500000000000000000000000000000000000000000000000000000000000
    export const testXRP = encodeAttestationName("testXRP");    // 0x7465737458525000000000000000000000000000000000000000000000000000
    export const BTC = encodeAttestationName("BTC");            // 0x4254430000000000000000000000000000000000000000000000000000000000
    export const testBTC = encodeAttestationName("testBTC");    // 0x7465737442544300000000000000000000000000000000000000000000000000
    export const DOGE = encodeAttestationName("DOGE");          // 0x444f474500000000000000000000000000000000000000000000000000000000
    export const testDOGE = encodeAttestationName("testDOGE");  // 0x74657374444f4745000000000000000000000000000000000000000000000000
    export const LTC = encodeAttestationName("LTC");            // 0x4c54430000000000000000000000000000000000000000000000000000000000
}
