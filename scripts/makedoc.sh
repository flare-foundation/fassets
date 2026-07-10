#!/bin/bash
set -euo pipefail

solfile=$1
barename=$(basename "$solfile" .sol)
targetdir=docs/api
cachedir=cache/docs

mkdir -p "$cachedir" "$targetdir"

# Compile the contract and extract its ABI + NatSpec (userdoc/devdoc) into the cache.
node scripts/compiledoc.js "$solfile" "$cachedir"

# Render a Markdown API reference from the extracted documentation.
yarn ts-node scripts/parsedoc.ts "$solfile" "$cachedir/$barename.docjson" "$targetdir/$barename.md"
