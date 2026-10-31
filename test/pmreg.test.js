// Compare with ftnonpar's pmreg (Davies & Kovac's own C taut string) run with the paper's settings.
// pmreg uses the paper's raw initial tube width, so we compare with initialWidth: 'raw'; the app's
// default ('centered', shift-invariant) differs only in that starting width.
// The fixture is generated outside the test suite (tools/pmreg-fixtures.R needs R and the archived
// ftnonpar sources); without it these tests are skipped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tautStringRegression } from '../src/core/tautstring.js';
import { localExtremes } from '../src/core/extremes.js';

const FIXTURE = new URL('./fixtures/pmreg.json', import.meta.url);
const REL_TOL = 1e-6; // max |f − f_pmreg| relative to the range of y
const fixture = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null;
const skip = fixture ? false : 'test/fixtures/pmreg.json not present (see tools/pmreg-fixtures.R)';

for (const c of fixture?.cases ?? [{ signal: 'pmreg fixture', n: 0 }]) {
    test(`matches pmreg: ${c.signal} n = ${c.n}`, { skip }, () => {
        const y = Float64Array.from(c.y);
        const fit = tautStringRegression(y, { sigma: c.sigmaHat, tau: c.tau, initialWidth: 'raw' });
        const ref = Float64Array.from(c.pmreg.f);
        let range = 0;
        let maxDiff = 0;
        for (let i = 0; i < y.length; i++) {
            range = Math.max(range, Math.abs(y[i] - y[0]));
            maxDiff = Math.max(maxDiff, Math.abs(fit.f[i] - ref[i]));
        }
        const ours = localExtremes(fit.f);
        const theirs = localExtremes(ref);
        console.log(`# ${c.signal} n=${c.n}: max |Δf| ${maxDiff.toExponential(2)}, iterations ${fit.iterations} vs `
            + `${c.pmreg.iterations}, extremes ${ours.extremes.length} vs ${theirs.extremes.length} (pmreg nmax ${c.pmreg.nmax})`);
        assert.ok(maxDiff <= REL_TOL * range, `max |Δf| = ${maxDiff}`);
        assert.equal(fit.iterations, c.pmreg.iterations);
        assert.equal(ours.extremes.length, theirs.extremes.length);
    });
}
