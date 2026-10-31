// Fast honest confidence bounds under shape or smoothness assumptions (paper §5.2–5.3, PLAN.md
// §1.7–1.8). Every bound comes from one Aₙ constraint on a window W of observations,
//     |Σ_{i∈W} (yᵢ − gᵢ)| ≤ c·√|W|,   c = σ√(τ log n),
// combined with what the assumption says about g on W. The fast versions use window radii on a
// geometric grid (O(n log n), or O(n log² n) for the convex lower bound); the "full" versions use every
// radius and serve as references in tests.
//
// Honesty caveat (PLAN.md Known issue 6): the windows {i−k..i}, {i−k..i+k}, … are not in the dyadic
// family, so the bounds are honest with respect to Aₙ over *all* intervals. Coverage is checked by
// simulation in test/bounds.test.js.
//
// Index conventions: 0-based observations; a segment [lo, hi] is inclusive. Convex and smoothness
// bounds assume equally spaced x (they use index symmetry and index-linear interpolation); monotone
// bounds use only the order.

import { prefixSums } from './prefix.js';
import { tieGroups } from './derivatives.js';

const DEFAULT_THETA = 1.5; // PLAN.md §1.7 default grid ratio

/**
 * Window radii for the fast bounds: distinct values ⌊θᵐ⌋ − offset (m = 0, 1, …) in [0, max], plus 0.
 * Monotone bounds use offset 1 (θ(k) = ⌊θᵏ − 1⌋, eq. 61); convex and smoothness bounds offset 0 (eq. 71).
 *
 * @param {number} theta   grid ratio θ > 1
 * @param {number} max     largest radius allowed
 * @param {number} offset  0 or 1
 * @returns {Int32Array}  ascending
 */
export function windowRadii(theta, max, offset = 0) {
    if (!(theta > 1))
        throw new RangeError('theta must be > 1');
    const set = new Set([0]);
    for (let m = 0; ; m++) {
        const v = Math.floor(Math.pow(theta, m)) - offset;
        if (v > max)
            break;
        if (v >= 0)
            set.add(v);
    }
    return Int32Array.from([...set].filter(v => v <= max).sort((a, b) => a - b));
}

function allRadii(max) {
    return Int32Array.from({ length: Math.max(0, max + 1) }, (_, k) => k);
}

function emptyBounds(n) {
    return { lb: new Float64Array(n).fill(-Infinity), ub: new Float64Array(n).fill(Infinity) };
}

// ---------------------------------------------------------------- monotone (eqs. 59–62)

// Non-decreasing g on [lo, hi]: gᵢ ≥ mean(g_{i−k..i}) and gᵢ ≤ mean(g_{i..i+k}), so
//   lbᵢ = max_k mean(y_{i−k..i}) − c/√(k+1),   ubᵢ = min_k mean(y_{i..i+k}) + c/√(k+1),
// then monotonized (lb running max forward, ub running min backward). sign = −1 applies this to −y
// for a non-increasing g.
function monotoneSegment(S, c, lo, hi, radii, sign, lb, ub) {
    const rawLb = new Float64Array(hi - lo + 1);
    const rawUb = new Float64Array(hi - lo + 1);
    for (let i = lo; i <= hi; i++) {
        let best = -Infinity;
        for (const k of radii) {
            if (i - k < lo)
                break;
            best = Math.max(best, sign * (S[i + 1] - S[i - k]) / (k + 1) - c / Math.sqrt(k + 1));
        }
        rawLb[i - lo] = best;
        best = Infinity;
        for (const k of radii) {
            if (i + k > hi)
                break;
            best = Math.min(best, sign * (S[i + k + 1] - S[i]) / (k + 1) + c / Math.sqrt(k + 1));
        }
        rawUb[i - lo] = best;
    }
    for (let i = 1; i < rawLb.length; i++)
        rawLb[i] = Math.max(rawLb[i], rawLb[i - 1]);
    for (let i = rawUb.length - 2; i >= 0; i--)
        rawUb[i] = Math.min(rawUb[i], rawUb[i + 1]);
    for (let i = lo; i <= hi; i++) {
        // for sign = −1 the bounds on −g flip into bounds on g
        const l = sign > 0 ? rawLb[i - lo] : -rawUb[i - lo];
        const u = sign > 0 ? rawUb[i - lo] : -rawLb[i - lo];
        lb[i] = Math.max(lb[i], l);
        ub[i] = Math.min(ub[i], u);
    }
}

