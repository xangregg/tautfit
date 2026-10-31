// App entry point: state → derived model → views.
//
// The data, σ̂, Aₙ and the taut string are computed synchronously (milliseconds). LP fits are solved
// in the worker and cached by data and settings; while the primary fit is being solved the previous
// render stays up, dimmed. The primary fit drives the residual view and readouts; overlays are drawn
// for comparison only.

import * as d3 from 'd3';
import { SIGNALS, simulate } from '../core/signals.js';
import { parseTable, prepareXY, rowIndex } from '../core/data.js';
import { sigmaMAD } from '../core/sigma.js';
import { multiresolution, multiresolutionLevels } from '../core/intervals.js';
import { threshold, checkRegion } from '../core/region.js';
import { tautStringRegression } from '../core/tautstring.js';
import { localExtremes, stepSigns } from '../core/extremes.js';
import { createControls } from './controls.js';
import { createMainChart } from './chart.js';
import { createResidualView } from './residual.js';
import { cellEdges } from './layout.js';
import { onThemeChange } from './theme.js';
import { regularizeInWorker } from './lp.js';
import { METHODS } from './methods.js';
import { BANDS } from './bands.js';
import {
    monotoneBounds, piecewiseMonotoneBounds, convexBounds, piecewiseConvexBounds, curvatureSegments,
    smoothnessBounds, smoothnessKMin, crossings,
} from '../core/bounds.js';

const fmt = d3.format('.4~g');
const fmtInt = d3.format(',');
const CACHE_LIMIT = 48; // LP fits kept
const LP_REGION_TOL = 1e-6; // relative slack for LP solutions on the boundary of Aₙ (matches core re-check)

const state = {
    source: 'blocks',
    n: SIGNALS.blocks.n,
    sigma: SIGNALS.blocks.sigma,
    seed: 1,
    showTruth: true,
    userText: '',
    xCol: null, // column index, −1 = row number, null = auto (first column if there are ≥ 2)
    yCol: null, // column index, null = auto (second column if there are ≥ 2, else the only one)
    tau: 3,
    lambda: 2,
    sigmaFixed: null, // number to override σ̂
    method: 'taut', // key of METHODS
    overlays: [], // keys of METHODS drawn in addition to the primary fit
    fixExtremes: false, // combined: pin extremes to the taut string's values
    band: 'none', // key of BANDS
    theta: 1.5, // window grid ratio for the fast bounds
    kMultiple: 2, // smoothness band: K = kMultiple × K_min (fast)
};

let tableCache = { text: null, table: null };

function getTable(text) {
    if (tableCache.text !== text)
        tableCache = { text, table: parseTable(text) };
    return tableCache.table;
}

// FNV-1a, to key pasted data without keeping the text in every cache key.
function hashText(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++)
        h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    return `${text.length}:${h.toString(16)}`;
}

/**
 * Everything that does not need the LP solver. Returns {error} when there is nothing to show.
 */
