// Linear programs for smoothness regularization inside Aₙ (paper §4.1–4.2, PLAN.md §1.6).
//
// Models are HiGHS ModelData objects (sparse CSR typed arrays), passed to `highs.createModel`, rather
// than CPLEX-LP text: HiGHS's LP reader rejects ranged rows (and aborts the Wasm instance), and typed
// arrays avoid generating and parsing megabytes of text (PLAN.md §LP worker).
//
// Formulation, in standardized units (ys = (y − ȳ)/s, c_s = c/s) on distinct x values:
//   columns  h_j, j = 0..m−1     fit at each distinct x (ties share a value), free
//            P_k, k = 1..n       prefix sums over observations, P_k = Σ_{i<k} h_{group(i)}, free (P₀ ≡ 0)
//            problem-specific auxiliaries
//   rows     P_{k+1} − P_k − h_{group(k)} = 0                       (n rows, ≤ 3 nonzeros)
//            S_I − c_s√|I| ≤ P_{hi+1} − P_lo ≤ S_I + c_s√|I|        (one ranged row per I ∈ 𝓘ₙ, eq. 7)
// so the region costs O(n) nonzeros instead of Σ|I| = O(n log n).
//
// Derivatives are divided differences with respect to τ = (m−1)·t, t = (x − x_min)/(x_max − x_min),
// so spacing is ≈ 1 and coefficients stay O(1) (in t units Dᵏ has coefficients ~ mᵏ, ~10⁹ for
// TV(g″) at m = 1000). Callers convert objectives back with the factor ((m−1)/R)ᵏ.

import { differenceRows } from './derivatives.js';

/**
 * A tiny 2-variable LP with a known unique optimum, used to check that HiGHS loads and solves
 * in both Node and the browser worker.
 *
 *     maximize  x + 2y   s.t.  x + y ≤ 4,  x + 3y ≤ 6,  x, y ≥ 0
 *
 * Optimum: x = 3, y = 1, objective 5.
 *
 * @returns {{lp: string, expected: {objective: number, primal: {x: number, y: number}}}}
 */
export function smokeLP() {
    const lp = [
        'Maximize',
        ' obj: x + 2 y',
        'Subject To',
        ' c1: x + y <= 4',
        ' c2: x + 3 y <= 6',
        'Bounds',
        ' x >= 0',
        ' y >= 0',
        'End',
    ].join('\n');
    return { lp, expected: { objective: 5, primal: { x: 3, y: 1 } } };
}

/** Incremental CSR model builder. */
function createBuilder() {
    const colCost = [];
    const colLower = [];
    const colUpper = [];
    const starts = [0];
    const indices = [];
    const values = [];
    const rowLower = [];
    const rowUpper = [];
    return {
        addCol(cost, lo, hi) {
            colCost.push(cost);
            colLower.push(lo);
            colUpper.push(hi);
            return colCost.length - 1;
        },
        addRow(cols, vals, lo, hi) {
            for (let r = 0; r < cols.length; r++) {
                if (vals[r] !== 0) {
                    indices.push(cols[r]);
                    values.push(vals[r]);
                }
            }
            starts.push(indices.length);
            rowLower.push(lo);
            rowUpper.push(hi);
        },
        finish() {
            const numCols = colCost.length;
            const numRows = rowLower.length;
            return {
                numCols,
                numRows,
                colCost: Float64Array.from(colCost),
                colLower: Float64Array.from(colLower),
                colUpper: Float64Array.from(colUpper),
                rowLower: Float64Array.from(rowLower),
                rowUpper: Float64Array.from(rowUpper),
                matrix: {
                    format: 'csr',
                    numRows,
                    numCols,
                    starts: Int32Array.from(starts),
                    indices: Int32Array.from(indices),
                    values: Float64Array.from(values),
                },
            };
        },
    };
}

/**
 * Add the columns and rows shared by all models: h_j (free, or bounded by `fixed`), prefix columns P_k,
 * prefix rows, one ranged Aₙ row per interval, and optional step-sign rows.
 *
 * @param {ReturnType<typeof createBuilder>} b
 * @param {{ys: Float64Array, group: Int32Array, tau: Float64Array, intervals: {lo: number, hi: number}[],
 *     c: number, signs?: Int8Array, fixed?: Array<{groups: number[], mid: number, value: number,
 *     type: 'max'|'min'}>}} spec
 * @returns {number}  hStart: column of h_0 (h_j is hStart + j)
 */
