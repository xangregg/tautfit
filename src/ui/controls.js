// Control panel. Plain DOM; every change is reported as a partial state patch via onChange. Explanations sit
// behind ⓘ icons (info.js) to keep the panel compact; text that depends on the state is updated in them by sync.
// What stays visible: labels, inputs, computed values (calibrated τ, K) and the reasons a control is unavailable.

import { SIGNALS } from '../core/signals.js';
import { METHODS, METHOD_KEYS, FIT_SHAPES, FIT_SHAPE_KEYS, takesShape } from './methods.js';
import { BANDS, BAND_KEYS } from './bands.js';
import { infoIcon, setInfo } from './info.js';

const K_MULT_MIN = 1; // K slider range, multiples of the fast K_min
const K_MULT_MAX = 4;
const K_MULT_STEP = 0.05;
const EXACT_MAX_N = 300; // matches main.js
const CALIBRATE_ALL_MAX_N = 2000; // matches main.js

const DEBOUNCE = 200; // ms for typed numeric input
const MAX_N = 20000; // simulated sample size cap
const USER = 'user';

const TIPS = {
    dataHead: 'The observations to fit: a simulated signal with Gaussian noise, or your own data.',
    source: 'Where the data come from:\n'
        + '- **Simulated**: a signal from the paper or the Donoho–Johnstone test set, at x = i/n, with Gaussian noise '
        + 'added. Choosing one sets n and σ to its usual values.\n'
        + '- **Your data**: CSV or TSV pasted or dropped on the box, or a file chosen; a header row is optional.',
    n: 'Number of observations.',
    sigma: 'Standard deviation of the Gaussian noise added to the signal.',
    seed: 'Seed of the simulated noise: the same seed gives the same data. New seed draws another sample.',
    showTruth: 'Draw the signal the data were simulated from, so you can see whether the fit and the band find it.',
    xCol: 'The column for x; (row number) uses the order of the rows. Rows are sorted by x, and rows with a '
        + 'missing x or y are dropped.',
    yCol: 'The column for y.',
    regionHead: 'Aₙ is the set of functions whose residuals look like noise: on every interval I of the family, '
        + '|w(I)|, the sum of the residuals over I divided by √|I|, is at most c = σ·√(τ log n) (eq. 7). Every fit '
        + 'below is the simplest function in Aₙ by its own measure.',
    tauMode: 'How the threshold c is set:\n'
        + '- **Fixed τ**: the τ given. The paper\'s default, 3, gives the dyadic family coverage of at least 0.95 '
        + 'for n ≥ 500 (eq. 11); at smaller n it covers less.\n'
        + '- **Calibrated**: τ is chosen by Monte Carlo on pure noise for this n and design, so that Aₙ contains f '
        + 'with probability α.',
    tau: 'Aₙ\'s threshold is c = σ·√(τ·log n). A larger τ gives a larger Aₙ, so simpler fits and wider bands. The '
        + 'paper\'s default is 3.',
    alpha: 'The coverage τ is calibrated for: the probability that Aₙ contains f.',
    calibFamily: 'The intervals the calibration simulates:\n'
        + '- **λ family**: the intervals Aₙ checks, so that Aₙ itself has coverage α.\n'
        + '- **All intervals**: every interval of observations. The fast bands derive bounds from windows outside the '
        + 'λ family, so their coverage is α only with this τ, which is larger.\n'
        + `All intervals is available for n ≤ ${CALIBRATE_ALL_MAX_N}.`,
    plugSigma: 'Estimate σ in each simulated sample too, with the σ estimate chosen, so that the calibrated τ allows '
        + 'for the error in σ̂. Otherwise σ is taken as known.',
    lambda: 'The scale of the interval family (eq. 9): at level k, the observations are cut into consecutive blocks '
        + 'of about λᵏ, for k = 0 (single observations) up to the whole range. λ = 2 gives the dyadic blocks; a '
        + 'larger λ gives fewer intervals.',
    sigmaMethod: 'How σ is estimated from the data:\n'
        + '- **First differences (eq. 10)**: the paper\'s default, median |yᵢ₊₁ − yᵢ| / (Φ⁻¹(0.75)·√2). A steep '
        + 'trend between neighbors inflates it.\n'
        + '- **Local linear (GSJS)**: the residual of each observation from the line through its two neighbors '
        + '(Gasser, Sroka & Jennen-Steinmetz 1986), so a locally linear trend cancels.\n'
        + 'With tied x, the spread within ties is pooled in; with enough ties, both use only that spread (pure '
        + 'error).',
    sigmaFixed: 'Use the σ given instead of an estimate from the data, for example when the noise level is known.',
    boxes: 'Each box spans an interval of Aₙ\'s family, at the mean of y there ± c/√|I| (eq. 7). Its tick is the '
        + 'fit\'s mean over the interval, which must lie inside; a tick outside is a violated interval.\n'
        + '- **Off**: no boxes.\n'
        + '- **Row hovered**: the level under the pointer in the residual view.\n'
        + '- **Level**: one level of the family, by its interval length.\n'
        + '- **All levels**: every interval, as faint outlines.',
    fitHead: 'The simplest function in Aₙ: the fewest local extremes, or the least total variation or bound of a '
        + 'derivative.',
    method: 'Each method takes the simplest function in Aₙ by its own measure:\n'
        + METHOD_KEYS.map(key => `- **${METHODS[key].label}**: ${METHODS[key].note}.`).join('\n'),
    fitShape: 'The simplest function in Aₙ that also has this shape. When none has it, the unconstrained fit is '
        + 'shown, with the smallest τ that would admit the shape.',
    fixExtremes: 'The combined fit keeps the taut string\'s monotone pieces. Checked, it also takes the taut '
        + 'string\'s values at its local extremes, as in the paper\'s Fig. 2.',
    overlays: 'Draw other methods\' fits as well, each in its method\'s color, for comparison.',
    bandHead: 'Bounds on f at each x that hold whenever f is in Aₙ and has the shape or smoothness assumed (§5.2–5.3).',
    band: 'What the band assumes about f:\n'
        + BAND_KEYS.map(key => `- **${BANDS[key].label}**: ${BANDS[key].note || 'no band'}.`).join('\n') + '\n'
        + 'Convex, concave, piecewise convex/concave and ‖g″‖∞ ≤ K need equally spaced x, since they use the '
        + 'symmetry of the indices.',
    k: 'The bound K on |g″|, in x units, as a multiple of K_min, the smallest K for which the band is not empty. A '
        + 'larger K assumes less and widens the band.',
    theta: 'The fast bounds use windows whose radii grow by the factor θ (eqs. 61, 71), so they take O(n log n) '
        + 'time. A θ nearer 1 uses more windows: tighter bounds, more time.',
    exact: '2n linear programs, the smallest and largest value at each x over Aₙ ∩ the shape (§5.2.1), solved in the '
        + 'worker and drawn dashed: as tight as Aₙ with the λ family allows, where the fast bounds are quicker '
        + 'approximations on other windows.',
};

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

