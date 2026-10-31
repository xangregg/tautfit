// Fast honest bounds (PLAN.md M4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    windowRadii, monotoneBounds, piecewiseMonotoneBounds, convexBounds, piecewiseConvexBounds,
    curvatureSegments, smoothnessBounds, smoothnessKMin, crossings,
} from '../src/core/bounds.js';
import { simulate } from '../src/core/signals.js';
import { sigmaMAD } from '../src/core/sigma.js';
import { threshold } from '../src/core/region.js';
import { createRng } from '../src/core/rng.js';

const TAU = 3;
const EPS = 1e-9; // absolute slack for "no tighter than" comparisons

function cFor(y) {
    return threshold(sigmaMAD(y), TAU, y.length);
}

function noTighter(fast, full, tag) {
    for (let i = 0; i < fast.lb.length; i++) {
        assert.ok(fast.lb[i] <= full.lb[i] + EPS, `${tag}: lb[${i}] ${fast.lb[i]} > ${full.lb[i]}`);
        assert.ok(fast.ub[i] >= full.ub[i] - EPS, `${tag}: ub[${i}] ${fast.ub[i]} < ${full.ub[i]}`);
    }
}

test('window radii', () => {
    assert.deepEqual(Array.from(windowRadii(1.5, 10, 1)), [0, 1, 2, 4, 6, 10]); // ⌊1.5ᵐ⌋ − 1
    assert.deepEqual(Array.from(windowRadii(2, 20, 0)), [0, 1, 2, 4, 8, 16]);
    assert.throws(() => windowRadii(1, 10), RangeError);
});

test('full monotone bounds equal a direct (no prefix sums) evaluation of eqs. 59–60 + monotonization', () => {
    const rng = createRng(3);
    const n = 40;
    const y = Float64Array.from({ length: n }, (_, i) => i / 10 + rng.normal());
    const c = 1.3;
    const b = monotoneBounds(y, c, { full: true });
    const lb = [];
    const ub = [];
    for (let i = 0; i < n; i++) {
        let lo = -Infinity;
        let hi = Infinity;
        for (let k = 0; k <= i; k++) {
            let s = 0;
            for (let j = i - k; j <= i; j++)
                s += y[j];
            lo = Math.max(lo, s / (k + 1) - c / Math.sqrt(k + 1));
        }
        for (let k = 0; i + k < n; k++) {
            let s = 0;
            for (let j = i; j <= i + k; j++)
                s += y[j];
            hi = Math.min(hi, s / (k + 1) + c / Math.sqrt(k + 1));
        }
        lb.push(lo);
        ub.push(hi);
    }
    for (let i = 1; i < n; i++)
        lb[i] = Math.max(lb[i], lb[i - 1]);
    for (let i = n - 2; i >= 0; i--)
        ub[i] = Math.min(ub[i], ub[i + 1]);
    for (let i = 0; i < n; i++) {
        assert.ok(Math.abs(b.lb[i] - lb[i]) < 1e-12);
        assert.ok(Math.abs(b.ub[i] - ub[i]) < 1e-12);
    }
});

test('fast bounds are no tighter than the all-windows references', () => {
    const { y: ye } = simulate('exp5', 200, 5, 1);
    const c = cFor(ye);
    for (const direction of [1, -1])
        noTighter(monotoneBounds(ye, c, { direction }), monotoneBounds(ye, c, { direction, full: true }), `monotone ${direction}`);
    const { y: small } = simulate('exp5', 90, 5, 2);
    const cs = cFor(small);
    for (const concave of [false, true])
        noTighter(convexBounds(small, cs, { concave }), convexBounds(small, cs, { concave, full: true }), `convex ${concave}`);
    const { y: ys } = simulate('sine', 200, 0.2, 3);
    noTighter(smoothnessBounds(ys, cFor(ys), 200, 1 / 200), smoothnessBounds(ys, cFor(ys), 200, 1 / 200, { full: true }), 'smooth');
    const ex = [{ type: 'max', position: 60 }, { type: 'min', position: 120 }];
    noTighter(piecewiseMonotoneBounds(ys, cFor(ys), ex), piecewiseMonotoneBounds(ys, cFor(ys), ex, { full: true }), 'pw monotone');
    const { y: yc } = simulate('sine', 90, 0.2, 4);
    const segs = [{ lo: 0, hi: 30, type: 'concave' }, { lo: 30, hi: 60, type: 'convex' }, { lo: 60, hi: 89, type: 'concave' }];
    noTighter(piecewiseConvexBounds(yc, cFor(yc), segs), piecewiseConvexBounds(yc, cFor(yc), segs, { full: true }), 'pw convex');
});

