import fs from "fs";

// Renders a Markdown API reference for a single contract from its combined
// documentation JSON (abi + userdoc + devdoc) produced by compiledoc.js.
//
// Usage: ts-node scripts/parsedoc.ts <solfile> <docjson> <outfile>

const solfile = process.argv[2];
const docfile = process.argv[3];
const outfile = process.argv[4];

interface AbiParam {
    name?: string;
    type: string;
    internalType?: string;
    indexed?: boolean;
    components?: AbiParam[];
}

interface AbiEntry {
    type: string; // "function" | "event" | "constructor" | "fallback" | ...
    name?: string;
    inputs?: AbiParam[];
    outputs?: AbiParam[];
    stateMutability?: string;
    anonymous?: boolean;
}

interface NatSpecMember {
    notice?: string;
    details?: string;
    params?: Record<string, string>;
    returns?: Record<string, string>;
}

const soltext = fs.readFileSync(solfile).toString();
const doc = JSON.parse(fs.readFileSync(docfile).toString());

const abi: AbiEntry[] = doc.abi || [];
const userMethods: Record<string, NatSpecMember> = (doc.userdoc && doc.userdoc.methods) || {};
const userEvents: Record<string, NatSpecMember> = (doc.userdoc && doc.userdoc.events) || {};
const devMethods: Record<string, NatSpecMember> = (doc.devdoc && doc.devdoc.methods) || {};
const devEvents: Record<string, NatSpecMember> = (doc.devdoc && doc.devdoc.events) || {};

// Source-declaration order, used to sort members the way they appear in the file.
// Members inherited from parent interfaces (absent from the source) are appended
// afterwards in ABI order.
const sourceOrder: Record<string, number> = {};
let sourceCount = 0;
for (const match of soltext.matchAll(/\n\s*(function|event)\s+(\w+)/g)) {
    if (!(match[2] in sourceOrder)) sourceOrder[match[2]] = sourceCount++;
}

// Canonical solidity type, used to reconstruct the signature keys that solc uses
// for the userdoc/devdoc maps (e.g. "transfer(address,uint256)").
function canonicalType(param: AbiParam): string {
    if (param.type.startsWith("tuple")) {
        const inner = "(" + (param.components || []).map(canonicalType).join(",") + ")";
        return param.type.replace("tuple", inner);
    }
    return param.type;
}

function signatureKey(entry: AbiEntry): string {
    return `${entry.name}(${(entry.inputs || []).map(canonicalType).join(",")})`;
}

// Human-friendly type for display: prefer internalType (keeps struct/enum/contract
// names) and strip the noisy "struct "/"enum "/"contract " prefixes.
function displayType(param: AbiParam): string {
    const t = param.internalType || param.type;
    return t.replace(/^struct /, "").replace(/^enum /, "").replace(/^contract /, "");
}

function paramText(param: AbiParam): string {
    const parts = [displayType(param)];
    if (param.indexed) parts.push("indexed");
    if (param.name) parts.push(param.name);
    return parts.join(" ");
}

function functionSignature(entry: AbiEntry): string {
    const params = (entry.inputs || []).map(paramText).join(", ");
    let sig = `function ${entry.name}(${params}) external`;
    const mut = entry.stateMutability;
    if (mut === "view" || mut === "pure" || mut === "payable") sig += ` ${mut}`;
    const outputs = entry.outputs || [];
    if (outputs.length > 0) {
        sig += ` returns (${outputs.map(paramText).join(", ")})`;
    }
    return sig;
}

function eventSignature(entry: AbiEntry): string {
    const params = (entry.inputs || []).map(paramText).join(", ");
    return `event ${entry.name}(${params})`;
}

// Put the NOTE marker (a NatSpec convention used in this codebase) on its own line.
function formatNotice(text: string | undefined): string {
    if (!text) return "";
    return text.replace(/\s*NOTE:/g, "\n\nNOTE:").trim();
}

function descriptionList(
    params: AbiParam[],
    descriptions: Record<string, string> | undefined,
    heading: string
): string {
    if (params.length === 0) return "";
    const descs = descriptions || {};
    // Only render the section if at least one entry has a description.
    const hasAny = params.some((p, i) => (p.name && descs[p.name]) || descs[`_${i}`]);
    if (!hasAny) return "";
    const items = params.map((p, i) => {
        const label = p.name || displayType(p);
        const desc = (p.name && descs[p.name]) || descs[`_${i}`] || "";
        return desc ? `- \`${label}\` — ${desc}` : `- \`${label}\``;
    });
    return `*${heading}:*\n\n${items.join("\n")}`;
}

interface Rendered {
    order: number;
    text: string;
}

const functions: Rendered[] = [];
const events: Rendered[] = [];

let abiIndex = 0;
for (const entry of abi) {
    const idx = abiIndex++;
    if (entry.type !== "function" && entry.type !== "event") continue;
    const name = entry.name || "";
    const key = signatureKey(entry);
    const order = name in sourceOrder ? sourceOrder[name] : sourceCount + idx;

    const blocks: string[] = [];
    blocks.push(`### ${name}`);

    if (entry.type === "function") {
        blocks.push("```solidity\n" + functionSignature(entry) + "\n```");
        const notice = formatNotice(userMethods[key] && userMethods[key].notice);
        const details = (devMethods[key] && devMethods[key].details) || "";
        if (notice) blocks.push(notice);
        if (details) blocks.push(details.trim());
        const params = descriptionList(entry.inputs || [], devMethods[key] && devMethods[key].params, "Parameters");
        if (params) blocks.push(params);
        const returns = descriptionList(entry.outputs || [], devMethods[key] && devMethods[key].returns, "Returns");
        if (returns) blocks.push(returns);
        functions.push({ order, text: blocks.join("\n\n") });
    } else {
        blocks.push("```solidity\n" + eventSignature(entry) + "\n```");
        const notice = formatNotice(userEvents[key] && userEvents[key].notice);
        const details = (devEvents[key] && devEvents[key].details) || "";
        if (notice) blocks.push(notice);
        if (details) blocks.push(details.trim());
        const params = descriptionList(entry.inputs || [], devEvents[key] && devEvents[key].params, "Parameters");
        if (params) blocks.push(params);
        events.push({ order, text: blocks.join("\n\n") });
    }
}

functions.sort((a, b) => a.order - b.order);
events.sort((a, b) => a.order - b.order);

const out: string[] = [];
out.push(`# ${doc.name || ""}`);

const title = doc.devdoc && doc.devdoc.title;
const contractNotice = formatNotice(doc.userdoc && doc.userdoc.notice);
const contractDetails = doc.devdoc && doc.devdoc.details;
const author = doc.devdoc && doc.devdoc.author;
if (title) out.push(`_${title.trim()}_`);
if (contractNotice) out.push(contractNotice);
if (contractDetails) out.push(contractDetails.trim());
if (author) out.push(`**Author:** ${author.trim()}`);

if (functions.length > 0) {
    out.push("## Methods");
    for (const f of functions) out.push(f.text);
}
if (events.length > 0) {
    out.push("## Events");
    for (const e of events) out.push(e.text);
}

fs.writeFileSync(outfile, out.join("\n\n") + "\n");
