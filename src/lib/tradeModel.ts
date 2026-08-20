/**
 * THE TRADE MATHS — consolidation adjustment and pick index estimation.
 *
 * Companion to `scratch/TRADE_MACHINE_MODEL.md`. Two mechanisms live here and
 * nothing else does:
 *
 *  1. **Consolidation adjustment** (§1). Only nine slots start, so a package's
 *     value is not the sum of its parts. Every asset is scaled by a utilization
 *     weight `s_lens(v)` — the share of weeks a thing of that value actually
 *     occupies a starting slot — and the gap between the scaled sum and the raw
 *     sum is shown in the ledger as its own row. Never smuggled into a total.
 *  2. **Pick DVI/CVI estimation** (§2). A pick has a market price and a WAR
 *     stream but no index, because DVI and CVI are computed from a projection
 *     and there is no player to project until the pick converts. See
 *     `makePickIndexer` for the approximation actually taken and why.
 *
 * SHARED BY BOTH SHELLS. It lives in `lib/` because the maths is not a property
 * of a skin: `components/TradeCalc.tsx` (classic) and `beta/screens/Trade.tsx`
 * both call these functions, so the two boards cannot print different numbers
 * for the same trade. Neither shell is allowed to re-implement a curve here.
 *
 * DELIBERATELY DEPENDENCY-FREE. Not one runtime import — no React, no
 * `./rosterModel`, no `./types`. Two reasons. The maths is the part that has
 * to be *provable*, and `tests/tradeModel.test.ts` imports this module directly
 * under `node --test`, which resolves specifiers the way Node does rather than
 * the way Vite does; a single extensionless relative import would drag in the
 * whole React tree and end the test run. The four-element `ROUND_ORD` below is
 * the one thing that is copied rather than imported, and it is copied for
 * exactly that reason.
 *
 * The screen owns presentation. This owns figures: it formats nothing, decides
 * no colour, and has no opinion about who won.
 */

/* ========================================================================
   VOCABULARY
   ======================================================================== */

/** The three currencies the ledger carries, left to right. */
export type Lens = "market" | "dvi" | "cvi";

export const LENSES: readonly Lens[] = ["market", "dvi", "cvi"];

/** One figure per currency. Every total in here is one of these. */
export interface Triple { market: number; dvi: number; cvi: number }

const zero = (): Triple => ({ market: 0, dvi: 0, cvi: 0 });

/** the only thing the ledger needs to know about an asset. Both shells' asset
 *  types — `beta/model.ts`'s `Asset` and `components/TradeCalc.tsx`'s — are
 *  structurally assignable to this, which is the point: the ledger takes what
 *  each screen already builds and this file never imports either of them. */
export interface LedgerAsset {
  kind: "player" | "pick";
  label: string;
  /** dynasty market price (KTC). Picks have one, by band. */
  ktc: number | null;
  dvi: number | null;
  cvi: number | null;
}

/** round names for pick labels. `lib/rosterModel.ts` exports the same four —
 *  see the module header for why this module owns a copy instead. */
const ROUND_ORD = ["1st", "2nd", "3rd", "4th"];
const TIERS = ["Early", "Mid", "Late"];

/* ========================================================================
   1. THE UTILIZATION CURVE
   ======================================================================== */

export interface UtilCurve {
  /** the floor. A throw-in contributes little; it never contributes nothing,
   *  and it MUST never contribute a negative, or "add a scrub" becomes a way
   *  to make a side look worse and the ledger stops being a scale. */
  uMin: number;
  /** the value at which a thing starts about half the time */
  v50: number;
  /** steepness, in the same units as v50 */
  tau: number;
}