function deriveBase(st) {
    let x;
    let y;
    let f = null;
    let columns = [];
    let dataKey;
    let equallySpaced;
    const notes = [];
    if (st.source === 'user') {
        const table = getTable(st.userText);
        columns = table.names;
        if (table.columns.length === 0)
            return { error: 'Paste or drop data with at least one numeric column.', columns };
        const two = columns.length >= 2;
        const xCol = st.xCol !== null && st.xCol < columns.length ? st.xCol : (two ? 0 : -1);
        const yCol = st.yCol !== null && st.yCol < columns.length ? st.yCol : (two ? 1 : 0);
        st.xCol = xCol;
        st.yCol = yCol;
        const xRaw = xCol < 0 ? rowIndex(table.rows) : table.columns[xCol];
        const d = prepareXY(xRaw, table.columns[yCol]);
        x = d.x;
        y = d.y;
        dataKey = `user|${hashText(st.userText)}|${xCol}|${yCol}`;
        equallySpaced = d.equallySpaced;
        if (d.dropped)
            notes.push(`${fmtInt(d.dropped)} incomplete row(s) dropped`);
        if (d.ties)
            notes.push(`${fmtInt(d.ties)} tied x value(s); smooth fits take one value per x`);
        notes.push(d.equallySpaced ? 'x equally spaced' : 'x unequally spaced (Aₙ uses only the order)');
    }
    else {
        const sim = simulate(st.source, st.n, st.sigma, st.seed);
        x = sim.x;
        y = sim.y;
        f = sim.f;
        dataKey = `${st.source}|${st.n}|${st.sigma}|${st.seed}`;
        equallySpaced = true;
        notes.push(`tᵢ = i/n; y = f(t) + ${fmt(st.sigma)}·Z, seed ${st.seed}`);
    }
    const n = y.length;
    if (n < 2)
        return { error: 'Need at least 2 complete observations.', columns };

    const sigmaHat = sigmaMAD(y);
    const sigmaUsed = st.sigmaFixed ?? sigmaHat;
    const c = threshold(sigmaUsed, st.tau, n);
    const family = multiresolution(n, st.lambda);
    const levels = multiresolutionLevels(n, st.lambda);
    const taut = tautStringRegression(y, { sigma: sigmaUsed, tau: st.tau, intervals: family });
    const tautExt = localExtremes(taut.f);
    const regionKey = `${dataKey}|${sigmaUsed}|${st.tau}|${st.lambda}`;
    const h = (x[n - 1] - x[0]) / (n - 1); // spacing, meaningful when equallySpaced
    // Bands are meant for τ = 3-style thresholds; they use c with σ (σ̂ unless fixed), like Aₙ.
    // K_min costs O(n·|grid|²); only the smoothness band needs it.
    const kMin = equallySpaced && st.band === 'smooth' ? smoothnessKMin(y, c, h, { theta: st.theta }) : null;
    return {
        columns, notes, x, y, f, n, sigmaHat, sigmaUsed, c, family, levels, taut, tautExt, regionKey,
        equallySpaced, h, kMin, edges: cellEdges(x),
    };
}

/** Attach extremes and the Aₙ checks (family and residual-view rows) to a fit, once. */
function analyze(fit, base) {
    if (fit.check)
        return fit;
    fit.ext = localExtremes(fit.g, METHODS[fit.key].extremesTol);
    // LP solutions sit on the boundary of Aₙ up to solver tolerance, so allow the same slack the
    // core re-check uses; the exact ratios remain visible in the residual view.
    const tol = METHODS[fit.key].lp ? LP_REGION_TOL : 0;
    fit.limit = 1 + tol;
    fit.check = checkRegion(base.y, fit.g, base.family, base.c, tol);
    const rows = base.levels.map(level => checkRegion(base.y, fit.g, level, base.c));
    fit.w = rows.map(r => r.w);
    fit.ratios = rows.map(r => r.ratios);
    return fit;
}

/**
 * The selected confidence band, {pending: true} while an LP it depends on is solving, or null.
 */
function computeBand(base, st, getFit) {
    const spec = BANDS[st.band];
    if (st.band === 'none' || (spec.needsEqual && !base.equallySpaced))
        return null;
    const { y, c } = base;
    const theta = st.theta;
    let b;
    let extra = '';
    if (st.band === 'monoUp' || st.band === 'monoDown') {
        b = monotoneBounds(y, c, { direction: st.band === 'monoUp' ? 1 : -1, theta });
    }
    else if (st.band === 'pwMono') {
        const extremes = base.tautExt.extremes.map(e => ({ type: e.type, position: Math.floor((e.start + e.end) / 2) }));
        b = piecewiseMonotoneBounds(y, c, extremes, { theta });
        extra = extremes.length ? `${extremes.length} extreme position(s) from the taut string`
            : 'taut string has no extremes: monotone in either direction';
    }
    else if (st.band === 'convex' || st.band === 'concave') {
        b = convexBounds(y, c, { concave: st.band === 'concave', theta });
    }
    else if (st.band === 'pwConvex') {
        const fit = getFit('minTV1');
        if (!fit)
            return { pending: true };
        if (fit.error)
            return null;
        const segments = curvatureSegments(base.x, fit.g);
        b = piecewiseConvexBounds(y, c, segments, { theta });
        extra = segments.map(sg => sg.type).join(' → ');
    }
    else {
        const K = st.kMultiple * base.kMin;
        b = smoothnessBounds(y, c, K, base.h, { theta });
        extra = `K = ${fmt(K)} (${st.kMultiple}× K_min)`;
    }
    const empty = crossings(b);
    const inside = base.f ? base.f.every((v, i) => b.lb[i] <= v && v <= b.ub[i]) : null;
    return { ...b, label: `band: ${spec.name}`, empty, inside, extra };
}