function addRegion(b, spec) {
    const { ys, group, tau, intervals, c } = spec;
    const n = ys.length;
    const m = tau.length;
    const hLower = new Float64Array(m).fill(-Infinity);
    const hUpper = new Float64Array(m).fill(Infinity);
    for (const ex of spec.fixed ?? []) {
        for (const j of ex.groups) {
            if (ex.type === 'max')
                hUpper[j] = Math.min(hUpper[j], ex.value);
            else
                hLower[j] = Math.max(hLower[j], ex.value);
        }
        hLower[ex.mid] = ex.value;
        hUpper[ex.mid] = ex.value;
    }
    const hStart = 0;
    for (let j = 0; j < m; j++)
        b.addCol(0, hLower[j], hUpper[j]);
    const pCol = new Int32Array(n + 1).fill(-1); // pCol[k] = column of P_k; P₀ ≡ 0 has none
    for (let kk = 1; kk <= n; kk++)
        pCol[kk] = b.addCol(0, -Infinity, Infinity);

    // prefix rows: P_{k+1} − P_k − h_{group(k)} = 0
    for (let kk = 0; kk < n; kk++) {
        const cols = [pCol[kk + 1], hStart + group[kk]];
        const vals = [1, -1];
        if (kk > 0) {
            cols.push(pCol[kk]);
            vals.push(-1);
        }
        b.addRow(cols, vals, 0, 0);
    }
    // region rows (eq. 7)
    const S = new Float64Array(n + 1);
    for (let i = 0; i < n; i++)
        S[i + 1] = S[i] + ys[i];
    for (const { lo, hi } of intervals) {
        const sum = S[hi + 1] - S[lo];
        const slack = c * Math.sqrt(hi - lo + 1);
        const cols = [pCol[hi + 1]];
        const vals = [1];
        if (lo > 0) {
            cols.push(pCol[lo]);
            vals.push(-1);
        }
        b.addRow(cols, vals, sum - slack, sum + slack);
    }
    // monotonicity signs on distinct steps
    if (spec.signs) {
        for (let j = 0; j + 1 < m; j++) {
            const s = spec.signs[j];
            if (s > 0)
                b.addRow([hStart + j + 1, hStart + j], [1, -1], 0, Infinity);
            else if (s < 0)
                b.addRow([hStart + j + 1, hStart + j], [1, -1], -Infinity, 0);
        }
    }
    return hStart;
}

/**
 * Aₙ plus shape constraints and no objective (all costs 0), for the exact bounds of §5.2.1 / §1.9: the
 * caller sets one h_j's cost to ±1 at a time.
 *
 * Shape rows, all on distinct x (second divided differences D²_j over h_j..h_{j+2}, τ units):
 *   signs      step signs as in buildRegularization (monotone, piecewise monotone)
 *   curvature  per distinct second difference: +1 ⇒ D²_j ≥ 0 (convex there), −1 ⇒ ≤ 0, 2 ⇒ = 0, 0 free
 *   maxCurv    |D²_j| ≤ maxCurv (smoothness ‖g″‖∞ ≤ K, converted to τ units and standardized y)
 * D²_j ≥ 0 is exactly convexity of the interpolant at any spacing, and ‖f″‖∞ ≤ K implies |D²_j| ≤ K
 * (mean value theorem), so these constraints are valid without equal spacing.
 *
 * @param {RegularizationSpec & {curvature?: Int8Array, maxCurv?: number}} spec
 * @returns {{model: object, hStart: number, m: number}}
 */
