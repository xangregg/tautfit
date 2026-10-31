// Taut string with local squeezing (paper §3.2 and appendix 7.3; Davies & Kovac 2001).
//
// Geometry: nodes i = 0..n at abscissa i. The tube has lower/upper boundaries Lᵢ ≤ Uᵢ, linear between
// nodes, with pinned ends (L₀ = U₀, Lₙ = Uₙ). The taut string F̃ is the shortest path through the tube;
// because the boundaries are polylines with vertices at the nodes, F̃ is linear between nodes and is
// determined by its node values. Its slopes f̃ᵢ = F̃ᵢ − F̃ᵢ₋₁ (i = 1..n) are the regression fit, with
// paper observation i (1-based) ↔ code index i − 1.
//
// F̃ is also the unique minimizer of Σ φ(Fᵢ − Fᵢ₋₁) over the tube for every strictly convex φ, which
// gives two independent test oracles: a projected-SOR solver for φ(d) = d² and a KKT check.
//
// Note on the KKT signs (PLAN.md Known issue 8): where F̃ touches the *upper* boundary the string bends
// upward (f̃ᵢ ≤ f̃ᵢ₊₁); where it touches the *lower* boundary it bends downward (f̃ᵢ ≥ f̃ᵢ₊₁).

import { prefixSums } from './prefix.js';
import { sigmaMAD } from './sigma.js';
import { multiresolution } from './intervals.js';
import { threshold, checkRegion } from './region.js';

const DEFAULT_TAU = 3; // paper default
const DEFAULT_SQUEEZE = 0.5; // appendix 7.3: λᵢ ← λᵢ/2
const DEFAULT_MAX_ITER = 200;

/**
 * Taut string through a tube, O(n) funnel algorithm.
 *
 * Keeps an apex (the last emitted string vertex) and two chains of boundary vertices visible from it:
 * the upper chain is the lower convex hull of upper-boundary points (slopes from the apex increasing),
 * the lower chain the upper concave hull of lower-boundary points (slopes decreasing). The feasible
 * directions from the apex lie between the first lower slope and the first upper slope. When a new
 * upper point falls below the first lower segment, the string must bend around the lower chain:
 * the apex advances along it, emitting vertices, and the upper chain restarts at the new point (and
 * symmetrically for a new lower point). Each node enters and leaves each chain at most once.
 *
 * @param {ArrayLike<number>} lower  Lᵢ, i = 0..n (n ≥ 1)
 * @param {ArrayLike<number>} upper  Uᵢ ≥ Lᵢ, with U₀ = L₀ and Uₙ = Lₙ
 * @returns {{F: Float64Array, f: Float64Array}}  F: node values (length n + 1);
 *     f: slopes, f[i − 1] = F[i] − F[i−1] (length n), set to the exact segment slope
 */
