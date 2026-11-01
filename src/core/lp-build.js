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

import { differenceRows, tieGroups } from './derivatives.js';

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
 * Standardized frame shared by every LP: ys = (y − ȳ)/s with s = σ (or sd(y) if σ = 0), tie groups, and
 * distinct abscissae in index units τ_j = (m−1)·(x_j − x_min)/R, R = x_max − x_min.
 *
 * @param {Float64Array} x  sorted (ties allowed)
 * @param {Float64Array} y
 * @param {number} sigma
 * @returns {{mean: number, scale: number, ys: Float64Array, group: Int32Array, xs: Float64Array, m: number,
 *     range: number, tauX: Float64Array}}
 */
export function lpFrame(x, y, sigma) {
    const n = y.length;
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
    return { mean, scale, ys, group, xs, m, range, tauX };
}

/**
 * @typedef {{type: 'monotone', direction: 1|-1}
 *     | {type: 'constant'}
 *     | {type: 'linear'}
 *     | {type: 'pwMonotone', segments: Array<{lo: number, hi: number, direction: 1|-1}>}
 *     | {type: 'convex', concave?: boolean}
 *     | {type: 'pwConvex', segments: Array<{lo: number, hi: number, type: 'convex'|'concave'|'linear'}>}
 *     | {type: 'smooth', K: number}} Shape
 *     Segments use observation indices (inclusive, shared endpoints), as returned by
 *     bounds.piecewiseMonotoneBounds / bounds.curvatureSegments. K is in x units.
 */

/**
 * Translate a shape assumption into constraint codes on distinct x (see addShapeRows).
 *
 * @param {Shape} shape
 * @param {ReturnType<typeof lpFrame>} frame
 * @returns {{signs?: Int8Array, curvature?: Int8Array, maxCurv?: number}}
 */
export function shapeConstraints(shape, frame) {
    const { group, m, scale, range } = frame;
    const n = group.length;
    if (shape.type === 'monotone')
        return { signs: new Int8Array(Math.max(0, m - 1)).fill(shape.direction) };
    if (shape.type === 'constant')
        return { signs: new Int8Array(Math.max(0, m - 1)).fill(2) };
    if (shape.type === 'linear')
        return { curvature: new Int8Array(Math.max(0, m - 2)).fill(2) };
    if (shape.type === 'pwMonotone') {
        // observation step i (i → i+1) gets its segment's direction; distinct step j uses the step that
        // leaves group j
        const obs = new Int8Array(Math.max(0, n - 1));
        for (const seg of shape.segments) {
            for (let i = seg.lo; i < seg.hi; i++)
                obs[i] = seg.direction;
        }
        const signs = new Int8Array(Math.max(0, m - 1));
        for (let i = 0; i + 1 < n; i++) {
            if (group[i + 1] !== group[i])
                signs[group[i]] = obs[i];
        }
        return { signs };
    }
    if (shape.type === 'convex')
        return { curvature: new Int8Array(Math.max(0, m - 2)).fill(shape.concave ? -1 : 1) };
    if (shape.type === 'pwConvex') {
        // D²_j involves groups j..j+2; constrain it when all three lie in one segment (the second
        // difference centered on an inflection point stays free)
        const curvature = new Int8Array(Math.max(0, m - 2));
        for (const seg of shape.segments) {
            const gLo = group[seg.lo];
            const gHi = group[seg.hi];
            const code = seg.type === 'convex' ? 1 : seg.type === 'concave' ? -1 : 2;
            for (let j = gLo; j + 2 <= gHi; j++)
                curvature[j] = code;
        }
        return { curvature };
    }
    if (shape.type === 'smooth') {
        const toX = m > 1 ? ((m - 1) / range) ** 2 : 1; // τ-derivative → x-derivative factor (k = 2)
        return { maxCurv: shape.K / (scale * toX) };
    }
    throw new RangeError(`unknown shape '${shape.type}'`);
}

/**
 * Fit columns h_j (free, or bounded by `fixed`), prefix columns P_k and the prefix rows.
 *
 * @param {ReturnType<typeof createBuilder>} b
 * @param {{ys: Float64Array, group: Int32Array, tau: Float64Array, fixed?: Array<{groups: number[],
 *     mid: number, value: number, type: 'max'|'min'}>}} spec
 * @returns {{hStart: number, pCol: Int32Array}}  h_j is column hStart + j; pCol[k] = column of P_k
 *     (P₀ ≡ 0 has none, −1)
 */
function addFit(b, spec) {
    const { group, tau } = spec;
    const n = spec.ys.length;
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
    const pCol = new Int32Array(n + 1).fill(-1);
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
    return { hStart, pCol };
}

// Prefix sums of ys: Σ_{i∈I} ys_i = S[hi+1] − S[lo].
function intervalSums(ys) {
    const S = new Float64Array(ys.length + 1);
    for (let i = 0; i < ys.length; i++)
        S[i + 1] = S[i] + ys[i];
    return S;
}

