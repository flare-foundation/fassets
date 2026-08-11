// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

library MathUtils {
    error RescaleToZero();

    /**
     * Increases the value `x` to a whole multiple of `rounding`.
     */
    function roundUp(uint256 x, uint256 rounding) internal pure returns (uint256) {
        // division by 0 and overflow checks preformed by Solidity >= 0.8
        uint256 remainder = x % rounding;
        return remainder == 0 ? x : x - remainder + rounding;
    }

    /**
     * Return the positive part of `_a - _b`.
     */
    function subOrZero(uint256 _a, uint256 _b) internal pure returns (uint256) {
        return _a > _b ? _a - _b : 0;
    }

    /**
     * Returns _x if it is positive, otherwise 0.
     */
    function positivePart(int256 _x) internal pure returns (uint256) {
        return _x >= 0 ? uint256(_x) : 0;
    }

    /**
     * Returns `_a <= _b`; works correctly when `_b` is any signed value.
     */
    function mixedLTE(uint256 _a, int256 _b) internal pure returns (bool) {
        return _b >= 0 && _a <= uint256(_b);
    }

    /**
     * Returns `_a <= _b`; works correctly when `_a` is any signed value.
     */
    function mixedLTE(int256 _a, uint256 _b) internal pure returns (bool) {
        return _a <= 0 || uint256(_a) <= _b;
    }

    /**
     * Bounds `_value` to be within the range `_min` to `_max` (both inclusive).
     */
    function bound(uint256 _value, uint256 _min, uint256 _max) internal pure returns (uint256) {
        if (_value < _min) {
            return _min;
        } else if (_value > _max) {
            return _max;
        } else {
            return _value;
        }
    }

    /**
     * Rescales `_value` by powers of 10 to be less than or equal to `_maxValue`.
     * @param _value the original value
     * @param _maxValue the rescaled value upper bound; must be nonzero
     * @return _result rescaled value: `_result = floor(_value / 10^_scaleDecimalPlaces) <= _maxValue`
     * @return _scaleDecimalPlaces the minimum `n` such that `floor(_value / 10^n) <= _maxValue`
     *  (i.e. the value is rescaled as little as possible, to keep the maximum precision);
     *  since max(uint256) ~= 10^77, it is guaranteed that `0 <= _scaleDecimalPlaces <= 78`
     */
    function rescale(uint256 _value, uint256 _maxValue)
        internal pure
        returns (uint256 _result, uint256 _scaleDecimalPlaces)
    {
        require(_maxValue != 0, RescaleToZero());
        (_result, _scaleDecimalPlaces) = _rescaleRec(_value, _maxValue, 10, 0);
        if (_result > _maxValue) {
            _result /= 10;
            _scaleDecimalPlaces += 1;
        }
    }

    // Divides `_value` by `10^(2^k)` for `k = _shift, _shift - 1, ..., 0`, but only when the intermediate
    // value is still too big, and returns the result together with the total number of decimal places divided.
    // The comparison is made on the divided value instead of multiplying `_maxValue`, to avoid overflow.
    // Precondition: `_factor = 10^(2^_shift)`.
    // Postcondition (for `_maxValue > 0`): `floor(returned value / _factor) < _maxValue`.
    function _rescaleRec(uint256 _value, uint256 _maxValue, uint256 _factor, uint256 _shift)
        private pure
        returns (uint256, uint256)
    {
        uint256 scaleDec = 0;
        if (_shift < 6) {
            (_value, scaleDec) = _rescaleRec(_value, _maxValue, _factor * _factor, _shift + 1);
        }
        uint256 newValue = _value / _factor;
        if (newValue >= _maxValue) {
            _value = newValue;
            scaleDec += 1 << _shift;
        }
        return (_value, scaleDec);
    }
}
