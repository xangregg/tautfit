// App state ⇄ URL hash, for shareable links and reloads.
//
// Only settings that differ from the defaults are written, as readable key=value pairs
// (#source=bumps&method=minTV2&overlays=taut,minTV1). Pasted data goes in `data`, deflate-compressed
// and base64url-encoded, when the result is short enough for a link; larger data is left out and the
// caller says so. Reading validates every value against the same ranges the controls allow and drops
// anything else, so a hand-edited or stale link can never put the app in an impossible state.
// No DOM use: runs in Node for tests (CompressionStream is global in Node ≥ 18 and in browsers).

import { SIGNALS } from '../core/signals.js';
import { METHOD_KEYS, FIT_SHAPE_KEYS } from './methods.js';
import { BAND_KEYS } from './bands.js';

const MAX_DATA_CHARS = 8000; // encoded data longer than this stays out of the link (chat apps truncate long URLs)
const MAX_N = 20000; // simulated sample size cap, matches controls.js
const MAX_COLUMN = 10000; // column index sanity cap
const USER = 'user';
export const VIEWS = ['single', 'gallery']; // one chart with its readouts, or several data sets at once
export const PANE_COUNTS = [4, 6, 8]; // gallery panes, two per row
// Aₙ's shortest interval, a share of the x range; the slider (controls.js) spans less, a link may hold up to this
export const AN_SHARE_RANGE = [0, 0.5];

const enumOf = values => ({
    write: v => String(v),
    read: s => (values.includes(s) ? s : undefined),
});
const num = (min, max = Infinity) => ({
    write: v => String(v),
    read: s => {
        const v = Number(s);
        return s !== '' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
    },
});
const int = (min, max) => ({
    write: v => String(v),
    read: s => {
        const v = Number(s);
        return s !== '' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
    },
});
const bool = {
    write: v => (v ? '1' : '0'),
    read: s => (s === '1' ? true : s === '0' ? false : undefined),
};

// Every persisted state key with its codec. Ranges match the inputs in controls.js. The order is the link's:
// view and panes come last (before only the pasted data), so the settings ahead of them are easier to edit by hand
// in the URL bar; reading does not depend on the order.
const FIELDS = {
    source: enumOf([...Object.keys(SIGNALS), USER]),
    n: int(2, MAX_N),
    sigma: num(0),
    seed: int(-1e9, 1e9),
    showTruth: bool,
    xCol: int(-1, MAX_COLUMN),
    yCol: int(0, MAX_COLUMN),
    tau: num(0.1),
    lambda: num(1.1),
    sigmaFixed: {
        write: v => (v === null ? 'none' : String(v)),
        read: s => {
            if (s === 'none')
                return null;
            const v = Number(s);
            return s !== '' && Number.isFinite(v) && v > 0 ? v : undefined;
        },
    },
    sigmaMethod: enumOf(['diff', 'gsjs']),
    method: enumOf(METHOD_KEYS),
    overlays: {
        write: v => v.join(','),
        read: s => (s === '' ? [] : s.split(',').filter(k => METHOD_KEYS.includes(k))),
    },
    fixExtremes: bool,
    fitShape: enumOf(FIT_SHAPE_KEYS),
    band: enumOf(BAND_KEYS),
    theta: num(1.05),
    kMultiple: num(1, 4),
    tauMode: enumOf(['fixed', 'calibrated']),
    alpha: num(0.5, 0.999),
    calibFamily: enumOf(['chosen', 'all']),
    plugSigma: bool,
    exact: bool,
    boxes: {
        write: v => v,
        read: s => (/^(off|hover|all|level:\d{1,3})$/.test(s) ? s : undefined),
    },
    anShare: num(...AN_SHARE_RANGE),
    view: enumOf(VIEWS),
    // the gallery's sources: simulated signals only (pasted data is one at a time, and a link could not carry several)
    panes: {
        write: v => v.join(','),
        read: s => {
            const list = s.split(',');
            return PANE_COUNTS.includes(list.length) && list.every(p => Boolean(SIGNALS[p])) ? list : undefined;
        },
    },
};
const USER_ONLY = new Set(['xCol', 'yCol']);
const SIMULATED_ONLY = new Set(['n', 'sigma', 'seed', 'showTruth']);
const GALLERY_ONLY = new Set(['panes']);
// every gallery pane is a simulated signal, which uses the seed and may show its true f, whatever the single
// view's source
const GALLERY_SIMULATED = new Set(['seed', 'showTruth']);

