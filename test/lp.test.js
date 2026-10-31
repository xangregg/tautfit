import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { smokeLP } from '../src/core/lp-build.js';
import { solveLP, primalByName } from '../src/core/lp-solve.js';

const TOL = 1e-9; // absolute tolerance on objective and primal values

test('HiGHS solves the smoke LP (same string the browser worker solves)', async () => {
    const highs = await loadHighs();
    const { lp, expected } = smokeLP();
    const sol = solveLP(highs, lp);

    assert.equal(sol.status, 'Optimal');
    assert.ok(Math.abs(sol.objective - expected.objective) < TOL, `objective ${sol.objective}`);
    assert.deepEqual(sol.names, ['x', 'y']);
    assert.ok(sol.primal instanceof Float64Array);
    const byName = primalByName(sol);
    for (const [name, value] of Object.entries(expected.primal))
        assert.ok(Math.abs(byName.get(name) - value) < TOL, `${name} = ${byName.get(name)}`);
});

test('HiGHS reports infeasibility rather than a bogus solution', async () => {
    const highs = await loadHighs();
    const lp = 'Minimize\n obj: x\nSubject To\n c1: x >= 2\n c2: x <= 1\nEnd';
    const sol = solveLP(highs, lp);
    assert.equal(sol.status, 'Infeasible');
});
