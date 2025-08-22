import { mine, mineUpTo, time as timeHH } from "@nomicfoundation/hardhat-network-helpers";
import Web3 from "web3";
import { filterEvents, TruffleExtractEvent } from "../../lib/utils/events/truffle";
import { BNish, DAYS, HOURS, MINUTES, toBN, toBNExp, WEEKS, YEARS } from "../../lib/utils/helpers";
import { web3DeepNormalize } from "../../lib/utils/web3normalize";
import { Web3EventDecoder } from "./Web3EventDecoder";

// openzeppelin time-like wrapper
export namespace time {
    /**
     * Forces a block to be mined, incrementing the block height.
     */
    export async function advanceBlock(): Promise<void> {
        await mine();
    }

    /**
     * Forces blocks to be mined until the the target block height is reached.
     * Note: Using this function to advance too many blocks can really slow down your tests. Keep its use to a minimum.
     * @param target the block number to which to mine
     */
    export async function advanceBlockTo(target: BN | number | string): Promise<void> {
        await mineUpTo(target);
    }

    /**
     * Returns the timestamp of the latest mined block. Should be coupled with advanceBlock to retrieve the current blockchain time.
     */
    export async function latest(): Promise<BN> {
        return Web3.utils.toBN(await timeHH.latest());
    }

    /**
     * Returns the latest mined block number.
     */
    export async function latestBlock(): Promise<BN> {
        return Web3.utils.toBN(await timeHH.latestBlock());
    }

    /**
     * Increases the time of the blockchain by duration (in seconds), and mines a new block with that timestamp.
     * @param duration duration in seconds, for conversion from other units use e.g. `time.duration.hours(2)`
     */
    export async function increase(duration: BN | number | string): Promise<void> {
        await timeHH.increase(duration);
    }

    /**
     * Same as increase, but a target time is specified instead of a duration.
     * @param target target time in seconds since unix epoch
     */
    export async function increaseTo(target: BN | number | string): Promise<void> {
        await timeHH.increaseTo(target);
    }

    /**
     * Ordinary time.increase(...) has an issue that the system time that passes between increase and next method
     * call is added to the new chain time. Apparently in CI environments these skips can be quite large (several seconds),
     * which makes tests relying on time.increase occasionally fail.
     * @param increase the exact time skip between previous transaction and next one (actually, 1 is added to account for 1s difference between consecutive blocks)
     */
    export async function deterministicIncrease(increase: string | number | BN) {
        const latest = await timeHH.latest();
        const skip = Math.max(Number(increase), 1);
        await timeHH.setNextBlockTimestamp(latest + skip);
        await mine(1);  // at least 1 block is expected to be mined
        await timeHH.setNextBlockTimestamp(latest + skip + 1);
    }

    export namespace duration {
        /**
         * Convert to seconds (identity). For use as argument of `time.increase`.
         */
        export function seconds(seconds: BNish): BN {
            return toBN(seconds);
        }

        /**
         * Convert minutes to seconds. For use as argument of `time.increase`.
         */
        export function minutes(minutes: BNish): BN {
            return toBN(minutes).muln(MINUTES);
        }

        /**
         * Convert hours to seconds. For use as argument of `time.increase`.
         */
        export function hours(hours: BNish): BN {
            return toBN(hours).muln(HOURS);
        }

        /**
         * Convert days to seconds. For use as argument of `time.increase`.
         */
        export function days(days: BNish): BN {
            return toBN(days).muln(DAYS);
        }

        /**
         * Convert weeks to seconds. For use as argument of `time.increase`.
         */
        export function weeks(weeks: BNish): BN {
            return toBN(weeks).muln(WEEKS);
        }

        /**
         * Convert years to seconds. For use as argument of `time.increase`.
         */
        export function years(years: BNish): BN {
            return toBN(years).muln(YEARS);
        }
    }
}

/**
 * Converts a value in Ether to wei.
 */
export function ether(value: BN | number | string): BN {
    return toBNExp(String(value), 18);
}

/**
 * Helpers for transaction failure (similar to chai’s throw): asserts that promise was rejected due to a reverted transaction.
 * It will also check that the revert reason includes message. Use `expectRevert.unspecified` when the revert reason is unknown.
 * @param promise response of a transaction
 * @param message the expected revert message
 */
