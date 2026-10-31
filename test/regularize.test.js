// LP regularizations (PLAN.md M3), solved with HiGHS from the dev dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadHighs from 'highs';
import { regularize } from '../src/core/regularize.js';
import { simulate, signalValues, designPoints } from '../src/core/signals.js';
import { tautStringRegression } from '../src/core/tautstring.js';
import { stepSigns, localExtremes } from '../src/core/extremes.js';
import { totalVariation, supNorm } from '../src/core/derivatives.js';
import { checkRegion, threshold } from '../src/core/region.js';
import { multiresolution } from '../src/core/intervals.js';
import { sigmaMAD } from '../src/core/sigma.js';
import { createRng } from '../src/core/rng.js';

const highs = await loadHighs();
const OBJ_REL_TOL = 1e-6; // LP objective vs recomputation from g, relative
const TAU = 3;

const METHODS = [['minTV', 0], ['minTV', 1], ['minTV', 2], ['minSup', 1], ['minSup', 2]];

test('every method returns an optimal g ∈ Aₙ whose recomputed objective matches the LP', () => {
    for (const [name, n, sigma] of [['doppler', 512, 1], ['blocks', 512, 1], ['sine', 300, 0.2]]) {
        const { x, y } = simulate(name, n, sigma, 2);
        const ts = tautStringRegression(y);
        const specs = [...METHODS.map(([method, k]) => ({ method, k })),
            { method: 'combined', signs: stepSigns(ts.f, { plateaus: 'split' }) }];
        for (const spec of specs) {
            const r = regularize(highs, { x, y, ...spec });
            const tag = `${name} ${spec.method}(${spec.k ?? 2})`;
            assert.equal(r.status, 'optimal', tag);
            assert.ok(r.region.ok, `${tag}: max ratio ${r.region.maxRatio}`);
            // independent re-check with the default family and σ̂
            const c = threshold(sigmaMAD(y), TAU, n);
            assert.ok(checkRegion(y, r.g, multiresolution(n), c, 1e-6).ok, tag);
            assert.ok(Math.abs(r.objective - r.objectiveCheck) <= OBJ_REL_TOL * Math.max(1, r.objective), `${tag}: ${r.objective} vs ${r.objectiveCheck}`);
        }
    }
});

test('pure noise → minTV(0) objective ≈ 0 (a constant) whenever a constant is in Aₙ', () => {
    let cases = 0;
    for (let seed = 1; seed <= 40; seed++) {
        const { x, y } = simulate('noise', 500, 1, seed);
        const mean = y.reduce((a, b) => a + b, 0) / 500;
        const c = threshold(sigmaMAD(y), TAU, 500);
        if (!checkRegion(y, new Float64Array(500).fill(mean), multiresolution(500), c).ok)
            continue;
        cases++;
        const r = regularize(highs, { x, y, method: 'minTV', k: 0 });
        assert.ok(r.objective < 1e-6, `seed ${seed}: TV ${r.objective}`);
    }
    assert.ok(cases >= 35, `${cases} seeds had the constant in Aₙ`);
});

test('linear signal + noise → minTV(1) objective ≈ 0 (a straight line) in ≥ 90% of seeds', () => {
    let zero = 0;
    const seeds = 40;
    for (let seed = 1; seed <= seeds; seed++) {
        const { x, y } = simulate('line', 500, 0.25, seed);
        const r = regularize(highs, { x, y, method: 'minTV', k: 1 });
        if (r.objective < 1e-6)
            zero++;
    }
    console.log(`# minTV(1) ≈ 0 on line + noise: ${zero}/${seeds} seeds`);
    assert.ok(zero / seeds >= 0.9);
});

test('unequal spacing: data on a line in x give minTV(1) ≈ 0 and a fit linear in x', () => {
    const rng = createRng(12);
    const n = 300;
    const x = new Float64Array(n);
    for (let i = 1; i < n; i++)
        x[i] = x[i - 1] + 0.01 + 0.2 * rng.uniform() ** 3;
    const y = Float64Array.from(x, v => 2 + 3 * v + 0.1 * rng.normal());
    const r = regularize(highs, { x, y, method: 'minTV', k: 1 });
    assert.ok(r.objective < 1e-6, `TV(g′) = ${r.objective}`);
    const slope = (r.g[n - 1] - r.g[0]) / (x[n - 1] - x[0]);
    for (let i = 0; i < n; i++)
        assert.ok(Math.abs(r.g[i] - (r.g[0] + slope * (x[i] - x[0]))) < 1e-6);
});

