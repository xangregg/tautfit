// App entry point: state → derived model → views.
//
// The data, σ̂, Aₙ and the taut string are computed synchronously (milliseconds). LP fits are solved
// in the worker and cached by data and settings; while the primary fit is being solved the previous
// render stays up, dimmed. The primary fit drives the residual view and readouts; overlays are drawn
// for comparison only.

import * as d3 from 'd3';
import { SIGNALS, simulate } from '../core/signals.js';
import { parseTable, prepareXY, rowIndex } from '../core/data.js';
import { sigmaMAD, sigmaGSJS, replicateInfo } from '../core/sigma.js';
import { multiresolutionLevels, xIntervalFamily, xIntervalLevels, tieRanges } from '../core/intervals.js';
import { threshold, checkRegion, constraintBoxes } from '../core/region.js';
import { tautStringRegression } from '../core/tautstring.js';
import { localExtremes, stepSigns } from '../core/extremes.js';
import { createControls } from './controls.js';
import { createMainChart } from './chart.js';
import { createResidualView } from './residual.js';
import { cellEdges } from './layout.js';
import { onThemeChange } from './theme.js';
import { regularizeInWorker, exactBoundsInWorker, calibrateInWorker } from './lp.js';
import { tauFromSample, coverageOfTau } from '../core/calibrate.js';
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
const CALIBRATION_B = 2000; // Monte Carlo replicates for τ
const CALIBRATION_SEED = 1; // fixed so a calibrated τ is reproducible
const CALIBRATE_ALL_MAX_N = 2000; // all-intervals calibration costs O(n²) per replicate
const EXACT_MAX_N = 300; // exact LP bounds: 2n LPs
const SMALL_N = 50; // below this, warn that σ̂ and τ = 3 are rough (the paper targets n ≥ 500)
// Warn when σ̂(eq. 10)/σ̂(GSJS) exceeds 1 + INFLATION_K/√n. Under pure noise (4000 runs per n, half
// unequal spacing) this fires in ≈ 1% of runs at n = 10 and ≈ 0.1% for n ≥ 100.
const INFLATION_K = 4;

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
    sigmaMethod: 'diff', // σ̂ estimator: 'diff' (eq. 10) | 'gsjs' (trend-robust local linear residuals)
    method: 'taut', // key of METHODS
    overlays: [], // keys of METHODS drawn in addition to the primary fit
    fixExtremes: false, // combined: pin extremes to the taut string's values
    band: 'none', // key of BANDS
    theta: 1.5, // window grid ratio for the fast bounds
    kMultiple: 2, // smoothness band: K = kMultiple × K_min (fast)
    tauMode: 'fixed', // 'fixed' (state.tau) | 'calibrated' (Monte Carlo τₙ(α))
    alpha: 0.95, // calibration coverage
    calibFamily: 'chosen', // calibrate for the λ family ('chosen') or all intervals ('all', for the fast bands)
    plugSigma: true, // calibrate with σ̂(Z), mimicking the estimated σ
    exact: false, // also compute exact LP bounds for the band (n ≤ EXACT_MAX_N)
    boxes: 'hover', // Aₙ boxes on the chart: 'off' | 'hover' | 'level:k' | 'all'
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
 * The data: observations, truth for simulated data, and notes. Returns {error} when there is nothing
 * to show.
 */
function deriveData(st) {
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
        if (d.ties) {
            notes.push(`${fmtInt(d.ties)} observations share an x with another: Aₙ uses intervals of x (eq. 6), `
                + 'so tied observations are always kept together, and every fit takes one value per x.');
        }
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
    return { columns, notes, x, y, f, n, dataKey, equallySpaced, ties: tieRanges(x).ties };
}

/**
 * Everything that does not need the LP solver, for a resolved τ.
 */
