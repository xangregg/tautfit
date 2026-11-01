import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stateToHash, hashToState, packText, unpackText } from '../src/ui/urlstate.js';

// Mirrors the initial state in src/ui/main.js.
const DEFAULTS = {
    source: 'blocks', n: 1024, sigma: 1, seed: 1, showTruth: true, userText: '', xCol: null, yCol: null,
    tau: 3, lambda: 2, sigmaFixed: null, sigmaMethod: 'diff', method: 'taut', overlays: [], fixExtremes: false, fitShape: 'none',
    band: 'none', theta: 1.5, kMultiple: 2, tauMode: 'fixed', alpha: 0.95, calibFamily: 'chosen', plugSigma: true,
    exact: false, boxes: 'hover',
};

test('defaults give an empty hash and an empty hash gives the defaults', async () => {
    assert.deepEqual(await stateToHash(DEFAULTS, DEFAULTS), { hash: '', dataOmitted: 0 });
    const { state, rejected } = await hashToState('', DEFAULTS);
    assert.deepEqual(state, DEFAULTS);
    assert.deepEqual(rejected, []);
});

test('changed settings round-trip and only they are written', async () => {
    const st = {
        ...DEFAULTS, source: 'exp5', n: 300, sigma: 5, seed: 42, method: 'minTV2', overlays: ['taut', 'minTV1'],
        band: 'convex', exact: true, sigmaFixed: 2.5, tauMode: 'calibrated', alpha: 0.9, boxes: 'level:3',
    };
    const { hash } = await stateToHash(st, DEFAULTS);
    // σ = 5 is exp5's own default, so it is not written
    assert.equal(hash, '#source=exp5&n=300&seed=42&sigmaFixed=2.5&method=minTV2&overlays=taut%2CminTV1'
        + '&band=convex&tauMode=calibrated&alpha=0.9&exact=1&boxes=level%3A3');
    const back = await hashToState(hash, DEFAULTS);
    assert.deepEqual(back.state, st);
    assert.deepEqual(back.rejected, []);
});

test('choosing a signal brings its own n and σ', async () => {
    const { state } = await hashToState('#source=exp5', DEFAULTS);
    assert.equal(state.n, 1000);
    assert.equal(state.sigma, 5);
});

test('invalid and unknown values are ignored and reported', async () => {
    const { state, rejected } = await hashToState(
        '#source=nope&n=1&tau=-3&method=bogus&overlays=taut,bogus,minTV2&band=convex&alpha=2&boxes=<x>&zzz=1&sigmaFixed=0',
        DEFAULTS);
    assert.equal(state.source, 'blocks');
    assert.equal(state.n, 1024);
    assert.equal(state.tau, 3);
    assert.equal(state.method, 'taut');
    assert.deepEqual(state.overlays, ['taut', 'minTV2']);
    assert.equal(state.band, 'convex');
    assert.equal(state.alpha, 0.95);
    assert.equal(state.boxes, 'hover');
    assert.equal(state.sigmaFixed, null);
    assert.deepEqual(rejected.sort(), ['alpha', 'boxes', 'method', 'n', 'sigmaFixed', 'source', 'tau', 'zzz']);
});

test('pasted data round-trips compressed; simulated-only keys are not written for user data', async () => {
    const text = 'age,correct\n' + Array.from({ length: 100 }, (_, i) => `${17 + (i % 30)},${(i * 7) % 13}`).join('\n');
    const st = { ...DEFAULTS, source: 'user', userText: text, xCol: 0, yCol: 1, seed: 9 };
    const { hash, dataOmitted } = await stateToHash(st, DEFAULTS);
    assert.equal(dataOmitted, 0);
    assert.ok(!hash.includes('seed='));
    assert.ok(hash.length < text.length, `compressed hash ${hash.length} vs text ${text.length}`);
    const back = await hashToState(hash, DEFAULTS);
    assert.equal(back.state.userText, text);
    assert.equal(back.state.xCol, 0);
    assert.equal(back.state.yCol, 1);
});

test('data too long for a link is left out and reported', async () => {
    let seed = 1;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const text = Array.from({ length: 4000 }, () => `${rand()},${rand()}`).join('\n');
    const { hash, dataOmitted } = await stateToHash({ ...DEFAULTS, source: 'user', userText: text }, DEFAULTS);
    assert.equal(dataOmitted, text.length);
    assert.ok(!hash.includes('data='));
});

test('packText/unpackText round-trip Unicode; malformed data is rejected', async () => {
    const s = 'x,y\n1,σ̂ = 3.145 → Aₙ\n';
    assert.equal(await unpackText(await packText(s)), s);
    const { rejected } = await hashToState('#source=user&data=!!notbase64', DEFAULTS);
    assert.deepEqual(rejected, ['data']);
});
