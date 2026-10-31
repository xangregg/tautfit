// Residual view: one row per resolution level k of the multiresolution scheme, one cell per interval,
// colored by |w(I)|/c. Cells with ratio > 1 are the constraints of Aₙ that the fit violates. Rows are
// full partitions (multiresolutionLevels), so an interval shared by two levels appears in both rows.

import * as d3 from 'd3';
import { MARGIN, xScale, cellIndex, sizeCanvas } from './layout.js';
import { themeColors } from './theme.js';
import { showTooltip, hideTooltip } from './tooltip.js';

const ROW_H = 13; // px per level
const ROW_GAP = 1; // px between rows
const fmt = d3.format('.4~g');
const fmtRatio = d3.format('.3f');
const byLo = d3.bisector(iv => iv.lo);

/**
 * @typedef {object} ResidualModel
 * @property {Float64Array} x
 * @property {Float64Array} edges
 * @property {{lo: number, hi: number, level: number}[][]} levels  rows (full partitions)
 * @property {Float64Array[]} w       w(I) per interval, per row
 * @property {Float64Array[]} ratios  |w(I)|/c per interval, per row
 * @property {number} [limit=1]       ratio above which a cell is a violation; 1 + solver tolerance for
 *                                    LP fits, whose active constraints sit on the boundary (ratio 1 ± ε)
 */

/**
 * Color scale for |w|/c on [0, 1] from the theme's sequential ramp.
 *
 * @param {Record<string, string>} colors
 */
function ratioColor(colors) {
    return d3.scaleLinear()
        .domain([0, 0.25, 0.5, 0.75, 1])
        .range([colors['seq-0'], colors['seq-1'], colors['seq-2'], colors['seq-3'], colors['seq-4']])
        .interpolate(d3.interpolateLab)
        .clamp(true);
}

/**
 * @param {HTMLElement} container
 * @param {{onHover: function({lo: number, hi: number}|null): void}} handlers
 * @returns {{render: function(ResidualModel): void}}
 */
