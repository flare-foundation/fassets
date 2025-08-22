import Web3 from "web3";
import { Artifact, HardhatRuntimeEnvironment } from "hardhat/types";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface DeployAccounts {
    deployer: string;
}

export function requiredEnvironmentVariable(name: string): string {
    const value = process.env[name];
    if (value) return value;
    throw new Error(`Missing environment variable ${name}`);
}

export function networkDeployerPrivateKeyName(network: string) {
    if (network === "flare") {
        return "FLARE_DEPLOYER_PRIVATE_KEY";
    } else if (network === "songbird") {
        return "SONGBIRD_DEPLOYER_PRIVATE_KEY";
    } else {
        return "DEPLOYER_PRIVATE_KEY";
    }
}

export function loadDeployAccounts(hre: HardhatRuntimeEnvironment): DeployAccounts {
    const deployerPrivateKeyName = networkDeployerPrivateKeyName(hre.network.name);
    const deployerPrivateKey = requiredEnvironmentVariable(deployerPrivateKeyName);
    const deployerAccount = hre.web3.eth.accounts.privateKeyToAccount(deployerPrivateKey);
    return {
        deployer: deployerAccount.address
    };
}

export async function readDeployedCode(hre: HardhatRuntimeEnvironment, address: string | undefined) {
    if (address == null) return null;
    const code = await hre.web3.eth.getCode(address);
    return code.replace(new RegExp(address.slice(2), "gi"), "0000000000000000000000000000000000000000");
}

export async function deployedCodeMatches(hre: HardhatRuntimeEnvironment, artifact: Artifact, address: string | undefined) {
    if (!address) return false;
    const code = await readDeployedCode(hre, address);
    return artifact.deployedBytecode === code;
}

export function abiEncodeCall<I extends Truffle.ContractInstance>(instance: I, call: (inst: I) => Promise<unknown>) {
    // call in ContractInstance returns a promise, but in contract.methods it returns an object which contains (among others) encodeABI method, so the cast below is safe
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return (call as any)(instance.contract.methods).encodeABI() as string;
}

// we use hardhat.json for network with name 'local'
export function networkConfigName(hre: HardhatRuntimeEnvironment) {
    return hre.network.name === 'local' ? 'hardhat' : hre.network.name;
}

function sleep(ms: number) {
    return new Promise<void>(resolve => setTimeout(() => resolve(), ms));
}

export type WaitFinalizeOptions = { extraBlocks: number, retries: number, sleepMS: number }
export const waitFinalizeDefaults: WaitFinalizeOptions = { extraBlocks: 0, retries: 3, sleepMS: 1000 };

/**
 * Finalization wrapper for web3/truffle. Needed on Flare network since account nonce has to increase
 * to have the transaction confirmed.
 */
export async function waitFinalize<T>(hre: HardhatRuntimeEnvironment, address: string, func: () => Promise<T>, options: WaitFinalizeOptions = waitFinalizeDefaults) {
    if (hre.network.name === 'local' || hre.network.name === 'hardhat') {
        return await func();
    }
    const nonce = await hre.web3.eth.getTransactionCount(address);
    const res = await func();
    while (await hre.web3.eth.getTransactionCount(address) <= nonce) {
        await sleep(options.sleepMS);
    }
    for (let i = 0; i < options.retries; i++) {
        const currentBlock = await hre.web3.eth.getBlockNumber();
        while (await hre.web3.eth.getBlockNumber() < currentBlock + options.extraBlocks) {
            await sleep(options.sleepMS);
        }
        // only end if the nonce didn't revert (and repeat up to 3 times)
        if (await hre.web3.eth.getTransactionCount(address) > nonce) break;
        console.warn(`Nonce reverted after ${i + 1} retries, retrying again...`);
    }
    return res;
}

export function truffleContractMetadata(contract: Truffle.Contract<unknown>): { contractName: string, abi: AbiItem[] } {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return
    return (contract as any)._json;
}

/**
 * Encode contract names in a way compatible with AddressUpdatable.updateContractAddresses.
 */
export function encodeContractNames(hre: HardhatRuntimeEnvironment, names: string[]): string[] {
    return names.map(name => encodeContractName(hre, name));
}

/**
 * Encode contract name in a way compatible with AddressUpdatable.updateContractAddresses.
 */
export function encodeContractName(hre: HardhatRuntimeEnvironment, text: string): string {
    return Web3.utils.keccak256(hre.web3.eth.abi.encodeParameters(["string"], [text]));
}

/**
 * Run async main function and wait for exit.
 */
export function runAsyncMain(func: (args: string[]) => Promise<void>, errorExitCode: number = 123) {
    void func(process.argv.slice(2))
        .then(() => { process.exit(0); })
        .catch(e => { console.error(e); process.exit(errorExitCode); });
}

export const ERC1967_STORAGE = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export async function getProxyImplementationAddress(hre: HardhatRuntimeEnvironment, proxyAddr: string) {
    const addressBytes32 = await hre.network.provider.send('eth_getStorageAt', [proxyAddr, ERC1967_STORAGE, 'latest']) as string;
    return web3.utils.toChecksumAddress('0x' + addressBytes32.slice(26));
}