test('monotone bounds are monotone; piecewise monotone bounds are monotone on each segment', () => {
    const { y } = simulate('sine', 500, 0.2, 5);
    const c = cFor(y);
    const b = monotoneBounds(y, c);
    for (let i = 1; i < 500; i++)
        assert.ok(b.lb[i] >= b.lb[i - 1] && b.ub[i] >= b.ub[i - 1]);
    const pw = piecewiseMonotoneBounds(y, c, [
        { type: 'max', position: 62 }, { type: 'min', position: 187 }, { type: 'max', position: 312 }, { type: 'min', position: 437 },
    ]);
    for (const { lo, hi, direction } of pw.segments) {
        for (let i = lo + 1; i <= hi; i++) {
            assert.ok(direction * (pw.lb[i] - pw.lb[i - 1]) >= -1e-12, `lb at ${i}`);
            assert.ok(direction * (pw.ub[i] - pw.ub[i - 1]) >= -1e-12, `ub at ${i}`);
        }
    }
});

test('a shape inconsistent with the data shows up as an empty band (lb > ub)', () => {
    const { y } = simulate('sine', 500, 0.2, 6);
    assert.ok(crossings(monotoneBounds(y, cFor(y))) > 0, 'sin(4πt) is not monotone');
    assert.ok(crossings(convexBounds(y, cFor(y))) > 0, 'sin(4πt) is not convex');
    assert.ok(crossings(smoothnessBounds(y, cFor(y), 1, 1 / 500)) > 0, '‖f″‖∞ ≈ 158, not ≤ 1');
});

test('K_min (closed form) is exactly where the smoothness band stops being empty', () => {
    for (let seed = 1; seed <= 5; seed++) {
        const { y } = simulate('sine', 500, 0.2, seed);
        const c = cFor(y);
        const k = smoothnessKMin(y, c, 1 / 500);
        assert.ok(k > 0);
        assert.equal(crossings(smoothnessBounds(y, c, k * (1 + 1e-9), 1 / 500)), 0);
        assert.ok(crossings(smoothnessBounds(y, c, k * (1 - 1e-6), 1 / 500)) > 0);
        assert.ok(smoothnessKMin(y, c, 1 / 500, { theta: 1.5 }) <= smoothnessKMin(y.slice(), c, 1 / 500, { full: true }) + 1e-9);
    }
});

test('curvature segments of a piecewise-linear fit', () => {
    const x = Float64Array.from({ length: 21 }, (_, i) => i);
    // slope 0 → 1 at x = 5 (convex kink), 1 → 2 at 8 (convex), 2 → 0 at 14 (concave)
    const g = Float64Array.from(x, v => (v <= 5 ? 0 : v <= 8 ? v - 5 : v <= 14 ? 3 + 2 * (v - 8) : 15));
    const segs = curvatureSegments(x, g);
    assert.deepEqual(segs.map(s => [s.lo, s.hi, s.type]), [[0, 11, 'convex'], [11, 20, 'concave']]);
    assert.deepEqual(curvatureSegments(x, x.map(v => 2 * v + 1)), [{ lo: 0, hi: 20, type: 'linear' }]);
});

// Coverage (PLAN.md M4; Known issue 6). The bounds use windows outside the dyadic family, so their
// honesty rests on Aₙ over all intervals, for which τ = 3 gives coverage ≥ 0.95 at n ≥ 500 (paper
// eq. 11). Rates measured when written: monotone 96.1%, convex 95.8%, smoothness 95.4% (binomial
// standard error ≈ 0.7%).
const COVERAGE_SEEDS = 1000;

function coverage(signal, sigma, band) {
    let covered = 0;
    for (let seed = 1; seed <= COVERAGE_SEEDS; seed++) {
        const { y, f } = simulate(signal, 500, sigma, seed);
        const b = band(y, cFor(y));
        if (f.every((v, i) => b.lb[i] <= v && v <= b.ub[i]))
            covered++;
    }
    return covered / COVERAGE_SEEDS;
}

for (const [label, signal, sigma, band] of [
    ['exp(5t), monotone', 'exp5', 5, (y, c) => monotoneBounds(y, c)],
    ['exp(5t), convex', 'exp5', 5, (y, c) => convexBounds(y, c)],
    ['sin(4πt), ‖f″‖∞ ≤ 16π²', 'sine', 0.2, (y, c) => smoothnessBounds(y, c, 16 * Math.PI ** 2, 1 / 500)],
]) {
    test(`coverage: ${label}, n = 500: f inside the band everywhere in ≥ 95% of ${COVERAGE_SEEDS} runs`, () => {
        const rate = coverage(signal, sigma, band);
        console.log(`# coverage ${label}: ${(100 * rate).toFixed(1)}%`);
        assert.ok(rate >= 0.95, `rate ${rate}`);
    });
}
