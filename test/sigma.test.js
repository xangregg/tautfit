import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, sigmaMAD, sigmaGSJS } from '../src/core/sigma.js';
import { normals, createRng } from '../src/core/rng.js';
import { simulate } from '../src/core/signals.js';

test('median of odd and even arrays, input unchanged', () => {
    const v = [5, 1, 3];
    assert.equal(median(v), 3);
    assert.deepEqual(v, [5, 1, 3]);
    assert.equal(median([4, 1, 3, 2]), 2.5);
});

// At n = 10⁴ the relative sd of σ̂ is ≈ 1.4% (measured), so a single draw lands within 3% only ≈ 97%
// of the time. Check the bias on the average and the 3% band on most seeds.
test('σ̂ ≈ σ on pure noise, n = 10⁴: mean over 50 seeds within 0.5%, ≥ 90% of seeds within 3%', () => {
    const sigma = 2.5;
    const seeds = 50;
    let sumRel = 0;
    let within = 0;
    for (let seed = 1; seed <= seeds; seed++) {
        const y = normals(10000, createRng(seed)).map(z => sigma * z);
        const rel = sigmaMAD(y) / sigma - 1;
        sumRel += rel;
        if (Math.abs(rel) < 0.03)
            within++;
    }
    assert.ok(Math.abs(sumRel / seeds) < 0.005, `mean relative error ${sumRel / seeds}`);
    assert.ok(within / seeds >= 0.9, `${within}/${seeds} within 3%`);
});

test('σ̂ is unaffected by adding a constant and scales with y', () => {
    const y = normals(1000, createRng(5));
    const base = sigmaMAD(y);
    assert.ok(Math.abs(sigmaMAD(y.map(v => v + 100)) - base) < 1e-9);
    assert.ok(Math.abs(sigmaMAD(y.map(v => 3 * v)) - 3 * base) < 1e-12);
});

test('σ̂ is only mildly biased upward by a smooth signal (sin(4πt), σ = 0.2, n = 500)', () => {
    const { y } = simulate('sine', 500, 0.2, 11);
    const est = sigmaMAD(y);
    assert.ok(est > 0.17 && est < 0.25, `σ̂ = ${est}`);
});

test('σ̂ rejects n < 2', () => {
    assert.throws(() => sigmaMAD([1]), RangeError);
});

function unevenX(n, rng) {
    const x = new Float64Array(n);
    for (let i = 1; i < n; i++)
        x[i] = x[i - 1] + 0.1 + 3 * rng.uniform() ** 2;
    return x;
}

test('GSJS σ̂ ≈ σ on pure noise, equal and unequal spacing (mean of 50 seeds within 1.5%)', () => {
    for (const uneven of [false, true]) {
        let sum = 0;
        for (let seed = 1; seed <= 50; seed++) {
            const rng = createRng(seed);
            const x = uneven ? unevenX(2000, rng) : Float64Array.from({ length: 2000 }, (_, i) => i);
            const y = normals(2000, rng).map(v => 0.7 * v);
            sum += sigmaGSJS(x, y) / 0.7;
        }
        assert.ok(Math.abs(sum / 50 - 1) < 0.015, `uneven ${uneven}: mean ratio ${sum / 50}`);
    }
});

test('GSJS σ̂ is unchanged by adding any linear trend a + b·x (tol 1e-9), at unequal spacing', () => {
    const rng = createRng(4);
    const x = unevenX(300, rng);
    const y = normals(300, rng);
    const base = sigmaGSJS(x, y);
    const trended = y.map((v, i) => v + 5 - 40 * x[i]);
    assert.ok(Math.abs(sigmaGSJS(x, trended) - base) < 1e-9 * Math.max(1, base));
    assert.ok(Math.abs(sigmaGSJS(x, y.map(v => 3 * v)) - 3 * base) < 1e-12);
});

test('a steep smooth trend inflates eq. (10) but not GSJS', () => {
    const rng = createRng(6);
    const x = unevenX(200, rng);
    const y = Float64Array.from(x, v => 2 * v + 0.05 * v * v + 0.5 * rng.normal());
    assert.ok(sigmaMAD(y) > 2, `eq. 10 gave ${sigmaMAD(y)}`);
    const g = sigmaGSJS(x, y);
    assert.ok(g > 0.35 && g < 0.7, `GSJS gave ${g}`);
});

test('GSJS skips triples with x_{i−1} = x_{i+1} and needs a usable triple', () => {
    assert.ok(Number.isFinite(sigmaGSJS([0, 0, 0, 1, 2], [1, 2, 3, 4, 6])));
    assert.throws(() => sigmaGSJS([1, 2], [1, 2]), RangeError);
    assert.throws(() => sigmaGSJS([1, 1, 1], [1, 2, 3]), RangeError);
});

