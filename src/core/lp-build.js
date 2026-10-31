// Builders for CPLEX-LP-format strings consumed by HiGHS (browser: src/lp-worker.js; Node: the
// `highs` dev dependency). M0 holds only a smoke-test problem; the §1.6/§1.9 builders arrive in M3.
//
// LP-format reminders (PLAN.md §LP worker): variables default to [0, ∞), so declare free variables in
// Bounds; keep lines under 255 characters.

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
