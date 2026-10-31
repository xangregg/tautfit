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
    return results;
})()