function bandRows(base, band, st) {
    const rows = [];
    const add = (label, value, title) => rows.push({ label, value, title });
    add('band', BANDS[st.band].name, band.extra || undefined);
    add('θ', fmt(st.theta), 'fast bounds on a geometric window grid');
    if (st.band === 'smooth')
        add('K_min (fast)', fmt(base.kMin), 'smallest K with a non-empty band; a lower bound on ‖g″‖∞ in x units');
    add('empty at', `${fmtInt(band.empty)} of ${fmtInt(base.n)} points`,
        band.empty ? 'the assumption is inconsistent with the data there' : 'the assumption is consistent with the data');
    if (band.inside !== null) {
        add('true f inside', band.inside ? 'yes' : 'no',
            'honest bands cover f in ≥ 95% of runs (measured 95–96% at n = 500)');
    }
    return rows;
}

function readoutRows(base, fit, st) {
    const rows = [];
    const add = (label, value, title) => rows.push({ label, value, title });
    add('n', fmtInt(base.n));
    add('σ̂ (eq. 10)', fmt(base.sigmaHat), 'median |Δy| / (Φ⁻¹(0.75)·√2)');
    if (base.f)
        add('true σ', fmt(st.sigma));
    if (st.sigmaFixed !== null)
        add('σ used (fixed)', fmt(base.sigmaUsed));
    add('τ', fmt(st.tau));
    add('c = σ√(τ log n)', fmt(base.c));
    add('|𝓘ₙ|', `${fmtInt(base.family.length)} intervals`, `λ = ${fmt(st.lambda)}, singletons included`);
    add('fit', METHODS[fit.key].name);
    if (fit.lp) {
        add(fit.lp.objectiveLabel, fmt(fit.lp.objective),
            'minimum over Aₙ, derivatives in x units; the minimizing g may not be unique (HiGHS returns a vertex)');
        add('LP', `${fit.lp.status}, ${fmtInt(Math.round(fit.lp.ms))} ms`,
            `${fmtInt(fit.lp.rows)} rows × ${fmtInt(fit.lp.cols)} columns`);
    }
    const { nMax, nMin } = fit.ext;
    add('local extremes', fmtInt(nMax + nMin), `${nMax} max, ${nMin} min`);
    if (fit.key === 'taut') {
        add('iterations', fmtInt(base.taut.iterations),
            base.taut.converged ? 'tube squeezes until the fit is in Aₙ' : 'stopped at the iteration cap');
    }
    const worst = base.family[fit.check.argMax];
    const onBoundary = fit.lp && fit.check.ok && fit.check.maxRatio >= 1 - LP_REGION_TOL;
    add('max |w(I)| / c', fit.check.maxRatio.toPrecision(onBoundary ? 10 : 4).replace(/\.?0+$/, ''),
        `at #${worst.lo + 1}–${worst.hi + 1} (|I| = ${worst.hi - worst.lo + 1})`
        + (onBoundary ? '; on the boundary of Aₙ, as an LP optimum is (within solver tolerance)' : ''));
    add('violated intervals', `${fmtInt(fit.check.violations)} of ${fmtInt(base.family.length)}`);
    return rows;
}

