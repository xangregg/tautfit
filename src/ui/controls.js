// Control panel. Plain DOM; every change is reported as a partial state patch via onChange.

import { SIGNALS } from '../core/signals.js';
import { METHODS, METHOD_KEYS } from './methods.js';
import { BANDS, BAND_KEYS } from './bands.js';

const K_MULT_MIN = 1; // K slider range, multiples of the fast K_min
const K_MULT_MAX = 4;
const K_MULT_STEP = 0.05;
const EXACT_MAX_N = 300; // matches main.js
const CALIBRATE_ALL_MAX_N = 2000; // matches main.js

const DEBOUNCE = 200; // ms for typed numeric input
const MAX_N = 20000; // simulated sample size cap
const USER = 'user';

function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text')
            node.textContent = v;
        else if (k in node && typeof v !== 'string')
            node[k] = v;
        else
            node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
}

function field(labelText, input, hint) {
    const children = [el('span', { class: 'field-label', text: labelText }), input];
    if (hint)
        children.push(el('span', { class: 'field-hint', text: hint }));
    return el('label', { class: 'field' }, children);
}

function debounce(fn, ms) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

/**
 * Build the controls.
 *
 * @param {HTMLElement} container
 * @param {object} state    initial state (see main.js)
 * @param {function(object): void} onChange  receives a partial state patch
 * @returns {{sync: function(object, {columns: string[]}): void}}  refresh dynamic parts
 */
