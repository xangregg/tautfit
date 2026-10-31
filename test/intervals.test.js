import { test } from 'node:test';
import assert from 'node:assert/strict';
import { multiresolutionLevels, multiresolution, allIntervals } from '../src/core/intervals.js';

const SIZES = [1, 2, 3, 7, 8, 9, 100, 500, 1000, 1023, 1024, 1025];

test('each level of multiresolution(n, λ) partitions 0..n−1', () => {
    for (const lambda of [2, 1.5, 3]) {
        for (const n of SIZES) {
            const levels = multiresolutionLevels(n, lambda);
            for (const level of levels) {
                let next = 0;
                for (const { lo, hi } of level) {
                    assert.equal(lo, next, `n=${n} λ=${lambda}: gap or overlap at ${lo}`);
                    assert.ok(hi >= lo);
                    next = hi + 1;
                }
                assert.equal(next, n, `n=${n} λ=${lambda}: level does not reach n`);
            }
            // top level is the whole range
            const top = levels[levels.length - 1];
            assert.deepEqual([top[0].lo, top[0].hi, top.length], [0, n - 1, 1]);
        }
    }
});

test('multiresolution contains every singleton, has no duplicates, and is O(n)', () => {
    for (const n of SIZES) {
        const fam = multiresolution(n, 2);
        const keys = new Set(fam.map(iv => `${iv.lo},${iv.hi}`));
        assert.equal(keys.size, fam.length, 'duplicates');
        for (let i = 0; i < n; i++)
            assert.ok(keys.has(`${i},${i}`), `missing singleton ${i}`);
        assert.ok(fam.length <= 2 * n + Math.log2(n) + 1, `n=${n}: ${fam.length} intervals`);
    }
});

test('dyadic blocks for n = 8 are exactly the expected intervals', () => {
    const fam = multiresolution(8, 2).map(iv => [iv.lo, iv.hi, iv.level]);
    assert.deepEqual(fam, [
        [0, 0, 0], [1, 1, 0], [2, 2, 0], [3, 3, 0], [4, 4, 0], [5, 5, 0], [6, 6, 0], [7, 7, 0],
        [0, 1, 1], [2, 3, 1], [4, 5, 1], [6, 7, 1],
        [0, 3, 2], [4, 7, 2],
        [0, 7, 3],
    ]);
});

test('allIntervals(n) has n(n+1)/2 distinct intervals', () => {
    const fam = allIntervals(20);
    assert.equal(fam.length, 210);
    assert.equal(new Set(fam.map(iv => `${iv.lo},${iv.hi}`)).size, 210);
});

test('λ ≤ 1 is rejected', () => {
    assert.throws(() => multiresolution(10, 1), RangeError);
});