/**
 * Bounds for a monotone g (eqs. 59–62 with monotonization).
 *
 * @param {ArrayLike<number>} y  observations ordered by x
 * @param {number} c             threshold σ√(τ log n), units of y
 * @param {{direction?: 1|-1, theta?: number, full?: boolean}} [opts]  direction +1 non-decreasing
 *     (default), −1 non-increasing; full = every radius (O(n²) reference)
 * @returns {{lb: Float64Array, ub: Float64Array}}
 */
export function monotoneBounds(y, c, opts = {}) {
    const n = y.length;
    const S = prefixSums(y);
    const radii = opts.full ? allRadii(n - 1) : windowRadii(opts.theta ?? DEFAULT_THETA, n - 1, 1);
    const out = emptyBounds(n);
    monotoneSegment(S, c, 0, n - 1, radii, opts.direction ?? 1, out.lb, out.ub);
    return out;
}

/**
 * Bounds for a piecewise monotone g with local extremes at given positions (§5.2.3): monotone
 * bounds on each segment between consecutive extremes, windows restricted to the segment. An extreme
 * belongs to both neighboring segments, where both sets of bounds apply.
 *
 * @param {ArrayLike<number>} y
 * @param {number} c
 * @param {Array<{type: 'max'|'min', position: number}>} extremes  ordered by position (0-based index)
 * @param {{theta?: number, full?: boolean, direction?: 1|-1|0}} [opts]  direction is used only when
 *     there are no extremes: ±1 monotone that way, 0 (default) either way (union of both bands)
 * @returns {{lb: Float64Array, ub: Float64Array, segments: Array<{lo: number, hi: number, direction: 1|-1}>}}
 */
export function piecewiseMonotoneBounds(y, c, extremes, opts = {}) {
    const n = y.length;
    const S = prefixSums(y);
    const radii = opts.full ? allRadii(n - 1) : windowRadii(opts.theta ?? DEFAULT_THETA, n - 1, 1);
    if (extremes.length === 0) {
        const dir = opts.direction ?? 0;
        if (dir !== 0) {
            const out = emptyBounds(n);
            monotoneSegment(S, c, 0, n - 1, radii, dir, out.lb, out.ub);
            return { ...out, segments: [{ lo: 0, hi: n - 1, direction: dir }] };
        }
        const up = emptyBounds(n);
        const down = emptyBounds(n);
        monotoneSegment(S, c, 0, n - 1, radii, 1, up.lb, up.ub);
        monotoneSegment(S, c, 0, n - 1, radii, -1, down.lb, down.ub);
        const lb = Float64Array.from(up.lb, (v, i) => Math.min(v, down.lb[i]));
        const ub = Float64Array.from(up.ub, (v, i) => Math.max(v, down.ub[i]));
        return { lb, ub, segments: [] };
    }
    const cuts = [0, ...extremes.map(e => e.position), n - 1];
    const segments = [];
    for (let s = 0; s + 1 < cuts.length; s++) {
        const lo = cuts[s];
        const hi = cuts[s + 1];
        // the segment ending at a max rises; the one starting after a max falls
        const direction = s < extremes.length
            ? (extremes[s].type === 'max' ? 1 : -1)
            : (extremes[s - 1].type === 'max' ? -1 : 1);
        if (hi >= lo)
            segments.push({ lo, hi, direction });
    }
    const out = emptyBounds(n);
    for (const seg of segments)
        monotoneSegment(S, c, seg.lo, seg.hi, radii, seg.direction, out.lb, out.ub);
    return { ...out, segments };
}

