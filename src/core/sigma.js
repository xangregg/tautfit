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

const PHI_INV_075 = 0.6744897501960817; // Φ⁻¹(0.75): median of |N(0, 1)|

/**
 * Trend-robust noise scale from local linear pseudo-residuals (Gasser, Sroka & Jennen-Steinmetz 1986,
 * Biometrika 73:625–633), in a median form for robustness like eq. (10).
 *
 * For interior points with x_{i−1} < x_{i+1}, the pseudo-residual is the gap between yᵢ and the line
 * through its neighbors,
 *     eᵢ = aᵢ y_{i−1} + bᵢ y_{i+1} − yᵢ,   aᵢ = (x_{i+1} − xᵢ)/(x_{i+1} − x_{i−1}),   bᵢ = 1 − aᵢ,
 * scaled by cᵢ = 1/√(aᵢ² + bᵢ² + 1) so that cᵢeᵢ ~ N(0, σ²) when f is linear on [x_{i−1}, x_{i+1}].
 * Then σ̂ = median|cᵢeᵢ| / Φ⁻¹(0.75). A locally linear trend cancels exactly at any spacing, so unlike
 * eq. (10) a steep smooth signal does not inflate it; curvature and jumps still do, less so.
 *
 * @param {ArrayLike<number>} x  sorted (ties allowed; triples with x_{i−1} = x_{i+1} are skipped)
 * @param {ArrayLike<number>} y  responses ordered by x
 * @returns {number}  σ̂, units of y
 */
export function sigmaGSJS(x, y) {
    const n = y.length;
    const r = [];
    for (let i = 1; i + 1 < n; i++) {
        const span = x[i + 1] - x[i - 1];
        if (!(span > 0))
            continue;
        const a = (x[i + 1] - x[i]) / span;
        const b = 1 - a;
        const e = a * y[i - 1] + b * y[i + 1] - y[i];
        r.push(Math.abs(e) / Math.sqrt(a * a + b * b + 1));
    }
    if (r.length === 0)
        throw new RangeError('sigmaGSJS needs at least 3 observations with distinct outer x');
    return median(r) / PHI_INV_075;
}