// n and σ default to the chosen signal's own values, so a link names them only when changed.
function defaultFor(key, st, defaults) {
    const spec = SIGNALS[st.source];
    if (spec && key === 'n')
        return spec.n;
    if (spec && key === 'sigma')
        return spec.sigma;
    return defaults[key];
}

function same(a, b) {
    return Array.isArray(a) ? Array.isArray(b) && a.join(',') === b.join(',') : a === b;
}

function toBase64Url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++)
        bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, ch => ch.charCodeAt(0));
}

async function pipe(bytes, stream) {
    const out = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(out).arrayBuffer());
}

/**
 * Compress text for a URL: deflate-raw, then base64url.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function packText(text) {
    return toBase64Url(await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw')));
}

/**
 * Inverse of packText.
 *
 * @param {string} packed
 * @returns {Promise<string>}  rejects on malformed input
 */
export async function unpackText(packed) {
    return new TextDecoder().decode(await pipe(fromBase64Url(packed), new DecompressionStream('deflate-raw')));
}

/**
 * The URL hash for a state.
 *
 * @param {object} st        app state (see main.js)
 * @param {object} defaults  the app's initial state
 * @returns {Promise<{hash: string, dataOmitted: number}>}  hash is '' or starts with '#';
 *     dataOmitted = length of pasted text left out of the link (0 if none)
 */
export async function stateToHash(st, defaults) {
    const params = new URLSearchParams();
    const isUser = st.source === USER;
    const isGallery = st.view === 'gallery';
    for (const [key, codec] of Object.entries(FIELDS)) {
        const forGallery = isGallery && GALLERY_SIMULATED.has(key);
        if ((USER_ONLY.has(key) && !isUser) || (SIMULATED_ONLY.has(key) && isUser && !forGallery)
            || (GALLERY_ONLY.has(key) && !isGallery))
            continue;
        const value = st[key];
        if (value === undefined || (value === null && key !== 'sigmaFixed'))
            continue;
        if (!same(value, defaultFor(key, st, defaults)))
            params.set(key, codec.write(value));
    }
    let dataOmitted = 0;
    if (isUser && st.userText) {
        const packed = await packText(st.userText);
        if (packed.length <= MAX_DATA_CHARS)
            params.set('data', packed);
        else
            dataOmitted = st.userText.length;
    }
    const s = params.toString();
    return { hash: s ? `#${s}` : '', dataOmitted };
}

/**
 * State patch from a URL hash: the defaults overridden by every valid value in the hash.
 * Invalid or unknown entries are ignored and listed in `rejected`.
 *
 * @param {string} hash      location.hash ('' or '#…')
 * @param {object} defaults  the app's initial state
 * @returns {Promise<{state: object, rejected: string[]}>}  a complete state
 */
export async function hashToState(hash, defaults) {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    const st = structuredClone(defaults);
    const rejected = [];
    const source = FIELDS.source.read(params.get('source') ?? '');
    if (source !== undefined)
        st.source = source;
    else if (params.has('source'))
        rejected.push('source');
    if (SIGNALS[st.source]) {
        st.n = SIGNALS[st.source].n;
        st.sigma = SIGNALS[st.source].sigma;
    }
    for (const [key, raw] of params) {
        if (key === 'source' || key === 'data')
            continue;
        const codec = FIELDS[key];
        const value = codec ? codec.read(raw) : undefined;
        if (value === undefined)
            rejected.push(key);
        else
            st[key] = value;
    }
    if (params.has('data')) {
        try {
            st.userText = await unpackText(params.get('data'));
        }
        catch {
            rejected.push('data');
        }
    }
    return { state: st, rejected };
}
