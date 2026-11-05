import fs from "fs";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import path from "path";
import { AbiInput, AbiItem } from "web3-utils";
import { ContractStore } from "./contracts";
import { getProxyImplementationAddress, requiredEnvironmentVariable, ZERO_ADDRESS } from "./deploy-utils";

/** Root directory for governance transaction files; transactions are written to `<root>/<Chain>Governance/<nonce>_<MM-DD-YYYY>/main.json`. */
export const GOVERNANCE_TRANSACTIONS_DIR_ENV = "GOVERNANCE_TRANSACTIONS_DIR";
/** Names of the two reviewers of every governance transaction. */
export const GOVERNANCE_REVIEWER_1_ENV = "GOVERNANCE_REVIEWER_1";
export const GOVERNANCE_REVIEWER_2_ENV = "GOVERNANCE_REVIEWER_2";

/**
 * Auto-incrementing governance multisig nonce counter.
 * When passed as the `execute` argument of the methods in `upgrade-contracts.ts` (or as the `execute` option of `deployCuts`),
 * the governance calls are never executed; instead, a governance transaction JSON file is created for every call,
 * each with the next nonce.
 */
export class GovernanceNonce {
    readonly outputDir: string;
    readonly reviewers: readonly [string, string];
    /** Formatted nonce of the last generated timelocked transaction; later non-timelocked transactions must wait for its timelock. */
    lastTimelockedNonce?: string;
    private nextNonce: number;

    constructor(start: number) {
        if (!Number.isSafeInteger(start) || start < 0) {
            throw new Error(`Invalid governance nonce ${start}`);
        }
        this.nextNonce = start;
        // read the environment immediately, so that missing variables are reported before anything is deployed
        this.outputDir = requiredEnvironmentVariable(GOVERNANCE_TRANSACTIONS_DIR_ENV);
        this.reviewers = [requiredEnvironmentVariable(GOVERNANCE_REVIEWER_1_ENV), requiredEnvironmentVariable(GOVERNANCE_REVIEWER_2_ENV)];
    }

    /** Return the current nonce and advance the counter. */
    next(): number {
        return this.nextNonce++;
    }
}

/**
 * Create an auto-incrementing governance nonce counter, to be used as `execute` argument, e.g. `let execute = Nonce(996);`.
 */
export function Nonce(start: number) {
    return new GovernanceNonce(start);
}

/**
 * Controls what happens with governance calls in deploy scripts:
 * - `true` - execute the call, unless the contract is in production mode (then just print the call data);
 * - `false` - just print the call data;
 * - `GovernanceNonce` - print the call data and write a governance transaction JSON file (with the next nonce).
 */
export type ExecuteOption = boolean | GovernanceNonce;

export interface GovernanceCall {
    /** The contract name to show in the transaction (typically the name in the contracts store). */
    contractName: string;
    /** The called contract (only `address` and `abi` are used). */
    instance: Truffle.ContractInstance;
    method: string;
    args: unknown[];
    /** Short description (`short_description` field). */
    description?: string;
    /** Timelock in seconds. If omitted, it is determined from the governance modifier of the called method. */
    timelockSeconds?: number;
    /**
     * Name of the Solidity contract that implements the called method; only used for determining the timelock.
     * If omitted, the contract is detected from the instance, diamond facets or ERC1967 proxy implementation.
     */
    implementationContract?: string;
}

/**
 * Write governance transaction JSON file for `call`, using the next nonce from `nonce`.
 * Only `initiation_section` is filled, the other sections have default values.
 * @returns the path of the written file
 */
