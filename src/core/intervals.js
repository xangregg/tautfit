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
 * With a shortest interval (share > 0), each level's blocks go through blockLevelsWithShortestSpan.
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed)
 * @param {number} lambda
 * @param {number} [share=0]  shortest interval as a share of the x range (0: every block, the paper's family)
 * @returns {Interval[][]}  observation-index intervals; level k groups λᵏ distinct x values
 */
export function xIntervalLevels(x, lambda = 2, share = 0) {
    const { start, m } = tieRanges(x);
    const levels = multiresolutionLevels(m, lambda).map(level => toObservations(level, start));
    return blockLevelsWithShortestSpan(x, levels, share);
}

/**
 * De-duplicated multiresolution family of x-intervals (see xIntervalLevels). Without ties it equals
 * multiresolution(n, λ).
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed)
 * @param {number} lambda
 * @param {number} [share=0]  shortest interval as a share of the x range (0: the paper's family, unchanged)
 * @returns {Interval[]}
 */
export function xIntervalFamily(x, lambda = 2, share = 0) {
    if (share > 0)
        return familyOfLevels(xIntervalLevels(x, lambda, share));
    const { start, m } = tieRanges(x);
    return toObservations(multiresolution(m, lambda), start);
}

/**
 * Every x-interval [t_j, t_k] as an observation range (m(m+1)/2 of them, m distinct x). With a shortest
 * interval, the shorter ones are widened to it (withShortestSpan), which leaves exactly the x-intervals
 * spanning at least that share.
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed)
 * @param {number} [share=0]  share of the x range
 * @returns {Interval[]}
 */
export function allXIntervals(x, share = 0) {
    const { start, m } = tieRanges(x);
    return withShortestSpan(x, toObservations(allIntervals(m), start), share);
}

// ---------------------------------------------------------------- shortest interval (after lafspline)

const SPAN_TOL = 1e-9; // share of the x range: an interval exactly at the shortest span is kept despite rounding

/**
 * The stretch of x an interval of observations stands for: from midway to the previous distinct x to midway to
 * the next (clipped to [min x, max x]), so a lone observation where x is sparse spans the gap around it, and a run
 * of observations where x is dense spans little. The family never splits ties, so x[lo − 1] is a different x.
 *
 * @param {ArrayLike<number>} x  sorted
 * @param {{lo: number, hi: number}} iv
 * @returns {number}  units of x
 */
export function intervalSpan(x, iv) {
    const n = x.length;
    const left = iv.lo > 0 ? (x[iv.lo - 1] + x[iv.lo]) / 2 : x[0];
    const right = iv.hi < n - 1 ? (x[iv.hi] + x[iv.hi + 1]) / 2 : x[n - 1];
    return right - left;
}

/**
 * The shortest span a share of the x range asks for, less a rounding tolerance; 0 for share 0.
 *
 * @param {ArrayLike<number>} x  sorted
 * @param {number} share  0 to 1
 * @returns {number}  units of x
 */
export function shortestSpan(x, share) {
    return share > 0 ? (share - SPAN_TOL) * (x[x.length - 1] - x[0]) : 0;
}

/**
 * Levels of the paper's blocks with a shortest interval. No interval spanning less is kept as it is, and none is
 * simply dropped, which would leave stretches of dense x without an interval at that level. In each level every
 * block that spans enough stays; each run of consecutive short blocks is merged within itself into parts that
 * span enough (mergeShort), and a run too short even as one part is widened over its neighbors (widen, flagged
 * `widened`). So a level stays a partition except where such a run overlaps, a block long enough is never
 * swallowed by a short neighbor, and where every block is short (an even design) the level becomes about 1/share
 * parts. Duplicates within a level are removed; levels are never empty, so their indices stay. It depends on x
 * alone, so the family is still fixed before y is seen.
 *
 * @param {ArrayLike<number>} x  sorted
 * @param {Interval[][]} levels  each ordered by lo and covering 0..n−1 (xIntervalLevels)
 * @param {number} share  share of the x range; 0 returns the levels as they are
 * @returns {Interval[][]}
 */
export function blockLevelsWithShortestSpan(x, levels, share) {
    if (!(share > 0))
        return levels;
    const shortest = shortestSpan(x, share);
    return levels.map(level => distinct(mergeRuns(x, level, shortest)));
}

/**
 * Intervals with a shortest interval: each one spanning less is widened to it (widen), duplicates removed.
 *
 * @param {ArrayLike<number>} x  sorted
 * @param {Interval[]} intervals
 * @param {number} share  share of the x range; 0 returns the intervals as they are
 * @returns {Interval[]}  ordered by lo, then hi
 */
export function withShortestSpan(x, intervals, share) {
    if (!(share > 0))
        return intervals;
    const shortest = shortestSpan(x, share);
    return distinct(intervals.map(iv => widen(x, iv, shortest)));
}

/** A family from its levels, in level order, each interval once (the lowest level kept). */
function familyOfLevels(levels) {
    const seen = new Set();
    const out = [];
    for (const level of levels) {
        for (const iv of level) {
            const key = `${iv.lo},${iv.hi}`;
            if (seen.has(key))
                continue;
            seen.add(key);
            out.push(iv);
        }
    }
    return out;
}

// The intervals ordered by lo (then hi), each once.
function distinct(intervals) {
    const seen = new Set();
    const out = [];
    for (const iv of intervals.sort((a, b) => a.lo - b.lo || a.hi - b.hi)) {
        const key = `${iv.lo},${iv.hi}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(iv);
    }
    return out;
}

// One level of blocks: those spanning at least `shortest` unchanged, each maximal run of shorter blocks between
// them merged within itself (mergeShort), and a part still short widened over its neighbors.
function mergeRuns(x, level, shortest) {
    const out = [];
    let run = [];
    const flush = () => {
        for (const part of mergeShort(x, run, shortest))
            out.push(intervalSpan(x, part) < shortest ? widen(x, part, shortest) : part);
        run = [];
    };
    for (const iv of level) {
        if (intervalSpan(x, iv) >= shortest) {
            flush();
            out.push(iv);
        }
        else {
            run.push(iv);
        }
    }
    flush();
    return out;
}

// Consecutive blocks merged into parts that each span at least `shortest`, as far as their total allows: the run's
// span T makes p = ⌊T/shortest⌋ parts (at least 1), cut at block boundaries where a part first reaches T/p, and a
// last part left short joins the one before it. So the parts are about equally wide in x. O(r) for r blocks.
function mergeShort(x, blocks, shortest) {
    if (blocks.length === 0)
        return [];
    const level = blocks[0].level;
    const whole = { lo: blocks[0].lo, hi: blocks[blocks.length - 1].hi, level };
    const parts = Math.max(1, Math.floor(intervalSpan(x, whole) / shortest));
    const target = intervalSpan(x, whole) / parts;
    const out = [];
    let lo = whole.lo;
    for (const iv of blocks) {
        if (intervalSpan(x, { lo, hi: iv.hi }) >= target) {
            out.push({ lo, hi: iv.hi, level });
            lo = iv.hi + 1;
        }
    }
    if (lo <= whole.hi) {
        if (out.length > 0 && intervalSpan(x, { lo, hi: whole.hi }) < shortest)
            out[out.length - 1].hi = whole.hi;
        else
            out.push({ lo, hi: whole.hi, level });
    }
    return out;
}

// An interval grown one distinct x at a time, on the side whose next x is nearer, until it spans at least
// `shortest` or covers every observation; tied observations are taken together. A grown interval is flagged
// `widened` (it may overlap its neighbors in a level).
function widen(x, iv, shortest) {
    const n = x.length;
    let { lo, hi } = iv;
    while (intervalSpan(x, { lo, hi }) < shortest && (lo > 0 || hi < n - 1)) {
        const left = lo > 0 ? x[lo] - x[lo - 1] : Infinity;
        const right = hi < n - 1 ? x[hi + 1] - x[hi] : Infinity;
        if (left <= right) {
            lo--;
            while (lo > 0 && x[lo - 1] === x[lo])
                lo--;
        }
        else {
            hi++;
            while (hi < n - 1 && x[hi + 1] === x[hi])
                hi++;
        }
    }
    if (lo === iv.lo && hi === iv.hi)
        return iv;
    return { lo, hi, level: iv.level, widened: true };
}
