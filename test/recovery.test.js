// Extremes recovery by the taut string (PLAN.md M2). Rates are over fixed seeds, so the test is
// deterministic; thresholds sit a little below the rates measured when the test was written (noted
// per case) and the observed rate is printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, signalValues } from '../src/core/signals.js';
import { tautStringRegression } from '../src/core/tautstring.js';
import { localExtremes } from '../src/core/extremes.js';

const SEEDS = 200;

function extremeCounts(name, n, sigma) {
    const counts = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
        const { y } = simulate(name, n, sigma, seed);
        counts.push(localExtremes(tautStringRegression(y).f).extremes.length);
    }
    return counts;
}

const CASES = [
    // [signal, n, σ, minimum exact-recovery rate, rate measured when written]
    ['blocks', 1024, 1, 0.97, 0.995],
    ['bumps', 1024, 1, 0.97, 1.0],
    ['heavisine', 1024, 1, 0.9, 0.94],
    ['sine', 500, 0.2, 0.97, 1.0],
    ['noise', 500, 1, 0.95, 0.99],
    ['exp5', 1000, 5, 0.95, 0.995],
];

for (const [name, n, sigma, minRate, measured] of CASES) {
    test(`${name} (n = ${n}, σ = ${sigma}): true number of extremes in ≥ ${100 * minRate}% of ${SEEDS} seeds`, () => {
        const truth = localExtremes(signalValues(name, n)).extremes.length;
        const counts = extremeCounts(name, n, sigma);
        const rate = counts.filter(k => k === truth).length / SEEDS;
        console.log(`# ${name}: true ${truth}, exact in ${(100 * rate).toFixed(1)}% (was ${100 * measured}%)`);
        assert.ok(rate >= minRate, `rate ${rate}`);
    });
}

test('Doppler (n = 1024): never more extremes than the true f in ≥ 95% of seeds', () => {
    // The true f on the grid has 39 extremes, most of them oscillations near t = 0 far below the noise,
    // so exact recovery is not expected. Minimality is: if f ∈ Aₙ the simplest fit has ≤ its count.
    const truth = localExtremes(signalValues('doppler', 1024)).extremes.length;
    const counts = extremeCounts('doppler', 1024, 1);
    const rate = counts.filter(k => k <= truth).length / SEEDS;
    const sorted = [...counts].sort((a, b) => a - b);
    console.log(`# doppler: true ${truth}, fitted median ${sorted[SEEDS / 2]}, range ${sorted[0]}–${sorted[SEEDS - 1]}`);
    assert.ok(rate >= 0.95);
});
