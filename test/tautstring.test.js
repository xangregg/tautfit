import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tautString, tautStringReference, checkKKT, tautStringRegression } from '../src/core/tautstring.js';
import { checkRegion, threshold } from '../src/core/region.js';
import { prefixSums } from '../src/core/prefix.js';
import { sigmaMAD } from '../src/core/sigma.js';
import { simulate } from '../src/core/signals.js';
import { createRng } from '../src/core/rng.js';

// Random tube: random-walk centerline with half-widths drawn from a mix of wide, narrow and zero.
function randomTube(n, rng) {
    const Y = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++)
        Y[i] = Y[i - 1] + rng.normal() + (rng.uniform() < 0.1 ? 4 * rng.normal() : 0);
    const lower = new Float64Array(n + 1);
    const upper = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
        const u = rng.uniform();
        const w = i === 0 || i === n ? 0 : u < 0.1 ? 0 : u < 0.4 ? 0.1 * rng.uniform() : 3 * rng.uniform();
        // asymmetric widths exercise the general tube, not just Y ± λ
        lower[i] = Y[i] - w * (0.5 + rng.uniform());
        upper[i] = Y[i] + w * (0.5 + rng.uniform());
        if (w === 0) {
            lower[i] = Y[i];
            upper[i] = Y[i];
        }
    }
    return { lower, upper };
}

test('funnel taut string matches the projected-SOR reference (random tubes, n ≤ 200, tol 1e-9)', () => {
    const rng = createRng(2024);
    for (let trial = 0; trial < 150; trial++) {
        const n = 1 + Math.floor(rng.uniform() * 200);
        const { lower, upper } = randomTube(n, rng);
        const fast = tautString(lower, upper);
        const ref = tautStringReference(lower, upper);
        assert.ok(ref.converged, `trial ${trial}: reference did not converge`);
        for (let i = 0; i <= n; i++)
            assert.ok(Math.abs(fast.F[i] - ref.F[i]) < 1e-9, `trial ${trial}, n=${n}, node ${i}: ${fast.F[i]} vs ${ref.F[i]}`);
        for (let i = 1; i <= n; i++)
            assert.ok(Math.abs(fast.f[i - 1] - (fast.F[i] - fast.F[i - 1])) < 1e-9);
    }
});

test('taut string satisfies the KKT certificate for n = 10⁴ random tubes', () => {
    const rng = createRng(77);
    for (let trial = 0; trial < 5; trial++) {
        const { lower, upper } = randomTube(10000, rng);
        const { F } = tautString(lower, upper);
        const kkt = checkKKT(lower, upper, F);
        assert.ok(kkt.ok, JSON.stringify(kkt.failures.slice(0, 5)));
    }
});

test('KKT checker rejects a non-taut feasible path and a sign-swapped bend', () => {
    // Tube with an upper bound pushing node 1 down: F = (0, −1, 0) is the taut string.
    const lower = [0, -5, 0];
    const upper = [0, -1, 0];
    assert.ok(checkKKT(lower, upper, [0, -1, 0]).ok);
    assert.ok(!checkKKT(lower, upper, [0, -2, 0]).ok); // kink inside the tube
    // Same bend against the lower boundary is the wrong direction.
    assert.ok(!checkKKT([0, -1, 0], [0, 5, 0], [0, -1, 0]).ok);
});

test('a wide tube gives the straight string, i.e. f = mean(y)', () => {
    const { y } = simulate('blocks', 300, 1, 3);
    const Y = prefixSums(y);
    const w = Math.max(...Y) - Math.min(...Y);
    const lower = Y.map((v, i) => (i === 0 || i === 300 ? v : v - w));
    const upper = Y.map((v, i) => (i === 0 || i === 300 ? v : v + w));
    const { f } = tautString(lower, upper);
    const mean = Y[300] / 300;
    assert.ok(f.every(v => Math.abs(v - mean) < 1e-12));
});

test('zero-width tube reproduces the data', () => {
    const { y } = simulate('doppler', 100, 0.1, 4);
    const Y = prefixSums(y);
    const { f } = tautString(Y, Y);
    for (let i = 0; i < 100; i++)
        assert.ok(Math.abs(f[i] - y[i]) < 1e-12);
});