export function buildShapeRegion(spec) {
    const m = spec.tau.length;
    const b = createBuilder();
    const hStart = addRegion(b, spec);
    if (spec.curvature || spec.maxCurv !== undefined) {
        const d = differenceRows(spec.tau, 2);
        for (let j = 0; j < d.length; j++) {
            const cols = [hStart + j, hStart + j + 1, hStart + j + 2];
            let lo = -Infinity;
            let hi = Infinity;
            const sgn = spec.curvature?.[j] ?? 0;
            if (sgn === 2) {
                // linear: both convex and concave
                lo = 0;
                hi = 0;
            }
            else if (sgn > 0) {
                lo = 0;
            }
            else if (sgn < 0) {
                hi = 0;
            }
            if (spec.maxCurv !== undefined) {
                lo = Math.max(lo, -spec.maxCurv);
                hi = Math.min(hi, spec.maxCurv);
            }
            if (lo > -Infinity || hi < Infinity)
                b.addRow(cols, d[j], lo, hi);
        }
    }
    return { model: b.finish(), hStart, m };
}

/**
 * @typedef {object} RegularizationSpec
 * @property {Float64Array} ys        standardized observations, ordered by x (length n)
 * @property {Int32Array} group       tie group of each observation (tieGroups)
 * @property {Float64Array} tau       distinct abscissae in index units τ_j (length m)
 * @property {{lo: number, hi: number}[]} intervals  family 𝓘ₙ (observation indices)
 * @property {number} c               threshold in standardized units
 * @property {'minTV'|'minSup'} objective
 * @property {number} k               derivative order: minTV k ∈ {0,1,2}, minSup k ∈ {1,2}
 * @property {Int8Array} [signs]      optional sign of h_{j+1} − h_j per distinct step (length m − 1):
 *                                    +1 ⇒ ≥ 0, −1 ⇒ ≤ 0, 0 ⇒ free
 * @property {Array<{groups: number[], mid: number, value: number, type: 'max'|'min'}>} [fixed]
 *     optional extremes to pin: h ≤ value (max) or ≥ value (min) on `groups`, h = value at `mid`
 */

/**
 * Build the LP for one regularization problem.
 *
 * minTV(k): minimize Σ_j |Dᵏ_{j+1} − Dᵏ_j| via ΔDᵏ_j − u⁺_j + u⁻_j = 0, u± ≥ 0.
 * minSup(k): minimize s subject to −s ≤ Dᵏ_j ≤ s.
 *
 * @param {RegularizationSpec} spec
 * @returns {{model: object, hStart: number, m: number}}  model: HiGHS ModelData; h_j is column
 *     hStart + j
 */
export function buildRegularization(spec) {
    const { ys, group, tau, intervals, c, objective, k } = spec;
    const n = ys.length;
    const m = tau.length;
    if (objective !== 'minTV' && objective !== 'minSup')
        throw new RangeError(`unknown objective '${objective}'`);
    if (objective === 'minTV' && !(k >= 0 && k <= 2))
        throw new RangeError('minTV needs k ∈ {0, 1, 2}');
    if (objective === 'minSup' && !(k >= 1 && k <= 2))
        throw new RangeError('minSup needs k ∈ {1, 2}');

    const b = createBuilder();
    const hStart = addRegion(b, spec);
    if (objective === 'minTV') {
        // ΔDᵏ_j = Dᵏ_{j+1} − Dᵏ_j over h_j..h_{j+k+1}
        const d = differenceRows(tau, k);
        for (let j = 0; j + 1 < d.length; j++) {
            const coef = new Float64Array(k + 2);
            for (let r = 0; r <= k; r++) {
                coef[r] -= d[j][r];
                coef[r + 1] += d[j + 1][r];
            }
            const up = b.addCol(1, 0, Infinity);
            const down = b.addCol(1, 0, Infinity);
            const cols = Array.from({ length: k + 2 }, (_, r) => hStart + j + r);
            b.addRow([...cols, up, down], [...coef, -1, 1], 0, 0);
        }
    }
    else {
        const d = differenceRows(tau, k);
        const s = b.addCol(1, 0, Infinity);
        for (let j = 0; j < d.length; j++) {
            const cols = Array.from({ length: k + 1 }, (_, r) => hStart + j + r);
            b.addRow([...cols, s], [...d[j], -1], -Infinity, 0);
            b.addRow([...cols, s], [...d[j], 1], 0, Infinity);
        }
    }
    return { model: b.finish(), hStart, m };
}