function deriveBase(st, data, tauInfo) {
    const { columns, notes, x, y, f, n, dataKey, equallySpaced } = data;
    const tau = tauInfo.tau;
    const sigmaHat = sigmaMAD(y, x);
    const replicates = replicateInfo(x);
    let sigmaRobust = NaN;
    try {
        sigmaRobust = sigmaGSJS(x, y);
    }
    catch {
        // fewer than 3 usable points: GSJS unavailable
    }
    const useRobust = st.sigmaMethod === 'gsjs' && Number.isFinite(sigmaRobust);
    const sigmaUsed = st.sigmaFixed ?? (useRobust ? sigmaRobust : sigmaHat);
    const warnings = sigmaWarnings(st, n, sigmaHat, sigmaRobust, useRobust, replicates);
    const c = threshold(sigmaUsed, tau, n);
    // Intervals of x (eq. 6): built on the distinct x values, so tied observations are never separated.
    const family = xIntervalFamily(x, st.lambda);
    const levels = xIntervalLevels(x, st.lambda);
    const groups = tieRanges(x);
    const levelSizes = multiresolutionLevels(groups.m, st.lambda).map(level => level[0].hi - level[0].lo + 1);
    const taut = tautStringRegression(y, { x, sigma: sigmaUsed, tau, intervals: family });
    const tautExt = localExtremes(taut.f);
    const regionKey = `${dataKey}|${sigmaUsed}|${tau}|${st.lambda}`;
    const h = (x[n - 1] - x[0]) / (n - 1); // spacing, meaningful when equallySpaced
    // Bands are meant for τ = 3-style thresholds; they use c with σ (σ̂ unless fixed), like Aₙ.
    // K_min costs O(n·|grid|²); only the smoothness band needs it.
    const kMin = equallySpaced && st.band === 'smooth' ? smoothnessKMin(y, c, h, { theta: st.theta }) : null;
    return {
        columns, notes, warnings, x, y, f, n, ties: groups.ties, levelSizes, replicates, sigmaHat, sigmaRobust, useRobust, sigmaUsed, tau, tauInfo, c, family, levels, taut, tautExt, regionKey,
        equallySpaced, h, kMin, edges: cellEdges(x),
    };
}

/**
 * Warnings about the noise scale, which sets c and hence how loose Aₙ is.
 */
function sigmaWarnings(st, n, sigmaHat, sigmaRobust, useRobust, replicates) {
    const out = [];
    if (n < SMALL_N) {
        const source = st.sigmaFixed !== null ? 'σ is fixed'
            : replicates.pureErrorOnly ? `σ̂ comes from only ${replicates.df} replicate degrees of freedom`
                : useRobust ? `GSJS σ̂ comes from only ${n - 2} pseudo-residuals`
                    : `σ̂ comes from only ${n - 1} differences`;
        out.push(`Small n (${n}): ${source}, and τ = 3 targets n ≥ 500; at small n it can cover far less than 95% `
            + '(e.g. 76% at n = 10 with GSJS σ̂). Calibrate τ for this n, and fix σ if you know the noise level.');
    }
    if (st.sigmaFixed === null && !useRobust && Number.isFinite(sigmaRobust) && sigmaRobust > 0) {
        const ratio = sigmaHat / sigmaRobust;
        if (ratio > 1 + INFLATION_K / Math.sqrt(n)) {
            out.push(`σ̂ (eq. 10) = ${fmt(sigmaHat)} is ${fmt(ratio)}× the trend-robust estimate ${fmt(sigmaRobust)}: `
                + 'differences between neighbors seem to contain signal, which inflates σ̂ and widens Aₙ '
                + '(c ∝ σ). Consider the GSJS σ estimate, or fix σ.');
        }
    }
    return out;
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
    let shape = null; // the same assumption for exact LP bounds (src/core/exact.js), when expressible
    if (st.band === 'monoUp' || st.band === 'monoDown') {
        const direction = st.band === 'monoUp' ? 1 : -1;
        b = monotoneBounds(y, c, { direction, theta, x: base.x });
        shape = { type: 'monotone', direction };
    }
    else if (st.band === 'pwMono') {
        const extremes = base.tautExt.extremes.map(e => ({ type: e.type, position: Math.floor((e.start + e.end) / 2) }));
        b = piecewiseMonotoneBounds(y, c, extremes, { theta, x: base.x });
        extra = extremes.length ? `${extremes.length} extreme position(s) from the taut string`
            : 'taut string has no extremes: monotone in either direction';
        // "monotone either way" is a union of two regions, not one LP
        shape = b.segments.length ? { type: 'pwMonotone', segments: b.segments } : null;
    }
    else if (st.band === 'convex' || st.band === 'concave') {
        b = convexBounds(y, c, { concave: st.band === 'concave', theta });
        shape = { type: 'convex', concave: st.band === 'concave' };
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
        shape = { type: 'pwConvex', segments };
    }
    else {
        const K = st.kMultiple * base.kMin;
        b = smoothnessBounds(y, c, K, base.h, { theta });
        extra = `K = ${fmt(K)} (${st.kMultiple}× K_min)`;
        shape = { type: 'smooth', K };
    }
    const empty = crossings(b);
    const inside = base.f ? base.f.every((v, i) => b.lb[i] <= v && v <= b.ub[i]) : null;
    return { ...b, label: `band: ${spec.name}`, empty, inside, extra, shape };
}

