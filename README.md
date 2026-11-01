# tautfit

An interactive browser app for the nonparametric regression methods of

> P. L. Davies, A. Kovac, M. Meise (2009). Nonparametric regression, confidence regions and regularization.
> *Annals of Statistics* 37(5B):2597–2625. [arXiv:0711.0690](https://arxiv.org/abs/0711.0690)

**Live:** https://xangregg.github.io/tautfit/

Instead of choosing a bandwidth or a penalty, the approach first describes every function that is
consistent with the data, then picks the simplest of them.

- **The confidence region Aₙ.** A function g is consistent with the data when no interval of the data shows a
  systematic residual: |Σ_I (y − g)| / √|I| ≤ σ·√(τ log n) for every interval I in a multiresolution family.
  The residual view under the chart shows that ratio for every interval.
- **Simplest fits in Aₙ.** The taut string (approximately the fewest local extremes), and linear programs for
  least total variation of g, g′ or g″, the smallest bound on |g′| or |g″| (K_min), and a smooth fit with the
  taut string's monotone pieces.
- **Honest confidence bands.** Under a shape assumption (monotone, piecewise monotone, convex/concave,
  piecewise convex, or |f″| ≤ K), Aₙ gives pointwise bounds on f. Fast O(n log n) bounds, plus exact LP
  bounds for small n.
- **Calibration.** τ = 3 by default, or calibrated by Monte Carlo for the actual n and interval family.

You can paste or drop your own CSV data or use the built-in test signals. The address bar holds the current
settings (and small pasted data, compressed), so a link reproduces the view. Fits and bands can be downloaded
as CSV.

## Where this implementation differs from the paper

Corrections to formulas as printed in the arXiv version:

- **Convex lower bound (eq. 67):** a missing division by 1 − (j+1)/(2k) and an index typo; we use a rederived
  bound.
- **Smoothness bounds (eqs. 72–73):** the lower and upper bound labels are swapped.
- **Appendix check (eq. 81):** omits σ and the 1/√|I| factor; we use eq. 7.
- **Interval family (eq. 9):** starts at k = 1, which omits the singleton intervals the text says the family
  contains; we include them.
- **Total variation (eq. 44):** with Δ = n(·), the sum is n times the total variation of the derivative. The
  minimizer is the same; we report the true total variation.

Choices that differ from the paper's algorithm:

- **Taut string initial width:** the paper's starting tube width uses the raw cumulative sums, so adding a
  constant to y changes the fit (beyond the shift). The default uses mean-centered sums, which makes the fit
  shift-equivariant. The paper's version is kept as an option, and it matches the R package ftnonpar's `pmreg`
  to about 1e−12 when pmreg's extra post-processing is turned off.
- **Combined fit (§4.2):** steps inside a taut-string extreme plateau are constrained to rise and then fall
  (split at the plateau's midpoint) instead of being left free; free steps let the fit wiggle inside long
  plateaus.
- **Ties in x:** intervals are intervals of x (as in eq. 6), so tied observations are never split. The noise
  scale uses the spread within tied x (pure error), which makes it independent of the order of tied rows.
- **Noise scale:** besides the paper's first-difference estimate (eq. 10), a trend-robust local linear estimate
  (Gasser, Sroka & Jennen-Steinmetz 1986) is available, with warnings when the two disagree. On small, steep
  data, eq. 10 can inflate σ enough to make Aₙ nearly useless.
- **Convex/concave bands** assume equally spaced x (as the paper says in §5.2.2) and are disabled otherwise;
  the exact LP bounds handle any spacing.

Findings worth knowing:

- **Coverage of τ = 3 (eq. 11):** by simulation, τ = 3 covers ≥ 95% for the dyadic family but only marginally,
  or not at all, over all intervals (93% at n = 500). The fast bands rely on all intervals, so the app states
  which coverage applies to the chosen τ and can calibrate τ for all intervals.

[PLAN.md](PLAN.md) has the full specification, the evidence for each of these (section 2, "Known issues"), and
measured results for every milestone.

## Running locally

No build step: plain ES modules.

```sh
npm install          # dev dependency only (HiGHS for Node tests)
npm test             # node --test
python3 -m http.server 8000    # then open http://localhost:8000/
```

`npm run check:page` and `npm run check:ui` run headless-Chrome checks against the local server.

## Credits

- The implementation was written with [Claude Code](https://claude.com/claude-code), working from a
  specification (PLAN.md) and with review, testing on real data, and direction by Xan Gregg.
- [HiGHS](https://highs.dev) solves the linear programs, via the highs-js WebAssembly build (MIT license,
  vendored in `vendor/highs/`). [D3](https://d3js.org) draws the charts (ISC license, loaded from jsDelivr).

## License

[0BSD](LICENSE) (except `vendor/highs/`, which keeps its MIT license).