/**
 * A labeled control. tip: the explanation behind an ⓘ after the label, a string or an icon from infoIcon (to
 * update it later). extra: nodes after the input that stay visible (a computed value, why it is unavailable).
 */
function field(labelText, input, tip, ...extra) {
    const head = el('span', { class: 'field-label' }, [labelText]);
    if (tip)
        head.append(tip instanceof Node ? tip : infoIcon(tip, labelText));
    return el('label', { class: 'field' }, [head, input, ...extra]);
}

function check(input, labelText, tip) {
    return el('label', { class: 'check' }, [input, ` ${labelText}`, infoIcon(tip, labelText)]);
}

function heading(text, tip) {
    return el('h2', {}, [text, infoIcon(tip, text)]);
}

/** A short line under a control that stays visible: a computed value, or (warn) why the control is limited. */
function note(warn = false) {
    return el('span', { class: warn ? 'field-note warn' : 'field-note' });
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
        el('div', { class: 'row' }, [field('n', nInput, TIPS.n), field('noise σ', sigmaInput, TIPS.sigma)]),
        el('div', { class: 'row' }, [field('seed', seedInput, TIPS.seed), newSeed]),
        check(truth, 'show true f', TIPS.showTruth),
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
        el('div', { class: 'row' }, [field('x column', xCol, TIPS.xCol), field('y column', yCol, TIPS.yCol)]),
    ]);

    // --- confidence region
    const tauInput = numberInput('tau', { min: 0.1, step: 0.1 });
    const tauFixedRadio = el('input', { type: 'radio', name: 'tau-mode', checked: state.tauMode === 'fixed' });
    const tauCalRadio = el('input', { type: 'radio', name: 'tau-mode', checked: state.tauMode === 'calibrated' });
    tauFixedRadio.addEventListener('change', () => onChange({ tauMode: 'fixed' }));
    tauCalRadio.addEventListener('change', () => onChange({ tauMode: 'calibrated' }));
    const alphaInput = numberInput('alpha', { min: 0.5, max: 0.999, step: 0.01 });
    const calFamily = el('select', {}, [
        el('option', { value: 'chosen', text: 'λ family' }),
        el('option', { value: 'all', text: 'all intervals' }),
    ]);
    calFamily.value = state.calibFamily;
    calFamily.addEventListener('change', () => onChange({ calibFamily: calFamily.value }));
    const plug = el('input', { type: 'checkbox', checked: state.plugSigma });
    plug.addEventListener('change', () => onChange({ plugSigma: plug.checked }));
    const calBox = el('div', { class: 'group' }, [
        el('div', { class: 'row' }, [
            field('α (coverage)', alphaInput, TIPS.alpha),
            field('calibrate for', calFamily, TIPS.calibFamily),
        ]),
        check(plug, 'include estimating σ', TIPS.plugSigma),
    ]);
    const tauValue = note();
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
        el('option', { value: 'gsjs', text: 'local linear (GSJS)' }),
    ]);
    sigmaMethod.value = state.sigmaMethod;
    const sigmaNote = note(true);
    sigmaMethod.addEventListener('change', () => onChange({ sigmaMethod: sigmaMethod.value }));
    sigmaFixed.addEventListener('change', sendSigmaFixed);
    sigmaFixedValue.addEventListener('input', sendSigmaFixed);

    const method = el('select', {}, METHOD_KEYS.map(key => el('option', { value: key, text: METHODS[key].label })));
    method.value = state.method;
    method.addEventListener('change', () => onChange({ method: method.value }));
    const fitShape = el('select', {}, FIT_SHAPE_KEYS.map(key => el('option', { value: key, text: FIT_SHAPES[key].label })));
    fitShape.value = state.fitShape;
    fitShape.addEventListener('change', () => onChange({ fitShape: fitShape.value }));
    const fitShapeInfo = infoIcon(TIPS.fitShape, 'the shape constraint');
    const fixExtremes = el('input', { type: 'checkbox', checked: state.fixExtremes });
    fixExtremes.addEventListener('change', () => onChange({ fixExtremes: fixExtremes.checked }));
    const fixBox = check(fixExtremes, 'pin extremes (Fig. 2)', TIPS.fixExtremes);

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
    const bandNote = note(true);
    const thetaInput = numberInput('theta', { min: 1.05, step: 0.05 });
    const kMult = el('input', {
        type: 'range', min: String(K_MULT_MIN), max: String(K_MULT_MAX), step: String(K_MULT_STEP),
        value: String(state.kMultiple),
    });
    const kLabel = note();
    kMult.addEventListener('input', () => later({ kMultiple: Number(kMult.value) }));
    const exactCheck = el('input', { type: 'checkbox', checked: state.exact });
    exactCheck.addEventListener('change', () => onChange({ exact: exactCheck.checked }));
    const exactNote = note(true);
    const exactBox = el('div', {}, [
        check(exactCheck, 'also exact LP bounds', TIPS.exact), exactNote,
    ]);
    const kBox = field('K (× K_min)', kMult, TIPS.k, kLabel);

    container.append(
        heading('Data', TIPS.dataHead),
        field('dataset', source, TIPS.source),
        simBox,
        userBox,
        heading('Confidence region Aₙ', TIPS.regionHead),
        el('div', { class: 'radio-row' }, [
            el('label', {}, [tauFixedRadio, ' fixed τ']),
            el('label', {}, [tauCalRadio, ' calibrated']),
            infoIcon(TIPS.tauMode, 'fixed or calibrated τ'),
        ]),
        field('τ', tauInput, TIPS.tau),
        calBox,
        tauValue,
        field('λ', lambdaInput, TIPS.lambda),
        field('σ estimate', sigmaMethod, TIPS.sigmaMethod, sigmaNote),
        check(sigmaFixed, 'fix σ', TIPS.sigmaFixed),
        sigmaFixedValue,
        field('Aₙ boxes on the chart', boxes, TIPS.boxes),
        heading('Fit', TIPS.fitHead),
        field('method', method, TIPS.method),
        field('constrain the fit to be', fitShape, fitShapeInfo),
        fixBox,
        el('span', { class: 'field-label' }, ['also show', infoIcon(TIPS.overlays, 'also show')]),
        overlays,
        heading('Confidence band', TIPS.bandHead),
        field('assume f is', band, TIPS.band, bandNote),
        kBox,
        field('θ', thetaInput, TIPS.theta),
        exactBox,
    );

    let lastColumns = null;
    let lastLevelSizes = null;
    function sync(st, { columns, equallySpaced = true, kMin = null, n = 0, tau = null, levelLabels = [], pureErrorOnly = false }) {
        sigmaMethod.disabled = pureErrorOnly;
        sigmaNote.hidden = !pureErrorOnly;
        sigmaNote.textContent = 'enough tied x: both estimates use the spread within tied x (pure error)';
        const sizesKey = levelLabels.join(',');
        if (sizesKey !== lastLevelSizes) {
            lastLevelSizes = sizesKey;
            boxes.replaceChildren(
                el('option', { value: 'off', text: 'Off' }),
                el('option', { value: 'hover', text: 'Row hovered in the residual view' }),
                ...levelLabels.map((label, k) => el('option', { value: `level:${k}`, text: `Level: ${label}` })),
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
        fixBox.hidden = st.method !== 'combined';
        fitShape.disabled = !takesShape(st.method);
        setInfo(fitShapeInfo, TIPS.fitShape + '\n' + (takesShape(st.method)
            ? 'The LP overlays get the shape too.'
            : st.method === 'combined' ? 'Not for the combined fit, which takes its shape from the taut string.'
                : 'For the LP methods only; min TV(g) gives a step fit like the taut string.'));
        for (const [key, { label }] of overlayChecks)
            label.hidden = key === st.method;
        for (const opt of band.options) {
            const needs = BANDS[opt.value].needsEqual;
            opt.disabled = needs && !equallySpaced;
            opt.title = opt.disabled ? 'needs equally spaced x' : '';
        }
        bandNote.hidden = !(BANDS[st.band].needsEqual && !equallySpaced);
        bandNote.textContent = 'needs equally spaced x; choose another band';
        kBox.hidden = st.band !== 'smooth';
        const calibrated = st.tauMode === 'calibrated';
        tauInput.disabled = calibrated;
        calBox.hidden = !calibrated;
        tauValue.hidden = !calibrated;
        tauValue.textContent = calibrated && tau !== null ? `calibrated τ = ${tau.toPrecision(4)}` : '';
        calFamily.options[1].disabled = n > CALIBRATE_ALL_MAX_N;
        exactBox.hidden = st.band === 'none';
        exactCheck.disabled = n > EXACT_MAX_N;
        exactNote.hidden = n <= EXACT_MAX_N;
        exactNote.textContent = `available for n ≤ ${EXACT_MAX_N} (2n LPs)`;
        kLabel.textContent = kMin === null ? ''
            : `K = ${(st.kMultiple * kMin).toPrecision(4)} (${st.kMultiple}× K_min = ${kMin.toPrecision(4)}, x units)`;
    }

    return { sync };
}
