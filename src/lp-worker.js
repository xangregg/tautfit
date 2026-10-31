// Module Web Worker that owns the HiGHS (WebAssembly) LP solver, keeping solves off the UI thread.
// Started from src/ui/lp.js with `new Worker(url, {type: 'module'})`.
//
// Protocol:  postMessage({id, lp, options})
//         →  {id, status, objective, names, primal: Float64Array, ms}   or   {id, error}
//
// highs.mjs locates highs.wasm next to itself via import.meta.url, so no locateFile is needed.

import loadHighs from '../vendor/highs/highs.mjs';
import { solveLP } from './core/lp-solve.js';

let highsPromise = null;

function getHighs() {
    if (!highsPromise)
        highsPromise = loadHighs();
    return highsPromise;
}

self.addEventListener('message', async event => {
    const { id, lp, options } = event.data;
    try {
        const highs = await getHighs();
        const result = solveLP(highs, lp, options);
        self.postMessage({ id, ...result }, [result.primal.buffer]);
    }
    catch (err) {
        // A failed solve can leave the Wasm heap in a bad state; start fresh next time.
        highsPromise = null;
        self.postMessage({ id, error: String(err?.message ?? err) });
    }
});
