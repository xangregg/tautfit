// Write the simulated inputs for the ftnonpar pmreg fixtures (see tools/pmreg-fixtures.R) as JSON on
// stdout. σ̂ is computed here so both implementations use exactly the same σ.
//
// Usage: node tools/pmreg-inputs.mjs > inputs.json

import { simulate } from '../src/core/signals.js';
import { sigmaMAD } from '../src/core/sigma.js';

const CASES = [
    // [signal, n, σ, seed]
    ['blocks', 1024, 1, 1],
    ['blocks', 2048, 1, 2],
    ['bumps', 1024, 1, 3],
    ['heavisine', 1024, 1, 4],
    ['doppler', 1024, 1, 5],
    ['doppler', 4096, 1, 6],
    ['sine', 500, 0.2, 7],
    ['exp5', 1000, 5, 8],
    ['noise', 500, 1, 9],
    ['box', 2000, 0.25, 10],
];

const out = CASES.map(([signal, n, sigma, seed]) => {
    const { y } = simulate(signal, n, sigma, seed);
    return { signal, n, sigma, seed, tau: 3, sigmaHat: sigmaMAD(y), y: Array.from(y) };
});
process.stdout.write(JSON.stringify(out));
