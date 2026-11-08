// In-page UI regression checks, run by `npm run check:ui` (tools/check-page.mjs --eval-file).
// Each failed check calls console.error, which check-page reports as a problem (exit status 1).
//
// 1. For every fit method on the default data: the residual view shows violation cells exactly when
//    the readouts report violated intervals. (Regression: LP optima on the boundary of Aₙ, ratio
//    1 + 1e−13, were painted as violations while the readout, using the solver tolerance, said 0.)
(async () => {
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const until = async (fn, ms = 15000) => {
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
            if (fn())
                return true;
            await wait(25);
        }
        return false;
    };
    // a readout row's value by its label; the label is the dt's first text node (an ⓘ icon may follow it)
    const readoutValue = test => {
        const dt = [...document.querySelectorAll('#readouts dt')].find(d => test(d.firstChild?.nodeValue ?? ''));
        return dt ? dt.nextElementSibling.innerText : null;
    };
    const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.trim().slice(i, i + 2), 16));
    const results = [];

    // 0. Hidden controls are not drawn. (Regression: .field and .check set display, which overrode the hidden
    //    attribute, so the K slider and "pin extremes" showed whatever the band and method.)
    const shownHidden = [...document.querySelectorAll('#controls [hidden]')].filter(e => e.getClientRects().length);
    if (shownHidden.length)
        console.error(`hidden controls drawn: ${shownHidden.map(e => e.textContent.trim().slice(0, 30)).join('; ')}`);
    results.push({ key: 'hidden controls', ok: !shownHidden.length });
    const method = [...document.querySelectorAll('#controls select')]
        .find(s => [...s.options].some(o => o.value === 'combined'));
    for (const key of [...method.options].map(o => o.value)) {
        method.value = key;
        method.dispatchEvent(new Event('change'));
        const settled = await until(() => !document.getElementById('charts').classList.contains('pending'));
        await wait(50);
        if (!settled) {
            console.error(`${key}: fit did not finish`);
            continue;
        }
        const violation = hexToRgb(getComputedStyle(document.documentElement).getPropertyValue('--violation'));
        const cv = document.querySelector('#residual-view canvas');
        const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        let red = 0;
        for (let i = 0; i < px.length; i += 4) {
            if (Math.abs(px[i] - violation[0]) < 6 && Math.abs(px[i + 1] - violation[1]) < 6
                && Math.abs(px[i + 2] - violation[2]) < 6)
                red++;
        }
        const violated = Number(readoutValue(t => t === 'violated intervals').split(' of ')[0].replace(/,/g, ''));
        const ok = (red > 0) === (violated > 0);
        results.push({ key, violated, redPixels: red, ok });
        if (!ok)
            console.error(`${key}: residual view shows ${red} violation pixels but readout says ${violated} violated`);
    }

    // 2. Gap connectors: none for equally spaced data; for data with a wide gap in x, the step fit is
    //    bridged by a dotted connector between the two data points instead of a jump at the midpoint.
    //    (Regression: with x = …, 10, 20, … the taut string was drawn jumping at x = 15.)
    method.value = 'taut';
    method.dispatchEvent(new Event('change'));
    await until(() => !document.getElementById('charts').classList.contains('pending'));
    const connectors = () => [...document.querySelectorAll('#main-chart .gap-connector')].filter(p => p.getAttribute('d'));
    if (connectors().length !== 0)
        console.error('gap connectors drawn for equally spaced data');
    const src = document.getElementById('source');
    src.value = 'user';
    src.dispatchEvent(new Event('change'));
    await wait(50);
    const ta = document.querySelector('#controls textarea');
    ta.value = 'x,y\n1,1\n2,2\n4,4\n6,5\n7,5.6\n8,6\n9,6.2\n10,6.5\n20,8\n21,7\n';
    ta.dispatchEvent(new Event('input'));
    await wait(400);
    let sigma = [...document.querySelectorAll('#controls select')].find(s => [...s.options].some(o => o.value === 'gsjs'));
    sigma.value = 'gsjs';
    sigma.dispatchEvent(new Event('change'));
    await until(() => !document.getElementById('charts').classList.contains('pending'));
    await wait(50);
    const gapOk = connectors().length > 0;
    if (!gapOk)
        console.error('no gap connector for data with a wide gap in x');
    results.push({ key: 'gap connectors', ok: gapOk });

    // 3. A link reproduces the view: leave via another hash, come back, and the readouts match.
    const idle = () => until(() => !document.getElementById('charts').classList.contains('pending'));
    const readoutText = () => document.getElementById('readouts').innerText;
    await wait(400); // the hash is written after a debounce
    const link = location.hash;
    const before = readoutText();
    location.hash = '#source=bumps&method=minTV0';
    await wait(100);
    await idle();
    const away = readoutText();
    location.hash = link;
    await wait(100);
    await idle();
    await wait(50);
    const linkOk = link.includes('data=') && away !== before && readoutText() === before;
    if (!linkOk)
        console.error(`link did not reproduce the view (hash ${link})`);
    results.push({ key: 'link round trip', ok: linkOk });
    sigma = [...document.querySelectorAll('#controls select')].find(s => [...s.options].some(o => o.value === 'gsjs'));
    sigma.value = 'diff';
    sigma.dispatchEvent(new Event('change'));

    // 4. Shape-constrained fit: on data whose early values rise, a decreasing min TV(g′) is not in Aₙ at
    //    τ = 3; the readouts say so and give the smallest τ admitting it (3.575, src/core/shapetest.js).
    const findSelect = value => [...document.querySelectorAll('#controls select')]
        .find(s => [...s.options].some(o => o.value === value));
    const setSelect = (sel, value) => {
        sel.value = value;
        sel.dispatchEvent(new Event('change'));
    };
    const ta2 = document.querySelector('#controls textarea');
    ta2.value = 'age,y\n22.98,0.8226\n24.10,0.4582\n24.29,0.8461\n25.03,0.8975\n25.03,0.9256\n27.83,0.8137\n'
        + '29.69,0.4400\n30.06,0.5755\n30.06,0.9260\n43.11,0.5204\n43.11,0.4924\n44.41,0.4037\n44.97,0.4458\n'
        + '47.20,0.3993\n48.88,0.4181\n49.25,0.5630\n51.30,0.4510\n54.10,0.4045\n61.18,0.4284\n61.93,0.4892\n'
        + '62.11,0.4612\n63.23,0.4099\n63.79,0.4566\n64.72,0.4567\n65.09,0.3680\n65.84,0.5456\n67.70,0.5504\n71.80,0.4713\n';
    ta2.dispatchEvent(new Event('input'));
    await wait(400);
    setSelect(findSelect('minTV2'), 'minTV1');
    setSelect(findSelect('decreasing'), 'decreasing');
    await until(() => /^3\.\d/.test(readoutValue(t => t.endsWith('needs τ ≥')) ?? '')
        && /p [≈<]/.test(readoutText()), 20000);
    const warning = [...document.querySelectorAll('#readouts .warning')].map(w => w.innerText).join(' ');
    const shapeOk = /No decreasing function is in Aₙ at τ = 3; one needs τ ≥ 3\.57/.test(warning);
    if (!shapeOk)
        console.error(`shape test readout missing or wrong: ${warning}`);
    results.push({ key: 'shape test', ok: shapeOk });
    setSelect(findSelect('decreasing'), 'none');
    setSelect(findSelect('minTV2'), 'taut');
    const srcNow = document.getElementById('source'); // controls are rebuilt when a link is followed
    srcNow.value = 'blocks';
    srcNow.dispatchEvent(new Event('change'));
    await idle();

    // 5. Gallery: every pane drawn with a footer and no error, the single view's chart and readouts hidden; ↗
    //    opens a pane's signal in the single view at its own n, with readouts.
    document.querySelector('#view-toggle [data-view=gallery]').click();
    const galleryReady = await until(() => document.body.dataset.ready === 'true', 30000);
    const paneEls = [...document.querySelectorAll('#gallery-grid .pane')];
    const footers = paneEls.map(p => p.querySelector('.pane-summary'));
    const galleryOk = galleryReady && paneEls.length === 4 && footers.every(f => /^n = /.test(f.textContent))
        && !footers.some(f => f.classList.contains('error')) && document.getElementById('readouts').hidden
        && document.getElementById('main-chart').hidden;
    if (!galleryOk)
        console.error(`gallery: ready ${galleryReady}, ${paneEls.length} panes, footers ${footers.map(f => f.textContent).join(' | ')}`);
    results.push({ key: 'gallery', ok: galleryOk });
    paneEls[2].querySelector('.pane-open').click(); // HeaviSine
    await until(() => document.querySelector('#readouts dl') && !document.getElementById('readouts').hidden);
    await idle();
    const openOk = document.getElementById('source').value === 'heavisine' && readoutValue(t => t === 'n') === '1,024';
    if (!openOk)
        console.error(`↗ did not open HeaviSine in the single view (source ${document.getElementById('source').value})`);
    results.push({ key: 'gallery ↗', ok: openOk });
    return results;
})()