export function createResidualView(container, { onHover }) {
    container.classList.add('chart');
    const header = d3.select(container).append('div').attr('class', 'legend residual-legend');
    const plot = d3.select(container).append('div').attr('class', 'plot');
    const canvas = plot.append('canvas').node();
    const svg = plot.append('svg');
    const gAxisX = svg.append('g').attr('class', 'axis');
    const gAxisY = svg.append('g').attr('class', 'axis');
    const yTitle = svg.append('text').attr('class', 'axis-title').text('|I|');
    const hover = svg.append('rect').attr('class', 'cell-hover').attr('visibility', 'hidden');
    const overlay = svg.append('rect').attr('class', 'overlay');

    let model = null;
    let sx = null;

    function rowTop(k) {
        return MARGIN.top + k * ROW_H;
    }

    function render(m) {
        model = m;
        hover.attr('visibility', 'hidden');
        const width = container.clientWidth;
        const rows = m.levels.length;
        const height = MARGIN.top + rows * ROW_H + MARGIN.bottom;
        const colors = themeColors();
        const color = ratioColor(colors);
        const limit = m.limit ?? 1;
        sx = xScale(m.edges, width);

        plot.style('height', `${height}px`);
        svg.attr('width', width).attr('height', height);
        overlay.attr('x', MARGIN.left).attr('y', MARGIN.top)
            .attr('width', width - MARGIN.left - MARGIN.right).attr('height', rows * ROW_H);
        gAxisX.attr('transform', `translate(0,${MARGIN.top + rows * ROW_H})`)
            .call(d3.axisBottom(sx).ticks(width / 90).tickSizeOuter(0));
        // Row labels: interval length of the row's first cell (exact for λ = 2 except a short last cell).
        const sy = d3.scaleBand().domain(d3.range(rows)).range([MARGIN.top, MARGIN.top + rows * ROW_H]);
        gAxisY.attr('transform', `translate(${MARGIN.left},0)`)
            .call(d3.axisLeft(sy).tickSize(0).tickPadding(6)
                .tickFormat(k => String(m.levels[k][0].hi - m.levels[k][0].lo + 1)));
        gAxisY.select('.domain').remove();
        yTitle.attr('x', 4).attr('y', MARGIN.top + rows * ROW_H / 2).attr('dy', '0.32em');

        const ctx = sizeCanvas(canvas, width, height);
        ctx.clearRect(0, 0, width, height);
        // First pass: every cell in its ratio color. Second pass: violations, at least 1 px wide, so a
        // violating interval narrower than a pixel is never blended away.
        for (let k = 0; k < rows; k++) {
            const level = m.levels[k];
            const ratios = m.ratios[k];
            const y0 = rowTop(k);
            for (let j = 0; j < level.length; j++) {
                const x0 = sx(m.edges[level[j].lo]);
                const x1 = sx(m.edges[level[j].hi + 1]);
                ctx.fillStyle = ratios[j] > limit ? colors.violation : color(ratios[j]);
                ctx.fillRect(x0, y0, x1 - x0, ROW_H - ROW_GAP);
            }
        }
        ctx.fillStyle = colors.violation;
        for (let k = 0; k < rows; k++) {
            const level = m.levels[k];
            const ratios = m.ratios[k];
            for (let j = 0; j < level.length; j++) {
                if (ratios[j] <= limit)
                    continue;
                const x0 = sx(m.edges[level[j].lo]);
                const x1 = sx(m.edges[level[j].hi + 1]);
                ctx.fillRect(x0, rowTop(k), Math.max(1, x1 - x0), ROW_H - ROW_GAP);
            }
        }

        renderLegend(colors, color);
    }

    function renderLegend(colors, color) {
        header.selectAll('*').remove();
        header.append('span').attr('class', 'legend-title').text('Residual view: |w(I)| / c per interval');
        const ramp = header.append('span').attr('class', 'item');
        ramp.append('span').attr('class', 'ramp-end').text('0');
        ramp.append('span').attr('class', 'ramp')
            .style('background', `linear-gradient(to right, ${d3.range(0, 1.0001, 0.125).map(color).join(', ')})`);
        ramp.append('span').attr('class', 'ramp-end').text('1');
        const v = header.append('span').attr('class', 'item');
        v.append('span').attr('class', 'key').style('background', colors.violation);
        v.append('span').attr('class', 'label').text('> 1: violation (g ∉ Aₙ)');
    }

    function locate(event) {
        const [px, py] = d3.pointer(event);
        const k = Math.floor((py - MARGIN.top) / ROW_H);
        if (k < 0 || k >= model.levels.length)
            return null;
        const i = cellIndex(model.edges, sx.invert(px));
        const level = model.levels[k];
        const j = byLo.right(level, i) - 1;
        return { k, j };
    }

    overlay.on('pointermove', event => {
        if (!model)
            return;
        const hit = locate(event);
        if (!hit)
            return;
        const { k, j } = hit;
        const iv = model.levels[k][j];
        const ratio = model.ratios[k][j];
        const w = model.w[k][j];
        const x0 = sx(model.edges[iv.lo]);
        const x1 = sx(model.edges[iv.hi + 1]);
        hover.attr('visibility', 'visible')
            .attr('x', x0 - 0.5).attr('width', Math.max(1, x1 - x0) + 1)
            .attr('y', rowTop(k) - 0.5).attr('height', ROW_H - ROW_GAP + 1);
        const len = iv.hi - iv.lo + 1;
        const where = len === 1
            ? `x = ${fmt(model.x[iv.lo])}`
            : `x ∈ [${fmt(model.x[iv.lo])}, ${fmt(model.x[iv.hi])}]`;
        const sign = w > 0 ? 'data above fit on average' : w < 0 ? 'data below fit on average' : '';
        showTooltip(event.pageX, event.pageY, `${where}  (#${iv.lo + 1}–${iv.hi + 1}, |I| = ${len})`, [
            [fmtRatio(ratio), '|w(I)| / c'],
            [fmt(w), `w(I)${sign ? ` · ${sign}` : ''}`],
        ], ratio > (model.limit ?? 1) ? 'Violation: this constraint of Aₙ fails'
            : ratio >= 1 ? 'On the boundary of Aₙ (an active LP constraint, within solver tolerance)' : undefined,
        ratio > (model.limit ?? 1));
        onHover(iv);
    });
    overlay.on('pointerleave', () => {
        hover.attr('visibility', 'hidden');
        hideTooltip();
        onHover(null);
    });

    return { render };
}
