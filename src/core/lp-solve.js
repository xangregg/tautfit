// Thin, pure wrapper around a loaded HiGHS instance. The caller supplies the instance (Node tests load
// it from the `highs` dev dependency, the browser worker from vendor/highs/highs.mjs), so this module
// has no imports and runs unchanged in both places.

/**
 * @typedef {object} LPSolution
 * @property {string} status       HiGHS model status, e.g. 'Optimal', 'Infeasible'
 * @property {number} objective    objective value (NaN if HiGHS reported none)
 * @property {string[]} names      column names in HiGHS column order
 * @property {Float64Array} primal primal values aligned with `names`
 * @property {number} ms           wall-clock solve time, milliseconds
 */

/**
 * Convert the result of `highs.solve()` (columns keyed by name) into column-ordered arrays.
 *
 * Column order is HiGHS's internal index, which for LP text is order of first appearance; callers
 * that need a particular variable should look it up by name rather than assume a position.
 *
 * @param {object} raw  object returned by `highs.solve(lpText, options)`
 * @returns {Omit<LPSolution, 'ms'>}
 */
export function normalizeSolution(raw) {
    const columns = Object.values(raw.Columns ?? {});
    columns.sort((a, b) => a.Index - b.Index);
    const names = columns.map(col => col.Name);
    const primal = new Float64Array(columns.length);
    for (let i = 0; i < columns.length; i++)
        primal[i] = columns[i].Primal;
    const objective = typeof raw.ObjectiveValue === 'number' ? raw.ObjectiveValue : NaN;
    return { status: raw.Status, objective, names, primal };
}

/**
 * Solve a CPLEX-LP-format problem with a loaded HiGHS instance.
 *
 * @param {{solve: function(string, object): object}} highs  instance from the HiGHS loader
 * @param {string} lp          problem in CPLEX LP format
 * @param {object} [options]   HiGHS options; solver log output is off unless overridden
 * @returns {LPSolution}
 */
export function solveLP(highs, lp, options = {}) {
    const start = performance.now();
    const raw = highs.solve(lp, { output_flag: false, ...options });
    const ms = performance.now() - start;
    return { ...normalizeSolution(raw), ms };
}

/**
 * Map a solution's primal values by column name.
 *
 * @param {{names: string[], primal: Float64Array}} solution
 * @returns {Map<string, number>}
 */
export function primalByName(solution) {
    const map = new Map();
    for (let i = 0; i < solution.names.length; i++)
        map.set(solution.names[i], solution.primal[i]);
    return map;
}
