import "dotenv/config";

import "@nomicfoundation/hardhat-verify";
import "@nomiclabs/hardhat-truffle5";
import "@nomiclabs/hardhat-web3";
import fs from "fs";
import { globSync } from "glob";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import { TASK_COMPILE, TASK_TEST_GET_TEST_FILES } from 'hardhat/builtin-tasks/task-names';
import { HardhatUserConfig, task } from "hardhat/config";
import { HardhatNetworkAccountUserConfig } from "hardhat/types";
import path from "path";
import 'solidity-coverage';
import "./type-extensions";
// Importing standalone simple library to surpass warnings in mock contracts and in mock contract imports
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-require-imports
const intercept = require('intercept-stdout');

// more complex tasks
import { networkDeployerPrivateKeyName } from "./deployment/lib/deploy-utils";
import "./hardhat-tasks.config";

// allow glob patterns in test file args
task(TASK_TEST_GET_TEST_FILES, async ({ testFiles }: { testFiles: string[] }, { config }) => {
    const cwd = process.cwd();
    if (testFiles.length === 0) {
        const testPath = path.relative(cwd, config.paths.tests).replace(/\\/g, '/');    // glob doesn't work with windows paths
        testFiles = [testPath + '/**/*.{js,ts}'];
    }
    return testFiles.flatMap(pattern => globSync(pattern))
        .map(fname => path.resolve(cwd, fname));
});

// Override solc compile task and filter out useless warnings
task(TASK_COMPILE)
    .setAction(async (args, hre, runSuper) => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        intercept((text: string) => {
            if (/MockContract.sol/.test(text) && text.match(/Warning: SPDX license identifier not provided in source file/)) return '';
            if (/MockContract.sol/.test(text) &&
                /Warning: This contract has a payable fallback function, but no receive ether function/.test(text)) return '';
            if (/FlareSmartContracts.sol/.test(text) &&
                /Warning: Visibility for constructor is ignored./.test(text)) return '';
            if (/VPToken.sol/.test(text) &&
                /Warning: Visibility for constructor is ignored./.test(text)) return '';
            if (/ReentrancyGuard.sol/.test(text) &&
                /Warning: Visibility for constructor is ignored/.test(text)) return '';
            if (/\/mock\//i.test(text) && /Warning:/.test(text) ) return ''; // ignore warnings for mock contracts
            return text;
        });
        await runSuper(args);
    });

function readAccounts(network: string) {
    const deployerPK = process.env[networkDeployerPrivateKeyName(network)];
    const deployerAccounts: HardhatNetworkAccountUserConfig[] = deployerPK ? [{ privateKey: deployerPK, balance: "100000000000000000000000000000000" }] : [];
    let testAccounts: HardhatNetworkAccountUserConfig[] = JSON.parse(fs.readFileSync('test/test-1020-accounts.json').toString()) as HardhatNetworkAccountUserConfig[];
    if (process.env.TENDERLY === 'true') {
        testAccounts = testAccounts.slice(0, 100);
    }
    testAccounts = testAccounts.filter(x => x.privateKey !== deployerPK);
    return [...deployerAccounts, ...testAccounts];
}

const config: HardhatUserConfig = {
    defaultNetwork: "hardhat",

    networks: {
        scdev: {
            url: "http://127.0.0.1:9650/ext/bc/C/rpc",
            gas: 8000000,
            timeout: 40000,
            accounts: readAccounts('scdev').map(x => x.privateKey)
        },
        songbird: {
            url: process.env.SONGBIRD_RPC || "https://songbird-api.flare.network/ext/C/rpc",
            timeout: 40000,
            accounts: readAccounts('songbird').map(x => x.privateKey)
        },
        flare: {
            url: process.env.FLARE_RPC || "https://flare-api.flare.network/ext/C/rpc",
            timeout: 40000,
            accounts: readAccounts('flare').map(x => x.privateKey)
        },
        coston: {
            url: process.env.COSTON_RPC || "https://coston-api.flare.network/ext/C/rpc",
            timeout: 40000,
            accounts: readAccounts('coston').map(x => x.privateKey)
        },
        coston2: {
            url: process.env.COSTON2_RPC || "https://coston2-api.flare.network/ext/C/rpc",
            timeout: 40000,
            accounts: readAccounts('coston2').map(x => x.privateKey)
        },
        hardhat: {
            accounts: readAccounts('hardhat'),
            allowUnlimitedContractSize: true,
            blockGasLimit: 125000000 // 10x ETH gas
        },
        local: {
            url: 'http://127.0.0.1:8545',
            chainId: 31337,
            accounts: readAccounts('local').map(x => x.privateKey)
        }
    },
    solidity: {
        compilers: [
            {
                version: "0.8.27",
                settings: {
                    evmVersion: "london",
                    optimizer: {
                        enabled: true,
                        runs: 200
                    }
                }
            },
            {
                version: "0.7.6",
                settings: {
                    optimizer: {
                        enabled: true,
                        runs: 200
                    }
                }
            }
        ],
        overrides: {
            "contracts/utils/Imports_Solidity_0_6.sol": {
                version: "0.6.12",
                settings: {}
            },
            "@gnosis.pm/mock-contract/contracts/MockContract.sol": {
                version: "0.6.12",
                settings: {}
            }
        }
    },
    paths: {
        sources: "./contracts/",
        tests: process.env.TEST_PATH || "./test/{unit,integration}",
        cache: "./cache",
        artifacts: "./artifacts"
    },
    mocha: {
        timeout: 1000000000
    },
    gasReporter: {
        showTimeSpent: true,
        outputFile: ".gas-report.txt"
    },
    etherscan: {
        apiKey: {
            songbird: '0000',
            flare: '0000',
            coston: '0000',
            coston2: '0000',
        },
        customChains: [
            {
                network: "songbird",
                chainId: 19,
                urls: {
                    apiURL: "https://songbird-explorer.flare.network/api",
                    browserURL: "https://songbird-explorer.flare.network"
                }
            },
            {
                network: "flare",
                chainId: 14,
                urls: {
                    apiURL: "https://flare-explorer.flare.network/api",
                    browserURL: "https://flare-explorer.flare.network"
                }
            },
            {
                network: "coston",
                chainId: 16,
                urls: {
                    apiURL: "https://coston-explorer.flare.network/api",
                    browserURL: "https://coston-explorer.flare.network/"
                }
            },
            {
                network: "coston2",
                chainId: 114,
                urls: {
                    apiURL: "https://coston2-explorer.flare.network/api",
                    browserURL: "https://coston2-explorer.flare.network"
                }
            },
        ]
    },
    sourcify: {
        enabled: false
    }
};

export default config;