export async function expectRevert(promise: Promise<unknown>, message: string): Promise<void> {
    try {
        await promise;
    } catch (error) {
        const actualMessage: string = (error as Error)?.message ?? "";
        if (!actualMessage.includes(message)) {
            // this gives nicer error message
            const revertMessage = actualMessage.replace(/^VM Exception while processing transaction: reverted with reason string '|'$/g, "");
            assert.equal(revertMessage, message, "Wrong kind of exception received");
        }
        return;
    }
    assert.fail("Expected an exception but none was received");
}

export namespace expectRevert {
    /**
     * Like expectRevert, asserts that promise was rejected due to a reverted transaction caused by a require or revert statement, but doesn’t check the revert reason.
     * @param promise response of a transaction
     */
    export function unspecified(promise: Promise<unknown>) {
        return expectRevert(promise, 'revert');
    }

    /**
     * Asserts that promise was rejected due to a transaction running out of gas.
     * @param promise response of a transaction
     */
    export function outOfGas(promise: Promise<unknown>) {
        return expectRevert(promise, 'out of gas');
    }

    /**
     * Asserts that promise was rejected with custom error with given name and args.
     * @param promise response of a transaction
     * @param name Solidity custom error name
     * @param args custom error args (optional - if not provided, the match is just by name)
     */
    export function custom(promise: Promise<unknown>, name: string, args?: unknown[]) {
        if (args) {
            // match byu name and args
            const argStrings = args.map(x => {
                return typeof x === 'string' || Array.isArray(x) ? JSON.stringify(x) : String(x);
            });
            const errorString = `${name}(${argStrings.join(", ")})`;
            return expectRevert(promise, `reverted with custom error '${errorString}'`);
        } else {
            // match by just name
            return expectRevert(promise, `reverted with custom error '${name}`);
        }
    }
}

export type StringForBN<T> = { [K in keyof T]: T[K] extends BN ? BN | string | number : T[K] };

/**
 * Asserts that the logs in `response` contain an event with name `eventName` and arguments that match
 *  those specified in `eventArgs`.
 * @param response an object returned by either a web3 Contract or a truffle-contract call.
 * @param eventName name of the event
 * @param eventArgs expected event args (not necessarily all)
 */
export function expectEvent<T extends Truffle.AnyEvent>(response: Truffle.TransactionResponse<T>, eventName: T['name'], eventArgs?: Partial<StringForBN<T['args']>>): void {
    const events = filterEvents(response, eventName);
    assert(events.length > 0, `No '${eventName}' events found`);
    matchEventListArgs(events, eventArgs);
}

export namespace expectEvent {
    /**
     * Same as expectEvent, but for events emitted in an arbitrary transaction (of hash txHash), by an arbitrary contract
     * (emitter, the contract instance), even if it was indirectly called (i.e. if it was called by another smart contract and not an externally owned account).
     * Note: emitter must be the deployed contract instance emitting the expected event.
     * Note 2: unlike expectEvent, returns a Promise.
     * @param receiptTx tx hash of the transaction (`response.tx` where `response` is an object returned by either a web3 Contract or a truffle-contract call.)
     * @param emitter the emitter contract
     * @param eventName name of the event
     * @param eventArgs expected event args (not necessarily all)
     */
    export async function inTransaction<T extends Truffle.AnyEvent = Truffle.AnyEvent>(receiptTx: string, emitter: Truffle.ContractInstance, eventName: T['name'], eventArgs?: Partial<StringForBN<T['args']>>): Promise<void> {
        const events = await eventsForTransaction(emitter, receiptTx, eventName);
        assert(events.length > 0, `No '${eventName}' events found`);
        matchEventListArgs(events, eventArgs);
    }

