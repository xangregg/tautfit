// Promise API over the LP worker (src/lp-worker.js). One worker, requests matched by id.

const WORKER_URL = new URL('../lp-worker.js', import.meta.url);

let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
    if (worker)
        return worker;
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.addEventListener('message', event => {
        const { id, error, progress, ...result } = event.data;
        const entry = pending.get(id);
        if (!entry)
            return;
        if (progress !== undefined) {
            entry.onProgress?.(progress);
            return;
        }
        pending.delete(id);
        if (error)
            entry.reject(new Error(error));
        else
            entry.resolve(result);
    });
    worker.addEventListener('error', event => {
        // Worker failed to load or threw outside a message handler: fail everything in flight.
        const err = new Error(`LP worker error: ${event.message ?? 'failed to load'}`);
        for (const entry of pending.values())
            entry.reject(err);
        pending.clear();
        worker = null;
    });
    return worker;
}

function request(message, onProgress) {
    const w = getWorker();
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onProgress });
        w.postMessage({ id, ...message });
    });
}

/**
 * Exact LP bounds (src/core/exact.js) in the worker.
 *
 * @param {object} spec  exactBounds spec without the HiGHS instance
 * @param {function(number): void} [onProgress]  completed fraction
 * @returns {Promise<{status: string, lb: Float64Array|null, ub: Float64Array|null, solves: number, ms: number}>}
 */
export function exactBoundsInWorker(spec, onProgress) {
    return request({ task: 'exactBounds', spec }, onProgress);
}

/**
 * Smallest τ admitting a shape (src/core/shapetest.js) in the worker.
 *
 * @param {object} spec  shapeThreshold spec without the HiGHS instance
 * @returns {Promise<import('../core/shapetest.js').ShapeThreshold>}
 */
export function shapeThresholdInWorker(spec) {
    return request({ task: 'shapeThreshold', spec });
}

/**
 * Monte Carlo sample of the multiscale statistic (src/core/calibrate.js) in the worker.
 *
 * @param {{n: number, lambda: number, family: 'chosen'|'all', B: number, seed: number,
 *     sigmaEstimator: 'diff'|'gsjs'|'none', x?: Float64Array}} spec
 * @param {function(number): void} [onProgress]
 * @returns {Promise<{sorted: Float64Array}>}
 */
export function calibrateInWorker(spec, onProgress) {
    return request({ task: 'calibrate', spec }, onProgress);
}

/**
 * Run a smoothness regularization (src/core/regularize.js) in the worker.
 *
 * @param {import('../core/regularize.js').RegularizeSpec} spec  without the HiGHS instance
 * @returns {Promise<import('../core/regularize.js').RegularizeResult>}
 */
export function regularizeInWorker(spec) {
    return request({ task: 'regularize', spec });
}

/**
 * Solve an LP in the worker.
 *
 * @param {string} lp          problem in CPLEX LP format
 * @param {object} [options]   HiGHS options
 * @returns {Promise<{status: string, objective: number, names: string[], primal: Float64Array, ms: number}>}
 */
export function solveLP(lp, options = {}) {
    return request({ lp, options });
}