// ---------------------------------------------------------------- convex (eqs. 66–71, derived lower bound)

// Convex g on [lo, hi], equal spacing.
// Upper (eq. 66): gᵢ ≤ mean(g_{i−k..i+k}) ⇒ ubᵢ = min_k mean(y_{i−k..i+k}) + c/√(2k+1).
// Lower (PLAN.md §1.7, replacing eq. 67): with an anchor at i+k (k ≥ 2) and 1 ≤ j < k, convexity gives
// g_{i+l} ≤ (1 − l/k)gᵢ + (l/k)ub_{i+k} for l = 1..j, and Aₙ on {i+1..i+j} gives Σ g_{i+l} ≥ Σ y_{i+l} − c√j,
// so gᵢ ≥ [mean(y_{i+1..i+j}) − c/√j − ub_{i+k}(j+1)/(2k)] / (1 − (j+1)/(2k)); mirrored on the left.
function convexSegment(S, c, lo, hi, kRadii, jRadii, sign, lb, ub) {
    const len = hi - lo + 1;
    const u = new Float64Array(len).fill(Infinity);
    for (let i = lo; i <= hi; i++) {
        const reach = Math.min(i - lo, hi - i);
        let best = Infinity;
        for (const k of kRadii) {
            if (k > reach)
                break;
            best = Math.min(best, sign * (S[i + k + 1] - S[i - k]) / (2 * k + 1) + c / Math.sqrt(2 * k + 1));
        }
        u[i - lo] = best;
    }
    const l = new Float64Array(len).fill(-Infinity);
    for (let i = lo; i <= hi; i++) {
        let best = -Infinity;
        for (const k of kRadii) {
            if (k < 2)
                continue;
            const right = i + k <= hi;
            const left = i - k >= lo;
            if (!right && !left)
                break;
            for (const j of jRadii) {
                if (j < 1)
                    continue;
                if (j >= k)
                    break;
                const w = (j + 1) / (2 * k);
                const slack = c / Math.sqrt(j);
                if (right) {
                    const m = sign * (S[i + j + 1] - S[i + 1]) / j;
                    best = Math.max(best, (m - slack - u[i + k - lo] * w) / (1 - w));
                }
                if (left) {
                    const m = sign * (S[i] - S[i - j]) / j;
                    best = Math.max(best, (m - slack - u[i - k - lo] * w) / (1 - w));
                }
            }
        }
        l[i - lo] = best;
    }
    for (let i = lo; i <= hi; i++) {
        const lv = sign > 0 ? l[i - lo] : -u[i - lo];
        const uv = sign > 0 ? u[i - lo] : -l[i - lo];
        lb[i] = Math.max(lb[i], lv);
        ub[i] = Math.min(ub[i], uv);
    }
}

function convexRadii(opts, n) {
    if (opts.full)
        return { kRadii: allRadii(n - 1), jRadii: allRadii(n - 1) };
    const r = windowRadii(opts.theta ?? DEFAULT_THETA, n - 1, 0);
    return { kRadii: r, jRadii: r };
}

/**
 * Bounds for a convex (or concave) g, equally spaced x (eqs. 66, 69 and the derived lower bound).
 *
 * @param {ArrayLike<number>} y
 * @param {number} c
 * @param {{concave?: boolean, theta?: number, full?: boolean}} [opts]  full = every radius
 *     (O(n²) upper, O(n³) lower; small n only)
 * @returns {{lb: Float64Array, ub: Float64Array}}
 */
export function convexBounds(y, c, opts = {}) {
    const n = y.length;
    const S = prefixSums(y);
    const { kRadii, jRadii } = convexRadii(opts, n);
    const out = emptyBounds(n);
    convexSegment(S, c, 0, n - 1, kRadii, jRadii, opts.concave ? -1 : 1, out.lb, out.ub);
    return out;
}