/**
 * v1 PARAMETERS — hand-tuned, per `TRADE_MACHINE_MODEL.md` §1 "the curve, v1".
 *
 * Each lens is parameterised **in its own value space**: Market in KTC points
 * (427–9999 across the priced field), DVI and CVI in index points (0–100).
 * Mixing them would have needed a normalisation nobody could check.
 *
 * The ruler used for all three is the league's own board: 12 teams × 9 starting
 * slots = **108 starting jobs**, so the marginal starter is the 108th-ranked
 * asset. On the data as shipped that is KTC 3438, DVI 51.6, CVI 58.2, and the
 * 50th is KTC 5317 / DVI 72.5 / CVI 79.8.
 *
 * | Lens   | v50  |  τ   | s at rank 50 | s at rank 108 | s at rank 200 | Reading |
 * |--------|------|------|--------------|---------------|---------------|---------|
 * | Market | 3400 | 1200 | 0.85         | 0.56          | 0.37          | v50 sits ON the marginal starter's price: the 108th asset starts half the time by construction. |
 * | DVI    |   34 |   24 | 0.85         | 0.71          | 0.49          | Low and gentle. A rebuilder has open slots and time, so the third asset still plays and quantity keeps its value. |
 * | CVI    |   72 |    9 | 0.73         | 0.26          | 0.10          | High and steep. v50 sits ABOVE the marginal starter (58.2), which is the assertion: a contender's lineup is full, so even a top-50 asset is not a lock to displace what he already starts. |
 *
 * CALIBRATION TRADES the parameters were tuned against (all on the shipped
 * field; `tests/tradeModel.test.ts` pins the first three):
 *
 *  - **One 9000 vs two 4500 (Market).** s(9000)=0.992 → 8925; s(4500)=0.743 →
 *    3343 each → 6686. The stud clears the pair by 33%. The model doc's own
 *    worked example predicts "s≈1.0 → 9000" and "s≈0.75 each → 6750"; these
 *    parameters reproduce it to within 1%, which is what fixed τ at 1200.
 *  - **The same trade in index space.** Read off the KTC→index ladder this file
 *    fits (`monotoneFit` over the shipped field), a 9000 KTC player is
 *    DVI 100 / CVI 96.9 and a 4500 is DVI 63.6 / CVI 70.9. Under CVI the stud
 *    wins (91.9 vs 74.6); under DVI the pair wins (102.3 vs 94.6). That
 *    reversal IS the lens split — the same trade, priced by two different
 *    questions — and no parameter set that failed to produce it was kept.
 *  - **Stud-for-stud, 1-for-1.** Two ~9000s: each side loses <1% to the
 *    adjustment and the net adjustment is 0. A fair trade must not be made
 *    unfair by the correction.
 *  - **Stud plus three throw-ins.** Three KTC-500 bodies add 3×0.174×500 ≈ 261
 *    to a side. Visible, negligible, never negative.
 *  - **2-for-1 consolidation penalty, by lens.** On a two-asset package at the
 *    equivalences above the adjustment runs −43% (CVI) / −26% (Market) /
 *    −20% (DVI). The ORDER is the claim; the magnitudes are v1 and will move
 *    when the empirical start-share fit lands (model doc §1 "the curve, v2").
 *
 * v2 replaces every number in this table with a measured start share per value
 * bin, fit on contenders for CVI and on the bottom half for DVI. Until then
 * these are asserted, and the table above is the whole of the assertion.
 */
export const UTIL_CURVES: Record<Lens, UtilCurve> = {
  market: { uMin: 0.10, v50: 3400, tau: 1200 },
  dvi: { uMin: 0.10, v50: 34, tau: 24 },
  cvi: { uMin: 0.10, v50: 72, tau: 9 },
};

/**
 * `s_lens(v) = u_min + (1 − u_min) / (1 + exp(−(v − v50) / τ))`
 *
 * The expected share of weeks an asset of value `v` occupies a starting slot.
 * Bounded on (uMin, 1), monotone increasing, and — the property that does the
 * KTC work — convex below v50, so consolidating two mid assets into one big one
 * gains value without anyone writing a "consolidation premium" rule.
 */
export function utilization(v: number, c: UtilCurve): number {
  // exp overflows to Infinity for large negative z on a 64-bit float; the
  // guard keeps a value far below the curve at exactly the floor rather than
  // at NaN.
  const z = (v - c.v50) / c.tau;
  if (z < -700) return c.uMin;
  return c.uMin + (1 - c.uMin) / (1 + Math.exp(-z));
}

