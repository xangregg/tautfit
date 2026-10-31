import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, sigmaMAD } from '../src/core/sigma.js';
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
