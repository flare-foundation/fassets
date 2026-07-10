// Compiles a single Solidity file with solc in standard-JSON mode and extracts
// its NatSpec documentation (userdoc/devdoc) into cache files that parsedoc.ts reads.
//
// The old `solcjs --userdoc --devdoc` CLI flags were removed in solc 0.8.x, so
// NatSpec is now only available through standard-JSON output selection.
//
// Usage: node scripts/compiledoc.js <solfile> <cachedir>

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const solfile = process.argv[2];
const cachedir = process.argv[3];

if (!solfile || !cachedir) {
    console.error("Usage: node scripts/compiledoc.js <solfile> <cachedir>");
    process.exit(1);
}

const barename = path.basename(solfile, ".sol");

const input = {
    language: "Solidity",
    sources: { [solfile]: { urls: [solfile] } },
    settings: { outputSelection: { "*": { "*": ["abi", "userdoc", "devdoc"] } } },
};

// Use the solc CLI in standard-JSON mode so import resolution (relative imports
// and node_modules packages) is handled by --base-path / --include-path.
// solc.js calls process.exit(), which truncates a piped stdout before the (large)
// JSON payload flushes, so capture stdout through a file descriptor instead.
fs.mkdirSync(cachedir, { recursive: true });
const rawOut = path.join(cachedir, `${barename}.solc-out.json`);
const outFd = fs.openSync(rawOut, "w");
let res;
try {
    res = spawnSync(
        process.execPath,
        [
            path.join("node_modules", "solc", "solc.js"),
            "--standard-json",
            "--base-path", ".",
            "--include-path", "node_modules",
        ],
        { input: JSON.stringify(input), stdio: ["pipe", outFd, "pipe"], encoding: "utf8" }
    );
} finally {
    fs.closeSync(outFd);
}

if (res.error) {
    console.error(res.error);
    process.exit(1);
}

// solc may print non-JSON notices (e.g. SMT warnings) before the JSON payload.
const stdout = fs.readFileSync(rawOut, "utf8");
fs.rmSync(rawOut, { force: true });
const jsonStart = stdout.indexOf("{");
if (jsonStart < 0) {
    console.error("solc produced no JSON output:\n" + stdout + (res.stderr || ""));
    process.exit(1);
}

const output = JSON.parse(stdout.slice(jsonStart));

const errors = (output.errors || []).filter((e) => e.severity === "error");
if (errors.length > 0) {
    console.error(errors.map((e) => e.formattedMessage || e.message).join("\n"));
    process.exit(1);
}

const fileContracts = output.contracts && output.contracts[solfile];
if (!fileContracts || Object.keys(fileContracts).length === 0) {
    console.error(`No contracts found in ${solfile}`);
    process.exit(1);
}

// Prefer the contract named like the file (project convention), else the first one.
const contractName = fileContracts[barename] ? barename : Object.keys(fileContracts)[0];
const contract = fileContracts[contractName];

const combined = {
    name: contractName,
    abi: contract.abi,
    userdoc: contract.userdoc,
    devdoc: contract.devdoc,
};
fs.writeFileSync(path.join(cachedir, `${barename}.docjson`), JSON.stringify(combined, null, 2));