export async function writeGovernanceTransaction(hre: HardhatRuntimeEnvironment, contracts: ContractStore, nonce: GovernanceNonce, call: GovernanceCall) {
    const methodAbi = findMethodAbi(call.instance.abi, call.method, call.args.length);
    const calldata = hre.web3.eth.abi.encodeFunctionCall(methodAbi, call.args as string[]);
    const inputs = methodAbi.inputs ?? [];
    const decodedArgs = hre.web3.eth.abi.decodeParameters(inputs, "0x" + calldata.slice(10));
    const parameters = inputs.map((input, i) => ({ name: input.name, value: formatAbiValue(input, decodedArgs[i]) }));
    const governed = await (hre.artifacts as Truffle.Artifacts).require("IGoverned").at(call.instance.address);
    const governanceAddress = await governed.governance();
    const timelock = call.timelockSeconds ?? await governanceMethodTimelock(hre, contracts, call, calldata.slice(0, 10));
    const chainName = hre.network.name;
    const wallet = `${chainName.charAt(0).toUpperCase()}${chainName.slice(1)}Governance`;
    const walletDir = path.join(nonce.outputDir, wallet);
    const nonceStr = String(nonce.next()).padStart(4, "0");
    const date = formatDate(new Date());
    checkNonceUnused(walletDir, nonceStr);
    // non-timelocked transactions must not overtake the preceding timelocked ones
    const comment = timelock === 0 && nonce.lastTimelockedNonce != null
        ? `must be executed after the timelock for ${nonce.lastTimelockedNonce}` : "";
    const transaction = {
        initiation_section: {
            chain_name: chainName,
            address: governanceAddress,
            wallet: wallet,
            nonce: nonceStr,
            date: date,
            contract_name: call.contractName,
            contract_address: call.instance.address,
            contract_method: call.method,
            short_description: call.description ?? "",
            is_cancellation_of_previous_transaction: false,
            bytecode_optional: calldata,
            timelock_duration: timelock,
            parameters: parameters,
            link_to_code_optional: "",
            reviewers: {
                reviewer_1: nonce.reviewers[0],
                reviewer_2: nonce.reviewers[1],
            },
            comment_optional: comment,
        },
        validation_section: {
            execution_time: "",
            last_signer_should_execute: false,
            preferred_executor: "",
            comment_optional: "",
        },
        review_section1: {
            reviewer: false,
        },
        review_section2: {
            reviewer: false,
        },
        execution_section: {
            transaction_canceled: false,
            execution_time: "",
            tx_id: "",
        },
    };
    const transactionDir = path.join(walletDir, `${nonceStr}_${date}`);
    fs.mkdirSync(transactionDir, { recursive: true });
    const file = path.join(transactionDir, "main.json");
    fs.writeFileSync(file, JSON.stringify(transaction, null, 2) + "\n");
    if (timelock > 0) {
        nonce.lastTimelockedNonce = nonceStr;
    }
    console.log(`Governance transaction ${wallet} #${nonceStr} (${call.contractName}.${call.method}) written to ${file}`);
    return file;
}

/**
 * Read the timelock from contract's governance settings.
 */
export async function readGovernanceTimelock(hre: HardhatRuntimeEnvironment, governedAddress: string) {
    const governed = await (hre.artifacts as Truffle.Artifacts).require("IGoverned").at(governedAddress);
    const governanceSettings = await (hre.artifacts as Truffle.Artifacts).require("IGovernanceSettings").at(await governed.governanceSettings());
    return Number(await governanceSettings.getTimelock());
}

function findMethodAbi(abi: AbiItem[], method: string, argCount: number) {
    const candidates = abi.filter(it => it.type === "function" && it.name === method && (it.inputs ?? []).length === argCount);
    if (candidates.length !== 1) {
        throw new Error(`Cannot find unique method ${method} with ${argCount} arguments in abi (found ${candidates.length})`);
    }
    return candidates[0];
}

/**
 * Format decoded ABI value like in governance transaction files: integers as decimal strings (enums as numbers),
 * tuples as objects with named fields, addresses checksummed.
 */
function formatAbiValue(param: AbiInput, value: unknown): unknown {
    const arrayMatch = /^(.*)\[\d*\]$/.exec(param.type);
    if (arrayMatch) {
        const elementParam: AbiInput = { ...param, type: arrayMatch[1], internalType: param.internalType?.replace(/\[\d*\]$/, "") };
        return (value as unknown[]).map(v => formatAbiValue(elementParam, v));
    }
    if (param.type === "tuple") {
        const components = param.components ?? [];
        const tuple = value as Record<number, unknown>;
        if (components.every(c => c.name)) {
            return Object.fromEntries(components.map((c, i) => [c.name, formatAbiValue(c, tuple[i])]));
        }
        return components.map((c, i) => formatAbiValue(c, tuple[i]));
    }
    if (/^u?int\d*$/.test(param.type)) {
        return param.internalType?.startsWith("enum ") ? Number(value) : String(value);
    }
    return value;
}