// Columns and coefficients of Σ_{i∈I} h_{group(i)} = P_{hi+1} − P_lo.
function intervalTerms(pCol, lo, hi) {
    const cols = [pCol[hi + 1]];
    const vals = [1];
    if (lo > 0) {
        cols.push(pCol[lo]);
        vals.push(-1);
    }
    return { cols, vals };
}

/**
 * Shape rows on distinct x (second divided differences D²_j over h_j..h_{j+2}, τ units):
 *   signs      per distinct step: +1 ⇒ h_{j+1} ≥ h_j, −1 ⇒ ≤, 2 ⇒ =, 0 free
 *   curvature  per distinct second difference: +1 ⇒ D²_j ≥ 0 (convex there), −1 ⇒ ≤ 0, 2 ⇒ = 0, 0 free
 *   maxCurv    |D²_j| ≤ maxCurv (smoothness ‖g″‖∞ ≤ K, converted to τ units and standardized y)
 * D²_j ≥ 0 is exactly convexity of the interpolant at any spacing, and ‖f″‖∞ ≤ K implies |D²_j| ≤ K
 * (mean value theorem), so these constraints are valid without equal spacing.
 */
function addShapeRows(b, spec, hStart) {
    const m = spec.tau.length;
    if (spec.signs) {
        for (let j = 0; j + 1 < m; j++) {
            const s = spec.signs[j];
            if (s === 2)
                b.addRow([hStart + j + 1, hStart + j], [1, -1], 0, 0);
            else if (s > 0)
                b.addRow([hStart + j + 1, hStart + j], [1, -1], 0, Infinity);
            else if (s < 0)
                b.addRow([hStart + j + 1, hStart + j], [1, -1], -Infinity, 0);
        }
    }
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
}

/**
 * The columns and rows shared by all models: fit and prefix columns, one ranged Aₙ row per interval
 * (eq. 7), and the optional shape rows.
 *
 * @param {ReturnType<typeof createBuilder>} b
 * @param {RegularizationSpec} spec
 * @returns {number}  hStart: column of h_0 (h_j is hStart + j)
 */
function addRegion(b, spec) {
    const { hStart, pCol } = addFit(b, spec);
    const S = intervalSums(spec.ys);
    for (const { lo, hi } of spec.intervals) {
        const sum = S[hi + 1] - S[lo];
        const slack = spec.c * Math.sqrt(hi - lo + 1);
        const { cols, vals } = intervalTerms(pCol, lo, hi);
        b.addRow(cols, vals, sum - slack, sum + slack);
    }
    addShapeRows(b, spec, hStart);
    return hStart;
}

/**
 * Aₙ plus shape constraints and no objective (all costs 0), for the exact bounds of §5.2.1 / §1.9: the
 * caller sets one h_j's cost to ±1 at a time.
 *
 * @param {RegularizationSpec} spec  objective and k are ignored
 * @returns {{model: object, hStart: number, m: number}}
 */
export function buildShapeRegion(spec) {
    const b = createBuilder();
    const hStart = addRegion(b, spec);
    return { model: b.finish(), hStart, m: spec.tau.length };
}

/**
 * The smallest threshold c for which some g satisfying the shape rows lies in Aₙ:
 *     minimize c  s.t.  |Σ_I (ys − g)| ≤ c·√|I| for every I,  shape rows on g,  c ≥ 0.
 * Linear in (g, c), so one LP. The shape is consistent with the data exactly for c ≥ c_min, i.e.
 * τ ≥ (c_min/σ)²/log n.
 *
 * @param {RegularizationSpec} spec  c, objective and k are ignored
 * @returns {{model: object, hStart: number, cCol: number}}
 */
export function buildMinThreshold(spec) {
    const b = createBuilder();
    const { hStart, pCol } = addFit(b, spec);
    const cCol = b.addCol(1, 0, Infinity);
    const S = intervalSums(spec.ys);
    for (const { lo, hi } of spec.intervals) {
        const sum = S[hi + 1] - S[lo];
        const root = Math.sqrt(hi - lo + 1);
        const { cols, vals } = intervalTerms(pCol, lo, hi);
        b.addRow([...cols, cCol], [...vals, root], sum, Infinity); // Σg + c√|I| ≥ Σys
        b.addRow([...cols, cCol], [...vals, -root], -Infinity, sum); // Σg − c√|I| ≤ Σys
    }
    addShapeRows(b, spec, hStart);
    return { model: b.finish(), hStart, cCol };
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
 *                                    +1 ⇒ ≥ 0, −1 ⇒ ≤ 0, 2 ⇒ = 0, 0 ⇒ free
 * @property {Array<{groups: number[], mid: number, value: number, type: 'max'|'min'}>} [fixed]
 *     optional extremes to pin: h ≤ value (max) or ≥ value (min) on `groups`, h = value at `mid`
 * @property {Int8Array} [curvature]  optional curvature codes per distinct second difference (addShapeRows)
 * @property {number} [maxCurv]       optional bound on |D²_j| (addShapeRows)
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
