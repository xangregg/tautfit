// App entry point. M0: confirm the import map resolves d3 and the LP worker solves a smoke-test LP.

import * as d3 from 'd3';
import { smokeLP } from '../core/lp-build.js';
import { primalByName } from '../core/lp-solve.js';
import { solveLP } from './lp.js';

async function startup() {
    const status = d3.select('#status');
    const { lp, expected } = smokeLP();
    try {
        const sol = await solveLP(lp);
        const byName = primalByName(sol);
        const ok = sol.status === 'Optimal' && Math.abs(sol.objective - expected.objective) < 1e-9;
        status
            .classed('error', !ok)
            .text(`d3 loaded · HiGHS smoke LP: ${sol.status}, objective ${sol.objective}, `
                + `x = ${byName.get('x')}, y = ${byName.get('y')} (${sol.ms.toFixed(1)} ms)`);
        if (!ok)
            console.error('Smoke LP returned an unexpected result', sol);
    }
    catch (err) {
        status.classed('error', true).text(`LP worker failed: ${err.message}`);
        console.error(err);
    }
}

startup();
