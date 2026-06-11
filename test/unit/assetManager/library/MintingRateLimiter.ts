import { time } from "../../../../lib/test-utils/test-helpers";
import { getTestFile } from "../../../../lib/test-utils/test-suite-helpers";
import { assertWeb3Equal } from "../../../../lib/test-utils/web3assertions";
import { DAYS, toBN } from "../../../../lib/utils/helpers";
import { MintingRateLimiterMockInstance } from "../../../../typechain-truffle";

const MintingRateLimiter = artifacts.require("MintingRateLimiterMock");

contract(`MintingRateLimiter.sol; ${getTestFile(__filename)}; MintingRateLimiter unit tests`, accounts => {
    const windowSizeSeconds = 1 * DAYS;
    const maxMintingPerWindow = 1000;
    let rateLimiter: MintingRateLimiterMockInstance;

    beforeEach(async () => {
        rateLimiter = await MintingRateLimiter.new();
        await rateLimiter.initialize(windowSizeSeconds, maxMintingPerWindow);
    });

    it("minting below the window limit should not be delayed", async () => {
        const { 0: delayed } = await rateLimiter.recordMinting.call(maxMintingPerWindow - 1);
        assert.isFalse(delayed);
    });

    it("minting at or above the window limit should be delayed proportionally to the excess", async () => {
        await rateLimiter.recordMinting(600);
        // second minting brings the window total to 1200, above the limit of 1000
        const { 0: delayed, 1: allowedAt } = await rateLimiter.recordMinting.call(600);
        assert.isTrue(delayed);
        const state = await rateLimiter.getState();
        assertWeb3Equal(allowedAt,
            toBN(state.windowStartTimestamp).addn(windowSizeSeconds * 1200 / maxMintingPerWindow));
    });

    it("elapsed windows should drain the minted amount by one window limit per window", async () => {
        await rateLimiter.recordMinting(1500);
        await time.deterministicIncrease(windowSizeSeconds);
        // one window has elapsed, draining 1000 from the recorded 1500; 500 + 400 = 900 < 1000
        const { 0: delayed } = await rateLimiter.recordMinting.call(400);
        assert.isFalse(delayed);
    });

    it("delay computation should not overflow for very large minted amounts", async () => {
        // make windowSizeSeconds * mintedInCurrentWindow exceed uint64 max (86400 * 2^62 >> 2^64 - 1);
        // before the fix, the uint64 multiplication reverted, blocking all further mintings
        // until enough windows elapsed to drain mintedInCurrentWindow below the overflow threshold
        const amount = toBN(2).pow(toBN(62));
        const { 0: delayed, 1: allowedAt } = await rateLimiter.recordMinting.call(amount);
        assert.isTrue(delayed);
        const state = await rateLimiter.getState();
        assertWeb3Equal(allowedAt,
            toBN(state.windowStartTimestamp).add(amount.muln(windowSizeSeconds).divn(maxMintingPerWindow)));
    });

    it("repeated large mintings should not overflow the recorded window total", async () => {
        // the accumulated mintedInCurrentWindow stays below uint64 max, but each delay
        // computation multiplies it by windowSizeSeconds, far exceeding uint64
        const amount = toBN(2).pow(toBN(60));
        for (let i = 1; i <= 4; i++) {
            await rateLimiter.recordMinting(amount);
            const state = await rateLimiter.getState();
            assertWeb3Equal(state.mintedInCurrentWindow, amount.muln(i));
        }
    });
});
