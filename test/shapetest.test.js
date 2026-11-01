import { test } from 'node:test';
import assert from 'node:assert/strict';
import highsLoader from 'highs';
import { prepareXY } from '../src/core/data.js';
import { simulate } from '../src/core/signals.js';
import { shapeThreshold } from '../src/core/shapetest.js';
import { exactBounds } from '../src/core/exact.js';
import { regularize } from '../src/core/regularize.js';
import { checkRegion, threshold } from '../src/core/region.js';
import { xIntervalFamily } from '../src/core/intervals.js';
import { sigmaMAD } from '../src/core/sigma.js';

const highs = await highsLoader();
const DECREASING = { type: 'monotone', direction: -1 };
const INCREASING = { type: 'monotone', direction: 1 };

// A user data set (28 rows, unsorted, two tied ages) whose early values rise, so a decreasing fit needs
// τ ≈ 3.57: the singleton at age 24.10 (y = 0.458) caps g there at y + c, while the next three
// observations need a mean of at least 0.89 − c/√3.
const USER = `24.0993788819876,0.458219655192431 29.6894409937888,0.439963429500203 30.0621118012422,0.57550647239798
27.8260869565217,0.813650084170198 22.9813664596273,0.822618563882278 24.2857142857143,0.846084634585244
25.0310559006211,0.897544552156499 25.0310559006211,0.925581935334069 30.0621118012422,0.925973762117606
43.1055900621118,0.520447553259418 43.1055900621118,0.492410170081848 44.9689440993789,0.445826319150171
44.4099378881988,0.403726708074534 47.2049689440994,0.399271492424682 48.8819875776398,0.418093690137575
51.304347826087,0.450992627851628 49.2546583850932,0.562982527427875 54.0993788819876,0.404481337435421
61.1801242236025,0.428397283334301 62.111801242236,0.461180124223602 61.9254658385093,0.489202995298079
63.7888198757764,0.456637835955187 63.2298136645963,0.409865327683288 65.0931677018633,0.367954373947873
64.7204968944099,0.456710396470657 65.8385093167702,0.545582515818192 67.7018633540372,0.550400534045394
71.8012422360248,0.471280547977013`;

function userData() {
    const pairs = USER.trim().split(/\s+/).map(p => p.split(',').map(Number));
    return prepareXY(pairs.map(p => p[0]), pairs.map(p => p[1]));
}

test('smallest τ admitting a decreasing fit on the user data, and it is exactly the feasibility edge', () => {
    const { x, y } = userData();
    const r = shapeThreshold(highs, { x, y, shape: DECREASING });
    assert.equal(r.status, 'optimal');
    assert.ok(Math.abs(r.tau - 3.5748) < 1e-3, `τ_min ${r.tau}`); // bisection on exactBounds gave 3.5748
    const REL = 1e-6; // relative step either side of the edge, well above solver tolerance
    for (const [factor, expected] of [[1 - REL, 'infeasible'], [1 + REL, 'optimal']]) {
        const tau = r.tau * factor;
        assert.equal(exactBounds(highs, { x, y, shape: DECREASING, tau }).status, expected, `exact at ${factor}`);
        assert.equal(regularize(highs, { x, y, method: 'minTV', k: 2, shape: DECREASING, tau }).status, expected,
            `regularize at ${factor}`);
    }
});

// Regression: just below τ_min, Aₙ ∩ shape is empty only to within solver tolerance; the first solve
// found it feasible and a later bound infeasible, and exactBounds threw ("exact bound for x #3: HiGHS
// infeasible") for 98 of these 201 values.
test('exact bounds at the edge of feasibility report infeasible (marginal) instead of throwing', () => {
    const { x, y } = userData();
    const { tau: tauMin } = shapeThreshold(highs, { x, y, shape: DECREASING });
    const STEP = 2.5e-10; // relative
    const seen = new Set();
    let lastFeasible = true;
    for (let k = 0; k <= 200; k++) {
        const r = exactBounds(highs, { x, y, shape: DECREASING, tau: tauMin * (1 - k * STEP) });
        assert.ok(r.status === 'optimal' || r.status === 'infeasible', r.status);
        // shrinking τ shrinks Aₙ: once infeasible, it stays infeasible
        assert.ok(lastFeasible || r.status === 'infeasible', `feasible again at k = ${k}`);
        lastFeasible = r.status === 'optimal';
        seen.add(`${r.status}${r.marginal ? '/marginal' : ''}`);
    }
    assert.ok(seen.has('optimal') && seen.has('infeasible'), [...seen].join(', '));
});