test('taut string regression ends in Aₙ, preserves Σy, and passes KKT on its final tube', () => {
    for (const name of ['blocks', 'bumps', 'heavisine', 'doppler', 'noise', 'exp5']) {
        const { y } = simulate(name, 1024, name === 'exp5' ? 5 : 1, 5);
        const fit = tautStringRegression(y);
        assert.ok(fit.converged, `${name}: not converged after ${fit.iterations}`);
        const sum = (a) => a.reduce((s, v) => s + v, 0);
        assert.ok(Math.abs(sum(fit.f) - sum(y)) < 1e-8 * (1 + Math.abs(sum(y))), name);
        // independent re-check of membership
        const r = checkRegion(y, fit.f, fit.intervals, threshold(sigmaMAD(y), 3, 1024), 1e-9);
        assert.ok(r.ok, `${name}: max ratio ${r.maxRatio}`);
        assert.ok(checkKKT(fit.lower, fit.upper, fit.F).ok, `${name}: KKT`);
    }
});

test('first pass is the constant mean, so pure noise usually needs one iteration', () => {
    const { y } = simulate('noise', 500, 1, 1);
    const fit = tautStringRegression(y);
    if (fit.iterations === 1) {
        const mean = y.reduce((a, b) => a + b, 0) / 500;
        assert.ok(fit.f.every(v => Math.abs(v - mean) < 1e-12));
    }
});

test('n = 2 works and rejects n < 2', () => {
    const fit = tautStringRegression([1, 3]);
    assert.ok(fit.converged);
    assert.throws(() => tautStringRegression([1]), RangeError);
});

// Regression for the initial tube width (PLAN.md Known issue 9). 'raw' is the paper's max − min of the
// uncentered cumulative sums; a first version accidentally mixed the two, which gave valid fits that
// differed from pmreg's by up to 4 units. The default 'centered' is shift-invariant.
test('initial tube width: centered range by default, raw range with initialWidth = raw', () => {
    const { y } = simulate('exp5', 1000, 5, 8); // large positive mean, so the two widths differ a lot
    const range = v => Math.max(...v) - Math.min(...v);
    const raw = prefixSums(y);
    const mean = raw[1000] / 1000;
    const centered = raw.map((v, i) => v - mean * i);
    assert.ok(range(raw) > 2 * range(centered));
    for (const [mode, expected] of [['centered', range(centered)], ['raw', range(raw)]]) {
        const fit = tautStringRegression(y, { maxIter: 1, initialWidth: mode });
        assert.equal(fit.widths[0], 0);
        assert.equal(fit.widths[1000], 0);
        for (let i = 1; i < 1000; i++)
            assert.ok(Math.abs(fit.widths[i] - expected) <= 1e-9 * expected, `${mode}, node ${i}`);
    }
});

test('default taut string regression is shift-invariant: f(y + a) = f(y) + a (tol 1e-9 × sd)', () => {
    for (const name of ['blocks', 'doppler', 'heavisine', 'exp5']) {
        const { y } = simulate(name, 1024, 1, 1);
        const sigma = sigmaMAD(y);
        const base = tautStringRegression(y, { sigma });
        for (const a of [10, 100, -100, 1e4]) {
            const shifted = tautStringRegression(y.map(v => v + a), { sigma });
            assert.equal(shifted.iterations, base.iterations, `${name} + ${a}`);
            for (let i = 0; i < 1024; i++)
                assert.ok(Math.abs(shifted.f[i] - a - base.f[i]) < 1e-9 * Math.max(1, Math.abs(a)), `${name} + ${a}, i = ${i}`);
        }
    }
});

test('the paper\'s raw initial width is not shift-invariant (documents Known issue 9)', () => {
    const { y } = simulate('doppler', 1024, 1, 1);
    const sigma = sigmaMAD(y);
    const a = tautStringRegression(y, { sigma, initialWidth: 'raw' });
    const b = tautStringRegression(y.map(v => v + 100), { sigma, initialWidth: 'raw' });
    const diff = Math.max(...a.f.map((v, i) => Math.abs(b.f[i] - 100 - v)));
    assert.ok(diff > 0.1, `max difference ${diff}`);
});

test('initialWidth rejects unknown modes', () => {
    assert.throws(() => tautStringRegression([1, 2, 3], { initialWidth: 'wide' }), RangeError);
});
