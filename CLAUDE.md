# CLAUDE.md

## Project

**tautfit**: a browser app (served from GitHub Pages) implementing the nonparametric regression methods of
Davies, Kovac & Meise (2009), "Nonparametric regression, confidence regions and regularization",
Annals of Statistics 37(5B):2597–2625 (arXiv:0711.0690). The central object is the multiresolution
confidence region Aₙ; fits are the *simplest* functions inside it (fewest local extremes, minimal
total variation of a derivative, etc.), plus honest confidence bands under shape/smoothness assumptions.

The full spec, formulas and milestones are in **PLAN.md**. Read it before starting a milestone, and tick
its checkboxes as work is completed.

## Hard rules

- **No bundler, no build step.** Plain ES modules served as static files. Do not add Vite, webpack,
  esbuild, TypeScript, Babel or Jest. Ask before adding any dependency.
- **Every relative import uses an explicit `.js` extension** (required by both browsers and Node ESM).
- **`src/core/` is pure**: no DOM, no `window`, no bare-specifier imports (`'d3'`), no network. It must
  run unchanged in Node for tests and in the browser.
- Bare imports (`d3`) are allowed only in `src/ui/`, resolved by the import map in `index.html`
  (jsDelivr ESM URLs, pinned versions).
- HiGHS (LP solver, WebAssembly) is vendored in `vendor/highs/` (ES-module build `highs.mjs` + `highs.wasm`)
  and used in the browser only through the module worker `src/lp-worker.js`. Node tests load it from the
  dev dependency `highs`.
- Do not add Claude attribution to commit messages

## Layout

```
index.html              import map, layout, loads src/ui/main.js as a module
styles.css
src/core/               pure algorithms (see PLAN.md for the module list)
src/ui/                 D3 charts, controls, state
src/lp-worker.js        module Web Worker wrapping HiGHS (see PLAN.md §LP worker)
vendor/highs/           highs.mjs + highs.wasm copied from node_modules/highs/build/
tools/check-page.mjs    headless-Chrome page check (console errors, worker exceptions, screenshot)
test/*.test.js          node:test + node:assert/strict
test/fixtures/          reference outputs (e.g. from R ftnonpar), JSON
package.json            "type": "module", scripts below
```

## Commands

- Tests: `npm test` (runs `node --test`). Node 20+.
- Serve locally: `python3 -m http.server 8000` then open http://localhost:8000/
  (WebStorm's built-in server also works; if .wasm loading complains about MIME type, use the python server).
- Refresh vendored HiGHS: `npm run vendor:highs`.
- Page check (server must be running): `npm run check:page -- http://localhost:8000/ --until '<js expr>'
  --eval '<js expr>' --screenshot out.png`. Exits 1 on any console error, exception, or failed load.
- UI regression checks (server on port 8000): `npm run check:ui` (runs `tools/ui-checks.js` in the page).

## Conventions

- Plain JS with JSDoc type annotations on every exported function (parameters, return, units).
- Numeric arrays are `Float64Array`. Code indices are **0-based**; the paper is 1-based. When implementing
  a formula from the paper, put the paper's equation number in a comment and state the index conversion.
- Natural log everywhere (`Math.log`), matching the paper's `log n`.
- Randomness only through `src/core/rng.js` (seeded). Tests must be deterministic.
- Each core module gets a test file. Numerical tests state their tolerance explicitly.
- Prefer clarity over micro-optimization, but keep everything O(n log n) or better where PLAN.md says so;
  O(n²) reference implementations live alongside and are used by tests.
- When the paper and PLAN.md disagree, PLAN.md's "Known issues in the paper" section explains why;
  follow PLAN.md and flag anything new you find rather than silently "fixing" the math.

## Working style

- Work one milestone at a time. At the end of each, run the tests, make sure the page loads without
  console errors, summarize what changed, and stop for review.
- Don't refactor unrelated code. Don't reformat files you didn't otherwise change.
- For new code, use a separate line for flow of control statements like return, break and continue as well as for the bodies of compound statements like if and for.
