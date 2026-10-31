// Main chart: data points (canvas, so n in the thousands stays fast), true signal and fit lines plus
// axes (SVG on top), a crosshair tooltip, and an optional highlighted interval driven by the residual
// view. Several fits can be drawn; the primary one is thicker and its extremes are marked.

import * as d3 from 'd3';
import { MARGIN, xScale, cellIndex, sizeCanvas } from './layout.js';
import { themeColors, cssColor } from './theme.js';
import { showTooltip, hideTooltip } from './tooltip.js';

const HEIGHT = 340; // px
const POINT_ALPHA = 0.55;
const MARK_ROW = 9; // px above the x axis for extreme-plateau marks
const MARK_SIZE = 42; // d3.symbol area, px²
const MARK_INSET = 2; // px trimmed from each end of a plateau mark so adjacent plateaus stay distinct
const MAX_MARKS = 100; // above this many extremes the marks are an unreadable band; the count is in the legend
const PRIMARY_WIDTH = 2.5; // px
const OVERLAY_WIDTH = 1.5; // px
const fmt = d3.format('.4~g');

/**
 * @typedef {object} ChartModel
 * @property {Float64Array} x       sorted x
 * @property {Float64Array} y
 * @property {Float64Array|null} f  true signal at x (simulated data only)
 * @property {ChartFit[]} fits      fits to draw, primary last
 * @property {{type: 'max'|'min', start: number, end: number}[]} extremes  local extremes of the primary
 * @property {Float64Array} edges   cell edges (layout.cellEdges)
 * @property {{lb: Float64Array, ub: Float64Array, label: string}|null} band  pointwise confidence band
 * @property {{lb: Float64Array, ub: Float64Array, label: string}|null} [exact]  exact LP bounds, dashed
 */

/**
 * @typedef {object} ChartFit
 * @property {string} key
 * @property {string} label
 * @property {Float64Array} g        fit at x
 * @property {boolean} step          draw as a step function over the cells (piecewise-constant fits)
 * @property {{start: number, end: number}[]} runs  runs of equal g (for step drawing)
 * @property {string} colorVar       CSS custom property holding the color
 * @property {boolean} primary
 */

/**
 * @param {HTMLElement} container
 * @returns {{render: function(ChartModel): void, highlight: function({lo: number, hi: number}|null): void}}
 */
