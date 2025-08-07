import { BNish, toBN } from "../utils/helpers";

export abstract class Approximation {
    abstract matches(value: BNish): boolean;

    abstract assertMatches(value: BNish, message?: string): void;

    static absolute(value: BNish, error: BNish) {
        return new AbsoluteApproximation(toBN(value), toBN(error));
    }

    static relative(value: BNish, relativeError: number) {
        return new RelativeApproximation(toBN(value), relativeError);
    }
}

class AbsoluteApproximation extends Approximation {
    constructor(
        public expected: BN,
        public maxError: BN,
    ) {
        super();
    }

    error(value: BNish) {
        return toBN(value).sub(this.expected).abs();
    }

    override matches(value: BNish) {
        return this.error(value).lte(this.maxError);
    }

    override assertMatches(value: BNish, message?: string) {
        const error = this.error(value);
        if (error.gt(this.maxError)) {
            // should use assert.fail, but it doesn't display expected and actual value
            assert.equal(String(value), String(this.expected), `${message ?? 'Values too different'} - absolute error is ${error}, should be below ${this.maxError}`);
        }
    }
}

class RelativeApproximation extends Approximation {
    constructor(
        public expected: BN,
        public maxError: number,
    ) {
        super();
    }

    error(value: BNish) {
        const error = toBN(value).sub(this.expected).abs();
        return error.isZero() ? 0 : Number(error) / Math.max(Math.abs(Number(value)), Math.abs(Number(this.expected)));
    }

    override matches(value: BNish) {
        return this.error(value) <= this.maxError;
    }

    override assertMatches(value: BNish, message?: string) {
        const error = this.error(value);
        if (error > this.maxError) {
            assert.equal(String(value), String(this.expected), `${message ?? 'Values too different'} - relative error is ${error.toExponential(3)}, should be below ${this.maxError}`);
        }
    }
}

export function assertApproximateMatch(value: BNish, expected: Approximation, message?: string) {
    return expected.assertMatches(value, message);
}

export function assertApproximatelyEqual(value: BNish, expected: BNish, approximationType: 'absolute' | 'relative', maxError: BNish, message?: string) {
    const approximation = approximationType === 'absolute' ? Approximation.absolute(expected, maxError) : Approximation.relative(expected, Number(maxError));
    // console.log(`value: ${value},  expected: ${expected},  error: ${toBN(value).sub(toBN(expected))},  relativeErr: ${approximation.relativeError(value)}`);
    approximation.assertMatches(value, message);
}