// The fast bands use windows outside the λ family, so their honesty needs a τ valid for all intervals
// (PLAN.md Known issues 6, 13). Measured at n = 500, 1000 runs (exp(5t) monotone/convex, sin(4πt)
// smoothness): τ = 3 → 95.4–96.1%; τ calibrated for the dyadic family (2.72) → 91.6–93.1%; τ calibrated
// for all intervals (3.08) → 96.2–96.5%.
function bandCoverageNote(base, st) {
    if (base.tauInfo.mode === 'calibrated' && st.calibFamily === 'all') {
        return { value: `≥ ${st.alpha} (calibrated)`,
            note: 'τ calibrated for all intervals, which covers every window the fast bands use' };
    }
    if (base.tauInfo.mode === 'calibrated') {
        return { value: 'below α', note: 'τ was calibrated for the λ family, but the fast bands use other windows: '
            + 'measured 92–93% at α = 0.95, n = 500. Calibrate for all intervals for honest bands.' };
    }
    if (base.tau === 3) {
        return { value: '≈ 95–96%', note: 'τ = 3; measured 95.4–96.1% at n = 500 (paper eq. 11 holds only marginally over all intervals)' };
    }
    return { value: 'unknown', note: 'depends on τ; calibrate for all intervals to get coverage α' };
}

function bandRows(base, band, st, exact) {
    const rows = [];
    const add = (label, value, title) => rows.push({ label, value, title });
    add('band', BANDS[st.band].name, band.extra || undefined);
    add('θ', fmt(st.theta), 'fast bounds on a geometric window grid');
    if (st.band === 'smooth')
        add('K_min (fast)', fmt(base.kMin), 'smallest K with a non-empty band; a lower bound on ‖g″‖∞ in x units');
    add('empty at', `${fmtInt(band.empty)} of ${fmtInt(base.n)} points`,
        band.empty ? 'the assumption is inconsistent with the data there' : 'the assumption is consistent with the data');
    add('coverage', bandCoverageNote(base, st).value, bandCoverageNote(base, st).note);
    if (band.inside !== null)
        add('true f inside', band.inside ? 'yes' : 'no', 'for this run of the simulation');
    if (exact?.lb) {
        let wExact = 0;
        let wFast = 0;
        let narrower = 0;
        for (let i = 0; i < base.n; i++) {
            const we = exact.ub[i] - exact.lb[i];
            const wf = band.ub[i] - band.lb[i];
            wExact += we / base.n;
            wFast += wf / base.n;
            if (we < wf)
                narrower++;
        }
        add('exact LP bounds', `${fmtInt(exact.solves)} LPs, ${fmt(exact.ms / 1000)} s`,
            `Aₙ with the λ family; mean width ${fmt(wExact)} vs fast ${fmt(wFast)}; narrower at ${narrower} of ${base.n} points`);
        if (base.f) {
            const inside = base.f.every((v, i) => exact.lb[i] - 1e-9 <= v && v <= exact.ub[i] + 1e-9);
            add('true f inside exact', inside ? 'yes' : 'no');
        }
    }
    else if (exact?.status) {
        add('exact LP bounds', exact.status === 'infeasible' ? 'infeasible' : exact.status,
            exact.status === 'infeasible' ? 'no function in Aₙ has this shape: the assumption is rejected' : undefined);
    }
    return rows;
}

