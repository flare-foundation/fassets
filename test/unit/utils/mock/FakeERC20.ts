import { GENESIS_GOVERNANCE_ADDRESS } from "../../../../lib/test-utils/constants";
import { waitForTimelock } from "../../../../lib/test-utils/fasset/CreateAssetManager";
import { expectRevert } from "../../../../lib/test-utils/test-helpers";
import { getTestFile, loadFixtureCopyVars } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { erc165InterfaceId } from "../../../../lib/utils/helpers";
import { FakeERC20Instance } from "../../../../typechain-truffle";

const FakeERC20 = artifacts.require('FakeERC20');
const GovernanceSettings = artifacts.require('GovernanceSettingsMock');

contract(`FakeERC20.sol; ${getTestFile(__filename)}; FakeERC20 basic tests`, accounts => {
    let coin: FakeERC20Instance;
    const governance = accounts[10];

    async function initialize() {
        const governanceSettings = await GovernanceSettings.new();
        await governanceSettings.initialise(governance, 60, [governance], { from: GENESIS_GOVERNANCE_ADDRESS });
        coin = await FakeERC20.new(governanceSettings.address, governance, "A Token", "TOK", 10);
        return { coin };
    }

    beforeEach(async () => {
        ({ coin } = await loadFixtureCopyVars(initialize));
    });

    describe("method tests", () => {
        it("can get metadata", async () => {
            assertWeb3Equal(await coin.name(), "A Token");
            assertWeb3Equal(await coin.symbol(), "TOK");
            assertWeb3Equal(await coin.decimals(), "10");
        });

        it("should mint and burn", async () => {
            await coin.mintAmount(accounts[0], 12345, { from: governance });
            assertWeb3Equal(await coin.balanceOf(accounts[0]), 12345);
            await coin.burnAmount(10000, { from: accounts[0] });
            assertWeb3Equal(await coin.balanceOf(accounts[0]), 2345);
        });

        it("only governance can mint", async () => {
            const pr1 = coin.mintAmount(accounts[0], 12345);
            await expectRevert.custom(pr1, "OnlyGovernance", []);
        });

        it("only timelocked governance can mint in production mode", async () => {
            await coin.switchToProductionMode({ from: governance });
            const pr1 = coin.mintAmount(accounts[0], 12345, { from: governance });
            assertWeb3Equal(await coin.balanceOf(accounts[0]), 0);
            await waitForTimelock(pr1, coin, governance);
            assertWeb3Equal(await coin.balanceOf(accounts[0]), 12345);
        });

        it("only owner can burn", async () => {
            await coin.mintAmount(accounts[0], 12345, { from: governance });
            assertWeb3Equal(await coin.balanceOf(accounts[0]), 12345);
            const pr2 = coin.burnAmount(12345, { from: governance });
            await expectRevert(pr2, "ERC20: burn amount exceeds balance");
        });
    });

    describe("ERC-165 interface identification", () => {
        it("should properly respond to supportsInterface", async () => {
            const IERC165 = artifacts.require("@openzeppelin/contracts/utils/introspection/IERC165.sol:IERC165" as 'IERC165');
            const IERC20 = artifacts.require("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20" as 'IERC20');
            const IERC20Metadata = artifacts.require("IERC20Metadata");
            const iERC165 = await IERC165.at(coin.address);
            const iERC20 = await IERC20.at(coin.address);
            const iERC20Metadata = await IERC20Metadata.at(coin.address);
            assert.isTrue(await coin.supportsInterface(erc165InterfaceId(iERC165.abi)));
            assert.isTrue(await coin.supportsInterface(erc165InterfaceId(iERC20.abi)));
            assert.isTrue(await coin.supportsInterface(erc165InterfaceId(iERC20Metadata.abi, [iERC20.abi])));
            assert.isFalse(await coin.supportsInterface('0xFFFFFFFF'));  // must not support invalid interface
        });
    });
});
