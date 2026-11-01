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
    const hexToRgb = hex => [1, 3, 5].map(i => parseInt(hex.trim().slice(i, i + 2), 16));
    const results = [];
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
        const dt = [...document.querySelectorAll('#readouts dt')].find(d => d.innerText === 'violated intervals');
        const violated = Number(dt.nextElementSibling.innerText.split(' of ')[0].replace(/,/g, ''));
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
    const srcNow = document.getElementById('source'); // controls are rebuilt when a link is followed
    srcNow.value = 'blocks';
    srcNow.dispatchEvent(new Event('change'));
    return results;
})()
