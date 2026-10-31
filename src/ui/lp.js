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
        const { id, error, ...result } = event.data;
        const entry = pending.get(id);
        if (!entry)
            return;
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

function request(message) {
    const w = getWorker();
    const id = nextId++;
    return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        w.postMessage({ id, ...message });
    });
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