export function tautString(lower, upper) {
    const n = lower.length - 1;
    if (n < 1 || upper.length !== n + 1)
        throw new RangeError('tube needs matching lower/upper arrays of length ≥ 2');
    if (lower[0] !== upper[0] || lower[n] !== upper[n])
        throw new RangeError('tube ends must be pinned (lower = upper at nodes 0 and n)');

    const F = new Float64Array(n + 1);
    const f = new Float64Array(n);
    let ax = 0;
    let ay = lower[0];
    F[0] = ay;

    // Chains as deques of node indices: upper chain uq[uh..ut), lower chain lq[lh..lt).
    const uq = new Int32Array(n + 1);
    const lq = new Int32Array(n + 1);
    let uh = 0;
    let ut = 0;
    let lh = 0;
    let lt = 0;

    const slope = (x0, y0, x1, y1) => (y1 - y0) / (x1 - x0);

    function emit(x, y) {
        const s = (y - ay) / (x - ax);
        for (let j = ax + 1; j <= x; j++) {
            F[j] = j === x ? y : ay + s * (j - ax);
            f[j - 1] = s;
        }
        ax = x;
        ay = y;
    }

    for (let k = 1; k <= n; k++) {
        // --- upper point (k, Uₖ)
        const pu = upper[k];
        if (lh < lt && slope(ax, ay, k, pu) < slope(ax, ay, lq[lh], lower[lq[lh]])) {
            while (lh < lt && slope(ax, ay, k, pu) < slope(ax, ay, lq[lh], lower[lq[lh]])) {
                const j = lq[lh++];
                emit(j, lower[j]);
            }
            uh = 0;
            ut = 0;
        }
        else {
            while (ut > uh) {
                const last = uq[ut - 1];
                const px = ut - uh >= 2 ? uq[ut - 2] : ax;
                const py = ut - uh >= 2 ? upper[px] : ay;
                if (slope(px, py, k, pu) <= slope(px, py, last, upper[last]))
                    ut--;
                else
                    break;
            }
        }
        uq[ut++] = k;

        // --- lower point (k, Lₖ)
        const pl = lower[k];
        if (ut > uh && uq[uh] !== k && slope(ax, ay, k, pl) > slope(ax, ay, uq[uh], upper[uq[uh]])) {
            while (ut > uh && uq[uh] !== k && slope(ax, ay, k, pl) > slope(ax, ay, uq[uh], upper[uq[uh]])) {
                const j = uq[uh++];
                emit(j, upper[j]);
            }
            lh = 0;
            lt = 0;
        }
        else {
            while (lt > lh) {
                const last = lq[lt - 1];
                const px = lt - lh >= 2 ? lq[lt - 2] : ax;
                const py = lt - lh >= 2 ? lower[px] : ay;
                if (slope(px, py, k, pl) >= slope(px, py, last, lower[last]))
                    lt--;
                else
                    break;
            }
        }
        lq[lt++] = k;
    }
    if (ax < n)
        emit(n, upper[n]);
    return { F, f };
}

/**
 * Reference taut string for tests: minimizes Σ (Fᵢ − Fᵢ₋₁)² over the tube by projected successive
 * over-relaxation, Fᵢ ← clamp((1−ω)Fᵢ + ω(Fᵢ₋₁ + Fᵢ₊₁)/2, Lᵢ, Uᵢ). O(n²) or worse; small n only.
 *
 * @param {ArrayLike<number>} lower
 * @param {ArrayLike<number>} upper
 * @param {{relTol?: number, maxSweeps?: number}} [opts]  stop when the largest change in a sweep is
 *     below relTol × max(1, max |boundary|); an absolute tolerance near 1e−14 can sit below rounding
 *     noise and never be met
 * @returns {{F: Float64Array, f: Float64Array, sweeps: number, converged: boolean}}
 */
export function tautStringReference(lower, upper, { relTol = 1e-14, maxSweeps = 2e6 } = {}) {
    const n = lower.length - 1;
    let scale = 1;
    for (let i = 0; i <= n; i++)
        scale = Math.max(scale, Math.abs(lower[i]), Math.abs(upper[i]));
    const tol = relTol * scale * 8; // 8 ulp-ish of the largest magnitude
    const F = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
        const straight = lower[0] + (lower[n] - lower[0]) * i / n;
        F[i] = Math.min(upper[i], Math.max(lower[i], straight));
    }
    const omega = 2 / (1 + Math.sin(Math.PI / (n + 1)));
    let sweeps = 0;
    for (; sweeps < maxSweeps; sweeps++) {
        let change = 0;
        for (let i = 1; i < n; i++) {
            const target = (1 - omega) * F[i] + omega * 0.5 * (F[i - 1] + F[i + 1]);
            const v = Math.min(upper[i], Math.max(lower[i], target));
            change = Math.max(change, Math.abs(v - F[i]));
            F[i] = v;
        }
        if (change < tol)
            break;
    }
    const f = new Float64Array(n);
    for (let i = 1; i <= n; i++)
        f[i - 1] = F[i] - F[i - 1];
    return { F, f, sweeps, converged: sweeps < maxSweeps };
}

