// Main chart: data points (canvas, so n in the thousands stays fast), true signal and fit lines plus
// axes (SVG on top), a crosshair tooltip, and an optional highlighted interval driven by the residual
// view.

import * as d3 from 'd3';
import { MARGIN, xScale, cellIndex, sizeCanvas } from './layout.js';
import { themeColors } from './theme.js';
import { showTooltip, hideTooltip } from './tooltip.js';

const HEIGHT = 340; // px
const POINT_ALPHA = 0.55;
const fmt = d3.format('.4~g');

/**
 * @typedef {object} ChartModel
 * @property {Float64Array} x       sorted x
 * @property {Float64Array} y
 * @property {Float64Array|null} f  true signal at x (simulated data only)
 * @property {Float64Array} g       fit at x
 * @property {string} gLabel        legend/tooltip name of the fit
 * @property {Float64Array} edges   cell edges (layout.cellEdges)
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
    const gGrid = svg.append('g').attr('class', 'grid');
    const gHighlight = svg.append('rect').attr('class', 'interval-highlight').attr('visibility', 'hidden');
    const gLines = svg.append('g');
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
        const width = container.clientWidth;
        const colors = themeColors();
        const { x, y, f, g, edges } = m;
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
        const series = [];
        if (f)
            series.push({ key: 'truth', label: 'true f', values: f, color: colors['series-2'], width: 1.5 });
        series.push({ key: 'fit', label: m.gLabel, values: g, color: colors['series-1'], width: 2 });
        gLines.selectAll('path').data(series, d => d.key).join('path')
            .attr('fill', 'none')
            .attr('stroke', d => d.color)
            .attr('stroke-width', d => d.width)
            .attr('d', d => line(d.values));

        const items = [{ label: 'data', color: colors.muted, dot: true }, ...series];
        legend.selectAll('span.item').data(items, d => d.label).join(enter => {
            const s = enter.append('span').attr('class', 'item');
            s.append('span').attr('class', 'key');
            s.append('span').attr('class', 'label');
            return s;
        })
            .call(s => s.select('.key')
                .classed('dot', d => Boolean(d.dot))
                .style('background', d => d.color))
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
        rows.push([fmt(model.g[i]), model.gLabel, colors['series-1']]);
        showTooltip(event.pageX, event.pageY, `x = ${fmt(model.x[i])}  (#${i + 1})`, rows);
    });
    overlay.on('pointerleave', () => {
        cross.attr('visibility', 'hidden');
        hideTooltip();
    });

    return { render, highlight };
}