/** One side's value under one currency. `adj` is `effective − raw`, always
 *  ≤ 0, and is the figure the ledger's consolidation row shows. */
export interface Packaged { raw: number; effective: number; adj: number }

/**
 * `package value = Σ v_i · s(v_i)`, and the adjustment that produced it.
 *
 * Negative inputs are clamped to zero rather than scaled. Nothing on the board
 * currently prices an asset below zero — market values and index points are
 * both non-negative — but a negative asset run through a utilization weight
 * would come back *less* negative, i.e. the curve would reward holding a
 * liability, which is the one behaviour a scale must not have.
 */
export function packageValue(values: number[], c: UtilCurve): Packaged {
  let raw = 0, effective = 0;
  for (const v0 of values) {
    const v = Math.max(0, v0);
    raw += v;
    effective += v * utilization(v, c);
  }
  return { raw, effective, adj: effective - raw };
}

/* ========================================================================
   2. PICK DVI/CVI ESTIMATION
   ======================================================================== */

/**
 * `data/leagues/<key>/value_bridge.json`.
 *
 * Committed, deployed, and until now unread by the front end. Written by
 * `scripts/value_bridge.py`. Only the parts this module uses are typed; the
 * isotonic `fits` ladders are declared as unknown rather than guessed at.
 *
 * The type lives HERE rather than in `lib/types.ts` because nothing outside the
 * trade machine reads the file yet. Promote it when a second reader appears.
 */
export interface ValueBridge {
  meta?: { values_fetched?: string; seed_season?: number };
  fits?: unknown;
  fits_by_pos?: unknown;
  /** per band: `[label, market price, total implied WAR, [y1, y2, y3]]` —
   *  e.g. `["2027 Early 1st", 6924, 1.971, [0.819, 0.676, 0.591]]`. The WAR is
   *  net of the waiver-dart baseline, so late bands are legitimately negative. */
  picks?: { ktc?: BridgePick[]; fc?: BridgePick[] };
}
export type BridgePick = [string, number, number, number[]];

/* ---- monotone (isotonic) fit -------------------------------------------- */

/**
 * A monotone non-decreasing map fit to scattered `(x, y)` pairs — pool
 * adjacent violators, then linear interpolation between block means.
 *
 * The same machinery `lib/rosterModel.ts` uses to keep the pick board
 * monotone, written out again here for the dependency reason in the module
 * header. Monotone rather than linear because the relationship being fit
 * (market price → index) is known to be increasing and is emphatically not a
 * straight line: the index saturates at 100 while KTC keeps climbing.
 *
 * Returns null when there is not enough evidence to fit anything, so the caller
 * can decline to estimate rather than publish a number it made up.
 */
