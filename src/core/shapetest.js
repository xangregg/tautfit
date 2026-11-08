// How strongly do the data reject a shape? The smallest τ for which some function with the shape lies in
// Aₙ, from one LP (lp-build.buildMinThreshold). With a Monte Carlo sample of the multiscale statistic
// (calibrate.js), 1 − coverage(τ_min) is a p-value for the shape: if f has the shape, f ∈ Aₙ(τ) with
// probability coverage(τ), and then Aₙ(τ) ∩ shape is non-empty, so the shape is rejected at τ only with
// probability ≤ 1 − coverage(τ).

import { buildMinThreshold, lpFrame, shapeConstraints } from './lp-build.js';
import { solveModel } from './lp-solve.js';
import { xIntervalFamily } from './intervals.js';
import { sigmaMAD } from './sigma.js';

/**
 * @typedef {object} ShapeThreshold
 * @property {string} status  HiGHS model status ('optimal' unless something went wrong)
 * @property {number} c       smallest threshold admitting the shape, units of y (NaN unless optimal)
 * @property {number} tau     the same as τ = (c/σ)²/log n (Infinity when σ = 0 or n = 1 and c > 0)
 * @property {number} ms
 */

/**
 * Smallest c (and τ) for which Aₙ contains a function with the given shape.
 *
 * @param {object} highs  loaded HiGHS instance
 * @param {{x: ArrayLike<number>, y: ArrayLike<number>, shape: import('./lp-build.js').Shape,
 *     sigma?: number, lambda?: number, share?: number, intervals?: {lo: number, hi: number}[], options?: object}} spec
 * @returns {ShapeThreshold}
 */
export function shapeThreshold(highs, spec) {
    const x = Float64Array.from(spec.x);
    const y = Float64Array.from(spec.y);
    const n = y.length;
    const sigma = spec.sigma ?? sigmaMAD(y, x);
    const intervals = spec.intervals ?? xIntervalFamily(x, spec.lambda ?? 2, spec.share ?? 0);
    const frame = lpFrame(x, y, sigma);
    const rows = shapeConstraints(spec.shape, frame);
    const { model, cCol } = buildMinThreshold({ ys: frame.ys, group: frame.group, tau: frame.tauX, intervals, ...rows });
    const sol = solveModel(highs, model, spec.options);
    if (!sol.x)
        return { status: sol.status, c: NaN, tau: NaN, ms: sol.ms };
    const c = Math.max(0, sol.x[cCol]) * frame.scale;
    const denom = sigma * sigma * Math.log(n);
    const tau = c === 0 ? 0 : (denom > 0 ? (c * c) / denom : Infinity);
    return { status: sol.status, c, tau, ms: sol.ms };
}
