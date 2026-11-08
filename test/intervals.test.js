import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    multiresolutionLevels, multiresolution, allIntervals, xIntervalLevels, xIntervalFamily, allXIntervals, intervalSpan,
} from '../src/core/intervals.js';

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

// Uneven x with ties (from lafspline's tests): dense near 0, sparse toward 10.
const UNEVEN = Float64Array.from([0, 0.01, 0.02, 0.02, 0.05, 0.3, 0.31, 1, 2, 2, 4, 7, 7.5, 10]);

test('an interval spans midway to its neighbors (clipped to the range)', () => {
    const tol = 1e-12; // units of x
    assert.ok(Math.abs(intervalSpan(UNEVEN, { lo: 0, hi: 0 }) - 0.005) < tol);
    assert.ok(Math.abs(intervalSpan(UNEVEN, { lo: 10, hi: 10 }) - (5.5 - 3)) < tol); // x = 4, between 2 and 7
    assert.ok(Math.abs(intervalSpan(UNEVEN, { lo: 8, hi: 9 }) - (3 - 1.5)) < tol); // the tied pair at 2
    assert.ok(Math.abs(intervalSpan(UNEVEN, { lo: 13, hi: 13 }) - (10 - 8.75)) < tol);
    assert.equal(intervalSpan(UNEVEN, { lo: 0, hi: 13 }), 10);
});

test('share 0 is the paper\'s family, unchanged', () => {
    const x = Float64Array.from({ length: 37 }, (_, i) => i * i);
    assert.deepEqual(xIntervalFamily(x, 2, 0), xIntervalFamily(x, 2));
    assert.deepEqual(xIntervalLevels(x, 1.5, 0), xIntervalLevels(x, 1.5));
    assert.deepEqual(allXIntervals(UNEVEN, 0), allXIntervals(UNEVEN));
});

test('with a shortest span blocks long enough stay, runs of short blocks merge, and every part spans enough', () => {
    const full = xIntervalLevels(UNEVEN, 2);
    for (const share of [0.05, 0.2, 0.5, 1]) {
        const shortest = share * 10;
        const levels = xIntervalLevels(UNEVEN, 2, share);
        assert.equal(levels.length, full.length, 'level numbers stay array indices');
        for (const [k, level] of levels.entries()) {
            for (const iv of level) {
                assert.equal(iv.level, k);
                assert.ok(intervalSpan(UNEVEN, iv) >= shortest * (1 - 1e-9) || level.length === 1);
                assert.ok(iv.lo === 0 || UNEVEN[iv.lo] !== UNEVEN[iv.lo - 1], 'ties are never split');
                assert.ok(iv.hi === 13 || UNEVEN[iv.hi] !== UNEVEN[iv.hi + 1], 'ties are never split');
            }
            // every observation is in some part, and a block long enough is a part as it was
            for (let i = 0; i < UNEVEN.length; i++)
                assert.ok(level.some(iv => iv.lo <= i && i <= iv.hi));
            for (const iv of full[k]) {
                if (intervalSpan(UNEVEN, iv) >= shortest)
                    assert.ok(level.some(w => w.lo === iv.lo && w.hi === iv.hi));
            }
            // a part not widened is a run of whole blocks
            for (const iv of level.filter(w => !w.widened)) {
                assert.ok(full[k].some(b => b.lo === iv.lo), `${share} level ${k}: starts at a block`);
                assert.ok(full[k].some(b => b.hi === iv.hi), `${share} level ${k}: ends at a block`);
            }
        }
    }
    // an even design: every singleton is short, so the finest level becomes about 1/share parts, a partition
    const even = Float64Array.from({ length: 100 }, (_, i) => i);
    const finest = xIntervalLevels(even, 2, 0.05)[0];
    assert.ok(finest.length >= 15 && finest.length <= 20, `${finest.length} parts`);
    let next = 0;
    for (const iv of finest) {
        assert.equal(iv.lo, next);
        next = iv.hi + 1;
    }
    assert.equal(next, 100);
    // 60 distinct intervals, against 199 with every block (lafspline's count for the same design)
    assert.equal(xIntervalFamily(even, 2, 0.05).length, 60);
    assert.equal(xIntervalFamily(even, 2).length, 199);
});

test('with a shortest span all intervals are widened to it, ties kept together, duplicates removed', () => {
    const full = allXIntervals(UNEVEN);
    for (const share of [0.05, 0.2, 0.5, 1]) {
        const out = allXIntervals(UNEVEN, share);
        assert.equal(new Set(out.map(iv => `${iv.lo},${iv.hi}`)).size, out.length);
        for (const iv of out) {
            assert.ok(intervalSpan(UNEVEN, iv) >= share * 10 * (1 - 1e-9) || (iv.lo === 0 && iv.hi === 13));
            assert.ok(iv.lo === 0 || UNEVEN[iv.lo] !== UNEVEN[iv.lo - 1], 'ties are never split');
            assert.ok(iv.hi === 13 || UNEVEN[iv.hi] !== UNEVEN[iv.hi + 1], 'ties are never split');
        }
        // exactly the x-intervals spanning at least the share
        const long = full.filter(iv => intervalSpan(UNEVEN, iv) >= share * 10 * (1 - 1e-9));
        assert.equal(out.length, long.length);
    }
    assert.equal(allXIntervals(UNEVEN, 1).length, 1);
    // where x is sparse a widened block holds fewer observations than where it is dense
    const finest = xIntervalLevels(UNEVEN, 2, 0.2)[0];
    const count = iv => iv.hi - iv.lo + 1;
    assert.ok(count(finest[0]) > count(finest.at(-1)), finest.map(count).join(','));
});