function verdictText(base, fit) {
    const ok = fit.check.ok;
    const k = fit.ext.nMax + fit.ext.nMin;
    const extremes = `${k} local extreme${k === 1 ? '' : 's'}`;
    if (fit.key === 'constant') {
        return ok
            ? ': a constant is consistent with the data, so the simplest fit is a constant.'
            : ': the data need a non-constant fit.';
    }
    if (fit.key === 'taut') {
        if (!ok)
            return ': the squeezing did not reach Aₙ within the iteration cap.';
        if (k === 0) {
            return fit.ext.runs.length === 1
                ? ': a constant is consistent with the data, so the simplest fit is a constant.'
                : ': a monotone fit (no local extremes) is consistent with the data.';
        }
        return `: ${extremes}, the taut string's approximation to the fewest of any function in Aₙ.`;
    }
    if (!ok)
        return ': the LP solution fails the Aₙ re-check (see the residual view).';
    if (fit.key === 'combined') {
        return `: the smallest ${fit.lp.objectiveLabel} among functions in Aₙ with the taut string's monotone `
            + `pieces${fit.lp.fixed ? ' and extreme values' : ''} is ${fmt(fit.lp.objective)}; ${extremes}.`;
    }
    if (fit.key === 'minSup2') {
        return `: K_min = ${fmt(fit.lp.objective)}; no function with |g″| ≤ K for a smaller K is `
            + `consistent with the data. ${extremes}.`;
    }
    return `: the smallest ${fit.lp.objectiveLabel} of any function in Aₙ is ${fmt(fit.lp.objective)}; ${extremes}.`;
}

function renderReadouts(container, base, fit, st, band) {
    const sel = d3.select(container);
    sel.selectAll('*').remove();
    sel.append('h2').text('Readouts');
    const verdict = sel.append('p').attr('class', `verdict ${fit.check.ok ? 'ok' : 'bad'}`);
    verdict.append('strong').text(`${METHODS[fit.key].name} ${fit.check.ok ? '∈' : '∉'} Aₙ`);
    verdict.append('span').text(verdictText(base, fit));
    const dl = sel.append('dl');
    for (const r of readoutRows(base, fit, st)) {
        dl.append('dt').text(r.label);
        dl.append('dd').text(r.value);
        if (r.title)
            dl.append('dd').attr('class', 'dd-note').text(r.title);
    }
    if (band && !band.pending) {
        sel.append('h2').text('Band');
        const bdl = sel.append('dl');
        for (const r of bandRows(base, band, st)) {
            bdl.append('dt').text(r.label);
            bdl.append('dd').text(r.value);
            if (r.title)
                bdl.append('dd').attr('class', 'dd-note').text(r.title);
        }
    }
    sel.append('ul').attr('class', 'notes').selectAll('li').data(base.notes).join('li').text(d => d);
}