function formatDate(date: Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${date.getFullYear()}`;
}

function checkNonceUnused(walletDir: string, nonceStr: string) {
    if (!fs.existsSync(walletDir)) return;
    const existing = fs.readdirSync(walletDir).find(name => name.startsWith(`${nonceStr}_`));
    if (existing) {
        throw new Error(`Governance transaction with nonce ${nonceStr} already exists: ${path.join(walletDir, existing)}`);
    }
}

// Timelock detection from the governance modifiers in the compiler AST

async function governanceMethodTimelock(hre: HardhatRuntimeEnvironment, contracts: ContractStore, call: GovernanceCall, selector: string) {
    const { contractName, modifiers } = await findMethodModifiers(hre, contracts, call, selector);
    if (modifiers.includes("onlyImmediateGovernance")) {
        return 0;
    } else if (modifiers.includes("onlyGovernance")) {
        return await readGovernanceTimelock(hre, call.instance.address);
    } else if (modifiers.includes("onlyGovernanceWithTimelockAtLeast")) {
        throw new Error(`Method ${contractName}.${call.method} has call-specific minimum timelock - timelockSeconds must be provided explicitly`);
    } else {
        throw new Error(`Method ${contractName}.${call.method} has no governance modifier`);
    }
}

async function findMethodModifiers(hre: HardhatRuntimeEnvironment, contracts: ContractStore, call: GovernanceCall, selector: string) {
    const address = call.instance.address;
    const candidates: (() => Promise<string | undefined>)[] = [
        async () => call.implementationContract,
        async () => truffleInstanceContractName(call.instance),
        async () => contractNameAt(contracts, await diamondFacetAddress(hre, address, selector)),
        async () => contractNameAt(contracts, await getProxyImplementationAddress(hre, address)),
    ];
    const tried: string[] = [];
    for (const candidate of candidates) {
        const contractName = await candidate();
        if (contractName == null || tried.includes(contractName)) continue;
        tried.push(contractName);
        const modifiers = await implementedMethodModifiers(hre, contractName, selector);
        if (modifiers != null) {
            return { contractName, modifiers };
        }
    }
    throw new Error(`Cannot determine timelock: no implementation of ${call.method} (${selector}) found for contract at ${address} (tried ${tried.join(", ") || "nothing"})`);
}

function truffleInstanceContractName(instance: Truffle.ContractInstance): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    return (instance as any).constructor?.contractName as string | undefined;
}

async function diamondFacetAddress(hre: HardhatRuntimeEnvironment, address: string, selector: string) {
    try {
        const loupe = await (hre.artifacts as Truffle.Artifacts).require("IDiamondLoupe").at(address);
        return await loupe.facetAddress(selector);
    } catch {
        return undefined;   // not a diamond
    }
}

function contractNameAt(contracts: ContractStore, address: string | undefined) {
    if (address == null || address === ZERO_ADDRESS) return undefined;
    const contract = contracts.findByAddress(address) ?? contracts.findByAddressInHistory(address);
    return contract?.contractName.replace(/\.sol$/, "");
}

interface AstNode {
    id: number;
    nodeType: string;
    name?: string;
    nodes?: AstNode[];
    linearizedBaseContracts?: number[];
    functionSelector?: string;
    implemented?: boolean;
    modifiers?: { modifierName: { name: string } }[];
}

interface AstContractIndex {
    byId: Map<number, AstNode>;
    byQualifiedName: Map<string, AstNode>;
}

const astContractIndexCache = new Map<string, AstContractIndex>();

/**
 * Find the modifiers of the method with `selector`, as implemented in Solidity contract `contractName` (including inherited methods).
 * Returns undefined if the contract is unknown or doesn't implement the method (e.g. it is an interface).
 */
async function implementedMethodModifiers(hre: HardhatRuntimeEnvironment, contractName: string, selector: string) {
    const artifact = await hre.artifacts.readArtifact(contractName).catch(() => undefined);
    if (artifact == null) return undefined;
    const qualifiedName = `${artifact.sourceName}:${artifact.contractName}`;
    const index = await astContractIndex(hre, qualifiedName);
    const contractNode = index.byQualifiedName.get(qualifiedName);
    const selectorHex = selector.replace(/^0x/, "").toLowerCase();
    for (const baseId of contractNode?.linearizedBaseContracts ?? []) {
        const method = index.byId.get(baseId)?.nodes?.find(node =>
            node.nodeType === "FunctionDefinition" && node.functionSelector === selectorHex && node.implemented);
        if (method) {
            return (method.modifiers ?? []).map(m => m.modifierName.name);
        }
    }
    return undefined;
}

async function astContractIndex(hre: HardhatRuntimeEnvironment, qualifiedName: string) {
    const buildInfo = await hre.artifacts.getBuildInfo(qualifiedName);
    if (buildInfo == null) {
        throw new Error(`Missing build info for ${qualifiedName}`);
    }
    let index = astContractIndexCache.get(buildInfo.id);
    if (index == null) {
        index = { byId: new Map(), byQualifiedName: new Map() };
        for (const [sourceName, source] of Object.entries(buildInfo.output.sources)) {
            for (const node of (source.ast as AstNode).nodes ?? []) {
                if (node.nodeType === "ContractDefinition") {
                    index.byId.set(node.id, node);
                    index.byQualifiedName.set(`${sourceName}:${node.name}`, node);
                }
            }
        }
        astContractIndexCache.set(buildInfo.id, index);
    }
    return index;
}
