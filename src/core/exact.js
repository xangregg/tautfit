// Exact confidence bounds by linear programming (paper §5.2.1 eqs. 57–58, §5.2.2 eqs. 64–65, §5.3):
//     lbᵢ = min {gᵢ : g ∈ Aₙ ∩ shape},   ubᵢ = max {gᵢ : g ∈ Aₙ ∩ shape}.
// 2m LPs (m distinct x) that differ only in the objective, so one persistent HiGHS model is reused and
// each solve warm-starts from the previous basis. Small n only (the UI allows n ≤ 300).
//
// Unlike the fast bounds (src/core/bounds.js), these use exactly the chosen family 𝓘ₙ (dyadic by default),
// so they are honest with respect to that Aₙ, and the shape constraints are on divided differences, which
// characterize convexity and ‖g″‖∞ ≤ K at any spacing.

import { tieGroups } from './derivatives.js';
import { buildShapeRegion } from './lp-build.js';
import { modelStatusName } from './lp-solve.js';
import { xIntervalFamily } from './intervals.js';
import { threshold } from './region.js';
import { sigmaMAD } from './sigma.js';

const DEFAULT_TAU = 3;

/**
 * @typedef {{type: 'monotone', direction: 1|-1}
 *     | {type: 'pwMonotone', segments: Array<{lo: number, hi: number, direction: 1|-1}>}
 *     | {type: 'convex', concave?: boolean}
 *     | {type: 'pwConvex', segments: Array<{lo: number, hi: number, type: 'convex'|'concave'|'linear'}>}
 *     | {type: 'smooth', K: number}} Shape
 *     Segments use observation indices (inclusive, shared endpoints), as returned by
 *     bounds.piecewiseMonotoneBounds / bounds.curvatureSegments. K is in x units.
 */

/**
 * Exact LP bounds under a shape assumption.
 *
 * @param {object} highs  loaded HiGHS instance
 * @param {{x: ArrayLike<number>, y: ArrayLike<number>, shape: Shape, sigma?: number, tau?: number,
 *     lambda?: number, intervals?: {lo: number, hi: number}[], options?: object, cold?: boolean}} spec
 *     cold: clear the solver before every solve (no warm start; for testing)
 * @param {function(number): void} [onProgress]  called with the completed fraction
 * @returns {{status: string, lb: Float64Array|null, ub: Float64Array|null, solves: number,
 *     coldRestarts: number, ms: number}}  status 'optimal', or 'infeasible' when no g in Aₙ satisfies the
 *     shape (the assumption is rejected)
 */
export function exactBounds(highs, spec, onProgress) {
    const start = performance.now();
    const x = Float64Array.from(spec.x);
    const y = Float64Array.from(spec.y);
    const n = y.length;
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

    const shape = spec.shape;
    let signs;
    let curvature;
    let maxCurv;
    if (shape.type === 'monotone') {
        signs = new Int8Array(Math.max(0, m - 1)).fill(shape.direction);
    }
    else if (shape.type === 'pwMonotone') {
        // observation step i (i → i+1) gets its segment's direction; distinct step j uses the step that
        // leaves group j
        const obs = new Int8Array(Math.max(0, n - 1));
        for (const seg of shape.segments) {
            for (let i = seg.lo; i < seg.hi; i++)
                obs[i] = seg.direction;
        }
        signs = new Int8Array(Math.max(0, m - 1));
        for (let i = 0; i + 1 < n; i++) {
            if (group[i + 1] !== group[i])
                signs[group[i]] = obs[i];
        }
    }
    else if (shape.type === 'convex') {
        curvature = new Int8Array(Math.max(0, m - 2)).fill(shape.concave ? -1 : 1);
    }
    else if (shape.type === 'pwConvex') {
        // D²_j involves groups j..j+2; constrain it when all three lie in one segment (the second
        // difference centered on an inflection point stays free)
        curvature = new Int8Array(Math.max(0, m - 2));
        for (const seg of shape.segments) {
            const gLo = group[seg.lo];
            const gHi = group[seg.hi];
            const code = seg.type === 'convex' ? 1 : seg.type === 'concave' ? -1 : 2;
            for (let j = gLo; j + 2 <= gHi; j++)
                curvature[j] = code;
        }
    }
    else if (shape.type === 'smooth') {
        const toX = m > 1 ? ((m - 1) / range) ** 2 : 1; // τ-derivative → x-derivative factor (k = 2)
        maxCurv = shape.K / (scale * toX);
    }
    else {
        throw new RangeError(`unknown shape '${shape.type}'`);
    }

    const { model, hStart } = buildShapeRegion({ ys, group, tau: tauX, intervals, c: c / scale, signs, curvature, maxCurv });
    const optimal = highs.constants.modelStatus.optimal;
    const unbounded = highs.constants.modelStatus.unbounded;
    const mdl = highs.createModel(model);
    let solves = 0;
    let coldRestarts = 0;
    // A warm-started solve occasionally ends with status 'unknown' (≈ 1 in 1600 measured); a cold
    // restart from scratch has always resolved it.
    const solve = () => {
        if (spec.cold)
            mdl.clearSolver();
        mdl.run();
        solves++;
        let status = mdl.getModelStatus();
        if (status !== optimal && status !== unbounded) {
            mdl.clearSolver();
            mdl.run();
            solves++;
            coldRestarts++;
            status = mdl.getModelStatus();
        }
        return status;
    };
    try {
        mdl.options.set({ output_flag: false, ...spec.options });
        const feasibility = solve();
        if (feasibility !== optimal) {
            return {
                status: modelStatusName(highs, feasibility), lb: null, ub: null, solves, coldRestarts,
                ms: performance.now() - start,
            };
        }
        const lbG = new Float64Array(m);
        const ubG = new Float64Array(m);
        for (let j = 0; j < m; j++) {
            for (const dir of [1, -1]) {
                mdl.changeColCost(hStart + j, dir);
                const status = solve();
                let v;
                if (status === optimal)
                    v = dir * mdl.getObjectiveValue();
                else if (status === unbounded)
                    v = dir > 0 ? -Infinity : Infinity;
                else
                    throw new Error(`exact bound for x #${j + 1}: HiGHS ${modelStatusName(highs, status)}`);
                if (dir > 0)
                    lbG[j] = v;
                else
                    ubG[j] = v;
            }
            mdl.changeColCost(hStart + j, 0);
            onProgress?.((j + 1) / m);
        }
        const lb = Float64Array.from(group, j => mean + scale * lbG[j]);
        const ub = Float64Array.from(group, j => mean + scale * ubG[j]);
        return { status: 'optimal', lb, ub, solves, coldRestarts, ms: performance.now() - start };
    }
    finally {
        mdl.dispose();
    }
}
