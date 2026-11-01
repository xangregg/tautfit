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

/**
 * Ranges of tied x: group j covers observations start[j]..start[j+1]−1 (x sorted ascending).
 *
 * @param {ArrayLike<number>} x  sorted
 * @returns {{start: Int32Array, m: number, ties: boolean}}  start has length m + 1, start[m] = n
 */
export function tieRanges(x) {
    const n = x.length;
    const start = [0];
    for (let i = 1; i < n; i++) {
        if (x[i] !== x[i - 1])
            start.push(i);
    }
    start.push(n);
    const m = start.length - 1;
    return { start: Int32Array.from(start), m, ties: m < n };
}

// Map intervals over distinct-x indices to observation ranges.
function toObservations(groupIntervals, start) {
    return groupIntervals.map(({ lo, hi, level }) => ({ lo: start[lo], hi: start[hi + 1] - 1, level }));
}

/**
 * The multiresolution scheme over intervals of x (paper eqs. 6 and 9: I = [t_j, t_k], |I| = number of
 * points in it), level by level. Built on the distinct x values and mapped to observation ranges, so an
 * interval never separates tied observations; without ties it equals multiresolutionLevels(n, λ).
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed)
 * @param {number} lambda
 * @returns {Interval[][]}  observation-index intervals; level k groups λᵏ distinct x values
 */
export function xIntervalLevels(x, lambda = 2) {
    const { start, m } = tieRanges(x);
    return multiresolutionLevels(m, lambda).map(level => toObservations(level, start));
}

/**
 * De-duplicated multiresolution family of x-intervals (see xIntervalLevels). Without ties it equals
 * multiresolution(n, λ).
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed)
 * @param {number} lambda
 * @returns {Interval[]}
 */
export function xIntervalFamily(x, lambda = 2) {
    const { start, m } = tieRanges(x);
    return toObservations(multiresolution(m, lambda), start);
}

/**
 * Every x-interval [t_j, t_k] as an observation range (m(m+1)/2 of them, m distinct x).
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed)
 * @returns {Interval[]}
 */
export function allXIntervals(x) {
    const { start, m } = tieRanges(x);
    return toObservations(allIntervals(m), start);
}