export function monotoneFit(points: [number, number][], minN = 20):
  ((x: number) => number) | null {
  const pts = points
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    .sort((a, b) => a[0] - b[0]);
  if (pts.length < minN) return null;

  // PAV: merge backwards while the previous block's mean exceeds this one's
  const blocks: { sx: number; sy: number; n: number }[] = [];
  for (const [x, y] of pts) {
    blocks.push({ sx: x, sy: y, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sy / a.n <= b.sy / b.n) break;
      a.sx += b.sx; a.sy += b.sy; a.n += b.n;
      blocks.pop();
    }
  }
  const knots = blocks.map(b => [b.sx / b.n, b.sy / b.n] as [number, number]);

  return (x: number) => {
    if (x <= knots[0][0]) return knots[0][1];
    const last = knots[knots.length - 1];
    if (x >= last[0]) return last[1];
    // knots are few (blocks, not points) and this runs a handful of times per
    // render, so a linear scan is the right amount of machinery
    for (let i = 1; i < knots.length; i++) {
      const [x1, y1] = knots[i];
      if (x > x1) continue;
      const [x0, y0] = knots[i - 1];
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
    return last[1];
  };
}

/* ---- timing kernels ------------------------------------------------------ */

/**
 * How much each of the next N seasons counts, per index.
 *
 * `TRADE_MACHINE_MODEL.md` §2 step 4 wants a pick's stream pushed through the
 * same weighting kernels players go through. Those kernels are Python-side
 * (`scripts/blend_values.py`, `scripts/contender_index.py`) and neither their
 * inputs nor their per-component outputs ship — `blended_values.json` and
 * `cvi_detail.json` are gitignored. So these two arrays stand in for the
 * horizon each index is asking about, and only for the horizon:
 *
 *  - **CVI is a question about now.** A contender is asking who helps him win
 *    this season. Steep decay: next year counts a third, the year after a
 *    tenth, and nothing beyond that counts at all.
 *  - **DVI is a question about the asset.** A dynasty index barely cares
 *    whether the WAR lands in year one or year three, so the decay is shallow
 *    and long — a discount for waiting, not a penalty for being young.
 *
 * Index 0 is the season now in progress.
 */
export const CVI_TIMING: readonly number[] = [1, 0.35, 0.10];
export const DVI_TIMING: readonly number[] =
  [1, 0.95, 0.90, 0.84, 0.77, 0.69, 0.60, 0.50, 0.40];

const kern = (k: readonly number[], t: number) => (t < 0 || t >= k.length ? 0 : k[t]);

/**
 * What a stream is worth arriving `lag` seasons from now, relative to the same
 * stream arriving immediately.
 *
 * This is the doc's "a 2028 pick is the same stream shifted one year later"
 * made into a number. `m(0) = 1` by construction, and the multiplier falls as
 * the pick moves out — brutally under CVI, mildly under DVI.
 *
 * The bridge's own per-year figures are net of the waiver-dart baseline, so
 * every band from the 2nd round down carries an all-negative stream. Those
 * carry no timing SHAPE to weight, only a level, so they fall back to a flat
 * stream: the multiplier then depends on lag and kernel alone, which for the
 * shipped data lands within 0.01 of the shaped answer anyway.
 */
export function timingMultiplier(
  stream: number[] | null | undefined, lag: number, kernel: readonly number[],
): number {
  let s = (stream ?? []).map(x => Math.max(0, x));
  if (!s.length || s.reduce((a, x) => a + x, 0) <= 0) s = [1, 1, 1];
  let now = 0, later = 0;
  for (let t = 0; t < s.length; t++) {
    now += kern(kernel, t) * s[t];
    later += kern(kernel, lag + t) * s[t];
  }
  if (now <= 0) return 0;
  return later / now;
}

/* ---- pick labels --------------------------------------------------------- */

export interface PickRef {
  year: number; round: number; tier: string;
  /** the Early/Mid/Late band label the bridge and the market both key on */
  band: string;
}

/**
 * `"2027 Early 1st"` and `"2026 Pick 1.03"` — the two shapes `useAssets()`
 * emits — resolved to one band.
 *
 * The slot→tier partition is `floor((slot − 1) / 4)`, the same one
 * `model.ts:248` uses, which is the doc's "early ≈ 3 / mid ≈ 6 / late ≈ 10"
 * expressed as a partition rather than as three representative slots.
 */
export function parsePick(label: string): PickRef | null {
  const band = /^(\d{4})\s+(Early|Mid|Late)\s+(1st|2nd|3rd|4th)$/.exec(label);
  if (band) {
    const round = ROUND_ORD.indexOf(band[3]) + 1;
    return { year: +band[1], round, tier: band[2], band: label };
  }
  const slot = /^(\d{4})\s+Pick\s+(\d)\.(\d{2})$/.exec(label);
  if (slot) {
    const round = +slot[2], n = +slot[3];
    const tier = TIERS[Math.min(2, Math.floor((n - 1) / 4))];
    return { year: +slot[1], round, tier, band: `${slot[1]} ${tier} ${ROUND_ORD[round - 1]}` };
  }
  return null;
}

/* ---- the estimator ------------------------------------------------------- */

export interface PickIndex {
  dvi: number; cvi: number;
  /** the index before timing — what a PLAYER at this price scores */
  baseDvi: number; baseCvi: number;
  /** the timing multipliers applied, for anyone auditing the figure */
  timeDvi: number; timeCvi: number;
  /** seasons until the pick is made. 0 = this year's class. */
  lag: number;
}

export interface PickIndexerInput {
  /** the player field: every player the market prices AND the index scores.
   *  `useAssets()` hands this over directly. */
  players: { ktc: number; dvi: number; cvi: number }[];
  bridge: ValueBridge | null;
  /** the rookie class drafting now — lag 0. `useAssets()` labels it. */
  currentClass: number | null;
}

/**
 * THE APPROXIMATION, AND ITS REPLACEMENT PATH.
 *
 * What the model doc asks for: resolve a pick to an expected WAR stream, then
 * push that stream through the *identical* DVI/CVI kernels players go through.
 * What is reachable from committed, deployed data: the stream (it is in
 * `value_bridge.json`, per band, per year, already market-implied) — but not
 * the kernels, which are Python and whose per-component inputs are gitignored.
 * Two of DVI's four channels (roster %, start %) are undefined for a pick
 * anyway, because nobody rosters "2027 Mid 1st" as a Sleeper player.
 *
 * So, per the gap audit's §7.3 route A, in two steps:
 *
 *  1. **Market-anchored base.** Fit a monotone `KTC → DVI` and `KTC → CVI` over
 *     the player field, evaluate at the pick's own market price. Defensible
 *     because market is 50% of DVI and 50% of CVI by construction, so the
 *     dominant channel is exact rather than approximated — and the emergent
 *     behaviour the doc wants falls out for free, since the players who trade
 *     at a 1st-rounder's price are young and unproven, which IS the high-DVI /
 *     low-CVI cohort.
 *  2. **Timing shape.** The base answers "what is a player at this price
 *     worth"; it does not know the pick has not happened yet. So it is scaled
 *     by `timingMultiplier` on the bridge's own per-year stream, which is what
 *     makes a 2028 pick discount brutally under CVI (~×0.07) and mildly under
 *     DVI (~×0.88).
 *
 * WHAT IT COSTS: the WAR / roster% / start% half of each index is inherited
 * from comparably-priced players rather than computed from the pick's own
 * stream. And because the market price ALREADY discounts a far-off pick, the
 * timing multiplier double-counts the calendar a little under CVI. Both push
 * the same way (future picks score lower under CVI), so the direction is safe
 * and the magnitude is v1.
 *
 * REPLACEMENT PATH: when the pipeline publishes pick streams through the real
 * kernels — i.e. when `blend_values.py` / `contender_index.py` emit a
 * `picks` block into `index_models.json` the way they emit `players` — delete
 * both steps and read the figure. Nothing else in this file changes; the
 * consolidation curve takes whatever index it is handed.
 *
 * Returns null when the field is too thin to fit (< 20 joined players) or the
 * bridge is missing, and the ledger then does what it did before: leaves the
 * pick out of the index columns and says so in the caption.
 */
export type PickIndexer = (label: string, marketValue: number | null) => PickIndex | null;

export function makePickIndexer(inp: PickIndexerInput): PickIndexer | null {
  const field = inp.players.filter(p =>
    p.ktc != null && p.dvi != null && p.cvi != null && p.ktc > 0);
  const fitDvi = monotoneFit(field.map(p => [p.ktc, p.dvi] as [number, number]));
  const fitCvi = monotoneFit(field.map(p => [p.ktc, p.cvi] as [number, number]));
  if (!fitDvi || !fitCvi) return null;

  const streams = new Map<string, number[]>();
  for (const row of inp.bridge?.picks?.ktc ?? []) streams.set(row[0], row[3]);
  const prices = new Map<string, number>();
  for (const row of inp.bridge?.picks?.ktc ?? []) prices.set(row[0], row[1]);

  return (label: string, marketValue: number | null): PickIndex | null => {
    const ref = parsePick(label);
    if (!ref) return null;
    const price = marketValue ?? prices.get(ref.band) ?? null;
    if (price == null) return null;
    // The current class is lag 0. Without it there is no calendar, so every
    // pick is treated as arriving now — which is wrong in the direction of
    // FLATTERING a future pick, so it is stated rather than silent.
    const lag = inp.currentClass == null ? 0 : Math.max(0, ref.year - inp.currentClass);
    const stream = streams.get(ref.band) ?? null;
    const timeDvi = timingMultiplier(stream, lag, DVI_TIMING);
    const timeCvi = timingMultiplier(stream, lag, CVI_TIMING);
    const baseDvi = fitDvi(price), baseCvi = fitCvi(price);
    return {
      baseDvi, baseCvi, timeDvi, timeCvi, lag,
      dvi: baseDvi * timeDvi,
      cvi: baseCvi * timeCvi,
    };
  };
}

/* ========================================================================
   3. THE LEDGER
   ======================================================================== */

/** What one asset contributes, per currency, after pick estimation. */
export interface PricedAsset {
  asset: LedgerAsset;
  value: Triple;
  /** true when the DVI/CVI figures are the estimate above rather than the
   *  model's own. The screen marks these; an estimated index rendered
   *  identically to a computed one is a lie of typography. */
  estimated: boolean;
}

export function priceAsset(a: LedgerAsset, idx: PickIndexer | null): PricedAsset {
  if (a.kind === "pick") {
    const e = idx ? idx(a.label, a.ktc) : null;
    if (e) {
      return {
        asset: a, estimated: true,
        value: { market: a.ktc ?? 0, dvi: e.dvi, cvi: e.cvi },
      };
    }
  }
  return {
    asset: a, estimated: false,
    // A null index contributes nothing rather than being dropped: the asset is
    // real and its market value counts. The caption says which columns are
    // short a figure.
    value: { market: a.ktc ?? 0, dvi: a.dvi ?? 0, cvi: a.cvi ?? 0 },
  };
}

export interface SideLedger {
  n: number;
  picks: number;
  /** how many assets contributed an ESTIMATED index */
  estimated: number;
  raw: Triple;
  /** Σ v·s(v) — what the package is worth once utilization is applied */
  effective: Triple;
  /** effective − raw, ≤ 0 per currency */
  adj: Triple;
  rows: PricedAsset[];
}

export function sideLedger(rows: LedgerAsset[], idx: PickIndexer | null): SideLedger {
  const priced = rows.map(r => priceAsset(r, idx));
  const raw = zero(), effective = zero(), adj = zero();
  for (const lens of LENSES) {
    const p = packageValue(priced.map(x => x.value[lens]), UTIL_CURVES[lens]);
    raw[lens] = p.raw; effective[lens] = p.effective; adj[lens] = p.adj;
  }
  return {
    n: priced.length,
    picks: priced.filter(p => p.asset.kind === "pick").length,
    estimated: priced.filter(p => p.estimated).length,
    raw, effective, adj, rows: priced,
  };
}

export interface TradeLedger {
  a: SideLedger; b: SideLedger;
  /** raw net TO SIDE A — what A gets minus what B gets */
  net: Triple;
  /** the consolidation adjustment's net effect on A */
  adj: Triple;
  /** `net + adj`, and equally `a.effective − b.effective` */
  adjNet: Triple;
}

/**
 * The whole ledger, in one object.
 *
 * Signed to A throughout, because the screen has one headline row and it is
 * "net to Side A". `adjNet` is derivable two ways and both are computed the
 * same here, which is the invariant the tests pin: the adjustment is shown, it
 * is never smuggled into the total above it, and the two rows still add up.
 */
export function tradeLedger(
  rowsA: LedgerAsset[], rowsB: LedgerAsset[], idx: PickIndexer | null,
): TradeLedger {
  const a = sideLedger(rowsA, idx), b = sideLedger(rowsB, idx);
  const net = zero(), adj = zero(), adjNet = zero();
  for (const lens of LENSES) {
    net[lens] = a.raw[lens] - b.raw[lens];
    adj[lens] = a.adj[lens] - b.adj[lens];
    adjNet[lens] = a.effective[lens] - b.effective[lens];
  }
  return { a, b, net, adj, adjNet };
}