/**
 * KKT certificate for the taut string (sufficient for optimality, since the problem is strictly
 * convex). At each interior node i (1..n−1), with slopes a = f̃ᵢ and b = f̃ᵢ₊₁:
 *   feasible:           Lᵢ − ε ≤ F̃ᵢ ≤ Uᵢ + ε
 *   strictly inside:    a = b
 *   touching upper:     a ≤ b   (string bends up around the upper boundary)
 *   touching lower:     a ≥ b
 * "Touching" means within ε of the boundary. Slopes are compared with tolerance εf.
 *
 * @param {ArrayLike<number>} lower
 * @param {ArrayLike<number>} upper
 * @param {ArrayLike<number>} F  node values (length n + 1)
 * @param {{eps?: number, epsSlope?: number}} [opts]  absolute tolerances (default 1e−9 × scale)
 * @returns {{ok: boolean, failures: Array<{node: number, reason: string}>}}
 */
export function checkKKT(lower, upper, F, opts = {}) {
    const n = F.length - 1;
    let scale = 0;
    for (let i = 0; i <= n; i++)
        scale = Math.max(scale, Math.abs(lower[i]), Math.abs(upper[i]));
    const eps = opts.eps ?? 1e-9 * Math.max(1, scale);
    const epsSlope = opts.epsSlope ?? 2 * eps;
    const failures = [];
    if (Math.abs(F[0] - lower[0]) > eps || Math.abs(F[n] - lower[n]) > eps)
        failures.push({ node: 0, reason: 'ends not pinned' });
    for (let i = 1; i < n; i++) {
        if (F[i] < lower[i] - eps || F[i] > upper[i] + eps) {
            failures.push({ node: i, reason: 'infeasible' });
            continue;
        }
        const a = F[i] - F[i - 1];
        const b = F[i + 1] - F[i];
        const atUpper = F[i] >= upper[i] - eps;
        const atLower = F[i] <= lower[i] + eps;
        if (atUpper && atLower)
            continue;
        if (atUpper && a > b + epsSlope)
            failures.push({ node: i, reason: 'bends down at upper boundary' });
        else if (atLower && a < b - epsSlope)
            failures.push({ node: i, reason: 'bends up at lower boundary' });
        else if (!atUpper && !atLower && Math.abs(a - b) > epsSlope)
            failures.push({ node: i, reason: 'kink inside the tube' });
    }
    return { ok: failures.length === 0, failures };
}

/**
 * @typedef {object} TautStringFit
 * @property {Float64Array} f          fitted values at the observations (piecewise constant)
 * @property {number} iterations       taut strings computed
 * @property {boolean} converged       final f ∈ Aₙ
 * @property {import('./region.js').RegionCheck} check  Aₙ check of the final f
 * @property {Float64Array} widths     final tube half-widths λᵢ at nodes 0..n
 * @property {Float64Array} lower      final tube, nodes 0..n (cumulative sums of centered y)
 * @property {Float64Array} upper
 * @property {Float64Array} F          final string at nodes 0..n (same centering)
 * @property {number} sigma            σ used
 * @property {number} c                threshold used
 * @property {{lo: number, hi: number, level: number}[]} intervals  family checked
 */