/**
 * Bounds for a piecewise convex/concave g (§5.2.4), equally spaced x. Segments share their endpoints
 * (the inflection points), where both sets of bounds apply. A 'linear' segment is taken as both convex
 * and concave.
 *
 * @param {ArrayLike<number>} y
 * @param {number} c
 * @param {Array<{lo: number, hi: number, type: 'convex'|'concave'|'linear'}>} segments
 * @param {{theta?: number, full?: boolean}} [opts]
 * @returns {{lb: Float64Array, ub: Float64Array}}
 */
export function piecewiseConvexBounds(y, c, segments, opts = {}) {
    const n = y.length;
    const S = prefixSums(y);
    const { kRadii, jRadii } = convexRadii(opts, n);
    const out = emptyBounds(n);
    for (const seg of segments) {
        if (seg.type !== 'concave')
            convexSegment(S, c, seg.lo, seg.hi, kRadii, jRadii, 1, out.lb, out.ub);
        if (seg.type !== 'convex')
            convexSegment(S, c, seg.lo, seg.hi, kRadii, jRadii, -1, out.lb, out.ub);
    }
    return out;
}

/**
 * Intervals of convexity/concavity of a piecewise-linear fit (e.g. min TV(g′)), §5.2.4. Kinks (slope
 * changes) larger than relTol × the largest kink are classified by sign; runs of same-sign kinks form
 * convex (+) or concave (−) segments, with each inflection point placed halfway between the last kink
 * of one run and the first of the next. Segments share endpoints.
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed)
 * @param {ArrayLike<number>} g  fit at the observations (equal at tied x)
 * @param {number} [relTol=1e-6]
 * @returns {Array<{lo: number, hi: number, type: 'convex'|'concave'|'linear'}>}  observation indices
 */
export function curvatureSegments(x, g, relTol = 1e-6) {
    const n = x.length;
    const { group, xs } = tieGroups(x);
    const m = xs.length;
    const h = new Float64Array(m);
    const first = new Int32Array(m).fill(-1);
    for (let i = 0; i < n; i++) {
        h[group[i]] = g[i];
        if (first[group[i]] < 0)
            first[group[i]] = i;
    }
    const kinks = [];
    let largest = 0;
    for (let j = 1; j + 1 < m; j++) {
        const d = (h[j + 1] - h[j]) / (xs[j + 1] - xs[j]) - (h[j] - h[j - 1]) / (xs[j] - xs[j - 1]);
        kinks.push({ j, d });
        largest = Math.max(largest, Math.abs(d));
    }
    const signed = kinks.filter(k => Math.abs(k.d) > relTol * largest && largest > 0);
    if (signed.length === 0)
        return [{ lo: 0, hi: n - 1, type: 'linear' }];
    const runs = [];
    for (const k of signed) {
        const s = Math.sign(k.d);
        if (runs.length && runs[runs.length - 1].sign === s)
            runs[runs.length - 1].last = k.j;
        else
            runs.push({ sign: s, first: k.j, last: k.j });
    }
    const segments = [];
    let lo = 0;
    for (let r = 0; r < runs.length; r++) {
        const hi = r + 1 < runs.length ? first[Math.floor((runs[r].last + runs[r + 1].first) / 2)] : n - 1;
        segments.push({ lo, hi, type: runs[r].sign > 0 ? 'convex' : 'concave' });
        lo = hi;
    }
    return segments;
}

// ---------------------------------------------------------------- smoothness (eqs. 72–73, corrected)

// ‖g″‖∞ ≤ K, equal spacing h (x units): for a symmetric window of radius k the linear Taylor term
// cancels and |mean(g_{i−k..i+k}) − gᵢ| ≤ (K/2)·h²·mean(j²) = K·h²·k(k+1)/6. With Aₙ on the window:
//   ubᵢ = min_k mean(y) + c/√(2k+1) + K h² k(k+1)/6,   lbᵢ = max_k mean(y) − c/√(2k+1) − K h² k(k+1)/6.
// (The paper's eqs. 72/73 have the labels swapped and use the looser term (k/n)²K.)
function smoothRadii(opts, n) {
    return opts.full ? allRadii(n - 1) : windowRadii(opts.theta ?? DEFAULT_THETA, n - 1, 0);
}