test('minSup(2) on sin(4πt), σ = 0.2, n = 500: K_min < 16π² in ≥ 90% of 40 seeds', () => {
    const K = 16 * Math.PI ** 2;
    const values = [];
    for (let seed = 1; seed <= 40; seed++) {
        const { x, y } = simulate('sine', 500, 0.2, seed);
        values.push(regularize(highs, { x, y, method: 'minSup', k: 2 }).objective);
    }
    values.sort((a, b) => a - b);
    const below = values.filter(v => v < K).length;
    console.log(`# K_min: median ${values[20].toFixed(1)}, range ${values[0].toFixed(1)}–${values[39].toFixed(1)}, `
        + `below 16π² in ${below}/40 (paper's draw: 117.7)`);
    assert.ok(below / 40 >= 0.9);
});

test('feasible points bound the optima: minTV(0) ≤ TV(taut string); minSup(2) ≤ ‖f″‖∞ when f ∈ Aₙ', () => {
    for (let seed = 1; seed <= 10; seed++) {
        const { x, y, f } = simulate('sine', 500, 0.2, seed);
        const ts = tautStringRegression(y);
        const tv0 = regularize(highs, { x, y, method: 'minTV', k: 0 });
        assert.ok(tv0.objective <= totalVariation(x, ts.f, 0) * (1 + 1e-7));
        const c = threshold(sigmaMAD(y), TAU, 500);
        if (checkRegion(y, f, multiresolution(500), c).ok) {
            const sup2 = regularize(highs, { x, y, method: 'minSup', k: 2 });
            assert.ok(sup2.objective <= supNorm(x, f, 2) * (1 + 1e-7));
        }
    }
});

test('combined: obeys the taut-string signs, never more extremes, objective ≥ unconstrained minTV(2)', () => {
    for (const [name, n, sigma] of [['blocks', 1024, 1], ['doppler', 1024, 1], ['heavisine', 1024, 1]]) {
        const { x, y } = simulate(name, n, sigma, 3);
        const ts = tautStringRegression(y);
        const signs = stepSigns(ts.f, { plateaus: 'split' });
        const comb = regularize(highs, { x, y, method: 'combined', signs });
        const free = regularize(highs, { x, y, method: 'minTV', k: 2 });
        const scale = Math.max(...y) - Math.min(...y);
        for (let i = 0; i + 1 < n; i++)
            assert.ok(signs[i] * (comb.g[i + 1] - comb.g[i]) >= -1e-6 * scale, `${name}: step ${i}`);
        const kComb = localExtremes(comb.g, 1e-7).extremes.length;
        const kTaut = localExtremes(ts.f).extremes.length;
        assert.ok(kComb <= kTaut, `${name}: ${kComb} > ${kTaut}`);
        assert.ok(comb.objective >= free.objective * (1 - 1e-7));
    }
});

test('combined with fixed extremes takes the taut string value at each extreme', () => {
    const { x, y } = simulate('sine', 500, 0.2, 4);
    const ts = tautStringRegression(y);
    const { extremes } = localExtremes(ts.f);
    const r = regularize(highs, {
        x, y, method: 'combined', signs: stepSigns(ts.f, { plateaus: 'split' }), fixExtremes: extremes,
    });
    assert.equal(r.status, 'optimal');
    for (const e of extremes) {
        const mid = Math.floor((e.start + e.end) / 2);
        assert.ok(Math.abs(r.g[mid] - e.value) < 1e-6, `extreme at ${mid}`);
        for (let i = e.start; i <= e.end; i++)
            assert.ok(e.type === 'max' ? r.g[i] <= e.value + 1e-6 : r.g[i] >= e.value - 1e-6);
    }
});

test('tied x share one fitted value and the fit stays in Aₙ', () => {
    const base = simulate('sine', 200, 0.2, 5);
    const x = Float64Array.from(base.x, (v, i) => (i % 3 === 1 ? base.x[i - 1] : v)); // every 3rd pair tied
    for (const [method, k] of METHODS) {
        const r = regularize(highs, { x, y: base.y, method, k });
        assert.equal(r.status, 'optimal');
        assert.ok(r.region.ok);
        for (let i = 1; i < x.length; i++) {
            if (x[i] === x[i - 1])
                assert.equal(r.g[i], r.g[i - 1]);
        }
    }
});

test('objective units: rescaling x by a scales ‖g″‖∞ by 1/a²; shifting y leaves it unchanged', () => {
    const { x, y } = simulate('sine', 300, 0.2, 6);
    const base = regularize(highs, { x, y, method: 'minSup', k: 2 });
    const xs = x.map(v => 10 * v + 5);
    const scaled = regularize(highs, { x: xs, y, method: 'minSup', k: 2 });
    assert.ok(Math.abs(scaled.objective * 100 / base.objective - 1) < 1e-6);
    const shifted = regularize(highs, { x, y: y.map(v => v + 1000), method: 'minSup', k: 2 });
    assert.ok(Math.abs(shifted.objective / base.objective - 1) < 1e-6);
});
