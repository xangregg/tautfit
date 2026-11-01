// Tied x (PLAN.md Known issue 14): Aₙ's intervals are intervals of x (paper eq. 6), so tied observations
// are never separated, every fit takes one value per x, and nothing depends on the order of tied rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { multiresolution, multiresolutionLevels, allIntervals, xIntervalFamily, xIntervalLevels, allXIntervals, tieRanges } from '../src/core/intervals.js';
import { tautString, tautStringReference, checkKKT, tautStringRegression } from '../src/core/tautstring.js';
import { checkRegion, threshold } from '../src/core/region.js';
import { regularize } from '../src/core/regularize.js';
import { exactBounds } from '../src/core/exact.js';
import { monotoneBounds } from '../src/core/bounds.js';
import { prepareXY } from '../src/core/data.js';
import { sigmaMAD } from '../src/core/sigma.js';
import { createRng } from '../src/core/rng.js';

const highs = await loadHighs();
const TOL = 1e-9;

// The user's data set that exposed the problem (age, items correct): 101 rows, 30 distinct ages.
const AGES = `60,5 60,7 21,9 21,7 49,14 49,11 54,12 54,12 41,15 41,19 38,9 38,9 23,10 23,18 53,17 53,7 8,7 8,8 53,5
53,11 17,22 17,13 24,3 24,2 18,9 18,3 17,7 17,6 18,6 18,10 19,3 19,6 18,6 18,6 18,2 18,0 18,5 18,4 18,5 18,6 18,5
18,4 18,6 18,7 18,3 18,4 17,3 17,3 17,1 17,5 17,5 69,0 69,9 25,18 25,8 59,12 59,9 14,8 14,3 80,6 80,4 55,15 55,14
30,10 30,11 18,8 18,13 22,10 22,7 55,11 55,3 55,3 55,3 26,6 26,5 52,5 52,4 29,6 29,1 52,2 52,2 20,7 20,9 59,9 59,6
20,14 20,21 9,5 9,2 10,2 10,2 38,5 38,7 74,7 74,4 69,2 69,1 58,2 58,0 70,0 70,1`.split(/\s+/).map(p => p.split(',').map(Number));

function agesData() {
    return prepareXY(AGES.map(r => r[0]), AGES.map(r => r[1]));
}

function groupSpread(x, g) {
    let worst = 0;
    for (let i = 1; i < x.length; i++) {
        if (x[i] === x[i - 1])
            worst = Math.max(worst, Math.abs(g[i] - g[i - 1]));
    }
    return worst;
}

const strip = fam => fam.map(({ lo, hi, level }) => [lo, hi, level]);

test('without ties the x-interval families equal the observation-index families', () => {
    for (const n of [7, 64, 100]) {
        const x = Float64Array.from({ length: n }, (_, i) => i * 0.3);
        assert.deepEqual(strip(xIntervalFamily(x, 2)), strip(multiresolution(n, 2)));
        assert.deepEqual(xIntervalLevels(x, 1.5).map(strip), multiresolutionLevels(n, 1.5).map(strip));
        assert.deepEqual(strip(allXIntervals(x)), strip(allIntervals(n)));
    }
});

test('with ties, no interval separates tied observations, and each group is a degenerate interval', () => {
    const { x } = agesData();
    const { start, m } = tieRanges(x);
    const fam = xIntervalFamily(x, 2);
    assert.equal(fam.length, multiresolution(m, 2).length);
    for (const { lo, hi } of fam) {
        assert.ok(lo === 0 || x[lo] !== x[lo - 1], `interval starts inside a group at ${lo}`);
        assert.ok(hi === x.length - 1 || x[hi] !== x[hi + 1], `interval ends inside a group at ${hi}`);
    }
    for (let j = 0; j < m; j++)
        assert.ok(fam.some(iv => iv.lo === start[j] && iv.hi === start[j + 1] - 1), `group ${j}`);
});

test('taut string with uneven node positions matches the weighted reference (random tubes, tol 1e-9)', () => {
    const rng = createRng(31);
    for (let trial = 0; trial < 80; trial++) {
        const n = 2 + Math.floor(rng.uniform() * 120);
        const pos = new Float64Array(n + 1);
        for (let k = 1; k <= n; k++)
            pos[k] = pos[k - 1] + 1 + Math.floor(rng.uniform() * 6); // group sizes 1–6
        const Y = new Float64Array(n + 1);
        for (let k = 1; k <= n; k++)
            Y[k] = Y[k - 1] + (pos[k] - pos[k - 1]) * rng.normal();
        const w = Float64Array.from(Y, (_, k) => (k === 0 || k === n ? 0 : 2 * rng.uniform() ** 2));
        const lower = Y.map((v, k) => v - w[k]);
        const upper = Y.map((v, k) => v + w[k]);
        const fast = tautString(lower, upper, pos);
        const ref = tautStringReference(lower, upper, { pos });
        assert.ok(ref.converged);
        for (let k = 0; k <= n; k++)
            assert.ok(Math.abs(fast.F[k] - ref.F[k]) < TOL, `trial ${trial} node ${k}`);
        assert.ok(checkKKT(lower, upper, fast.F, { pos }).ok, `trial ${trial} KKT`);
    }
});