/**
 * Bounds under ‖g″‖∞ ≤ K for equally spaced x.
 *
 * @param {ArrayLike<number>} y
 * @param {number} c
 * @param {number} K   bound on |g″| in x units
 * @param {number} h   spacing of x (x units)
 * @param {{theta?: number, full?: boolean}} [opts]
 * @returns {{lb: Float64Array, ub: Float64Array}}
 */
export function smoothnessBounds(y, c, K, h, opts = {}) {
    const n = y.length;
    const S = prefixSums(y);
    const radii = smoothRadii(opts, n);
    const out = emptyBounds(n);
    for (let i = 0; i < n; i++) {
        const reach = Math.min(i, n - 1 - i);
        let lo = -Infinity;
        let hi = Infinity;
        for (const k of radii) {
            if (k > reach)
                break;
            const mean = (S[i + k + 1] - S[i - k]) / (2 * k + 1);
            const slack = c / Math.sqrt(2 * k + 1) + K * h * h * k * (k + 1) / 6;
            lo = Math.max(lo, mean - slack);
            hi = Math.min(hi, mean + slack);
        }
        out.lb[i] = lo;
        out.ub[i] = hi;
    }
    return out;
}

/**
 * Smallest K for which the smoothness bounds are consistent (lbᵢ ≤ ubᵢ for all i), §5.3. In closed
 * form: lbᵢ ≤ ubᵢ for all i iff for every i and radii k₁, k₂,
 *   m₁ − c/√(2k₁+1) − K·a₁ ≤ m₂ + c/√(2k₂+1) + K·a₂,   a = h²k(k+1)/6,
 * so K_min = max(0, max over (i, k₁, k₂) with a₁ + a₂ > 0 of (m₁ − m₂ − c₁ − c₂)/(a₁ + a₂)).
 * A lower bound on ‖g″‖∞ for any g consistent with the data (honest w.r.t. Aₙ over all intervals).
 *
 * @param {ArrayLike<number>} y
 * @param {number} c
 * @param {number} h   spacing of x
 * @param {{theta?: number, full?: boolean}} [opts]
 * @returns {number}  K_min in x units
 */
export function smoothnessKMin(y, c, h, opts = {}) {
    const n = y.length;
    const S = prefixSums(y);
    const radii = smoothRadii(opts, n);
    let kMin = 0;
    const means = new Float64Array(radii.length);
    const slacks = new Float64Array(radii.length);
    const curv = new Float64Array(radii.length);
    for (let i = 0; i < n; i++) {
        const reach = Math.min(i, n - 1 - i);
        let count = 0;
        for (const k of radii) {
            if (k > reach)
                break;
            means[count] = (S[i + k + 1] - S[i - k]) / (2 * k + 1);
            slacks[count] = c / Math.sqrt(2 * k + 1);
            curv[count] = h * h * k * (k + 1) / 6;
            count++;
        }
        for (let a = 0; a < count; a++) {
            for (let b = 0; b < count; b++) {
                const denom = curv[a] + curv[b];
                if (denom > 0)
                    kMin = Math.max(kMin, (means[a] - means[b] - slacks[a] - slacks[b]) / denom);
            }
        }
    }
    return kMin;
}

/**
 * Where a band is empty (lb > ub): the assumption is inconsistent with the data there.
 *
 * @param {{lb: ArrayLike<number>, ub: ArrayLike<number>}} band
 * @returns {number}  count of indices with lb > ub
 */
export function crossings(band) {
    let count = 0;
    for (let i = 0; i < band.lb.length; i++) {
        if (band.lb[i] > band.ub[i])
            count++;
    }
    return count;
}
