# PLAN.md — Davies–Kovac–Meise regression explorer

Source: P. L. Davies, A. Kovac, M. Meise (2009). Nonparametric regression, confidence regions and
regularization. Ann. Statist. 37(5B):2597–2625. doi:10.1214/07-AOS575. Preprint: arXiv:0711.0690.
Section/equation numbers below refer to the paper.

Data: pairs (xᵢ, yᵢ), i = 1..n, sorted by x. The paper assumes xᵢ = i/n; see §Unequal spacing and ties.

---

## 1. Mathematical spec

### 1.1 Noise scale (eq. 10)

    σ̂ = median(|y₂ − y₁|, …, |yₙ − yₙ₋₁|) / (Φ⁻¹(0.75)·√2)

Φ⁻¹(0.75)·√2 = 0.9538725524… (hard-code with a comment). Positively biased under signal, which only makes
Aₙ more conservative. Allow a user override of σ.

*Added in M6:* optional trend-robust estimate `sigmaGSJS` (Gasser, Sroka & Jennen-Steinmetz 1986, median
form): pseudo-residuals eᵢ = aᵢy_{i−1} + bᵢy_{i+1} − yᵢ against the line through the neighbors, scaled by
1/√(aᵢ² + bᵢ² + 1); a locally linear trend cancels exactly at any spacing. Motivation: on small, steep data the
inflation is not just conservative but makes Aₙ useless (user example, n = 10: eq. 10 gives 1.05, GSJS 0.12,
c = 2.75 vs 0.32 with y spanning 7). eq. 10 stays the default (on the built-in signals the two agree within ~10%).
Readout warnings: n < 50; σ̂(eq. 10)/σ̂(GSJS) > 1 + 4/√n (≈ 1% false alarms at n = 10, ≈ 0.1% for n ≥ 100 under
pure noise). Calibration plugs in the estimator actually used (none when σ is fixed). At n = 10 with GSJS σ̂ the
calibrated τ is 8.7, i.e. τ = 3 covers only 76%.

*Tied x (M6, after Known issue 14):* both estimators are order-free when x has ties. Pseudo-residuals: pure error
(yᵢ − ȳ_j)·√(k_j/(k_j−1)) within each replicated x (weight (k_j−1)/k_j, i.e. k_j−1 df per group) plus between-x
terms on the x-means (eq. 10: (ȳ_{j+1} − ȳ_j)/√(1/k_j + 1/k_{j+1}); GSJS: sd-scaled local linear residual of the
means), weighted median / Φ⁻¹(0.75). If the replicate df ≥ the number of between-x terms, the between-x terms are
dropped (they only add trend bias). Measured, σ = 1: steep trend with 1–4 replicates, row-order eq. 10 1.63, tie-aware
0.99; pure noise 0.99–1.00; 5% ties ≈ eq. 10. The user's age data (101 rows, 30 ages): row-order eq. 10 ranged
2.62–4.19 over shuffles of tied rows; tie-aware 3.145 for every order. Without ties both are exactly as before.

### 1.2 Interval family 𝓘ₙ (eq. 9, appendix 7.3)

Multiresolution scheme with parameter λ > 1 (default λ = 2 → dyadic blocks). Using 1-based indices,
for k = 0, 1, …, ⌈log n / log λ⌉ and j = 1, …, ⌈n / λᵏ⌉:

    l(j,k) = ⌊(j−1)·λᵏ⌋ + 1,   u(j,k) = min(⌊j·λᵏ⌋, n)

Keep only non-empty intervals (l ≤ u), dedupe. **Include k = 0** (all singletons); see Known issues.
Also provide `allIntervals(n)` (every [i, j], ~n²/2) for small n, used only for checking/reference.

Represent an interval as {lo, hi} with 0-based inclusive indices.

*Corrected in M6 (Known issue 14):* the family is built on the **distinct x values** and mapped to observation
ranges (`xIntervalFamily`, `xIntervalLevels`, `allXIntervals`), because the paper's intervals are intervals of x
(eq. 6: I = [t_j, t_k], |I| = number of points in it) and so never separate tied observations. Without ties this
is identical to the index-based family.

### 1.3 Confidence region Aₙ (eqs. 6–8)

For a candidate vector g (values at the design points) and interval I with |I| points:

    w(I) = Σ_{i∈I} (yᵢ − gᵢ) / √|I|

    g ∈ Aₙ  ⇔  max_{I∈𝓘ₙ} |w(I)| ≤ c,   where  c = σ·√(τ·log n)

Default τ = 3 (paper: coverage ≥ 0.95 for n ≥ 500 with σ̂). Use prefix sums so checking is O(|𝓘ₙ|).
Expose per-interval ratios |w(I)|/c for the residual view (ratio > 1 = violation).

Each constraint is linear in g:  Σ_{i∈I} yᵢ − c√|I|  ≤  Σ_{i∈I} gᵢ  ≤  Σ_{i∈I} yᵢ + c√|I|.

### 1.4 Calibrating τ by Monte Carlo (eq. 8) — optional, for small n