function startup() {
    const status = d3.select('#status');
    const chart = createMainChart(document.getElementById('main-chart'));
    const residualEl = document.getElementById('residual-view');
    const residual = createResidualView(residualEl, { onHover: iv => chart.highlight(iv) });
    const readouts = document.getElementById('readouts');
    const charts = document.getElementById('charts');

    const lpCache = new Map(); // key → fit {key, g, lp} or {error}
    const inFlight = new Set();
    let base = null;
    let shown = null; // {primary, overlays} currently drawn
    let shownRegion = null; // regionKey of the data behind `shown`

    function lpKey(methodKey) {
        const extra = methodKey === 'combined' ? `|${state.fixExtremes}` : '';
        return `${base.regionKey}|${methodKey}${extra}`;
    }

    // Returns the fit if available; otherwise starts the LP (once) and returns null.
    function getFit(methodKey) {
        const spec = METHODS[methodKey];
        if (methodKey === 'taut')
            return analyze(base.tautFit ??= { key: 'taut', g: base.taut.f }, base);
        if (methodKey === 'constant')
            return analyze(base.constFit ??= { key: 'constant', g: new Float64Array(base.n).fill(d3.mean(base.y)) }, base);
        const key = lpKey(methodKey);
        const cached = lpCache.get(key);
        if (cached)
            return cached.error ? cached : analyze(cached, base);
        if (!inFlight.has(key)) {
            inFlight.add(key);
            const req = { x: base.x, y: base.y, sigma: base.sigmaUsed, tau: state.tau, lambda: state.lambda, ...spec.lp };
            if (methodKey === 'combined') {
                req.signs = stepSigns(base.taut.f, { plateaus: 'split' });
                if (state.fixExtremes)
                    req.fixExtremes = base.tautExt.extremes;
            }
            regularizeInWorker(req)
                .then(result => (result.g ? { key: methodKey, g: result.g, lp: { ...result, fixed: Boolean(req.fixExtremes) } }
                    : { key: methodKey, error: `LP ${result.status}` }))
                .catch(err => ({ key: methodKey, error: String(err.message ?? err) }))
                .then(fit => {
                    inFlight.delete(key);
                    lpCache.set(key, fit);
                    if (lpCache.size > CACHE_LIMIT)
                        lpCache.delete(lpCache.keys().next().value);
                    if (fit.error)
                        console.error(`${methodKey}: ${fit.error}`);
                    render();
                });
        }
        return null;
    }

    function render() {
        if (!base || base.error)
            return;
        const primary = getFit(state.method);
        const overlays = state.overlays.filter(k => k !== state.method).map(getFit).filter(f => f && !f.error);
        if (primary?.error) {
            status.classed('error', true).text(`${METHODS[state.method].name}: ${primary.error}`);
            return;
        }
        const band = computeBand(base, state, getFit);
        const bandPending = Boolean(band?.pending);
        const pending = !primary || bandPending;
        charts.classList.toggle('pending', pending);
        readouts.classList.toggle('pending', pending);
        status.classed('error', false).text(!primary ? `Solving ${METHODS[state.method].name}…`
            : bandPending ? 'Solving min TV(g′) for the convexity intervals…' : '');
        if (pending && shown)
            return; // keep the previous frame, dimmed, until the solve returns
        const drawPrimary = primary ?? getFit('taut');
        shown = { primary: drawPrimary, overlays, band: bandPending ? null : band };
        draw();
        renderReadouts(readouts, base, drawPrimary, state, shown.band);
    }

    function draw() {
        if (!shown)
            return;
        const { primary, overlays, band } = shown;
        const fits = [...overlays, primary].map(fit => ({
            key: fit.key, label: METHODS[fit.key].name, g: fit.g, step: METHODS[fit.key].step,
            runs: localExtremes(fit.g, METHODS[fit.key].extremesTol).runs,
            colorVar: METHODS[fit.key].color, primary: fit === primary,
        }));
        chart.render({ x: base.x, y: base.y, f: state.showTruth ? base.f : null, fits,
            extremes: primary.ext.extremes, edges: base.edges, band });
        residual.render({ x: base.x, edges: base.edges, levels: base.levels, w: primary.w, ratios: primary.ratios,
            limit: primary.limit });
    }

    function update() {
        try {
            base = deriveBase(state);
        }
        catch (err) {
            base = { error: String(err.message ?? err), columns: [] };
            console.error(err);
        }
        controls.sync(state, { columns: base.columns, equallySpaced: base.equallySpaced ?? true, kMin: base.kMin ?? null });
        charts.classList.toggle('empty', Boolean(base.error));
        if (base.error) {
            status.classed('error', false).text(base.error);
            d3.select(readouts).selectAll('*').remove();
            shown = null;
            return;
        }
        // Fits from earlier data or another Aₙ must not be redrawn against the new one.
        if (base.regionKey !== shownRegion)
            shown = null;
        shownRegion = base.regionKey;
        render();
    }

    const controls = createControls(document.getElementById('controls'), state, patch => {
        Object.assign(state, patch);
        update();
    });

    new ResizeObserver(() => draw()).observe(charts);
    onThemeChange(draw);
    update();
}

startup();
