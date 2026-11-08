// Exact confidence bounds by linear programming (paper §5.2.1 eqs. 57–58, §5.2.2 eqs. 64–65, §5.3):
//     lbᵢ = min {gᵢ : g ∈ Aₙ ∩ shape},   ubᵢ = max {gᵢ : g ∈ Aₙ ∩ shape}.
// 2m LPs (m distinct x) that differ only in the objective, so one persistent HiGHS model is reused and
// each solve warm-starts from the previous basis. Small n only (the UI allows n ≤ 300).
//
// Unlike the fast bounds (src/core/bounds.js), these use exactly the chosen family 𝓘ₙ (dyadic by default),
// so they are honest with respect to that Aₙ, and the shape constraints are on divided differences, which
// characterize convexity and ‖g″‖∞ ≤ K at any spacing.

import { buildShapeRegion, lpFrame, shapeConstraints } from './lp-build.js';
import { modelStatusName } from './lp-solve.js';
import { xIntervalFamily } from './intervals.js';
import { threshold } from './region.js';
import { sigmaMAD } from './sigma.js';

const DEFAULT_TAU = 3;

/** @typedef {import('./lp-build.js').Shape} Shape */

/**
 * Exact LP bounds under a shape assumption.
 *
 * When τ is at the edge of admitting the shape, Aₙ ∩ shape is empty to within solver tolerance: the
 * first solve can find it feasible and a later one infeasible (measured: within ~1e−8 of the smallest
 * admissible τ). That is reported as 'infeasible' with `marginal: true`, not as an error.
 *
 * @param {object} highs  loaded HiGHS instance
 * @param {{x: ArrayLike<number>, y: ArrayLike<number>, shape: Shape, sigma?: number, tau?: number,
 *     lambda?: number, share?: number, intervals?: {lo: number, hi: number}[], options?: object, cold?: boolean}} spec
 *     cold: clear the solver before every solve (no warm start; for testing)
 * @param {function(number): void} [onProgress]  called with the completed fraction
 * @returns {{status: string, marginal?: boolean, lb: Float64Array|null, ub: Float64Array|null,
 *     solves: number, coldRestarts: number, ms: number}}  status 'optimal', or 'infeasible' when no g in
 *     Aₙ satisfies the shape (the assumption is rejected)
 */
export function exactBounds(highs, spec, onProgress) {
    const start = performance.now();
    const x = Float64Array.from(spec.x);
    const y = Float64Array.from(spec.y);
    const n = y.length;
    const sigma = spec.sigma ?? sigmaMAD(y, x);
    const tau = spec.tau ?? DEFAULT_TAU;
    const intervals = spec.intervals ?? xIntervalFamily(x, spec.lambda ?? 2, spec.share ?? 0);
    const c = threshold(sigma, tau, n);
    const frame = lpFrame(x, y, sigma);
    const { mean, scale, ys, group, m, tauX } = frame;
    const { signs, curvature, maxCurv } = shapeConstraints(spec.shape, frame);

    const { model, hStart } = buildShapeRegion({ ys, group, tau: tauX, intervals, c: c / scale, signs, curvature, maxCurv });
    const optimal = highs.constants.modelStatus.optimal;
    const unbounded = highs.constants.modelStatus.unbounded;
    const infeasible = highs.constants.modelStatus.infeasible;
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
    const fail = (status, marginal) => ({
        status: modelStatusName(highs, status), ...(marginal ? { marginal: true } : {}), lb: null, ub: null,
        solves, coldRestarts, ms: performance.now() - start,
    });
    try {
        mdl.options.set({ output_flag: false, ...spec.options });
        const feasibility = solve();
        if (feasibility !== optimal)
            return fail(feasibility, false);
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
                else if (status === infeasible)
                    return fail(status, true);
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