For a given family and n, simulate Z ~ N(0,1)ⁿ, compute M = max_I |Σ_{I} Zᵢ|/√|I|, repeat B times
(default 2000, in a worker). Then τₙ(α) = q_α(M)² / log n. Option: plug in σ̂(Z) (i.e. use
M' = max |ΣZ|/(σ̂(Z)√|I|)) to account for estimating σ. Cache results by (n, λ, α).

### 1.5 Taut string with local squeezing (§3.2, appendix 7.3)

Goal: a member of Aₙ with the fewest local extremes. Output f̃ is piecewise constant.

1. Cumulative sums (1-based nodes): Y₀ = 0, Yₖ = Yₖ₋₁ + yₖ.
2. Tube widths λ₀..λₙ with λ₀ = λₙ = 0. Initial interior widths λᵢ = max(Yᶜ) − min(Yᶜ) on the mean-centered
   sums Yᶜᵢ = Yᵢ − i·Yₙ/n (shift-invariant default, decided in M2). The paper uses max(Y) − min(Y) on the raw
   sums; that is available as `initialWidth: 'raw'` and is what the ftnonpar fixture test uses (Known issue 9).
3. Tube: lower Lᵢ = Yᵢ − λᵢ, upper Uᵢ = Yᵢ + λᵢ at nodes i = 0..n, linear between nodes.
4. Taut string F̃: the shortest path from (0, 0) to (n, Yₙ) staying inside the tube.
   f̃ᵢ = F̃(i) − F̃(i−1), i = 1..n.
5. Check Aₙ (§1.3) on the dyadic family. For each interior node i (1..n−1), if *any* violating interval
   contains observation i or i+1, set λᵢ ← squeeze·λᵢ (default squeeze = 0.5). Otherwise keep λᵢ.
6. Repeat 3–5 until no violations (terminates: as λ → 0, f̃ → y, which is always in Aₙ). Cap iterations
   (e.g. 200) and report.

Note the first pass gives a straight string, i.e. f̃ = mean(y) everywhere: if a constant is in Aₙ the
answer is a constant. (This matters for the later "least ambitious fit".)

**Taut string algorithm, O(n).** Funnel / string-pulling between two x-monotone polylines: keep the
current anchor point, a chain of candidate upper-boundary vertices (slopes from anchor decreasing) and a
chain of candidate lower-boundary vertices (slopes increasing). Advance node by node; when the funnel
collapses (the steepest admissible lower slope exceeds the shallowest upper slope), emit the segment to the
front vertex of the blocking chain, make it the new anchor, and restart the chains from there.
Davies & Kovac (2001, appendix) describe an O(n) version. Implement carefully with these test oracles:

- **Reference solver (slow, for tests only):** F̃ is also the unique minimizer of Σ (Fᵢ − Fᵢ₋₁)² subject
  to Lᵢ ≤ Fᵢ ≤ Uᵢ, F₀ = 0, Fₙ = Yₙ (it minimizes Σ φ(Fᵢ − Fᵢ₋₁) for every strictly convex φ). Solve by
  projected Gauss–Seidel: repeat Fᵢ ← clamp((Fᵢ₋₁ + Fᵢ₊₁)/2, Lᵢ, Uᵢ) until max change < 1e−13.
  Fine for n ≤ 200.
- **KKT check (any n):** with f̃ as above, at each interior node i:
  inside the tube (Lᵢ + ε < F̃ᵢ < Uᵢ − ε) ⇒ f̃ᵢ = f̃ᵢ₊₁;
  touching upper (F̃ᵢ = Uᵢ) ⇒ f̃ᵢ ≤ f̃ᵢ₊₁;   *(corrected in M2; this line originally had ≥, see Known issue 8)*
  touching lower (F̃ᵢ = Lᵢ) ⇒ f̃ᵢ ≥ f̃ᵢ₊₁;
  plus feasibility Lᵢ − ε ≤ F̃ᵢ ≤ Uᵢ + ε.

**Counting local extremes:** compress f̃ into runs of equal values (relative tolerance 1e−9); a run is a
local max if both neighbouring runs are lower, a local min if both are higher. Endpoint runs are not
counted. Also return each extreme's plateau [start, end] — used for piecewise-monotone constraints and
bounds.

### 1.6 Smoothness regularization by LP (§4.1–4.2)

Discrete derivatives on t ∈ [0, 1] (rescale x to [0, 1]): with equal spacing Δ⁽¹⁾gᵢ = n(gᵢ − gᵢ₋₁),
Δ⁽ᵏ⁺¹⁾ = Δ⁽¹⁾Δ⁽ᵏ⁾. With unequal spacing use divided differences on the rescaled x.

Problems (all subject to g ∈ Aₙ, §1.3):

- `minTV(k)`, k = 0, 1, 2: minimize TV(g⁽ᵏ⁾) = Σ |Δ⁽ᵏ⁺¹⁾gᵢ| (eq. 44). *(M3: implemented and reported as the
  true total variation Σ|Δ⁽ᵏ⁾gᵢ − Δ⁽ᵏ⁾gᵢ₋₁| ≈ ∫|g⁽ᵏ⁺¹⁾|, which is eq. 44 divided by n; same minimizer, Known issue 10.)*
  LP: auxiliary uᵢ ≥ ±Δ⁽ᵏ⁺¹⁾gᵢ, minimize Σ uᵢ.
  k = 0 → piecewise constant (close to taut string); k = 1 → linear spline (its convex/concave intervals
  give the shape constraints for §1.7 bounds); k = 2 → smoother.
- `minSup(k)`: minimize s subject to −s ≤ Δ⁽ᵏ⁾gᵢ ≤ s (eq. 46). k = 2 also gives K_min for §1.8.
- `combined`: minTV(2) plus monotonicity sign constraints from the taut string (§4.2, Fig. 2):
  for each step i between consecutive observations, sᵢ ∈ {−1, 0, +1} = direction of the monotone segment
  of f̃ containing that step; steps inside an extreme's plateau get 0 (unconstrained). *(M3: changed to split
  each plateau at its midpoint, rising then falling for a max; with free plateau steps the fit wiggled inside
  long plateaus, e.g. 33 extremes vs the taut string's 9 on Blocks. `stepSigns(f, {plateaus: 'split'})`.)* Constraint
  sᵢ·(gᵢ₊₁ − gᵢ) ≥ 0. Option (paper's Fig. 2): also fix g at the extreme to the taut string's value.

LP solutions may be non-unique; HiGHS returns a vertex. That's acceptable; note it in the UI tooltip.

*Added after M7 (user request): shape-constrained fits and a shape test.* The LP fits (not `combined`) take an
optional shape (decreasing, increasing, convex, concave), using the same divided-difference rows as the exact
bounds (§1.9): the simplest function in Aₙ ∩ shape. When that is empty, the app shows the unconstrained fit and
says how far off the shape is: `shapetest.shapeThreshold` solves one LP, min c s.t. |Σ_I(y − g)| ≤ c√|I| and
g has the shape (linear in (g, c)), giving τ_min = (c_min/σ)²/log n. With the Monte Carlo sample for the λ family
(n ≤ 2000), 1 − coverage(τ_min) is a p-value for "f has the shape": if f has it, f ∈ Aₙ(τ) with probability
coverage(τ), and then Aₙ(τ) ∩ shape ≠ ∅. Motivation: a user data set (n = 28) whose decreasing band was empty
at the start. A decreasing fit needs τ ≥ 3.575, where Aₙ covers 90–91% at n = 28 (Monte Carlo), so p ≈ 0.09:
"decreasing" is rejected at τ = 3 (which covers only 84–86% at this n) but not at 95%. The calibrated τ (4.29)
admits it. Tests: test/shapetest.test.js; `check:ui` check 4.

Numerics: solve in standardized units (y − mean(y)) / σ̂ and transform back. With dyadic 𝓘ₙ the LP has
≈ 2n variables and ≈ 6n rows, fine for n up to a few thousand.

### 1.7 Fast honest bounds under shape constraints (§5.2)

Let c = σ̂·√(τ·log n). Use prefix sums; restrict window sizes to a geometric grid
θ(m) = ⌊θᵐ − 1⌋ (or ⌊θᵐ⌋ where the paper does), θ default 1.5, giving O(n log n). Also implement the
all-windows O(n²) versions as references.

**Non-decreasing** (eqs. 59–62), 1-based:

    lbᵢ = max over k ∈ grid, 0 ≤ k ≤ i−1  of  mean(y_{i−k..i}) − c/√(k+1)
    ubᵢ = min over k ∈ grid, 0 ≤ k ≤ n−i  of  mean(y_{i..i+k}) + c/√(k+1)

then monotonize: ubᵢ = min(ubᵢ, ubᵢ₊₁) for i = n−1..1; lbᵢ = max(lbᵢ, lbᵢ₋₁) for i = 2..n.
Non-increasing: apply to −y and negate/swap.

**Piecewise monotone** (§5.2.3): take extreme positions from the taut string (default: plateau
midpoints). On each monotone segment apply the monotone bounds with the segment's direction, with
windows restricted to the segment. UI lets the user drag extreme positions later (stretch goal).

**Convex** (eqs. 66, 69): upper bound from symmetric windows,

    ubᵢ = min over k ∈ grid, k ≤ min(i−1, n−i)  of  mean(y_{i−k..i+k}) + c/√(2k+1)

Lower bound: **use this derived form, not eq. 67 as printed** (see Known issues). For a right-hand
anchor at distance k ≥ 2 and 1 ≤ j < k (windows to the right of i, mirror for the left):

    convexity ⇒ g_{i+l} ≤ (1 − l/k)·gᵢ + (l/k)·ub_{i+k},  l = 1..j
    Aₙ on {i+1..i+j} ⇒ Σ_{l=1..j} g_{i+l} ≥ Σ_{l=1..j} y_{i+l} − c√j
    ⇒ gᵢ ≥ [ mean(y_{i+1..i+j}) − c/√j − ub_{i+k}·(j+1)/(2k) ] / (1 − (j+1)/(2k))

lbᵢ = max of that over k and j in the grids, both sides. Concave: apply to −y.

**Piecewise convex/concave** (§5.2.4): intervals of convexity from the minTV(1) linear spline (sign
changes of its slope changes); apply convex/concave bounds per interval.

### 1.8 Fast bounds under a smoothness bound ‖g″‖∞ ≤ K (§5.3, eqs. 72–73)

Equal spacing, t ∈ [0, 1]. For a symmetric window of half-width k, the linear Taylor term cancels and
|mean_{window} g − gᵢ| ≤ K·k(k+1)/(6n²) (the paper uses the looser K·(k/n)²; either is honest). So:

    ubᵢ = min_k [ mean(y_{i−k..i+k}) + c/√(2k+1) + K·k(k+1)/(6n²) ]
    lbᵢ = max_k [ mean(y_{i−k..i+k}) − c/√(2k+1) − K·k(k+1)/(6n²) ]

(the paper's labels for 72/73 are swapped — see Known issues). K_min = smallest K with lbᵢ ≤ ubᵢ for all
i (bisection). Show K_min and let the user set K ≥ K_min (slider in multiples of K_min). Report K in user
units: K_user = K / (x_max − x_min)².

v1: smoothness bounds only for equally spaced x (disable with an explanation otherwise).

### 1.9 Exact LP bounds (§5.2.1, eqs. 57–58) — small n only

lbᵢ / ubᵢ = min / max gᵢ subject to Aₙ plus the shape constraints (monotone, convex, or sign pattern).
2n LPs; enable only for n ≤ 300 and run in the worker with progress.

*Fixed after M7:* when τ is within ~1e−8 (relative) of the smallest τ admitting the shape, Aₙ ∩ shape is empty
only to within solver tolerance: the first solve found it feasible and a later bound infeasible, and
`exactBounds` threw. On the user data above, 98 of 201 values of τ just below τ_min threw. Now reported as
`{status: 'infeasible', marginal: true}`; regression test in test/shapetest.test.js.

### 1.10 Unequal spacing and ties

- Aₙ, σ̂, taut string, minTV(0) and the *monotone* shape bounds use only the ordering: fine for any spacing.
  *(Corrected in M4: the convex/concave bounds also need equal spacing — the upper bound uses gᵢ ≤ (gᵢ₋ⱼ + gᵢ₊ⱼ)/2
  and the lower bound index-linear interpolation; Known issue 12. The UI disables them for unequal spacing.)*
- Derivative-based methods use divided differences on rescaled x.
- Ties in x: stable sort, keep rows. For derivative-based LPs add gᵢ = gᵢ₊₁ for tied x and skip
  zero-width differences. For display, plot the fit's mean at each tied x. *(Corrected in M6, Known issue 14:
  that was not enough. Aₙ's intervals must be intervals of x, the taut string has nodes only between distinct x
  (one value per x), and monotone band windows are runs of whole tie groups. σ̂ (eq. 10, GSJS) uses pure error
  within tied x and is order-free, §1.1.)* *(M3: all LP fits use one variable per
  distinct x, so tied observations share a value by construction.)*

---

## 2. Known issues in the paper (as read from the arXiv version — verify)

1. Appendix eq. 81 prints the check as |Σ(yᵢ − fᵢ)| < √(3 log n), omitting σ and 1/√|I|. Use eq. 7.
2. Eq. 9 starts k at 1 (no singletons), but the text says the family always contains the degenerate
   intervals and the appendix family includes 2⁰. Include singletons.
3. Eq. 67 (convex lower bound) is missing the division by (1 − (j+1)/(2k)) and has an index typo in the
   sum; use the derivation in §1.7.
4. Eqs. 72/73: the expression labelled lower bound is the upper bound and vice versa.
5. Fig. 3 text says tᵢ = i/1000, i = 1..100; presumably i = 1..1000.
6. Coverage subtlety: the fast bounds use windows such as {i−k..i} and symmetric windows that are not in
   the dyadic family, so their honesty rests on Aₙ with *all* intervals (for which τ = 3 is still ≥ the
   asymptotic value 2). Verify coverage by simulation (§4, M4) rather than assuming it.
7. Appendix 7.3 says the dyadic family "consists of at most n subsets"; with all levels it has up to ≈ 2n
   (n singletons + n/2 pairs + …). Harmless; noted so test bounds use 2n + log₂n.
8. *(PLAN error, not the paper's.)* §1.5's KKT check originally had the bend directions swapped. For
   min Σ(Fᵢ − Fᵢ₋₁)² s.t. Fᵢ ≤ Uᵢ, stationarity gives 2(f̃ᵢ − f̃ᵢ₊₁) + μ = 0 with μ ≥ 0, so at an upper
   contact f̃ᵢ ≤ f̃ᵢ₊₁ (the string bends up around the upper boundary; e.g. F₀ = F₂ = 0, U₁ = −1 gives
   slopes −1, +1). Fixed in §1.5; `checkKKT` uses the corrected signs and a test rejects the swapped one.
9. The taut-string algorithm of appendix 7.3 is not shift-equivariant: the initial width
   max(Y) − min(Y) uses the raw cumulative sums, so adding a constant to y changes the width schedule
   and hence the fit (beyond the shift). Measured at σ = 1, n = 1024: shifting y by ±10 or ±100 moved
   the fit by up to 1.4 (Blocks), 2.7 (HeaviSine), 4.4 (Doppler), with the same number of extremes
   and both fits in Aₙ. **Decision (M2): default to the range of the mean-centered sums**, which makes
   f(y + a) = f(y) + a (tested to 1e−9); the paper's version stays available as `initialWidth: 'raw'`
   and matches ftnonpar's pmreg to ≤ 4e−12.
10. Eq. 44 defines TV(g⁽ᵏ⁾) = Σ|Δ⁽ᵏ⁺¹⁾g(i/n)| with Δ⁽¹⁾ = n(·), which is n × the total variation of the
    k-th derivative (a Riemann sum for n∫|g⁽ᵏ⁺¹⁾| rather than ∫|g⁽ᵏ⁺¹⁾|). The minimizer is unchanged; we report
    the true TV. Eq. 46 (sup norm) is scaled correctly.
11. K_min for sin(4πt) (paper §5.3: 117.7). Note §5.3 actually says σ = 1 (not 0.2 as §5 of this plan lists for
    Fig. 6), gives no n, and quotes the minimum as 117.7, 117.2 and 115.0 in different sentences; its fast-bound
    K_min is 104.5. With σ = 0.2, n = 500: Ours over 40 seeds with the dyadic family:
    median 104.2, range 97.5–109.7. Denser families raise it (10 seeds: dyadic 103.8, λ = 1.1 107.0, all
    125 250 intervals 110.3) but stay below 117.7; the paper's family/σ̂ in Kovac's software may differ. All
    below 16π² ≈ 157.9 as the theory requires. Fast-bound K_min (M4, θ = 1.5) ≈ 72–96, below the LP value in
    20/20 seeds, matching the paper's pattern (104.5 fast vs 115.0).
12. Convex/concave bounds (eqs. 66–71) assume equally spaced design points, as the paper says in §5.2.2; this
    plan's §1.10 originally listed them among the order-only methods.
13. Eq. 11 (τ = 3 with σ̂ covers ≥ 0.95 for all n ≥ 500) holds for the dyadic family but only marginally, or
    not at all, for all intervals. Pure-noise Monte Carlo, B = 4000, σ̂ plugged in: dyadic 97.7% (n = 500),
    98.5% (n = 1000); all intervals 93.1% ± 0.8 (n = 500), 94.8% ± 0.7 (n = 1000); with σ known, all intervals
    95.0% at n = 500. Calibrated τ₅₀₀(0.95): dyadic 2.69, all intervals 3.12. Since the fast bands' honesty rests on
    all-interval coverage (issue 6), a τ calibrated for the dyadic family is too small for them (band coverage
    91.6–93.1% at n = 500), while one calibrated for all intervals gives 96.2–96.5%. The UI says which applies.
14. *(Our bug, not the paper's.)* The interval family was built over observation indices, so with tied x it split
    tie groups in arbitrary (file) order: Aₙ depended on row order, and forcing one value per x could make it
    empty. A user data set (101 rows, 30 distinct ages) made every LP fit infeasible: inside the age-17 group
    alone the index intervals required g(17) ≥ 10.30 and ≤ 8.85. The taut string also gave up to 8.5 different
    values at one x. Fixed by using intervals of x throughout (eq. 6), tie-aware taut-string nodes and band
    windows; regression tests in test/ties.test.js (including that data set and a row-shuffle invariance test).

---

## 3. Architecture

### Core modules (`src/core/`, pure)

| module | exports |
|---|---|
| `rng.js` | seeded PRNG (mulberry32 or xoshiro128**), `normal()` via Box–Muller |
| `signals.js` | test functions + `simulate(name, n, sigma, seed)` (§5) |
| `data.js` | parse CSV text, choose columns, sort/tie handling, rescale x |
| `prefix.js` | prefix sums, window means |
| `sigma.js` | `sigmaMAD(y)` |
| `intervals.js` | `multiresolution(n, lambda)`, `allIntervals(n)` |
| `region.js` | `threshold(sigma, tau, n)`, `checkRegion(y, g, intervals, c)` → {ok, maxRatio, ratios} |
| `calibrate.js` | Monte Carlo τₙ(α) |
| `tautstring.js` | `tautString(Y, lower, upper)`, `tautStringRegression(y, opts)`, reference solver, KKT check |
| `extremes.js` | runs, local extremes with plateaus, monotone sign pattern |
| `lp-build.js` | builds CPLEX-LP-format strings for every §1.6/§1.9 problem |
| `bounds.js` | monotone, piecewise monotone, convex, piecewise convex, smoothness-K bounds; O(n²) references |
| `exact.js` | exact LP bounds under a shape (§1.9) |
| `shapetest.js` | smallest τ admitting a shape (one LP), for the shape test (§1.6, after M7) |

### LP worker (`src/lp-worker.js`)

- **Module** worker (`new Worker(url, {type: 'module'})`). *Changed in M0:* this plan originally called for a
  classic worker using `importScripts`, on the assumption that the Emscripten loader is UMD only. The `highs`
  package also ships an ES-module build (`build/highs.mjs`) that locates `highs.wasm` via `import.meta.url`,
  so the worker imports `vendor/highs/highs.mjs` directly and can also import pure `src/core/` modules
  (e.g. `lp-solve.js`, later `lp-build.js`).
- Protocol: `postMessage({id, lp, options})` → `{id, status, objective, names, primal: Float64Array, ms}` or
  `{id, error}`. `primal` is in HiGHS column order (order of first appearance in the LP text); `names`
  gives the matching column names. The UI side wraps this in a promise API in `src/ui/lp.js`.
- `{id, task: 'regularize', spec}` → `{id, ...RegularizeResult}`: the worker builds and solves the model
  itself (`src/core/regularize.js`), so only data and settings cross the thread boundary.
- *Changed in M3:* regularization models are HiGHS `ModelData` (sparse CSR typed arrays, `highs.createModel`
  via `withModel`), not CPLEX-LP text. Reasons: HiGHS's LP reader **rejects ranged rows** (`-1 <= x - y <= 1`)
  and aborts the Wasm instance (the worker discards it after any error); typed arrays need no text
  generation or parsing; `colValue` comes back in column order. LP text is kept for the smoke test, and
  `model.exportModel('lp')` can dump any model for debugging.
- Formulation: one column per distinct x (ties share a value), prefix-sum columns Pₖ so each Aₙ constraint is
  one ranged row with 2 nonzeros (O(n) total instead of O(n log n)); derivatives w.r.t. τ = (m−1)·t so
  coefficients are O(1) (in t units Dᵏ ~ mᵏ, ~10⁹ for TV(g″)); objectives converted to x units after.
- Node tests import `highs` from node_modules and call the same `regularize()`.
- *Added in M5:* `{id, task: 'exactBounds', spec}` and `{id, task: 'calibrate', spec}`, both sending
  `{id, progress}` messages (≤ 10/s) before the result. Exact bounds reuse one persistent HiGHS model and change
  only the objective (`changeColCost`), so each of the 2m solves warm-starts; a warm solve occasionally ends
  'unknown' (≈ 1 in 1600) and is retried cold after `clearSolver()`.

### UI (`src/ui/`, D3 via import map)

- **Main chart:** points (small, translucent), fit line(s) (taut string drawn as steps), band ribbon,
  extreme plateaus marked on the x-axis. *(Added in M6:)* step fits are drawn over each point's cell (edges at
  midpoints), except across gaps in x (spacing > 3× the median): there the solid line stops at the data and a
  dotted connector joins the two points, and plateau marks stop at the data too, so no jump or extreme is drawn
  at a position with no data. Line fits and the residual view / Aₙ boxes keep the cell convention.
- **Residual view under the main chart:** one row per resolution level k, one cell per interval, colour =
  |w(I)|/c (sequential scale, distinct colour for > 1). This is the picture that explains Aₙ.
- **Aₙ boxes (added in M6):** each constraint of eq. 7 drawn on the main chart as a box spanning its interval's
  cells, height mean_I(y) ± c/√|I|; a tick marks the fit's mean over the interval, so g ∈ Aₙ exactly when every tick
  lies in its box (violations in the violation color). Modes: off, the row hovered in the residual view (default),
  one level, all levels (faint outlines). A plain y ± c ribbon is deliberately not offered: it is the exact
  per-point projection of Aₙ (eq. 53) but suggests that any curve inside it is in Aₙ, which is false.
  `region.constraintBoxes`; tested against `checkRegion` (tick inside ⇔ ratio ≤ 1).
- **Readouts:** n, σ̂, τ, c, number of local extremes, taut-string iterations, LP objective and time,
  K_min, coverage note.
- **Controls:** dataset (built-ins, CSV paste/drop with column pickers), seed, noise σ for simulated data,
  τ (or α with MC calibration), σ override, λ, method (taut string / minTV k / minSup k / combined),
  band type (none / monotone / piecewise monotone / convex / piecewise convex / smoothness-K), θ, K slider.
- Recompute in workers; keep the UI responsive; debounce sliders.
- Keep state in the URL hash for shareable links (dataset, seed, settings), not localStorage. *(M7: `urlstate.js`;
  small pasted data travels in the link, compressed.)*
- **Toolbar (M7):** Copy link, Download CSV (`export.js`, what is on screen), About dialog. *(After M7:* an Export
  menu in place of Download CSV: the same CSV, and the main chart as SVG, PNG or JPEG.)*
- **ⓘ tips (after M7):** explanations sit behind a small ⓘ after a label, shown on hover, focus or tap and pinned
  by a click (`info.js`, lafspline's own module, copied as is; a line per paragraph, `- ` lines as a list, `**…**`
  bold, built from text nodes). Visible: labels, inputs, values, warnings, the verdict, and the reasons a control
  is unavailable (needs equally spaced x, n ≤ 300 for exact bounds, pure error with enough ties).

---

## 4. Milestones

Each milestone ends with: tests passing, page loads with no console errors, short summary, stop for review.

### M0 — Scaffold
- [x] package.json (`"type": "module"`, scripts `test`, `vendor:highs`), .gitignore, devDependency `highs`
- [x] `npm run vendor:highs` copies the loader JS and .wasm from node_modules/highs/build/ (check actual file names)
      → copies `highs.mjs`, `highs.wasm`, `LICENSE`
- [x] index.html with import map (d3 pinned from jsDelivr), styles.css, empty main.js
- [x] lp-worker.js solves a 2-variable LP in the browser; a Node test solves the same LP string
- [x] `node --test` runs a trivial test
- [x] `npm run check:page -- <url>`: headless-Chrome check for console errors/exceptions/failed loads
      (page and workers), with `--until`, `--eval`, `--screenshot`

### M1 — Data, σ̂, Aₙ, residual view
- [x] rng, signals, data, prefix, sigma, intervals, region (+ tests)
- [x] Tests: σ̂ ≈ σ on pure noise (n = 10⁴, within 3%); `multiresolution(n, 2)` covers every index at every level,
      contains all singletons, count O(n); g = y is always in Aₙ; a constant g = mean(y) passes on pure noise for ≥ ~95%
      of seeds (n = 500, τ = 3)
      → σ̂ at n = 10⁴ has relative sd ≈ 1.4%, so a single draw is within 3% only ≈ 97% of the time; the test checks the
        mean over 50 seeds (within 0.5%) and ≥ 90% of seeds within 3%. Constant-in-Aₙ rate observed: 98.0% of 400 seeds.
- [x] UI: dataset picker, chart of points, residual view for g = constant mean, readouts
      → also CSV paste/drop/file with column pickers, τ, λ, σ override; residual-cell hover highlights the interval
        on the main chart

### M2 — Taut string
- [x] O(n) taut string; reference solver; KKT checker
      → funnel algorithm with hull chains (`tautString`); projected SOR reference with a scale-relative
        stopping rule (an absolute 1e−14 never triggered); a mutation check confirmed both oracles catch
        broken variants
- [x] Tests: matches reference solver (n ≤ 200, random tubes, tol 1e−9); passes KKT for n = 10⁴;
      final f̃ ∈ Aₙ; noise-free Blocks/Bumps/Doppler at moderate noise recover the true number of extremes
      in a stated fraction of seeds; pure noise → 0 extremes in ≥ ~95% of seeds
      → exact recovery over 200 seeds (σ = 1, sd 7, n = 1024): Blocks 99.5%, Bumps 100%, HeaviSine 94%;
        sin(4πt) 100%; pure noise 99% zero extremes; exp(5t) 99.5% zero. Doppler has 39 extremes on the
        grid, most far below the noise, so the test checks minimality instead (fit count ≤ 39; median 24).
- [x] Optional fixtures: R ftnonpar `pmreg` output on the same simulated data (see §6) → compare extremes count
      and fit closely (note parameter names may differ from τ; read its docs)
      → `tools/pmreg-inputs.mjs` + `tools/pmreg-fixtures.R` (compiles only ftnonpar's `src/strings.c`, no
        gfortran needed) → `test/fixtures/pmreg.json`, 10 cases. pmreg defaults differ from the paper
        (thr.const 2.3, dyad.factor 1.1, extra global squeezing after convergence, extremes set to local
        means, isotonic post-processing); the script's `pmregPaper` turns those off. Result: fits agree to
        ≤ 4e−12 with identical iteration and extreme counts (using `initialWidth: 'raw'`). The first comparison
        exposed the initial-width difference that led to Known issue 9 and the shift-invariant default.

- [x] UI: taut string fit, extremes markers, iterations; residual view updates
      → fit selector (taut string / constant), step drawing over cells, ▲▼ plateau marks, plateau note in
        the crosshair tooltip; n = 20 000 Doppler recomputes and renders in ≈ 125 ms on the main thread

### M3 — LP regularizations
- [x] lp-build for minTV(0,1,2), minSup(1,2), combined; worker plumbing
      → `derivatives.js` (divided differences, exact for polynomials at any spacing), `lp-build.js` (ModelData),
        `regularize.js` (standardize, solve, map back, re-check Aₙ, recompute the objective from g)
- [x] Tests (Node + highs): solutions ∈ Aₙ; pure noise → minTV(0) objective ≈ 0 (constant); linear signal + noise →
      minTV(1) objective ≈ 0 (a straight line); minSup(2) on sin(4πt), σ = 0.2, n = 500 gives K_min below 16π² ≈ 157.9
      in most seeds (paper reports 117.7 for its draw)
      → all hold: minTV(1) ≈ 0 in 40/40 seeds; K_min < 16π² in 40/40 (median 104.2, Known issue 11). Also: LP
        objective = objective recomputed from g; feasible-point bounds (minTV(0) ≤ TV(taut string), minSup(2) ≤
        ‖f″‖∞ when f ∈ Aₙ); combined obeys the signs and never has more extremes than the taut string; pinned
        extremes; ties; unequal spacing; x-rescaling and y-shift units.
- [x] UI: method selector, overlay several fits
      → 8 methods with a fixed color each, overlays, LP fits solved in the worker and cached, previous frame kept
        dimmed while solving; n = 1024 solves in 27–104 ms in the browser. `npm run check:ui` checks that the
        residual view and readouts agree on violations for every method (regression: LP optima on the boundary of
        Aₙ were painted as violations).

### M4 — Fast bounds
- [x] bounds.js: monotone, piecewise monotone, convex (derived lower bound), piecewise convex, smoothness-K, K_min
      → K_min in closed form (max over i, k₁, k₂ of (m₁ − m₂ − c₁ − c₂)/(a₁ + a₂)) instead of bisection; tested to
        be exactly where the band stops being empty. `curvatureSegments` gets convex/concave intervals from the
        min TV(g′) spline. `crossings` counts points where a band is empty (assumption rejected).
- [x] Tests: fast bounds are no tighter than the O(n²) references (lb_fast ≤ lb_full, ub_fast ≥ ub_full); lb ≤ ub on
      data from a shape-consistent f; monotone bounds are monotone; **coverage simulation**: for exp(5t) (monotone &
      convex), sin(4πt) (smoothness, K = 16π²), n = 500, 1000 seeds, f lies inside the band everywhere in ≥ 95% of runs —
      report the observed rate
      → observed: monotone 96.1%, convex 95.8%, smoothness 95.4% (s.e. ≈ 0.7%), consistent with Known issue 6
        (honesty rests on Aₙ over all intervals, ≥ 0.95 at τ = 3, n ≥ 500). Not asserted, measured once: piecewise
        monotone with taut-string extreme positions 96.5%; piecewise convex with min TV(g′) intervals 98.5% (200 seeds).
        Also: full monotone bounds equal a direct evaluation of eqs. 59–60; inconsistent shapes give empty bands.
- [x] UI: band selector, θ, K slider with K_min readout
      → band drawn as a ribbon (empty spots in the violation color, infinite bounds to the plot edge, exact values
        in the tooltip); readouts: empty count and, for simulated data, whether the true f is inside; convex and
        smoothness bands disabled for unequal spacing. Piecewise convex waits for the min TV(g′) LP.
      → not done: the "any position within the taut-string plateau" variant of §5.2.3 (Fig. 4 upper panel) and
        dragging extreme positions (stretch goal).

### M5 — Calibration and exact bounds
- [x] Monte Carlo τₙ(α) in a worker with caching; UI switch "τ = 3" vs "calibrated α"
      → `calibrate.js`: sorted sample of M (σ̂ plug-in by default) so α changes are instant; τ from the ⌈αB⌉-th
        order statistic with a 95% Monte Carlo interval; calibrate for the λ family or for all intervals (n ≤ 2000,
        O(n²) per replicate; 1.2 s at n = 1024, B = 2000). Tests: brute-force statistic, out-of-sample coverage
        within ±2.5% of α, and Known issue 13 (τ = 3 covers ≥ 95% for dyadic, < 95% for all intervals at n = 500).
        The band readout states the coverage that applies to the chosen τ (issue 13).
- [x] Exact LP bounds for n ≤ 300 with progress; compare visually with fast bounds (paper Fig. 3)
      → `exact.js` for every band shape (monotone, piecewise monotone, convex/concave, piecewise convex, ‖g″‖∞ ≤ K);
        divided-difference shape rows, so convex/smoothness work at unequal spacing too. n = 300 takes 0.7 s
        (monotone) to 1.7 s (convex) in the browser (paper: ~12 h). Tests: with all intervals the exact bounds are at
        least as tight as every fast bound (cross-checks both implementations); warm = cold solves; infeasible
        shape detected; smoothness infeasible just below the LP K_min and feasible just above; unequal spacing; ties.
        With the dyadic family the exact bounds are *wider* than the fast monotone bounds (exp(5t), n = 300: mean
        width 16.2 vs 13.7) and about equal for convex (10.15 vs 9.96), since the fast bounds use extra windows.

### M6 — Small and tied data (driven by user data sets)
- [x] Aₙ boxes overlay (§3 UI): each constraint of eq. 7 as a box mean_I(y) ± c/√|I| with a tick at the fit's mean
      over I; modes off / hovered residual row (default) / one level / all levels
      → `region.constraintBoxes`, tested against `checkRegion` (tick inside ⇔ ratio ≤ 1)
- [x] Trend-robust σ̂ option (§1.1): `sigmaGSJS`, local linear pseudo-residuals in median form; calibration plugs in
      the estimator actually used; readout warnings for n < 50 and for σ̂(eq. 10)/σ̂(GSJS) > 1 + 4/√n
      → motivated by a user data set (n = 10, unevenly spaced, steep): eq. 10 gave σ̂ = 1.05 and c = 2.75 with y
        spanning 7, so Aₙ barely constrained anything; GSJS gives 0.12
- [x] Gap connectors (§3 UI): across gaps in x (spacing > 3× the median) step fits stop at the data with a dotted
      connector, and plateau marks stop at the data, so no jump or extreme is drawn where there are no data
- [x] Ties (Known issue 14): intervals of x throughout (`xIntervalFamily`, `xIntervalLevels`, `allXIntervals`),
      taut-string nodes only between distinct x, monotone band windows over whole tie groups; the y-domain always
      includes the fits
      → a user data set (101 rows, 30 distinct ages) made every LP infeasible before the fix; min TV(g″) on it is
        now a parabola peaking near age 40. Regression tests in test/ties.test.js, including row-shuffle invariance.
- [x] Tie-aware σ̂ (§1.1): pure error within tied x, plus between-x-means terms only when the replicates carry fewer
      df than there are such terms; both estimators order-free, unchanged without ties. The σ estimator choice is
      disabled when only pure error is used.
      → ages data: row-order eq. 10 ranged 2.62–4.19 over shuffles of tied rows; tie-aware 3.145 for every order.
        Steep trend with 1–4 replicates (σ = 1): 1.63 → 0.99.
      → not done (offered): an explicit frequency column (rows expanded, n = Σ freq), and dot size by the
        multiplicity of identical (x, y) points.

### M7 — Polish and deploy
- [x] URL-hash state, CSV export of fit and bands, About panel with the paper reference and method notes
      → `src/ui/urlstate.js`: only settings that differ from the defaults are written (readable key=value), n and σ
        relative to the chosen signal's defaults; pasted data deflate-compressed + base64url when ≤ 8000 chars
        (the ages data: 101 rows, 537 chars of CSV → 294), otherwise left out and the Copy link message says so. Every value
        is validated against the control ranges; invalid entries are ignored and listed in the readout notes.
        Written with `history.replaceState` (debounced) so reloads keep the view without flooding Back; following
        a link or editing the hash rebuilds the controls. `src/ui/export.js`: x, y, f_true, every drawn fit
        (primary first), band and exact bounds, full precision, Inf/-Inf for infinite edges, user column names.
        Toolbar: Copy link, Download CSV, About (a `<dialog>`). Tests: test/urlstate.test.js,
        test/export.test.js; `npm run check:ui` gained a link round-trip check (mutation-tested).
- [x] GitHub Pages from main branch root; verify .wasm loads from Pages
      → app renamed tautfit (repo and site name; the local folder is still nicefit). `.nojekyll` added so Pages
        serves files as-is. Live at https://xangregg.github.io/tautfit/ (repo xangregg/tautfit). Pages serves
        highs.wasm as `application/wasm` (streaming instantiation works). The full `tools/ui-checks.js` passes
        against the live site with no console errors; exact LP bounds on exp(5t), n = 200: 401 LPs in 0.64 s.

### After M7 — UI refinements backported from lafspline (UI-TIPS.md)
- [x] ⓘ tips instead of inline hints in the controls and readouts (UI-TIPS §1–5)
      → `src/ui/info.js`; `controls.js` gathers its texts in `TIPS` (method and band tips are built from
        `METHODS` and `BANDS`), short fields share a row; readout rows are `{label, value, note?, tip?}`, both behind
        one ⓘ (`appendRows`); "c = σ√(τ log n)" became "threshold c" and "|𝓘ₙ|" "intervals". Fixed on the way: a
        global `[hidden]` rule, since `.field` and `.check` set `display` and so overrode `hidden` (the K slider and
        "pin extremes" showed whatever the band and method); `npm run check:ui` checks it.
- [x] Export menu: CSV, SVG, PNG, JPEG (§6)
      → `chart.js` `toSvg`, ported from lafspline: the legend laid out and wrapped as on the page, points and Aₙ
        boxes as vector shapes (`boxShapes` feeds both the canvas and the SVG), the SVG layers cloned with their
        computed styles as SVG 1.1 attributes; 12 px of background around it. PNG and JPEG are the SVG drawn at 2×.
        The image uses the current color scheme; the residual view is not exported (said in the menu titles and the
        About text). The CSV is unchanged (byte-identical on sine with a band, exact bounds and an overlay).
- [x] Reset, Undo and Redo for the settings (§7)
      → `src/ui/history.js` and `test/history.test.js`, lafspline's own, copied as is (snapshots; a gesture on the
        same settings within 1 s is one step; 200 entries). `main.js`: `DATA_KEYS` (source, n, σ, seed, pasted data
        and its columns; the gallery's view and panes join them in §8) are never touched; a followed link and Reset
        are steps of their own; ⌘/Ctrl+Z and ⇧⌘Z / Ctrl+Shift+Z / Ctrl+Y unless a text field has focus. Undo back to
        a calibrated τ reuses the cached calibration (70 ms). `tools/check-page.mjs` no longer runs --eval on a page
        that did not get ready, and reports an eval exception as a problem: a failed jsDelivr load had shown up as
        a TypeError from ui-checks.js.
- [ ] Gallery view (§8)
- [ ] Aₙ's shortest interval (§9)
- [ ] Advanced subsections (§10)

### M8 — Moved to a separate project: "least ambitious fit" on top of Aₙ
Ladder of simplicity checked by tiny LPs inside Aₙ: constant feasible? → linear (a + b·x) feasible? →
minTV(1) linear spline with fewest kinks (ramps with flat ends arise naturally), then optionally smooth the
joins with minTV(2) under the same sign pattern. Display which rung was reached.

**Decision (after M7):** tautfit stays a faithful implementation of the paper; the ladder becomes its own
project. Minimizing the number of kinks is combinatorial (heuristics or mixed-integer programming, not one LP)
and makes claims the paper does not, so it would blur what this app stands for.
- [x] The bottom rungs are here, as shape constraints in the paper's own terms: "constrain the fit to be"
      Constant or Linear gives the simplest such function in Aₙ, or, when there is none, the smallest τ that
      admits one and its p-value (§1.6 shape test). Constant finds whether *any* constant is in Aₙ, not just
      mean(y). Tests: test/shapetest.test.js (constant c_min equals a direct minimization over the constant).
- Reusable for the new project: everything in `src/core/` is pure and tested. Aₙ (`intervals.js`, `region.js`,
  `sigma.js`, `calibrate.js`), the LP builder with shared frame and shape rows (`lp-build.js`, `lp-solve.js`),
  `regularize.js`, `shapetest.js` (smallest τ for any linear constraint set on g), and `exact.js`. The UI
  modules (`chart.js`, `residual.js`, `urlstate.js`, `export.js`) are also independent of the methods.

---

## 5. Built-in datasets (`signals.js`)

Donoho–Johnstone test functions on t ∈ [0, 1] (verify constants against a standard source, e.g. WaveLab):

- **Blocks:** f = Σ hⱼ·(1 + sign(t − tⱼ))/2,
  tⱼ = [.10 .13 .15 .23 .25 .40 .44 .65 .76 .78 .81], hⱼ = [4 −5 3 −4 5 −4.2 2.1 4.3 −3.1 2.1 −4.2]
- **Bumps:** f = Σ hⱼ·(1 + |(t − tⱼ)/wⱼ|)⁻⁴, same tⱼ, hⱼ = [4 5 3 4 5 4.2 2.1 4.3 3.1 5.1 4.2],
  wⱼ = [.005 .005 .006 .01 .01 .03 .01 .01 .005 .008 .005]
- **HeaviSine:** f = 4 sin(4πt) − sign(t − 0.3) − sign(0.72 − t)
- **Doppler:** f = √(t(1 − t))·sin(2π·1.05/(t + 0.05))

Conventionally scaled so sd(f) = 7 with σ = 1 (make the scaling a parameter).

From the paper: exp(5t) + 5Z, n = 1000 (Fig. 3); sin(4πt) + 0.2Z, n = 500 (Fig. 6); narrow box peak
b((t − 1/2)/0.01) (eq. 18). Also: pure noise, straight line, and a logistic ramp (for the least-ambitious-fit ladder, now a separate project; see M8).

---

## 6. Reference implementation for validation (optional)

R package **ftnonpar** (Kovac; archived from CRAN in 2022). Install from the archive tarball, e.g.
`install.packages("https://cran.r-project.org/src/contrib/Archive/ftnonpar/ftnonpar_0.1-88.tar.gz", repos = NULL, type = "source")`
(needs compilers). Functions of interest: `pmreg` (taut string), `mintvmon` (minimal total variation),
`smqreg` (smooth piecewise monotone). Export inputs and outputs as JSON into test/fixtures/ with a small R
script kept in `tools/`.