/**
 * Taut string regression with local squeezing (appendix 7.3): the member of Aₙ found by the paper's
 * algorithm, which has (approximately) the fewest local extremes.
 *
 * 1. Yᵢ = cumulative sums of y; tube Yᵢ ± λᵢ with λ₀ = λₙ = 0 and a common initial interior width.
 * 2. f̃ = slopes of the taut string.
 * 3. If f̃ ∉ Aₙ: for each interior node i (between paper observations i and i+1, i.e. code indices
 *    i−1 and i), if any violated interval contains either observation, λᵢ ← squeeze·λᵢ. Repeat.
 *
 * Initial width (PLAN.md Known issue 9). The paper uses max Y − min Y on the raw cumulative sums
 * ('raw', matches ftnonpar's pmreg). That depends on the level of y, and since every later width is a
 * power of `squeeze` times it, adding a constant to y changes the fit by more than the constant. The
 * default 'centered' uses the range of the mean-centered sums Yᵢ − i·Yₙ/n instead, i.e. the spread of
 * Y around the straight string from (0, 0) to (n, Yₙ). It still contains the straight string (the
 * centered sums are 0 at both ends), so the first pass is still the constant mean, and the fit
 * satisfies f(y + a) = f(y) + a.
 *
 * y is centered for the arithmetic in either mode: for a given tube the taut string is equivariant
 * under adding a constant (the tube is sheared by a linear function and Σ f̃ᵢ is fixed), and centering
 * keeps Yᵢ small.
 *
 * @param {ArrayLike<number>} y  observations ordered by x, n ≥ 2
 * @param {object} [opts]
 * @param {number} [opts.sigma]     noise scale (default σ̂ of eq. 10)
 * @param {number} [opts.tau=3]     threshold constant
 * @param {number} [opts.lambda=2]  multiresolution scale for the check
 * @param {{lo: number, hi: number}[]} [opts.intervals]  family to check (overrides lambda)
 * @param {number} [opts.squeeze=0.5]
 * @param {number} [opts.maxIter=200]
 * @param {'centered'|'raw'} [opts.initialWidth='centered']  shift-invariant (default) or the paper's
 * @returns {TautStringFit}
 */
export function tautStringRegression(y, opts = {}) {
    const n = y.length;
    if (n < 2)
        throw new RangeError('tautStringRegression needs at least 2 observations');
    const sigma = opts.sigma ?? sigmaMAD(y);
    const tau = opts.tau ?? DEFAULT_TAU;
    const intervals = opts.intervals ?? multiresolution(n, opts.lambda ?? 2);
    const squeeze = opts.squeeze ?? DEFAULT_SQUEEZE;
    const maxIter = opts.maxIter ?? DEFAULT_MAX_ITER;
    const initialWidth = opts.initialWidth ?? 'centered';
    if (initialWidth !== 'centered' && initialWidth !== 'raw')
        throw new RangeError(`initialWidth must be 'centered' or 'raw'`);
    const c = threshold(sigma, tau, n);

    let mean = 0;
    for (let i = 0; i < n; i++)
        mean += y[i];
    mean /= n;
    const yc = Float64Array.from(y, v => v - mean);
    const Y = prefixSums(yc);
    const offset = initialWidth === 'raw' ? mean : 0; // 'raw' measures the uncentered sums Yᵢ + mean·i
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let i = 0; i <= n; i++) {
        const v = Y[i] + offset * i;
        yMin = Math.min(yMin, v);
        yMax = Math.max(yMax, v);
    }
    const widths = new Float64Array(n + 1).fill(yMax - yMin);
    widths[0] = 0;
    widths[n] = 0;
    const lower = new Float64Array(n + 1);
    const upper = new Float64Array(n + 1);
    const marked = new Uint8Array(n);
    const cover = new Int32Array(n + 1);

    let iterations = 0;
    let string = null;
    let check = null;
    while (true) {
        for (let i = 0; i <= n; i++) {
            lower[i] = Y[i] - widths[i];
            upper[i] = Y[i] + widths[i];
        }
        string = tautString(lower, upper);
        iterations++;
        check = checkRegion(yc, string.f, intervals, c);
        if (check.ok || iterations >= maxIter)
            break;
        // Mark observations covered by a violated interval (difference array, O(n + |𝓘|)).
        cover.fill(0);
        for (let k = 0; k < intervals.length; k++) {
            if (check.ratios[k] > 1) {
                cover[intervals[k].lo]++;
                cover[intervals[k].hi + 1]--;
            }
        }
        let run = 0;
        for (let i = 0; i < n; i++) {
            run += cover[i];
            marked[i] = run > 0 ? 1 : 0;
        }
        for (let i = 1; i < n; i++) {
            if (marked[i - 1] || marked[i])
                widths[i] *= squeeze;
        }
    }
    const f = Float64Array.from(string.f, v => v + mean);
    return {
        f, iterations, converged: check.ok, check, widths, lower, upper, F: string.F, sigma, c, intervals,
    };
}