    /**
     * Same as expectEvent, but also works for events emitted in a contract that was indirectly called
     * (i.e. if it was called by another smart contract and not an externally owned account).
     * Note: emitter must be the deployed contract instance emitting the expected event.
     * @param response an object returned by either a web3 Contract or a truffle-contract call.
     * @param emitter the emitter contract
     * @param eventName name of the event
     * @param eventArgs expected event args (not necessarily all)
     */
    export async function fromContract<T extends Truffle.AnyEvent = Truffle.AnyEvent>(response: Truffle.TransactionResponse<Truffle.AnyEvent>, emitter: Truffle.ContractInstance, eventName: T['name'], eventArgs?: Partial<StringForBN<T['args']>>): Promise<void> {
        const events = await eventsFromContract(emitter, response, eventName);
        assert(events.length > 0, `No '${eventName}' events found`);
        matchEventListArgs(events, eventArgs);
    }

    /**
     * Check that event was NOT emitted.
     * @param response an object returned by either a web3 Contract or a truffle-contract call.
     * @param eventName name of the event
     */
    export function notEmitted<T extends Truffle.AnyEvent>(response: Truffle.TransactionResponse<T>, eventName: T['name']) {
        const events = filterEvents(response, eventName);
        assert(events.length === 0, `Unexpected event '${eventName}' was found`);
    }

    export namespace notEmitted {
        /**
         * Check that event was NOT emitted (for any contract `emitter` involved in the transaction).
         * Note: unlike expectEvent, returns a Promise.
         * @param receiptTx tx hash of the transaction (`response.tx` where `response` is an object returned by either a web3 Contract or a truffle-contract call.)
         * @param emitter the emitter contract
         * @param eventName name of the event
         */
        export async function inTransaction<T extends Truffle.AnyEvent = Truffle.AnyEvent>(receiptTx: string, emitter: Truffle.ContractInstance, eventName: T['name']): Promise<void> {
            const events = await eventsForTransaction(emitter, receiptTx, eventName);
            assert(events.length === 0, `Unexpected event '${eventName}' was found`);
        }

        /**
         * Check that event was NOT emitted (for any contract `emitter`).
         * @param response an object returned by either a web3 Contract or a truffle-contract call.
         * @param emitter the emitter contract
         * @param eventName name of the event
         * @param eventArgs expected event args (not necessarily all)
         */
        export async function fromContract<T extends Truffle.AnyEvent = Truffle.AnyEvent>(response: Truffle.TransactionResponse<Truffle.AnyEvent>, emitter: Truffle.ContractInstance, eventName: T['name']): Promise<void> {
            const events = await eventsFromContract(emitter, response, eventName);
            assert(events.length === 0, `Unexpected event '${eventName}' was found`);
        }
}
}

async function eventsForTransaction(emitter: Truffle.ContractInstance, receiptTx: string, name: string) {
    const decoder = new Web3EventDecoder({ emitter });
    const receipt = await web3.eth.getTransactionReceipt(receiptTx);
    const events = decoder.decodeEvents(receipt);
    return events.filter(ev => ev.event === name);
}

async function eventsFromContract(emitter: Truffle.ContractInstance, res: Truffle.TransactionResponse<Truffle.AnyEvent> | TransactionReceipt, name: string) {
    const decoder = new Web3EventDecoder({ emitter });
    const events = decoder.decodeEvents(res);
    return events.filter(ev => ev.event === name);
}

function matchEventListArgs<T extends Truffle.AnyEvent>(events: TruffleExtractEvent<T, T["name"]>[], eventArgs?: Partial<StringForBN<T["args"]>>) {
    if (!eventArgs) return;
    const errors: unknown[] = [];
    for (const event of events) {
        try {
            matchEventArgs<T>(event, eventArgs);
            return; // immediately return on sucess of a single event
        } catch (error) {
            errors.push(error);
        }
    }
    throw errors[0]; // errors must have at least one element at this point
}

function matchEventArgs<T extends Truffle.AnyEvent>(event: TruffleExtractEvent<T, T["name"]>, eventArgs: Partial<StringForBN<T["args"]>>) {
    for (const [name, expected] of Object.entries(eventArgs)) {
        const actual = event.args[name];        // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        if (actual === undefined) {
            assert.fail(`Event argument '${name}' not found`);
        }
        const [expectedS, actualS] = web3DeepNormalize([expected, actual]);     // eslint-disable-line @typescript-eslint/no-unsafe-assignment
        assert.deepStrictEqual(actualS, expectedS, `expected event argument '${name}' to have value ${expectedS} but got ${actualS}`);
    }
}
