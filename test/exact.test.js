// Exact LP bounds (PLAN.md §1.9, M5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { exactBounds } from '../src/core/exact.js';
import { monotoneBounds, convexBounds, smoothnessBounds, piecewiseMonotoneBounds, piecewiseConvexBounds } from '../src/core/bounds.js';
import { regularize } from '../src/core/regularize.js';
import { simulate } from '../src/core/signals.js';
import { allIntervals } from '../src/core/intervals.js';
import { sigmaMAD } from '../src/core/sigma.js';
import { threshold } from '../src/core/region.js';
import { createRng } from '../src/core/rng.js';

const highs = await loadHighs();
const TOL = 1e-6; // absolute slack in units of y (solver tolerance ~1e−7 in standardized units)

// With all intervals, each fast bound is a consequence of Aₙ ∩ shape, so the exact bounds must be at
// least as tight: lb_exact ≥ lb_fast and ub_exact ≤ ub_fast. This checks both implementations.
test('exact bounds over all intervals are at least as tight as the fast bounds, for every shape', () => {
    const n = 60;
    const intervals = allIntervals(n);
    const cases = [
        ['exp5', 5, { type: 'monotone', direction: 1 }, (y, c) => monotoneBounds(y, c)],
        ['exp5', 5, { type: 'convex' }, (y, c) => convexBounds(y, c)],
        ['sine', 0.2, { type: 'convex', concave: true }, null],
        ['sine', 0.2, { type: 'smooth', K: 16 * Math.PI ** 2 * 1.5 }, (y, c) => smoothnessBounds(y, c, 16 * Math.PI ** 2 * 1.5, 1 / n)],
    ];
    // sin(4πt) at tᵢ = i/60: extremes near i = 7, 22, 37, 52; concave/convex quarter periods of 15 points
    const ext = [{ type: 'max', position: 7 }, { type: 'min', position: 22 }, { type: 'max', position: 37 }, { type: 'min', position: 52 }];
    const pmSegs = [[0, 7, 1], [7, 22, -1], [22, 37, 1], [37, 52, -1], [52, 59, 1]].map(([lo, hi, direction]) => ({ lo, hi, direction }));
    const pcSegs = [[0, 15, 'concave'], [15, 30, 'convex'], [30, 45, 'concave'], [45, 59, 'convex']].map(([lo, hi, type]) => ({ lo, hi, type }));
    cases.push(['sine', 0.2, { type: 'pwMonotone', segments: pmSegs }, (y, c) => piecewiseMonotoneBounds(y, c, ext)]);
    cases.push(['sine', 0.2, { type: 'pwConvex', segments: pcSegs }, (y, c) => piecewiseConvexBounds(y, c, pcSegs)]);
    for (const [signal, sigma, shape, fast] of cases) {
        if (!fast)
            continue;
        const { x, y } = simulate(signal, n, sigma, 1);
        const c = threshold(sigmaMAD(y), 3, n);
        const exact = exactBounds(highs, { x, y, shape, intervals });
        assert.equal(exact.status, 'optimal', shape.type);
        const fb = fast(y, c);
        for (let i = 0; i < n; i++) {
            assert.ok(exact.lb[i] >= fb.lb[i] - TOL, `${shape.type}: lb[${i}] ${exact.lb[i]} < fast ${fb.lb[i]}`);
            assert.ok(exact.ub[i] <= fb.ub[i] + TOL, `${shape.type}: ub[${i}] ${exact.ub[i]} > fast ${fb.ub[i]}`);
        }
    }
});

test('warm-started bounds equal cold-started ones', () => {
    const n = 50;
    for (const shape of [{ type: 'convex' }, { type: 'monotone', direction: 1 }]) {
        const { x, y } = simulate('exp5', n, 5, 2);
        const warm = exactBounds(highs, { x, y, shape });
        const cold = exactBounds(highs, { x, y, shape, cold: true });
        for (let i = 0; i < n; i++)
            assert.ok(Math.abs(warm.lb[i] - cold.lb[i]) < TOL && Math.abs(warm.ub[i] - cold.ub[i]) < TOL, `${shape.type} ${i}`);
    }
});

test('a shape inconsistent with the data makes the LP infeasible', () => {
    const { x, y } = simulate('sine', 100, 0.2, 3);
    assert.equal(exactBounds(highs, { x, y, shape: { type: 'monotone', direction: 1 } }).status, 'infeasible');
});

test('smoothness: infeasible just below the LP K_min (minSup(2)), feasible just above', () => {
    const { x, y } = simulate('sine', 150, 0.2, 4);
    const kMin = regularize(highs, { x, y, method: 'minSup', k: 2 }).objective;
    assert.equal(exactBounds(highs, { x, y, shape: { type: 'smooth', K: kMin * 0.99 } }).status, 'infeasible');
    const r = exactBounds(highs, { x, y, shape: { type: 'smooth', K: kMin * 1.01 } });
    assert.equal(r.status, 'optimal');
    assert.ok(r.lb.every((v, i) => v <= r.ub[i] + TOL));
});

test('convex exact bounds work at unequal spacing and contain a convex truth in Aₙ', () => {
    const rng = createRng(9);
    const n = 80;
    const x = new Float64Array(n);
    for (let i = 1; i < n; i++)
        x[i] = x[i - 1] + 0.005 + 0.03 * rng.uniform() ** 2;
    const f = x.map(v => 3 * (v - 0.6) ** 2);
    const y = f.map(v => v + 0.05 * rng.normal());
    const r = exactBounds(highs, { x, y, shape: { type: 'convex' } });
    assert.equal(r.status, 'optimal');
    assert.ok(f.every((v, i) => r.lb[i] - TOL <= v && v <= r.ub[i] + TOL));
});

test('ties share bounds', () => {
    const base = simulate('exp5', 60, 5, 5);
    const x = Float64Array.from(base.x, (v, i) => (i % 4 === 1 ? base.x[i - 1] : v));
    const r = exactBounds(highs, { x, y: base.y, shape: { type: 'monotone', direction: 1 } });
    for (let i = 1; i < 60; i++) {
        if (x[i] === x[i - 1])
            assert.ok(r.lb[i] === r.lb[i - 1] && r.ub[i] === r.ub[i - 1]);
    }
});
