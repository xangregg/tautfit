// Fit methods offered in the UI. Each method keeps one color (a CSS token) whether it is the primary
// fit or an overlay, so color always identifies the method.

const LP_EXTREMES_TOL = 1e-7; // relative tolerance for runs/extremes of LP solutions (solver tol ~1e−7)

/**
 * @typedef {object} MethodSpec
 * @property {string} label       control label
 * @property {string} name        short name for legends, tooltips and readouts
 * @property {string} color       CSS custom property (without --)
 * @property {boolean} step       piecewise constant: draw as steps over the cells
 * @property {null|{method: string, k?: number}} lp  regularize() spec, or null for local methods
 * @property {number} extremesTol relative tolerance for counting extremes
 * @property {string} note        one-line description
 */

/** @type {Record<string, MethodSpec>} */
export const METHODS = {
    taut: {
        label: 'Taut string', name: 'taut string', color: 'fit-taut', step: true, lp: null,
        extremesTol: 1e-9, note: 'fewest local extremes in Aₙ (§3.2)',
    },
    constant: {
        label: 'Constant', name: 'constant mean(y)', color: 'fit-constant', step: true, lp: null,
        extremesTol: 1e-9, note: 'the simplest candidate; in Aₙ only if no signal is detected',
    },
    minTV0: {
        label: 'min TV(g)', name: 'min TV(g)', color: 'fit-minTV0', step: true,
        lp: { method: 'minTV', k: 0 }, extremesTol: LP_EXTREMES_TOL,
        note: 'least total variation; piecewise constant, close to the taut string (§4.1)',
    },
    minTV1: {
        label: 'min TV(g′)', name: 'min TV(g′)', color: 'fit-minTV1', step: false,
        lp: { method: 'minTV', k: 1 }, extremesTol: LP_EXTREMES_TOL,
        note: 'least total variation of the slope; a linear spline (§4.1)',
    },
    minTV2: {
        label: 'min TV(g″)', name: 'min TV(g″)', color: 'fit-minTV2', step: false,
        lp: { method: 'minTV', k: 2 }, extremesTol: LP_EXTREMES_TOL,
        note: 'least total variation of the curvature; smooth (§4.1)',
    },
    minSup1: {
        label: 'min ‖g′‖∞', name: 'min ‖g′‖∞', color: 'fit-minSup1', step: false,
        lp: { method: 'minSup', k: 1 }, extremesTol: LP_EXTREMES_TOL,
        note: 'smallest maximum slope (eq. 46); not unique, may wiggle below the bound',
    },
    minSup2: {
        label: 'min ‖g″‖∞ (K_min)', name: 'min ‖g″‖∞', color: 'fit-minSup2', step: false,
        lp: { method: 'minSup', k: 2 }, extremesTol: LP_EXTREMES_TOL,
        note: 'smallest bound on |g″| (eq. 46, gives K_min); not unique, may wiggle',
    },
    combined: {
        label: 'min TV(g″) + taut-string shape', name: 'min TV(g″) + shape', color: 'fit-combined', step: false,
        lp: { method: 'combined' }, extremesTol: LP_EXTREMES_TOL,
        note: 'smooth, with the taut string’s monotone pieces (§4.2, Fig. 2)',
    },
};

export const METHOD_KEYS = Object.keys(METHODS);

/**
 * Shape constraints for the fit: the simplest function in Aₙ that also has the shape. They apply to the
 * LP methods except `combined`, which takes its shape from the taut string.
 *
 * @type {Record<string, {label: string, name: string, shape: import('../core/lp-build.js').Shape|null}>}
 */
export const FIT_SHAPES = {
    none: { label: 'None', name: '', shape: null },
    constant: { label: 'Constant', name: 'constant', shape: { type: 'constant' } },
    linear: { label: 'Linear (a + b·x)', name: 'linear', shape: { type: 'linear' } },
    decreasing: { label: 'Decreasing', name: 'decreasing', shape: { type: 'monotone', direction: -1 } },
    increasing: { label: 'Increasing', name: 'increasing', shape: { type: 'monotone', direction: 1 } },
    convex: { label: 'Convex', name: 'convex', shape: { type: 'convex' } },
    concave: { label: 'Concave', name: 'concave', shape: { type: 'convex', concave: true } },
};

export const FIT_SHAPE_KEYS = Object.keys(FIT_SHAPES);

/**
 * Whether a shape constraint applies to a method.
 *
 * @param {string} methodKey
 * @returns {boolean}
 */
export function takesShape(methodKey) {
    return Boolean(METHODS[methodKey].lp) && methodKey !== 'combined';
}