export function createMainChart(container) {
    container.classList.add('chart');
    const legend = d3.select(container).append('div').attr('class', 'legend');
    const plot = d3.select(container).append('div').attr('class', 'plot').style('height', `${HEIGHT}px`);
    const canvas = plot.append('canvas').node();
    const svg = plot.append('svg').attr('height', HEIGHT);
    const clipId = `plot-clip-${Math.random().toString(36).slice(2)}`;
    const clipRect = svg.append('clipPath').attr('id', clipId).append('rect');
    const gGrid = svg.append('g').attr('class', 'grid');
    const gBand = svg.append('g').attr('class', 'band').attr('clip-path', `url(#${clipId})`);
    const gHighlight = svg.append('rect').attr('class', 'interval-highlight').attr('visibility', 'hidden');
    const gLines = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const gMarks = svg.append('g').attr('class', 'extreme-marks');
    const gAxisX = svg.append('g').attr('class', 'axis');
    const gAxisY = svg.append('g').attr('class', 'axis');
    const cross = svg.append('g').attr('class', 'crosshair').attr('visibility', 'hidden');
    cross.append('line').attr('y1', MARGIN.top).attr('y2', HEIGHT - MARGIN.bottom);
    const crossDot = cross.append('circle').attr('r', 4);
    const overlay = svg.append('rect').attr('class', 'overlay')
        .attr('y', MARGIN.top).attr('height', HEIGHT - MARGIN.top - MARGIN.bottom);

    let model = null;
    let sx = null;
    let sy = null;

    function render(m) {
        model = m;
        // Anything showing values from the previous model is now stale.
        cross.attr('visibility', 'hidden');
        gHighlight.attr('visibility', 'hidden');
        hideTooltip();
        const width = container.clientWidth;
        const colors = themeColors();
        const { x, y, f, edges } = m;
        const n = x.length;
        sx = xScale(edges, width);
        let lo = d3.min(y);
        let hi = d3.max(y);
        if (f) {
            lo = Math.min(lo, d3.min(f));
            hi = Math.max(hi, d3.max(f));
        }
        sy = d3.scaleLinear().domain([lo, hi]).nice().range([HEIGHT - MARGIN.bottom, MARGIN.top]);

        svg.attr('width', width);
        clipRect.attr('x', MARGIN.left).attr('y', MARGIN.top)
            .attr('width', width - MARGIN.left - MARGIN.right).attr('height', HEIGHT - MARGIN.top - MARGIN.bottom);
        overlay.attr('x', MARGIN.left).attr('width', width - MARGIN.left - MARGIN.right);
        gAxisX.attr('transform', `translate(0,${HEIGHT - MARGIN.bottom})`)
            .call(d3.axisBottom(sx).ticks(width / 90).tickSizeOuter(0));
        gAxisY.attr('transform', `translate(${MARGIN.left},0)`)
            .call(d3.axisLeft(sy).ticks(HEIGHT / 50).tickSizeOuter(0));
        gGrid.selectAll('line').data(sy.ticks(HEIGHT / 50)).join('line')
            .attr('x1', MARGIN.left).attr('x2', width - MARGIN.right)
            .attr('y1', d => sy(d)).attr('y2', d => sy(d));

        const ctx = sizeCanvas(canvas, width, HEIGHT);
        ctx.clearRect(0, 0, width, HEIGHT);
        ctx.fillStyle = colors.muted;
        ctx.globalAlpha = POINT_ALPHA;
        const r = n > 2000 ? 1.5 : n > 500 ? 2 : 2.5; // px; smaller points when dense
        for (let i = 0; i < n; i++) {
            ctx.beginPath();
            ctx.arc(sx(x[i]), sy(y[i]), r, 0, 2 * Math.PI);
            ctx.fill();
        }
        ctx.globalAlpha = 1;

        const line = v => d3.line().x((_, i) => sx(x[i])).y((_, i) => sy(v[i]))(v);

        // Band: infinite bounds are drawn to just past the plot edge (the tooltip shows ±∞). Where
        // lb > ub the band is empty: the assumption is inconsistent with the data there.
        gBand.selectAll('*').remove();
        if (m.band) {
            const [y0, y1] = sy.range(); // bottom, top in px
            const clampPx = v => Math.max(y1 - 10, Math.min(y0 + 10, sy(v)));
            const px = v => (v === Infinity ? y1 - 10 : v === -Infinity ? y0 + 10 : clampPx(v));
            const { lb, ub } = m.band;
            const ok = i => lb[i] <= ub[i];
            gBand.append('path').attr('class', 'band-fill')
                .attr('d', d3.area().defined((_, i) => ok(i)).x((_, i) => sx(x[i]))
                    .y0((_, i) => px(lb[i])).y1((_, i) => px(ub[i]))(lb));
            gBand.append('path').attr('class', 'band-empty')
                .attr('d', d3.area().defined((_, i) => !ok(i)).x((_, i) => sx(x[i]))
                    .y0((_, i) => px(ub[i])).y1((_, i) => px(lb[i]))(lb));
            for (const v of [lb, ub]) {
                gBand.append('path').attr('class', 'band-edge')
                    .attr('d', d3.line().defined(i => Number.isFinite(v[i])).x(i => sx(x[i])).y(i => px(v[i]))(d3.range(n)));
            }
            if (m.exact) {
                for (const v of [m.exact.lb, m.exact.ub]) {
                    gBand.append('path').attr('class', 'band-exact')
                        .attr('d', d3.line().defined(i => Number.isFinite(v[i])).x(i => sx(x[i])).y(i => px(v[i]))(d3.range(n)));
                }
            }
        }
        // A piecewise-constant fit is drawn over each observation's cell, so plateaus show their extent.
        const steps = fit => {
            let d = '';
            for (const r of fit.runs) {
                const yv = sy(fit.g[r.start]);
                d += d ? `V${yv}` : `M${sx(edges[r.start])},${yv}`;
                d += `H${sx(edges[r.end + 1])}`;
            }
            return d;
        };
        const series = [];
        if (f)
            series.push({ key: 'truth', label: 'true f', d: line(f), color: colors['series-2'], width: 1.5 });
        for (const fit of m.fits) {
            series.push({
                key: fit.key, label: fit.label, d: fit.step ? steps(fit) : line(fit.g),
                color: cssColor(fit.colorVar), width: fit.primary ? PRIMARY_WIDTH : OVERLAY_WIDTH,
            });
        }
        gLines.selectAll('path').data(series, d => d.key).join('path')
            .attr('fill', 'none')
            .attr('stroke', d => d.color)
            .attr('stroke-width', d => d.width)
            .attr('stroke-linejoin', 'round')
            .attr('d', d => d.d);

        const markY = HEIGHT - MARGIN.bottom - MARK_ROW;
        const shown = m.extremes.length <= MAX_MARKS ? m.extremes : [];
        const marks = gMarks.selectAll('g.mark').data(shown).join(enter => {
            const e = enter.append('g').attr('class', 'mark');
            e.append('line');
            e.append('path');
            return e;
        });
        marks.select('line')
            .attr('x1', d => Math.min(sx(edges[d.start]) + MARK_INSET, sx((edges[d.start] + edges[d.end + 1]) / 2)))
            .attr('x2', d => Math.max(sx(edges[d.end + 1]) - MARK_INSET, sx((edges[d.start] + edges[d.end + 1]) / 2)))
            .attr('y1', markY).attr('y2', markY)
            .attr('stroke', colors.ink);
        marks.select('path')
            .attr('d', d3.symbol(d3.symbolTriangle, MARK_SIZE)())
            .attr('transform', d => `translate(${sx((edges[d.start] + edges[d.end + 1]) / 2)},${markY})`
                + (d.type === 'min' ? ' rotate(180)' : ''))
            .attr('fill', colors.ink);

        const items = [{ label: 'data', color: colors.muted, dot: true }, ...series];
        if (m.band)
            items.push({ label: m.band.label, color: colors['band'], box: true });
        if (m.band && m.exact)
            items.push({ label: m.exact.label, color: colors.ink, glyph: '┄' });
        if (shown.length)
            items.push({ label: 'local max / min plateau', color: colors.ink, glyph: '▲▼' });
        else if (m.extremes.length)
            items.push({ label: `${m.extremes.length} local extremes (marks hidden)`, color: colors.ink, glyph: '▲▼' });
        legend.selectAll('span.item').data(items, d => d.label).join(enter => {
            const s = enter.append('span').attr('class', 'item');
            s.append('span').attr('class', 'key');
            s.append('span').attr('class', 'label');
            return s;
        })
            .call(s => s.select('.key')
                .classed('box', d => Boolean(d.box))
                .classed('dot', d => Boolean(d.dot))
                .classed('glyph', d => Boolean(d.glyph))
                .text(d => d.glyph ?? '')
                .style('background', d => (d.glyph ? 'none' : d.color))
                .style('color', d => d.color))
            .call(s => s.select('.label').text(d => d.label));
    }

    function highlight(interval) {
        if (!interval || !model) {
            gHighlight.attr('visibility', 'hidden');
            return;
        }
        const x0 = sx(model.edges[interval.lo]);
        const x1 = sx(model.edges[interval.hi + 1]);
        gHighlight.attr('visibility', 'visible')
            .attr('x', x0).attr('width', Math.max(1, x1 - x0))
            .attr('y', MARGIN.top).attr('height', HEIGHT - MARGIN.top - MARGIN.bottom);
    }

    overlay.on('pointermove', event => {
        if (!model)
            return;
        const [px] = d3.pointer(event);
        const i = cellIndex(model.edges, sx.invert(px));
        const cx = sx(model.x[i]);
        cross.attr('visibility', 'visible');
        cross.select('line').attr('x1', cx).attr('x2', cx);
        crossDot.attr('cx', cx).attr('cy', sy(model.y[i]));
        const colors = themeColors();
        const rows = [[fmt(model.y[i]), 'y', colors.muted]];
        if (model.f)
            rows.push([fmt(model.f[i]), 'true f', colors['series-2']]);
        for (const fit of [...model.fits].reverse())
            rows.push([fmt(fit.g[i]), fit.label, cssColor(fit.colorVar)]);
        if (model.band) {
            const b = model.band;
            const show = v => (v === Infinity ? '+∞' : v === -Infinity ? '−∞' : fmt(v));
            rows.push([`[${show(b.lb[i])}, ${show(b.ub[i])}]`, b.lb[i] > b.ub[i] ? 'band (empty here)' : 'band']);
            if (model.exact)
                rows.push([`[${show(model.exact.lb[i])}, ${show(model.exact.ub[i])}]`, 'exact LP bounds']);
        }
        const ext = model.extremes.find(e => e.start <= i && i <= e.end);
        const note = ext
            ? `In a local ${ext.type === 'max' ? 'maximum' : 'minimum'} plateau: #${ext.start + 1}–${ext.end + 1}, `
                + `x ∈ [${fmt(model.x[ext.start])}, ${fmt(model.x[ext.end])}]`
            : undefined;
        showTooltip(event.pageX, event.pageY, `x = ${fmt(model.x[i])}  (#${i + 1})`, rows, note);
    });
    overlay.on('pointerleave', () => {
        cross.attr('visibility', 'hidden');
        hideTooltip();
    });

    return { render, highlight };
}
