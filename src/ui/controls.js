// Control panel. Plain DOM; every change is reported as a partial state patch via onChange.

import { SIGNALS } from '../core/signals.js';
import { METHODS, METHOD_KEYS } from './methods.js';

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

    container.append(
        el('h2', { text: 'Data' }),
        field('dataset', source),
        simBox,
        userBox,
        el('h2', { text: 'Confidence region Aₙ' }),
        field('τ', tauInput, 'c = σ·√(τ·log n); paper default 3'),
        field('λ', lambdaInput, 'interval family scale; 2 = dyadic'),
        el('label', { class: 'check' }, [sigmaFixed, ' fix σ instead of σ̂ (eq. 10)']),
        sigmaFixedValue,
        el('h2', { text: 'Fit' }),
        el('label', { class: 'field' }, [el('span', { class: 'field-label', text: 'method' }), method, methodHint]),
        fixBox,
        el('span', { class: 'field-label', text: 'also show' }),
        overlays,
    );

    let lastColumns = null;
    function sync(st, { columns }) {
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
    }

    return { sync };
}