function tauRow(base, st) {
    const t = base.tauInfo;
    if (t.mode === 'fixed')
        return ['τ', fmt(t.tau), undefined];
    const family = st.calibFamily === 'all' ? 'all intervals' : `λ = ${fmt(st.lambda)} family`;
    const plug = st.sigmaFixed !== null || !st.plugSigma ? ' with σ known'
        : st.sigmaMethod === 'gsjs' ? ' with GSJS σ̂' : ' with σ̂ (eq. 10)';
    return ['τ (calibrated)', fmt(t.tau),
        `Monte Carlo τₙ(${st.alpha}) for ${family}${plug}, B = ${CALIBRATION_B}; `
        + `95% MC interval ${fmt(t.tauLo)}–${fmt(t.tauHi)}; τ = 3 would cover ${fmt(100 * t.cov3)}%`];
}

function readoutRows(base, fit, st) {
    const rows = [];
    const add = (label, value, title) => rows.push({ label, value, title });
    add('n', fmtInt(base.n));
    const inUse = which => (st.sigmaFixed === null && which ? ' · used' : '');
    const rep = base.replicates;
    if (rep.pureErrorOnly) {
        // both estimators reduce to the same pure-error estimate
        add('σ̂', fmt(base.sigmaHat),
            `spread within tied x (pure error, ${rep.df} df), robust; no trend enters${inUse(true)}`);
    }
    else {
        const tied = rep.df > 0 ? `, pooled with the spread within tied x (${rep.df} df)` : '';
        add('σ̂ (eq. 10)', fmt(base.sigmaHat), `median |Δy| / (Φ⁻¹(0.75)·√2)${tied}${inUse(!base.useRobust)}`);
        if (Number.isFinite(base.sigmaRobust)) {
            add('σ̂ (GSJS)', fmt(base.sigmaRobust),
                `median local linear residual, trend-robust (Gasser et al. 1986)${tied}${inUse(base.useRobust)}`);
        }
    }
    if (base.f)
        add('true σ', fmt(st.sigma));
    if (st.sigmaFixed !== null)
        add('σ used (fixed)', fmt(base.sigmaUsed));
    add(...tauRow(base, st));
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

function renderReadouts(container, base, fit, st, band, exact) {
    const sel = d3.select(container);
    sel.selectAll('*').remove();
    sel.append('h2').text('Readouts');
    const verdict = sel.append('p').attr('class', `verdict ${fit.check.ok ? 'ok' : 'bad'}`);
    verdict.append('strong').text(`${METHODS[fit.key].name} ${fit.check.ok ? '∈' : '∉'} Aₙ`);
    verdict.append('span').text(verdictText(base, fit));
    for (const w of base.warnings)
        sel.append('p').attr('class', 'warning').text(w);
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
        for (const r of bandRows(base, band, st, exact)) {
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
    let hovered = null; // interval hovered in the residual view
    const residual = createResidualView(residualEl, {
        onHover: iv => {
            hovered = iv;
            chart.highlight(iv);
            applyBoxes();
        },
    });
    const readouts = document.getElementById('readouts');
    const charts = document.getElementById('charts');

    const lpCache = new Map(); // key → fit {key, g, lp} or {error}
    const inFlight = new Set();
    const calibCache = new Map(); // key → sorted Monte Carlo sample
    const exactCache = new Map(); // key → exact bounds result
    const progress = new Map(); // in-flight job key → {label, fraction}
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
            const req = { x: base.x, y: base.y, sigma: base.sigmaUsed, tau: base.tau, lambda: state.lambda, ...spec.lp };
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

    function showProgress() {
        const jobs = [...progress.values()].map(p => `${p.label} ${Math.round(100 * p.fraction)}%`);
        return jobs.join(' · ');
    }

    // σ̂ plug-in that matches the procedure: none when σ is fixed (known), else the chosen estimator.
    function calibEstimator() {
        if (state.sigmaFixed !== null || !state.plugSigma)
            return 'none';
        return state.sigmaMethod;
    }

    function calibKey(data) {
        const fam = state.calibFamily === 'all' ? 'all' : `λ${state.lambda}`;
        const est = calibEstimator();
        // GSJS and tied x (the family is over the distinct x) make the calibration specific to the data's x
        const design = est === 'gsjs' || data.ties ? `|${data.dataKey}` : '';
        return `${data.n}|${fam}|${est}${design}|${CALIBRATION_B}|${CALIBRATION_SEED}`;
    }

    // τ for this data: fixed, or calibrated from a cached Monte Carlo sample (started on demand).
    function resolveTau(data) {
        if (state.tauMode === 'fixed')
            return { tau: state.tau, mode: 'fixed' };
        if (state.calibFamily === 'all' && data.n > CALIBRATE_ALL_MAX_N)
            return { error: `All-interval calibration is limited to n ≤ ${CALIBRATE_ALL_MAX_N} (O(n²) per replicate).` };
        const key = calibKey(data);
        const sorted = calibCache.get(key);
        if (sorted) {
            const t = tauFromSample(sorted, state.alpha, data.n);
            return { ...t, mode: 'calibrated', cov3: coverageOfTau(sorted, 3, data.n) };
        }
        if (!progress.has(key)) {
            progress.set(key, { label: 'Calibrating τ', fraction: 0 });
            calibrateInWorker({
                n: data.n, lambda: state.lambda, family: state.calibFamily, B: CALIBRATION_B,
                seed: CALIBRATION_SEED, sigmaEstimator: calibEstimator(), x: data.x,
            }, fr => {
                progress.get(key).fraction = fr;
                status.text(showProgress());
            }).then(({ sorted: s }) => {
                calibCache.set(key, s);
            }).catch(err => {
                console.error(err);
                status.classed('error', true).text(`Calibration failed: ${err.message}`);
            }).finally(() => {
                progress.delete(key);
                update();
            });
        }
        return { pending: true };
    }

    // Exact LP bounds for the band, if requested and possible; null, {pending}, or the result.
    function getExact(band) {
        if (!state.exact || !band || band.pending || !band.shape || base.n > EXACT_MAX_N)
            return null;
        const key = `${base.regionKey}|${state.band}|${JSON.stringify(band.shape)}`;
        const cached = exactCache.get(key);
        if (cached)
            return cached;
        if (!progress.has(key)) {
            progress.set(key, { label: 'Exact LP bounds', fraction: 0 });
            exactBoundsInWorker({ x: base.x, y: base.y, shape: band.shape, sigma: base.sigmaUsed, tau: base.tau, lambda: state.lambda },
                fr => {
                    progress.get(key).fraction = fr;
                    status.text(showProgress());
                })
                .then(r => exactCache.set(key, r))
                .catch(err => exactCache.set(key, { status: `error: ${err.message}` }))
                .finally(() => {
                    progress.delete(key);
                    render();
                });
        }
        return { pending: true };
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
        const exact = getExact(band);
        const exactPending = Boolean(exact?.pending);
        const pending = !primary || bandPending || exactPending;
        charts.classList.toggle('pending', pending);
        readouts.classList.toggle('pending', pending);
        status.classed('error', false).text(!primary ? `Solving ${METHODS[state.method].name}…`
            : bandPending ? 'Solving min TV(g′) for the convexity intervals…'
                : exactPending ? showProgress() || 'Exact LP bounds…' : '');
        if (pending && shown)
            return; // keep the previous frame, dimmed, until the solve returns
        const drawPrimary = primary ?? getFit('taut');
        shown = { primary: drawPrimary, overlays, band: bandPending ? null : band, exact: exactPending ? null : exact };
        draw();
        renderReadouts(readouts, base, drawPrimary, state, shown.band, shown.exact);
    }

    // Aₙ constraint boxes of the primary fit for one level, computed once per fit and level.
    function boxesFor(fit, k) {
        fit.boxes ??= [];
        fit.boxes[k] ??= constraintBoxes(base.y, fit.g, base.levels[k], base.c);
        return fit.boxes[k];
    }

    function boxesLabel() {
        if (state.boxes === 'off')
            return null;
        if (state.boxes === 'hover')
            return 'Aₙ boxes: hover a residual-view row';
        if (state.boxes === 'all')
            return 'Aₙ boxes, all levels';
        const k = Number(state.boxes.split(':')[1]);
        const size = base.levelSizes[k];
        if (size === undefined)
            return null;
        const what = base.ties ? `${size} distinct x per box` : `|I| = ${size}`;
        return `Aₙ boxes, ${what}: fit mean (tick) must lie in each box`;
    }

    function applyBoxes() {
        if (!shown || !base || base.error) {
            chart.setBoxes(null);
            return;
        }
        const fit = shown.primary;
        const common = { limit: fit.limit ?? 1, fitColorVar: METHODS[fit.key].color };
        const emphasis = k => (hovered && hovered.level === k
            ? base.levels[k].findIndex(iv => iv.lo === hovered.lo) : -1);
        if (state.boxes === 'off' || (state.boxes === 'hover' && !hovered)) {
            chart.setBoxes(null);
        }
        else if (state.boxes === 'all') {
            chart.setBoxes({ ...common, faint: true,
                levels: base.levels.map((_, k) => ({ boxes: boxesFor(fit, k), emphasize: emphasis(k) })) });
        }
        else {
            const k = state.boxes === 'hover' ? hovered.level : Number(state.boxes.split(':')[1]);
            if (!base.levels[k]) {
                chart.setBoxes(null);
                return;
            }
            chart.setBoxes({ ...common, faint: false, levels: [{ boxes: boxesFor(fit, k), emphasize: emphasis(k) }] });
        }
    }

    function draw() {
        if (!shown)
            return;
        const { primary, overlays, band, exact } = shown;
        const fits = [...overlays, primary].map(fit => ({
            key: fit.key, label: METHODS[fit.key].name, g: fit.g, step: METHODS[fit.key].step,
            runs: localExtremes(fit.g, METHODS[fit.key].extremesTol).runs,
            colorVar: METHODS[fit.key].color, primary: fit === primary,
        }));
        chart.render({ x: base.x, y: base.y, f: state.showTruth ? base.f : null, fits,
            extremes: primary.ext.extremes, edges: base.edges, band,
            exact: exact?.lb ? { lb: exact.lb, ub: exact.ub, label: 'exact LP bounds' } : null,
            boxesLabel: boxesLabel() });
        applyBoxes();
        residual.render({ x: base.x, edges: base.edges, levels: base.levels, w: primary.w, ratios: primary.ratios,
            limit: primary.limit, rowLabels: base.levelSizes.map(String), rowTitle: base.ties ? '#x' : '|I|' });
    }

    function update() {
        let data;
        try {
            data = deriveData(state);
            if (!data.error) {
                const tauInfo = resolveTau(data);
                if (tauInfo.pending) {
                    controls.sync(state, { columns: data.columns, equallySpaced: data.equallySpaced, kMin: null, n: data.n });
                    charts.classList.add('pending');
                    readouts.classList.add('pending');
                    status.classed('error', false).text(showProgress() || 'Calibrating τ…');
                    return; // update() runs again when the calibration arrives
                }
                base = tauInfo.error ? { error: tauInfo.error, columns: data.columns } : deriveBase(state, data, tauInfo);
            }
            else {
                base = data;
            }
        }
        catch (err) {
            base = { error: String(err.message ?? err), columns: [] };
            console.error(err);
        }
        controls.sync(state, {
            columns: base.columns, equallySpaced: base.equallySpaced ?? true, kMin: base.kMin ?? null,
            n: base.n ?? 0, tau: base.tau ?? null, pureErrorOnly: base.replicates?.pureErrorOnly ?? false,
            levelLabels: base.levelSizes
                ? base.levelSizes.map(size => (base.ties ? `${size} distinct x per box` : `|I| = ${size}`)) : [],
        });
        charts.classList.toggle('empty', Boolean(base.error));
        if (base.error) {
            charts.classList.remove('pending');
            readouts.classList.remove('pending');
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
