// Noise-scale estimate from first differences, paper eq. (10).

// Φ⁻¹(0.75)·√2 ≈ 0.9538725524: for white noise with sd σ, yᵢ₊₁ − yᵢ ~ N(0, 2σ²), and the median of
// |N(0, 2σ²)| is σ·√2·Φ⁻¹(0.75).
const MAD_DIFF_SCALE = 0.6744897501960817 * Math.SQRT2;

/**
 * Median of an array (copies; does not modify the input). Mean of the middle pair for even length.
 *
 * @param {ArrayLike<number>} v  non-empty
 * @returns {number}
 */
export function median(v) {
    const a = Float64Array.from(v).sort();
    const m = a.length >> 1;
    return a.length % 2 === 1 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * σ̂ = median(|y₂ − y₁|, …, |yₙ − yₙ₋₁|) / (Φ⁻¹(0.75)·√2)   (eq. 10).
 *
 * Positively biased when there is signal, which only makes Aₙ more conservative. Assumes y is
 * ordered by x.
 *
 * @param {ArrayLike<number>} y  responses ordered by x, length ≥ 2
 * @returns {number}  σ̂, in the units of y
 */
export function sigmaMAD(y) {
    const n = y.length;
    if (n < 2)
        throw new RangeError('sigmaMAD needs at least 2 observations');
    const d = new Float64Array(n - 1);
    for (let i = 1; i < n; i++)
        d[i - 1] = Math.abs(y[i] - y[i - 1]);
    return median(d) / MAD_DIFF_SCALE;
}
