// Module Web Worker that owns the HiGHS (WebAssembly) LP solver, keeping solves off the UI thread.
// Started from src/ui/lp.js with `new Worker(url, {type: 'module'})`.
//
// Protocol:
//   {id, lp, options}               → {id, status, objective, names, primal: Float64Array, ms}
//   {id, task: 'regularize', spec}  → {id, ...RegularizeResult}   (see src/core/regularize.js)
//   failures                        → {id, error}
//
// highs.mjs locates highs.wasm next to itself via import.meta.url, so no locateFile is needed.

import loadHighs from '../vendor/highs/highs.mjs';
import { solveLP } from './core/lp-solve.js';
import { regularize } from './core/regularize.js';

let highsPromise = null;

function getHighs() {
    if (!highsPromise)
        highsPromise = loadHighs();
    return highsPromise;
}

self.addEventListener('message', async event => {
    const { id, task, lp, options, spec } = event.data;
    try {
        const highs = await getHighs();
        if (task === 'regularize') {
            const result = regularize(highs, spec);
            self.postMessage({ id, ...result }, result.g ? [result.g.buffer] : []);
        }
        else {
            const result = solveLP(highs, lp, options);
            self.postMessage({ id, ...result }, [result.primal.buffer]);
        }
    }
    catch (err) {
        // A failed solve can leave the Wasm heap in a bad state (e.g. an LP parse error aborts it);
        // start fresh next time.
        highsPromise = null;
        self.postMessage({ id, error: String(err?.message ?? err) });
    }
});