test('a shape the data follow needs a small τ, the opposite shape a large one', () => {
    const sim = simulate('exp5', 300, 5, 3);
    const y = Float64Array.from(sim.y, v => -v); // decreasing truth
    const down = shapeThreshold(highs, { x: sim.x, y, shape: DECREASING });
    const up = shapeThreshold(highs, { x: sim.x, y, shape: INCREASING });
    assert.ok(down.tau < 3, `decreasing τ_min ${down.tau}`);
    assert.ok(up.tau > 30, `increasing τ_min ${up.tau}`);
});

test('τ_min is invariant under affine changes of y and the LP certificate is attained', () => {
    const { x, y } = userData();
    const shape = { type: 'convex', concave: true };
    const a = shapeThreshold(highs, { x, y, shape });
    const b = shapeThreshold(highs, { x, y: y.map(v => 3 * v + 10), shape });
    assert.ok(Math.abs(a.tau - b.tau) < 1e-6 * a.tau, `${a.tau} vs ${b.tau}`);
    assert.ok(Math.abs(b.c - 3 * a.c) < 1e-6 * b.c);
    // at c_min the region (with σ̂) admits a concave fit: regularize just above it succeeds
    const r = regularize(highs, { x, y, method: 'minTV', k: 1, shape, tau: a.tau * (1 + 1e-6) });
    assert.equal(r.status, 'optimal');
});

test('shape-constrained fits have the shape and lie in Aₙ, at unequal spacing and with ties', () => {
    const { x, y } = userData();
    const tau = 4.26; // ≈ τ calibrated for 95% at this n (Monte Carlo, dyadic family)
    const c = threshold(sigmaMAD(y, x), tau, y.length);
    const intervals = xIntervalFamily(x, 2);
    const TOL = 1e-7; // solver tolerance, units of y
    for (const [method, k] of [['minTV', 0], ['minTV', 1], ['minTV', 2], ['minSup', 1], ['minSup', 2]]) {
        const r = regularize(highs, { x, y, method, k, shape: DECREASING, tau });
        assert.equal(r.status, 'optimal', `${method}${k}`);
        for (let i = 1; i < y.length; i++)
            assert.ok(r.g[i] <= r.g[i - 1] + TOL, `${method}${k} increases at ${i}`);
        assert.ok(checkRegion(y, r.g, intervals, c, 1e-6).ok, `${method}${k} not in Aₙ`);
    }
    const convex = regularize(highs, { x, y, method: 'minTV', k: 2, shape: { type: 'convex' }, tau });
    assert.equal(convex.status, 'optimal');
    // convex at unequal spacing: slopes between distinct x never decrease
    const xs = [];
    const gs = [];
    for (let i = 0; i < x.length; i++) {
        if (i === 0 || x[i] !== x[i - 1]) {
            xs.push(x[i]);
            gs.push(convex.g[i]);
        }
    }
    for (let j = 2; j < xs.length; j++) {
        const s1 = (gs[j - 1] - gs[j - 2]) / (xs[j - 1] - xs[j - 2]);
        const s2 = (gs[j] - gs[j - 1]) / (xs[j] - xs[j - 1]);
        assert.ok(s2 >= s1 - 1e-6, `slope decreases at x = ${xs[j - 1]}`);
    }
});

test('combined rejects an extra shape constraint', () => {
    const { x, y } = userData();
    assert.throws(() => regularize(highs, { x, y, method: 'combined', shape: DECREASING }), RangeError);
});
