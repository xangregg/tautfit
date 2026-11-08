import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentence } from '../src/ui/format.js';

test('sentence: capitalizes a leading Latin letter and adds a period, but leaves a leading symbol as it is', () => {
    assert.equal(sentence('the fit stays inside'), 'The fit stays inside.');
    assert.equal(sentence('Already a sentence.'), 'Already a sentence.');
    assert.equal(sentence('is it?'), 'Is it?');
    // Regression: the readouts' tips read 'Λ = 2, singletons included' and 'Τ = 3; measured 95.4–96.1% …'.
    assert.equal(sentence('λ = 2, singletons included'), 'λ = 2, singletons included.');
    assert.equal(sentence('τ = 3; measured 95.4–96.1% at n = 500'), 'τ = 3; measured 95.4–96.1% at n = 500.');
    assert.equal(sentence('σ̂ (eq. 10)'), 'σ̂ (eq. 10).');
    assert.equal(sentence('2n LPs'), '2n LPs.');
});
