// App entry point: state → derived model → views. The fit (taut string or the constant mean) is
// shown with its local extremes, and the residual view shows it against Aₙ.

import * as d3 from 'd3';
import { SIGNALS, simulate } from '../core/signals.js';
import { parseTable, prepareXY, rowIndex } from '../core/data.js';
import { sigmaMAD } from '../core/sigma.js';
import { multiresolution, multiresolutionLevels } from '../core/intervals.js';
import { threshold, checkRegion } from '../core/region.js';
import { tautStringRegression } from '../core/tautstring.js';
import { localExtremes } from '../core/extremes.js';
import { createControls } from './controls.js';
import { createMainChart } from './chart.js';
import { createResidualView } from './residual.js';
import { cellEdges } from './layout.js';
import { onThemeChange } from './theme.js';

const fmt = d3.format('.4~g');
const fmtInt = d3.format(',');

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
    method: 'taut', // 'taut' | 'constant'
};

const METHOD_LABELS = { taut: 'taut string', constant: 'constant mean(y)' };

let tableCache = { text: null, table: null };

function getTable(text) {
    if (tableCache.text !== text)
        tableCache = { text, table: parseTable(text) };
    return tableCache.table;
}

/**
 * Compute everything the views need from the state. Returns {error} when there is nothing to show.
 */
function derive(st) {
    let x;
    let y;
    let f = null;
    let columns = [];
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
        if (d.dropped)
            notes.push(`${fmtInt(d.dropped)} incomplete row(s) dropped`);
        if (d.ties)
            notes.push(`${fmtInt(d.ties)} tied x value(s)`);
        notes.push(d.equallySpaced ? 'x equally spaced' : 'x unequally spaced (Aₙ uses only the order)');
    }
    else {
        const sim = simulate(st.source, st.n, st.sigma, st.seed);
        x = sim.x;
        y = sim.y;
        f = sim.f;
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
    let g;
    let taut = null;
    if (st.method === 'taut') {
        taut = tautStringRegression(y, { sigma: sigmaUsed, tau: st.tau, intervals: family });
        g = taut.f;
    }
    else {
        g = new Float64Array(n).fill(d3.mean(y));
    }
    const ext = localExtremes(g);
    const check = checkRegion(y, g, family, c);
    const rowChecks = levels.map(level => checkRegion(y, g, level, c));
    return {
        columns, notes, x, y, f, n, g, taut, ext, sigmaHat, sigmaUsed, c, family, levels, check,
        w: rowChecks.map(r => r.w),
        ratios: rowChecks.map(r => r.ratios),
        edges: cellEdges(x),
    };
}

function renderReadouts(container, model, st) {
    const rows = [];
    const add = (label, value, title) => rows.push({ label, value, title });
    add('n', fmtInt(model.n));
    add('σ̂ (eq. 10)', fmt(model.sigmaHat), 'median |Δy| / (Φ⁻¹(0.75)·√2)');
    if (model.f)
        add('true σ', fmt(st.sigma));
    if (st.sigmaFixed !== null)
        add('σ used (fixed)', fmt(model.sigmaUsed));
    add('τ', fmt(st.tau));
    add('c = σ√(τ log n)', fmt(model.c));
    add('|𝓘ₙ|', `${fmtInt(model.family.length)} intervals`, `λ = ${fmt(st.lambda)}, singletons included`);
    add('fit', METHOD_LABELS[st.method]);
    const { nMax, nMin } = model.ext;
    add('local extremes', fmtInt(nMax + nMin), `${nMax} max, ${nMin} min`);
    if (model.taut) {
        add('iterations', fmtInt(model.taut.iterations),
            model.taut.converged ? 'tube squeezes until the fit is in Aₙ' : 'stopped at the iteration cap');
    }
    const worst = model.family[model.check.argMax];
    add('max |w(I)| / c', fmt(model.check.maxRatio),
        `at #${worst.lo + 1}–${worst.hi + 1} (|I| = ${worst.hi - worst.lo + 1})`);
    add('violated intervals', `${fmtInt(model.check.violations)} of ${fmtInt(model.family.length)}`);

    const sel = d3.select(container);
    sel.selectAll('*').remove();
    sel.append('h2').text('Readouts');
    const verdict = sel.append('p').attr('class', `verdict ${model.check.ok ? 'ok' : 'bad'}`);
    const name = METHOD_LABELS[st.method];
    verdict.append('strong').text(`${name} ${model.check.ok ? '∈' : '∉'} Aₙ`);
    const k = model.ext.nMax + model.ext.nMin;
    let text;
    if (st.method === 'constant') {
        text = model.check.ok
            ? ': a constant is consistent with the data, so the simplest fit is a constant.'
            : ': the data need a non-constant fit.';
    }
    else if (model.check.ok) {
        const flat = model.ext.runs.length === 1;
        text = k === 0
            ? (flat
                ? ': a constant is consistent with the data, so the simplest fit is a constant.'
                : ': a monotone fit (no local extremes) is consistent with the data.')
            : `: ${k} local extreme${k === 1 ? '' : 's'}, the taut string's approximation to the fewest `
                + 'of any function in Aₙ.';
    }
    else {
        text = ': the squeezing did not reach Aₙ within the iteration cap.';
    }
    verdict.append('span').text(text);
    const dl = sel.append('dl');
    for (const r of rows) {
        dl.append('dt').text(r.label);
        dl.append('dd').text(r.value);
        if (r.title)
            dl.append('dd').attr('class', 'dd-note').text(r.title);
    }
    sel.append('ul').attr('class', 'notes').selectAll('li').data(model.notes).join('li').text(d => d);
}

function startup() {
    const status = d3.select('#status');
    const chart = createMainChart(document.getElementById('main-chart'));
    const residual = createResidualView(document.getElementById('residual-view'),
        { onHover: iv => chart.highlight(iv) });
    const readouts = document.getElementById('readouts');
    const charts = document.getElementById('charts');

    let model = null;
    function draw() {
        if (!model || model.error)
            return;
        chart.render({ x: model.x, y: model.y, f: state.showTruth ? model.f : null, g: model.g,
            gLabel: METHOD_LABELS[state.method], gStep: true, gRuns: model.ext.runs,
            extremes: model.ext.extremes, edges: model.edges });
        residual.render(model);
    }

    function update() {
        try {
            model = derive(state);
        }
        catch (err) {
            model = { error: String(err.message ?? err), columns: [] };
            console.error(err);
        }
        controls.sync(state, { columns: model.columns });
        charts.classList.toggle('empty', Boolean(model.error));
        status.classed('error', false).text(model.error ?? '');
        if (model.error) {
            d3.select(readouts).selectAll('*').remove();
            return;
        }
        draw();
        renderReadouts(readouts, model, state);
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
