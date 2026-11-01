// Module Web Worker that owns the HiGHS (WebAssembly) LP solver, keeping solves off the UI thread.
// Started from src/ui/lp.js with `new Worker(url, {type: 'module'})`.
//
// Protocol:
//   {id, lp, options}               → {id, status, objective, names, primal: Float64Array, ms}
//   {id, task: 'regularize', spec}  → {id, ...RegularizeResult}   (see src/core/regularize.js)
//   {id, task: 'exactBounds', spec} → {id, progress} … then {id, status, lb, ub, solves, ms}
//   {id, task: 'calibrate', spec}   → {id, progress} … then {id, sorted: Float64Array}
//                                     spec: {n, lambda, family: 'chosen'|'all', B, seed,
//                                            sigmaEstimator: 'diff'|'gsjs'|'none', x}
//                                     with x given, the family is over intervals of x (ties kept together)
//   failures                        → {id, error}
//
// highs.mjs locates highs.wasm next to itself via import.meta.url, so no locateFile is needed.

import loadHighs from '../vendor/highs/highs.mjs';
import { solveLP } from './core/lp-solve.js';
import { regularize } from './core/regularize.js';
import { exactBounds } from './core/exact.js';
import { simulateMaxStatistics, sigmaPlugIn } from './core/calibrate.js';
import { multiresolution, allIntervals, xIntervalFamily, allXIntervals } from './core/intervals.js';

const PROGRESS_INTERVAL = 100; // ms between progress messages

function progressReporter(id) {
    let last = 0;
    return fraction => {
        const now = performance.now();
        if (now - last >= PROGRESS_INTERVAL) {
            last = now;
            self.postMessage({ id, progress: fraction });
        }
    };
}

let highsPromise = null;

function getHighs() {
    if (!highsPromise)
        highsPromise = loadHighs();
    return highsPromise;
}

self.addEventListener('message', async event => {
    const { id, task, lp, options, spec } = event.data;
    try {
        const highs = task === 'calibrate' ? null : await getHighs();
        if (task === 'regularize') {
            const result = regularize(highs, spec);
            self.postMessage({ id, ...result }, result.g ? [result.g.buffer] : []);
        }
        else if (task === 'exactBounds') {
            const result = exactBounds(highs, spec, progressReporter(id));
            self.postMessage({ id, ...result }, result.lb ? [result.lb.buffer, result.ub.buffer] : []);
        }
        else if (task === 'calibrate') {
            let intervals;
            if (spec.family === 'all')
                intervals = spec.x ? allXIntervals(spec.x) : allIntervals(spec.n);
            else
                intervals = spec.x ? xIntervalFamily(spec.x, spec.lambda) : multiresolution(spec.n, spec.lambda);
            const sorted = simulateMaxStatistics(spec.n, intervals,
                { B: spec.B, seed: spec.seed, plugSigma: sigmaPlugIn(spec.sigmaEstimator, spec.x),
                    onProgress: progressReporter(id) });
            self.postMessage({ id, sorted }, [sorted.buffer]);
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
