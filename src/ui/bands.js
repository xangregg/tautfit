// Confidence band types offered in the UI (paper §5.2–5.3).

/**
 * @typedef {object} BandSpec
 * @property {string} label
 * @property {string} name        short name for legend/readouts
 * @property {boolean} needsEqual requires equally spaced x (index symmetry / interpolation)
 * @property {string} note
 */

/** @type {Record<string, BandSpec>} */
export const BANDS = {
    none: { label: 'None', name: '', needsEqual: false, note: '' },
    monoUp: {
        label: 'Increasing', name: 'increasing', needsEqual: false,
        note: 'f non-decreasing (eqs. 61–62, monotonized)',
    },
    monoDown: {
        label: 'Decreasing', name: 'decreasing', needsEqual: false,
        note: 'f non-increasing (eqs. 61–62, monotonized)',
    },
    pwMono: {
        label: 'Piecewise monotone (taut-string extremes)', name: 'piecewise monotone', needsEqual: false,
        note: 'extremes at the midpoints of the taut string’s extreme plateaus (§5.2.3)',
    },
    convex: {
        label: 'Convex', name: 'convex', needsEqual: true,
        note: 'f convex (eq. 69 and the corrected lower bound, PLAN Known issue 3)',
    },
    concave: {
        label: 'Concave', name: 'concave', needsEqual: true,
        note: 'f concave (bounds for −y, negated)',
    },
    pwConvex: {
        label: 'Piecewise convex/concave (min TV(g′))', name: 'piecewise convex/concave', needsEqual: true,
        note: 'inflection points from the min TV(g′) linear spline (§5.2.4)',
    },
    smooth: {
        label: '‖g″‖∞ ≤ K', name: '‖g″‖∞ ≤ K', needsEqual: true,
        note: 'smoothness bound (eqs. 72–73 corrected); K must be at least K_min',
    },
};

export const BAND_KEYS = Object.keys(BANDS);
