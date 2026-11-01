// Smoothness regularization inside Aₙ (paper §4.1–4.2): set up, solve and translate back.
// The HiGHS instance is passed in, so this runs unchanged in Node tests and in the LP worker.

import { tieGroups, totalVariation, supNorm } from './derivatives.js';
import { buildRegularization } from './lp-build.js';
import { solveModel } from './lp-solve.js';
import { xIntervalFamily } from './intervals.js';
import { threshold, checkRegion } from './region.js';
import { sigmaMAD } from './sigma.js';

const DEFAULT_TAU = 3;
const REGION_TOL = 1e-6; // relative slack when re-checking LP solutions against Aₙ (solver tolerance ~1e−7)

/**
 * @typedef {object} RegularizeSpec
 * @property {ArrayLike<number>} x     sorted, user units (ties allowed)
 * @property {ArrayLike<number>} y     observations ordered by x
 * @property {'minTV'|'minSup'|'combined'} method   combined = minTV(2) + monotonicity signs (§4.2)
 * @property {number} [k]              derivative order (minTV 0–2, minSup 1–2; combined uses 2)
 * @property {number} [sigma]          noise scale (default σ̂)
 * @property {number} [tau=3]
 * @property {number} [lambda=2]       multiresolution scale (ignored if intervals given)
 * @property {{lo: number, hi: number}[]} [intervals]
 * @property {Int8Array} [signs]       combined: step signs over observations (extremes.stepSigns of
 *                                     the taut string, length n − 1)
 * @property {Array<{type: 'max'|'min', start: number, end: number, value: number}>} [fixExtremes]
 *     combined, optional: make each taut-string extreme's value the fit's extreme value there
 *     (paper Fig. 2): g ≤ value on the plateau (max; ≥ for min) and g = value at its middle
 * @property {object} [options]        HiGHS options
 */

/**
 * @typedef {object} RegularizeResult
 * @property {string} status       HiGHS model status ('optimal', 'infeasible', …)
 * @property {Float64Array|null} g fit at the observations, user units (null unless optimal)
 * @property {number} objective    optimal value in user units: TV(g⁽ᵏ⁾) (true total variation, see
 *                                 derivatives.totalVariation) or ‖g⁽ᵏ⁾‖∞, derivatives w.r.t. x
 * @property {number} objectiveCheck  the same quantity recomputed from g (agrees to solver tolerance)
 * @property {string} objectiveLabel  e.g. 'TV(g″)'
 * @property {{ok: boolean, maxRatio: number, violations: number}|null} region  Aₙ re-check of g
 * @property {number} ms           solve time including model setup, milliseconds
 * @property {number} rows
 * @property {number} cols
 */

const PRIMES = ['', '′', '″'];

/**
 * Minimize TV(g⁽ᵏ⁾) (eq. 44) or ‖g⁽ᵏ⁾‖∞ (eq. 46) over g ∈ Aₙ.
 *
 * Works in standardized units ys = (y − ȳ)/s with s = σ (or sd(y) if σ = 0) and on τ = (m−1)·t, where t
 * is x rescaled to [0, 1] and m the number of distinct x; the k-th derivative in x units is the τ
 * derivative times ((m−1)/R)ᵏ, R = x_max − x_min. Tied x share one value.
 *
 * @param {object} highs  loaded HiGHS instance
 * @param {RegularizeSpec} spec
 * @returns {RegularizeResult}
 */
export function regularize(highs, spec) {
    const n = spec.y.length;
    const x = Float64Array.from(spec.x);
    const y = Float64Array.from(spec.y);
    const method = spec.method;
    const objective = method === 'combined' ? 'minTV' : method;
    const k = method === 'combined' ? 2 : spec.k;
    const sigma = spec.sigma ?? sigmaMAD(y);
    const tau = spec.tau ?? DEFAULT_TAU;
    const intervals = spec.intervals ?? xIntervalFamily(x, spec.lambda ?? 2);
    const c = threshold(sigma, tau, n);

    let mean = 0;
    for (const v of y)
        mean += v;
    mean /= n;
    let scale = sigma;
    if (!(scale > 0)) {
        let ss = 0;
        for (const v of y)
            ss += (v - mean) ** 2;
        scale = Math.sqrt(ss / Math.max(1, n - 1)) || 1;
    }
    const ys = Float64Array.from(y, v => (v - mean) / scale);

    const { group, xs } = tieGroups(x);
    const m = xs.length;
    const range = xs[m - 1] - xs[0];
    const tauX = Float64Array.from(xs, v => (m > 1 ? (m - 1) * (v - xs[0]) / range : 0));

    let signs;
    if (method === 'combined' && spec.signs) {
        // Distinct step j (group j → j+1) crosses the observation step after group j's last member.
        signs = new Int8Array(Math.max(0, m - 1));
        for (let i = 0; i + 1 < n; i++) {
            if (group[i + 1] !== group[i])
                signs[group[i]] = spec.signs[i];
        }
    }
    let fixed;
    if (method === 'combined' && spec.fixExtremes) {
        fixed = spec.fixExtremes.map(ex => {
            const groups = [];
            for (let j = group[ex.start]; j <= group[ex.end]; j++)
                groups.push(j);
            return {
                groups, type: ex.type, value: (ex.value - mean) / scale,
                mid: group[Math.floor((ex.start + ex.end) / 2)],
            };
        });
    }

    const { model, hStart } = buildRegularization({
        ys, group, tau: tauX, intervals, c: c / scale, objective, k, signs, fixed,
    });
    const sol = solveModel(highs, model, spec.options);
    const toX = m > 1 ? Math.pow((m - 1) / range, k) : 0; // τ-derivative → x-derivative factor
    const label = objective === 'minTV' ? `TV(g${PRIMES[k]})` : `‖g${PRIMES[k]}‖∞`;
    const base = { status: sol.status, objectiveLabel: label, ms: sol.ms, rows: model.numRows, cols: model.numCols };
    if (!sol.x)
        return { ...base, g: null, objective: NaN, objectiveCheck: NaN, region: null };

    const h = new Float64Array(m);
    for (let j = 0; j < m; j++)
        h[j] = mean + scale * sol.x[hStart + j];
    const g = Float64Array.from(group, j => h[j]);
    const r = checkRegion(y, g, intervals, c, REGION_TOL);
    const objectiveCheck = m > k
        ? (objective === 'minTV' ? totalVariation(xs, h, k) : supNorm(xs, h, k))
        : 0;
    return {
        ...base,
        g,
        objective: sol.objective * scale * toX,
        objectiveCheck,
        region: { ok: r.ok, maxRatio: r.maxRatio, violations: r.violations },
    };
}