test('taut string regression with tied x: one value per x, in Aₙ, KKT on its own nodes', () => {
    const { x, y } = agesData();
    const fit = tautStringRegression(y, { x });
    assert.ok(fit.converged);
    assert.equal(groupSpread(x, fit.f), 0);
    const c = threshold(sigmaMAD(y), 3, y.length);
    assert.ok(checkRegion(y, fit.f, xIntervalFamily(x, 2), c).ok);
    assert.ok(checkKKT(fit.lower, fit.upper, fit.F, { pos: fit.pos }).ok);
});

test('passing x without ties changes nothing (bitwise)', () => {
    const rng = createRng(8);
    const n = 300;
    const x = Float64Array.from({ length: n }, (_, i) => i + rng.uniform() * 0.5);
    const y = Float64Array.from(x, v => Math.sin(v / 30) + 0.3 * rng.normal());
    assert.deepEqual(tautStringRegression(y, { x }).f, tautStringRegression(y).f);
});

test('nothing depends on the order of tied rows (fixed σ, since σ̂ itself is order-dependent)', () => {
    const { x, y } = agesData();
    const sigma = 3;
    const rng = createRng(5);
    const shuffled = Float64Array.from(y);
    const { start, m } = tieRanges(x);
    for (let j = 0; j < m; j++) {
        for (let i = start[j + 1] - 1; i > start[j]; i--) {
            const k = start[j] + Math.floor(rng.uniform() * (i - start[j] + 1));
            [shuffled[i], shuffled[k]] = [shuffled[k], shuffled[i]];
        }
    }
    const a = tautStringRegression(y, { x, sigma });
    const b = tautStringRegression(shuffled, { x, sigma });
    for (let i = 0; i < y.length; i++)
        assert.ok(Math.abs(a.f[i] - b.f[i]) < TOL);
    for (const [method, k] of [['minTV', 0], ['minTV', 2]]) {
        const ra = regularize(highs, { x, y, method, k, sigma });
        const rb = regularize(highs, { x, y: shuffled, method, k, sigma });
        assert.ok(Math.abs(ra.objective - rb.objective) < 1e-6 * Math.max(1, ra.objective), method);
    }
});

test('regression (user data set with many ties): every smooth fit is feasible and in Aₙ', () => {
    const { x, y } = agesData();
    for (const [method, k] of [['minTV', 0], ['minTV', 1], ['minTV', 2], ['minSup', 1], ['minSup', 2]]) {
        const r = regularize(highs, { x, y, method, k });
        assert.equal(r.status, 'optimal', `${method}(${k}) was ${r.status}`);
        assert.ok(r.region.ok);
        assert.equal(groupSpread(x, r.g), 0);
    }
});

test('tie-aware fast monotone bounds are implied by Aₙ over all x-intervals (exact ⊆ fast)', () => {
    const rng = createRng(13);
    const xs = [];
    const ys = [];
    for (let v = 0; v < 40; v++) {
        const reps = 1 + Math.floor(rng.uniform() * 4);
        for (let r = 0; r < reps; r++) {
            xs.push(v);
            ys.push(Math.sqrt(v) + 0.5 * rng.normal());
        }
    }
    const x = Float64Array.from(xs);
    const y = Float64Array.from(ys);
    const c = threshold(sigmaMAD(y), 3, y.length);
    const fast = monotoneBounds(y, c, { x });
    assert.equal(groupSpread(x, fast.lb), 0);
    assert.equal(groupSpread(x, fast.ub), 0);
    const exact = exactBounds(highs, { x, y, shape: { type: 'monotone', direction: 1 }, intervals: allXIntervals(x) });
    assert.equal(exact.status, 'optimal');
    for (let i = 0; i < y.length; i++) {
        assert.ok(exact.lb[i] >= fast.lb[i] - 1e-6, `lb at ${i}`);
        assert.ok(exact.ub[i] <= fast.ub[i] + 1e-6, `ub at ${i}`);
    }
});
