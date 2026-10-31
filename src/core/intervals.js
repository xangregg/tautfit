// Interval families 𝓘ₙ over the design indices. Intervals are {lo, hi}: 0-based, inclusive.

/**
 * @typedef {object} Interval
 * @property {number} lo     first index, 0-based inclusive
 * @property {number} hi     last index, 0-based inclusive
 * @property {number} level  resolution level k (window length ≈ λᵏ)
 */

/**
 * The multiresolution scheme of eq. (9), level by level, before de-duplication.
 *
 * Paper (1-based): l(j,k) = ⌊(j−1)λᵏ⌋ + 1, u(j,k) = min(⌊jλᵏ⌋, n), j = 1..⌈n/λᵏ⌉. 0-based here:
 * lo = ⌊(j−1)λᵏ⌋, hi = min(⌊jλᵏ⌋, n) − 1. Levels run k = 0..⌈log n / log λ⌉; the paper starts at
 * k = 1 but k = 0 (singletons) is included per PLAN.md Known issue 2. Each level partitions 0..n−1,
 * which is what the residual view draws as one row.
 *
 * @param {number} n       number of observations, ≥ 1
 * @param {number} lambda  λ > 1 (2 gives dyadic blocks)
 * @returns {Interval[][]}  levels[k] = intervals of level k, ordered by lo
 */
export function multiresolutionLevels(n, lambda = 2) {
    if (!(lambda > 1))
        throw new RangeError('lambda must be > 1');
    const kMax = Math.ceil(Math.log(n) / Math.log(lambda));
    const levels = [];
    for (let k = 0; k <= kMax; k++) {
        const width = Math.pow(lambda, k);
        const jMax = Math.ceil(n / width);
        const level = [];
        for (let j = 1; j <= jMax; j++) {
            const lo = Math.floor((j - 1) * width);
            const hi = Math.min(Math.floor(j * width), n) - 1;
            if (lo <= hi)
                level.push({ lo, hi, level: k });
        }
        levels.push(level);
    }
    return levels;
}

/**
 * The multiresolution family 𝓘ₙ of eq. (9) (with singletons), de-duplicated; when an interval occurs
 * at several levels the lowest level is kept. Size is O(n) (≤ 2n + log₂n for λ = 2).
 *
 * @param {number} n       number of observations, ≥ 1
 * @param {number} lambda  λ > 1
 * @returns {Interval[]}  ordered by level, then lo
 */
export function multiresolution(n, lambda = 2) {
    const seen = new Set();
    const out = [];
    for (const level of multiresolutionLevels(n, lambda)) {
        for (const iv of level) {
            const key = iv.lo * (n + 1) + iv.hi;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push(iv);
        }
    }
    return out;
}

/**
 * Every interval [i, j], 0 ≤ i ≤ j < n (n(n+1)/2 of them). Reference family for checks on small n.
 * `level` is ⌊log₂ length⌋, so rows group intervals of similar length.
 *
 * @param {number} n
 * @returns {Interval[]}
 */
export function allIntervals(n) {
    const out = [];
    for (let lo = 0; lo < n; lo++) {
        for (let hi = lo; hi < n; hi++)
            out.push({ lo, hi, level: Math.floor(Math.log2(hi - lo + 1)) });
    }
    return out;
}