export function createControls(container, state, onChange) {
    const later = debounce(onChange, DEBOUNCE);
    const numberInput = (key, attrs, parse = Number) => {
        const input = el('input', { type: 'number', value: String(state[key]), ...attrs });
        input.addEventListener('input', () => {
            const v = parse(input.value);
            if (Number.isFinite(v) && input.checkValidity())
                later({ [key]: v });
        });
        return input;
    };

    // --- data source
    const source = el('select', { id: 'source' });
    const sim = el('optgroup', { label: 'Simulated' });
    for (const [key, spec] of Object.entries(SIGNALS))
        sim.append(el('option', { value: key, text: spec.label }));
    source.append(sim, el('option', { value: USER, text: 'Your data (paste or drop CSV)' }));
    source.value = state.source;
    source.addEventListener('change', () => {
        const patch = { source: source.value };
        const spec = SIGNALS[source.value];
        if (spec) {
            patch.n = spec.n;
            patch.sigma = spec.sigma;
            nInput.value = String(spec.n);
            sigmaInput.value = String(spec.sigma);
        }
        onChange(patch);
    });

    const nInput = numberInput('n', { min: 2, max: MAX_N, step: 1 }, v => Math.round(Number(v)));
    const sigmaInput = numberInput('sigma', { min: 0, step: 'any' });
    const seedInput = numberInput('seed', { step: 1 }, v => Math.round(Number(v)));
    const newSeed = el('button', { type: 'button', text: 'New seed' });
    newSeed.addEventListener('click', () => {
        const seed = Math.floor(Math.random() * 1e6);
        seedInput.value = String(seed);
        onChange({ seed });
    });
    const truth = el('input', { type: 'checkbox', checked: state.showTruth });
    truth.addEventListener('change', () => onChange({ showTruth: truth.checked }));
    const simBox = el('div', { class: 'group' }, [
        field('n', nInput),
        field('noise σ', sigmaInput),
        el('div', { class: 'row' }, [field('seed', seedInput), newSeed]),
        el('label', { class: 'check' }, [truth, ' show true f']),
    ]);

    const text = el('textarea', {
        rows: 6, spellcheck: false,
        placeholder: 'Paste CSV/TSV here or drop a file. A header row is optional.',
    });
    text.value = state.userText;
    text.addEventListener('input', () => later({ userText: text.value }));
    const loadText = t => {
        text.value = t;
        onChange({ userText: t, xCol: null, yCol: null });
    };
    text.addEventListener('dragover', e => e.preventDefault());
    text.addEventListener('drop', async e => {
        e.preventDefault();
        const file = e.dataTransfer?.files?.[0];
        if (file)
            loadText(await file.text());
    });
    const file = el('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain' });
    file.addEventListener('change', async () => {
        if (file.files[0])
            loadText(await file.files[0].text());
    });
    const xCol = el('select');
    const yCol = el('select');
    xCol.addEventListener('change', () => onChange({ xCol: Number(xCol.value) }));
    yCol.addEventListener('change', () => onChange({ yCol: Number(yCol.value) }));
    const userBox = el('div', { class: 'group' }, [
        text, file,
        field('x column', xCol),
        field('y column', yCol),
    ]);

    // --- confidence region
    const tauInput = numberInput('tau', { min: 0.1, step: 0.1 });
    const tauFixedRadio = el('input', { type: 'radio', name: 'tau-mode', checked: state.tauMode === 'fixed' });
    const tauCalRadio = el('input', { type: 'radio', name: 'tau-mode', checked: state.tauMode === 'calibrated' });
    tauFixedRadio.addEventListener('change', () => onChange({ tauMode: 'fixed' }));
    tauCalRadio.addEventListener('change', () => onChange({ tauMode: 'calibrated' }));
    const alphaInput = numberInput('alpha', { min: 0.5, max: 0.999, step: 0.01 });
    const calFamily = el('select', {}, [
        el('option', { value: 'chosen', text: 'the λ family (as Aₙ uses)' }),
        el('option', { value: 'all', text: 'all intervals (fast bands rely on these)' }),
    ]);
    calFamily.value = state.calibFamily;
    calFamily.addEventListener('change', () => onChange({ calibFamily: calFamily.value }));
    const plug = el('input', { type: 'checkbox', checked: state.plugSigma });
    plug.addEventListener('change', () => onChange({ plugSigma: plug.checked }));
    const calBox = el('div', { class: 'group' }, [
        field('α (coverage)', alphaInput),
        field('calibrate for', calFamily),
        el('label', { class: 'check' }, [plug, ' include estimating σ (σ̂ of the noise)']),
    ]);
    const tauValue = el('span', { class: 'field-hint' });
    const boxes = el('select');
    boxes.addEventListener('change', () => onChange({ boxes: boxes.value }));
    const lambdaInput = numberInput('lambda', { min: 1.1, step: 0.1 });
    const sigmaFixed = el('input', { type: 'checkbox', checked: state.sigmaFixed !== null });
    const sigmaFixedValue = el('input', {
        type: 'number', min: 0, step: 'any', value: String(state.sigmaFixed ?? 1),
        disabled: state.sigmaFixed === null,
    });
    const sendSigmaFixed = () => {
        const v = Number(sigmaFixedValue.value);
        sigmaFixedValue.disabled = !sigmaFixed.checked;
        if (!sigmaFixed.checked)
            onChange({ sigmaFixed: null });
        else if (Number.isFinite(v) && v > 0)
            later({ sigmaFixed: v });
    };
    const sigmaMethod = el('select', {}, [
        el('option', { value: 'diff', text: 'first differences (eq. 10)' }),
        el('option', { value: 'gsjs', text: 'local linear residuals (GSJS), trend-robust' }),
    ]);
    sigmaMethod.value = state.sigmaMethod;
    sigmaMethod.addEventListener('change', () => onChange({ sigmaMethod: sigmaMethod.value }));
    sigmaFixed.addEventListener('change', sendSigmaFixed);
    sigmaFixedValue.addEventListener('input', sendSigmaFixed);

    const method = el('select', {}, METHOD_KEYS.map(key => el('option', { value: key, text: METHODS[key].label })));
    method.value = state.method;
    const methodHint = el('span', { class: 'field-hint' });
    method.addEventListener('change', () => onChange({ method: method.value }));
    const fixExtremes = el('input', { type: 'checkbox', checked: state.fixExtremes });
    fixExtremes.addEventListener('change', () => onChange({ fixExtremes: fixExtremes.checked }));
    const fixBox = el('label', { class: 'check' }, [fixExtremes, ' pin extremes to the taut string’s values (Fig. 2)']);

    const overlayChecks = new Map();
    const overlays = el('div', { class: 'overlays' });
    for (const key of METHOD_KEYS) {
        const box = el('input', { type: 'checkbox', checked: state.overlays.includes(key) });
        box.addEventListener('change', () => {
            const keys = METHOD_KEYS.filter(k => overlayChecks.get(k).box.checked);
            onChange({ overlays: keys });
        });
        const swatch = el('span', { class: 'swatch' });
        swatch.style.background = `var(--${METHODS[key].color})`;
        const label = el('label', {}, [box, swatch, METHODS[key].name]);
        overlayChecks.set(key, { box, label });
        overlays.append(label);
    }

    const band = el('select', {}, BAND_KEYS.map(key => el('option', { value: key, text: BANDS[key].label })));
    band.value = state.band;
    band.addEventListener('change', () => onChange({ band: band.value }));
    const bandHint = el('span', { class: 'field-hint' });
    const thetaInput = numberInput('theta', { min: 1.05, step: 0.05 });
    const kMult = el('input', {
        type: 'range', min: String(K_MULT_MIN), max: String(K_MULT_MAX), step: String(K_MULT_STEP),
        value: String(state.kMultiple),
    });
    const kLabel = el('span', { class: 'field-hint' });
    kMult.addEventListener('input', () => later({ kMultiple: Number(kMult.value) }));
    const exactCheck = el('input', { type: 'checkbox', checked: state.exact });
    exactCheck.addEventListener('change', () => onChange({ exact: exactCheck.checked }));
    const exactHint = el('span', { class: 'field-hint' });
    const exactBox = el('div', {}, [
        el('label', { class: 'check' }, [exactCheck, ' also exact LP bounds (dashed)']), exactHint,
    ]);
    const kBox = el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'K, in multiples of K_min' }), kMult, kLabel,
    ]);

    container.append(
        el('h2', { text: 'Data' }),
        field('dataset', source),
        simBox,
        userBox,
        el('h2', { text: 'Confidence region Aₙ' }),
        el('div', { class: 'radio-row' }, [
            el('label', {}, [tauFixedRadio, ' fixed τ']),
            el('label', {}, [tauCalRadio, ' calibrated']),
        ]),
        field('τ', tauInput, 'c = σ·√(τ·log n); paper default 3'),
        calBox,
        tauValue,
        field('λ', lambdaInput, 'interval family scale; 2 = dyadic'),
        field('σ estimate', sigmaMethod, 'GSJS: a locally linear trend cancels; eq. 10 is the paper’s default'),
        el('label', { class: 'check' }, [sigmaFixed, ' fix σ instead of estimating it']),
        sigmaFixedValue,
        field('Aₙ boxes on the chart', boxes, 'each box: where the fit’s mean over its x-span must lie (eq. 7)'),
        el('h2', { text: 'Fit' }),
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'method' }), method, methodHint]),
        fixBox,
        el('span', { class: 'field-label', text: 'also show' }),
        overlays,
        el('h2', { text: 'Confidence band' }),
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'assume f is' }), band, bandHint]),
        kBox,
        field('θ', thetaInput, 'window grid ratio for the fast bounds (O(n log n))'),
        exactBox,
    );

    let lastColumns = null;
    let lastLevelSizes = null;
    function sync(st, { columns, equallySpaced = true, kMin = null, n = 0, tau = null, levelSizes = [] }) {
        const sizesKey = levelSizes.join(',');
        if (sizesKey !== lastLevelSizes) {
            lastLevelSizes = sizesKey;
            boxes.replaceChildren(
                el('option', { value: 'off', text: 'Off' }),
                el('option', { value: 'hover', text: 'Row hovered in the residual view' }),
                ...levelSizes.map((size, k) => el('option', { value: `level:${k}`, text: `Level |I| = ${size}` })),
                el('option', { value: 'all', text: 'All levels (faint)' }),
            );
        }
        boxes.value = [...boxes.options].some(o => o.value === st.boxes) ? st.boxes : 'hover';
        const isUser = st.source === USER;
        simBox.hidden = isUser;
        userBox.hidden = !isUser;
        const key = columns.join('\u0000');
        if (key !== lastColumns) {
            lastColumns = key;
            xCol.replaceChildren(el('option', { value: '-1', text: '(row number)' }),
                ...columns.map((name, j) => el('option', { value: String(j), text: name })));
            yCol.replaceChildren(...columns.map((name, j) => el('option', { value: String(j), text: name })));
        }
        xCol.value = String(st.xCol);
        yCol.value = String(st.yCol);
        methodHint.textContent = METHODS[st.method].note;
        fixBox.hidden = st.method !== 'combined';
        for (const [key, { label }] of overlayChecks)
            label.hidden = key === st.method;
        for (const opt of band.options) {
            const needs = BANDS[opt.value].needsEqual;
            opt.disabled = needs && !equallySpaced;
            opt.title = opt.disabled ? 'needs equally spaced x' : '';
        }
        bandHint.textContent = BANDS[st.band].needsEqual && !equallySpaced
            ? 'needs equally spaced x (uses index symmetry); choose another band'
            : BANDS[st.band].note;
        kBox.hidden = st.band !== 'smooth';
        const calibrated = st.tauMode === 'calibrated';
        tauInput.disabled = calibrated;
        calBox.hidden = !calibrated;
        tauValue.hidden = !calibrated;
        tauValue.textContent = calibrated && tau !== null ? `calibrated τ = ${tau.toPrecision(4)}` : '';
        calFamily.options[1].disabled = n > CALIBRATE_ALL_MAX_N;
        exactBox.hidden = st.band === 'none';
        exactCheck.disabled = n > EXACT_MAX_N;
        exactHint.textContent = n > EXACT_MAX_N
            ? `available for n ≤ ${EXACT_MAX_N} (2n LPs)`
            : '2n LPs over Aₙ ∩ shape (§5.2.1), in the worker';
        kLabel.textContent = kMin === null ? ''
            : `K = ${(st.kMultiple * kMin).toPrecision(4)} (${st.kMultiple}× K_min = ${kMin.toPrecision(4)}, x units)`;
    }

    return { sync };
}
