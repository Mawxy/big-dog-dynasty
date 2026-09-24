/**
 * Locks the trade math — `src/lib/tradeModel.ts` — and, in a second section at
 * the bottom, the pure shared helpers in `src/lib/seasons.ts` and
 * `src/lib/projRecord.ts`.
 *
 * Four behaviors the model doc asserts and the ledger would be wrong without,
 * plus the invariant that makes the consolidation row honest:
 *
 *  1. MONOTONICITY — one 9000 beats two 4500s on the Market lens once the
 *     utilization weight is applied. This is the whole reason the adjustment
 *     exists; without it the ledger prices quantity and quality identically.
 *  2. 1-FOR-1 NEUTRALITY — equal singles net to zero and the adjustment is
 *     symmetric, so the correction never invents a winner in a fair trade.
 *  3. PICK TIMING — the same band one year further out costs a little under
 *     DVI and almost everything under CVI.
 *  4. FLOOR — throw-ins never push a side's adjusted value down. `u ≥ u_min`
 *     is what makes "add a scrub" unable to make a package look worse.
 *  5. THE CONVERSION SEAM — a converted pick contributes its haircut figure
 *     but is read on the utilization curve at what it converts to.
 *
 * WHAT PINS WHAT. The lens PARAMETERS are v1 hand-tuned figures and will move
 * when the empirical start-share fit lands (`TRADE_MACHINE_MODEL.md` §1 v2), so
 * nothing here asserts an exact `s(v)`. What is pinned is the ORDERING and the
 * SIGN — the properties any replacement curve must also have.
 *
 * RUNNER. Everything else in tests/ is Python (`unittest`, run under pytest)
 * because everything else it tests is Python. This one tests TypeScript
 * modules, so it runs on Node's built-in test runner with native type
 * stripping — no framework, no build step, no new dependency. `npm test` is
 * the one line of package.json it needed, and is how CI runs it. FROM THE
 * REPO ROOT, either of:
 *
 *     npm test
 *     node --test tests/tradeModel.test.ts
 *
 * Needs Node ≥ 22.18 (type stripping unflagged; 22.22 in this workspace).
 *
 * THAT RUNNER IS WHY THE MODULES UNDER TEST HAVE NO RUNTIME IMPORTS. Node
 * resolves specifiers its own way, and one extensionless relative import would
 * drag the React tree into the test run. `tradeModel.ts` imports nothing at
 * all; `seasons.ts` and `projRecord.ts` import only types, which stripping
 * erases. Their React wrappers live in `lib/caps.ts`, which is NOT importable
 * here and deliberately holds no logic of its own.
 *
 * NOT TYPECHECKED BY `npx tsc --noEmit`. tsconfig's `include` is `["src"]`, so
 * this file is outside the program, and type stripping erases annotations
 * without checking them — the types here are documentation that Node ignores.
 * The modules under test ARE in the program and are checked there. Wiring this
 * in would cost `@types/node`; it is deliberately not taken, and stated so
 * nobody assumes coverage that is not there.
 *
 * The pick-timing tests read committed league data (value_bridge.json,
 * dvi.json, cvi.json, data/values.json) rather than a fixture, and SKIP if a
 * clone is missing it — the same gating `test_slot_value.py` uses for its
 * corpus test. Everything in the second section is synthetic and never skips.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CVI_TIMING, DVI_TIMING, UTIL_CURVES,
  CVI_CONVERSION, makePickIndexer, monotoneFit, packageValue, parsePick, priceAsset,
  sideLedger, timingMultiplier, tradeLedger, utilization,
  type LedgerAsset, type PickIndexer, type ValueBridge,
} from "../src/lib/tradeModel.ts";
import {
  currentPickClass, isSeasonSettled, lastSettledSeason, ridOf, seasonRow,
  settledSeasons,
} from "../src/lib/seasons.ts";
import { playedWeeks, projectedRecord } from "../src/lib/projRecord.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const player = (label: string, ktc: number, dvi: number, cvi: number): LedgerAsset =>
  ({ kind: "player", label, ktc, dvi, cvi });
const pick = (label: string, ktc: number): LedgerAsset =>
  ({ kind: "pick", label, ktc, dvi: null, cvi: null });

/**
 * The index equivalences of two market prices, on the field as shipped.
 *
 * Not invented: these are `monotoneFit(ktc → dvi)` and `monotoneFit(ktc → cvi)`
 * evaluated at 4500 and 9000 over the committed dvi.json / cvi.json /
 * values.json join — the same fit `makePickIndexer` uses to price a pick. They
 * are what makes "one 9000 against two 4500s" a single trade expressible in
 * three currencies instead of three unrelated arithmetic problems.
 */
const MID_DVI = 63.6, MID_CVI = 70.9;   // a KTC 4500 player
const TOP_DVI = 100, TOP_CVI = 96.9;    // a KTC 9000 player

/* ========================================================================
   THE CURVE ITSELF
   ======================================================================== */

test("utilization is bounded, monotone and floored at u_min", () => {
  for (const [lens, c] of Object.entries(UTIL_CURVES)) {
    assert.ok(utilization(-1e6, c) >= c.uMin - 1e-12, `${lens} underflows the floor`);
    assert.ok(utilization(-1e6, c) <= c.uMin + 1e-6, `${lens} floor is not the floor`);
    assert.ok(utilization(1e6, c) <= 1, `${lens} exceeds 1`);
    assert.ok(utilization(1e6, c) > 0.999, `${lens} never reaches full utilization`);
    // monotone across the whole of its own value space
    let prev = -Infinity;
    for (let v = 0; v <= c.v50 * 4; v += c.tau / 8) {
      const s = utilization(v, c);
      assert.ok(s >= prev, `${lens} is not monotone at v=${v}`);
      prev = s;
    }
    assert.ok(utilization(c.v50, c) > c.uMin && utilization(c.v50, c) < 1);
  }
});

test("the lens split: CVI penalises a package hardest, DVI least", () => {
  // The same 2-for-1 in each currency's own value space, at the shipped field's
  // own equivalences — read off the KTC→index ladder `monotoneFit` produces
  // rather than guessed: KTC 4500 ≈ DVI 63.6 ≈ CVI 70.9, KTC 9000 ≈ DVI 100 ≈
  // CVI 96.9. Rounded to MID_DVI/MID_CVI/TOP_* below so one edit moves them all
  // when the field is refreshed.
  const twoMkt = packageValue([4500, 4500], UTIL_CURVES.market);
  const twoDvi = packageValue([MID_DVI, MID_DVI], UTIL_CURVES.dvi);
  const twoCvi = packageValue([MID_CVI, MID_CVI], UTIL_CURVES.cvi);
  const pen = (p: { raw: number; adj: number }) => -p.adj / p.raw;
  assert.ok(pen(twoCvi) > pen(twoMkt), "CVI must penalise quantity harder than Market");
  assert.ok(pen(twoMkt) > pen(twoDvi), "Market must penalise quantity harder than DVI");
  // and a stud passes through nearly untouched in every currency
  assert.ok(-packageValue([9000], UTIL_CURVES.market).adj / 9000 < 0.02);
  assert.ok(-packageValue([TOP_DVI], UTIL_CURVES.dvi).adj / TOP_DVI < 0.08);
  assert.ok(-packageValue([TOP_CVI], UTIL_CURVES.cvi).adj / TOP_CVI < 0.08);
});

/* ========================================================================
   1. MONOTONICITY — one 9000 beats two 4500s
   ======================================================================== */

test("Market: one 9000 clearly beats two 4500s after the adjustment", () => {
  const one = packageValue([9000], UTIL_CURVES.market);
  const two = packageValue([4500, 4500], UTIL_CURVES.market);
  assert.equal(one.raw, two.raw, "the raw sums are equal — that is the premise");
  assert.ok(one.effective > two.effective, "consolidation must win");
  // "clearly": the model doc's worked example puts the pair near 6750 against
  // the stud's 9000. Anything under a 10% edge would not survive rounding in
  // the ledger and would not read as a real difference to a human.
  assert.ok(one.effective / two.effective > 1.10,
    `edge too small: ${one.effective.toFixed(0)} vs ${two.effective.toFixed(0)}`);
  // ... and it keeps winning as the package gets wider
  const three = packageValue([3000, 3000, 3000], UTIL_CURVES.market);
  const four = packageValue([2250, 2250, 2250, 2250], UTIL_CURVES.market);
  assert.ok(two.effective > three.effective);
  assert.ok(three.effective > four.effective);
});

test("through the ledger: the consolidation row carries the whole difference", () => {
  const led = tradeLedger(
    [player("stud", 9000, TOP_DVI, TOP_CVI)],
    [player("a", 4500, MID_DVI, MID_CVI), player("b", 4500, MID_DVI, MID_CVI)],
    null,
  );
  assert.equal(Math.round(led.net.market), 0, "raw market net is zero by construction");
  assert.ok(led.adj.market > 0, "the adjustment must favor the consolidated side");
  assert.ok(led.adjNet.market > 0);
  // the invariant that makes the row honest: shown, never smuggled
  for (const lens of ["market", "dvi", "cvi"] as const)
    assert.ok(Math.abs(led.adjNet[lens] - (led.net[lens] + led.adj[lens])) < 1e-9,
      `${lens}: adjusted net is not net + adj`);
  // the lens split, end to end: CVI likes the stud, DVI likes the pair
  assert.ok(led.adjNet.cvi > 0, "CVI must prefer the consolidated side");
  assert.ok(led.adjNet.dvi < 0, "DVI must prefer the pair");
});

/* ========================================================================
   2. 1-FOR-1 NEUTRALITY
   ======================================================================== */

test("1-for-1: equal singles net to zero and the adjustment cancels", () => {
  const led = tradeLedger(
    [player("A", 7000, 85, 88)],
    [player("B", 7000, 85, 88)],
    null,
  );
  for (const lens of ["market", "dvi", "cvi"] as const) {
    assert.ok(Math.abs(led.net[lens]) < 1e-9, `${lens} raw net is not zero`);
    assert.ok(Math.abs(led.adj[lens]) < 1e-9, `${lens} adjustment is not symmetric`);
    assert.ok(Math.abs(led.adjNet[lens]) < 1e-9, `${lens} adjusted net is not zero`);
  }
});

test("1-for-1 stud swap: each side's own adjustment is small", () => {
  // Different players, same value. Net still zero; what is pinned here is that
  // the correction on a single top asset is a rounding error rather than a
  // penalty for trading at all.
  const led = tradeLedger(
    [player("A", 8600, 96, 95)],
    [player("B", 8600, 96, 95)],
    null,
  );
  assert.ok(-led.a.adj.market / led.a.raw.market < 0.02);
  assert.ok(Math.abs(led.a.adj.market - led.b.adj.market) < 1e-9, "not symmetric");
  assert.ok(Math.abs(led.adjNet.market) < 1e-9);
});

/* ========================================================================
   4. FLOOR — throw-ins never subtract
   ======================================================================== */

test("floor: piling on scrubs never lowers a side's adjusted value", () => {
  for (const [lens, c] of Object.entries(UTIL_CURVES)) {
    const scrub = lens === "market" ? 450 : 4;
    let prev = packageValue([], c).effective;
    const bag: number[] = [];
    for (let i = 0; i < 40; i++) {
      bag.push(scrub);
      const now = packageValue(bag, c).effective;
      assert.ok(now > prev, `${lens}: adding a throw-in did not increase the package`);
      prev = now;
    }
    // and each one is worth at least the floor share of its face value
    assert.ok(prev >= 40 * scrub * c.uMin, `${lens}: a throw-in fell below u_min`);
  }
});

test("floor: forty throw-ins never out-value one stud on the CVI lens", () => {
  // The other half of the floor's job. A floor that was too GENEROUS would let
  // a pile of bodies buy a contender's franchise player, which is the failure
  // the utilization weight exists to prevent.
  const stud = packageValue([TOP_CVI], UTIL_CURVES.cvi).effective;
  const pile = packageValue(Array(40).fill(20), UTIL_CURVES.cvi).effective;
  assert.ok(pile < stud * 1.5, `pile ${pile.toFixed(1)} vs stud ${stud.toFixed(1)}`);
});

test("floor, through the ledger: a throw-in never moves the net against its own side", () => {
  // The packageValue tests above prove the curve floors. This proves the thing
  // a reader would actually notice: adding a body to side A moves "adjusted net
  // to A" UP in every currency, never down. If it could go down, the screen
  // would be telling someone that receiving an extra asset made his side worse,
  // and the ledger would have stopped being a scale.
  const base: LedgerAsset[] = [player("stud", 9000, TOP_DVI, TOP_CVI)];
  const other: LedgerAsset[] = [player("x", 7000, 85, 88), player("y", 3000, 45, 40)];
  let prev = tradeLedger(base, other, null);
  for (let i = 0; i < 12; i++) {
    base.push(player(`scrub${i}`, 450, 4, 3));
    const now = tradeLedger(base, other, null);
    for (const lens of ["market", "dvi", "cvi"] as const)
      assert.ok(now.adjNet[lens] > prev.adjNet[lens],
        `${lens}: throw-in #${i + 1} did not help the side receiving it`);
    // and it never helps the OTHER side either — the adjustment is A's alone
    assert.ok(Math.abs(now.b.effective.market - prev.b.effective.market) < 1e-9);
    prev = now;
  }
});

test("negative inputs clamp rather than being rewarded by the curve", () => {
  const p = packageValue([-500, 1000], UTIL_CURVES.market);
  assert.equal(p.raw, 1000);
  assert.ok(p.adj <= 0);
});

/* ========================================================================
   MONOTONE FIT
   ======================================================================== */

test("monotoneFit is monotone, clamped at the ends, and declines thin data", () => {
  assert.equal(monotoneFit([[1, 1], [2, 2]]), null, "must refuse to fit 2 points");
  const noisy: [number, number][] = [];
  for (let i = 0; i < 200; i++) {
    const x = i * 50;
    noisy.push([x, Math.min(100, x / 45) + (i % 7 === 0 ? -9 : i % 5 === 0 ? 6 : 0)]);
  }
  const f = monotoneFit(noisy)!;
  assert.ok(f, "should fit 200 points");
  let prev = -Infinity;
  for (let x = -1000; x < 12000; x += 37) {
    const y = f(x);
    assert.ok(y >= prev - 1e-9, `not monotone at ${x}`);
    prev = y;
  }
  assert.equal(f(-1e6), f(0), "left clamp");
  assert.equal(f(1e6), f(9950), "right clamp");
});

/* ========================================================================
   3. PICK TIMING
   ======================================================================== */

test("timing multipliers: identity at lag 0, brutal under CVI, mild under DVI", () => {
  const stream = [0.819, 0.676, 0.591];
  assert.ok(Math.abs(timingMultiplier(stream, 0, CVI_TIMING) - 1) < 1e-12);
  assert.ok(Math.abs(timingMultiplier(stream, 0, DVI_TIMING) - 1) < 1e-12);

  const c1 = timingMultiplier(stream, 1, CVI_TIMING);
  const c2 = timingMultiplier(stream, 2, CVI_TIMING);
  const d1 = timingMultiplier(stream, 1, DVI_TIMING);
  const d2 = timingMultiplier(stream, 2, DVI_TIMING);

  assert.ok(1 > c1 && c1 > c2 && c2 > 0, "CVI must decay and stay positive");
  assert.ok(1 > d1 && d1 > d2 && d2 > 0, "DVI must decay and stay positive");
  assert.ok(c1 < 0.5, `a one-year wait should cost a contender most of it (${c1})`);
  assert.ok(c2 < 0.15, `a two-year wait should cost a contender nearly all of it (${c2})`);
  assert.ok(d1 > 0.85, `a one-year wait should be mild under DVI (${d1})`);
  assert.ok(d2 > 0.75, `a two-year wait should still be mild under DVI (${d2})`);

  // an all-negative stream (every band below the 1st is net of the waiver
  // baseline) falls back to flat rather than to NaN or to zero
  const flat = timingMultiplier([-0.9, -0.8, -0.7], 1, CVI_TIMING);
  assert.ok(Number.isFinite(flat) && flat > 0 && flat < 1);
});

test("pick labels resolve to bands, both shapes", () => {
  assert.deepEqual(parsePick("2027 Early 1st"),
    { year: 2027, round: 1, tier: "Early", band: "2027 Early 1st" });
  assert.deepEqual(parsePick("2026 Pick 1.03"),
    { year: 2026, round: 1, tier: "Early", band: "2026 Early 1st" });
  assert.deepEqual(parsePick("2026 Pick 2.06"),
    { year: 2026, round: 2, tier: "Mid", band: "2026 Mid 2nd" });
  assert.deepEqual(parsePick("2026 Pick 4.12"),
    { year: 2026, round: 4, tier: "Late", band: "2026 Late 4th" });
  assert.equal(parsePick("Jahmyr Gibbs"), null);
});

/* ---- against the committed league data ----------------------------------- */

interface Field { indexer: PickIndexer; bridge: ValueBridge; currentClass: number }

function loadField(): Field | null {
  const leagues = path.join(ROOT, "data", "leagues");
  if (!existsSync(leagues)) return null;
  const key = readdirSync(leagues).find(d =>
    existsSync(path.join(leagues, d, "value_bridge.json")) &&
    existsSync(path.join(leagues, d, "dvi.json")));
  if (!key) return null;
  const dir = path.join(leagues, key);
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const valuesPath = path.join(ROOT, "data", "values.json");
  if (!existsSync(valuesPath)) return null;

  const bridge = read(path.join(dir, "value_bridge.json")) as ValueBridge;
  const dvi = read(path.join(dir, "dvi.json"));
  const cvi = read(path.join(dir, "cvi.json"));
  const vals = read(valuesPath);

  const players: { ktc: number; dvi: number; cvi: number }[] = [];
  for (const [pid, d] of Object.entries<{ dvi: number }>(dvi.players)) {
    const v = vals.players?.[pid], c = cvi.players?.[pid];
    if (v?.ktc && c) players.push({ ktc: v.ktc, dvi: d.dvi, cvi: c.cvi });
  }
  // the rookie class drafting now is the earliest year the bridge prices
  const years = (bridge.picks?.ktc ?? []).map(r => Number(r[0].slice(0, 4)));
  const currentClass = Math.min(...years);
  const indexer = makePickIndexer({ players, bridge, currentClass });
  return indexer ? { indexer, bridge, currentClass } : null;
}

const FIELD = loadField();
const priceOf = (b: ValueBridge, label: string) =>
  (b.picks?.ktc ?? []).find(r => r[0] === label)?.[1] ?? null;

test("pick index: a future 1st under CVI lands on the conversion floor, not the timing cliff",
  { skip: FIELD ? false : "committed league data not present in this clone" }, () => {
    // Bands are built off the live pick class, not the calendar, so the test
    // does not rot when the class rolls: near is one year out, far is two.
    const { indexer, bridge, currentClass } = FIELD!;
    const nearBand = `${currentClass + 1} Early 1st`;
    const farBand = `${currentClass + 2} Early 1st`;
    const near = indexer(nearBand, priceOf(bridge, nearBand))!;
    const far = indexer(farBand, priceOf(bridge, farBand))!;
    assert.ok(near && far, "both bands must estimate");

    assert.ok(far.cvi <= near.cvi, "the far pick must not beat the near one under CVI");
    assert.ok(far.dvi < near.dvi, "the far pick must be weaker than the near one under DVI");
    // Timing alone would put a far pick near zero for a contender. The pick
    // is liquid, so its CVI is floored at what it converts to less the haircut
    // (Max, 2026-09-08): the figure is baseCvi × CVI_CONVERSION exactly, and
    // the estimate says so.
    assert.ok(far.timeCvi < CVI_CONVERSION, "a far pick's timing is below the floor");
    assert.ok(far.converted, "the floor must be flagged");
    assert.ok(Math.abs(far.cvi - far.baseCvi * CVI_CONVERSION) < 1e-9,
      "CVI must be the conversion figure");
    assert.ok(far.cvi > far.baseCvi * far.timeCvi * 3,
      "the floor must lift the pick well clear of the timing cliff");
    // DVI is untouched by the floor: it still takes its mild timing step
    const dRatio = far.dvi / near.dvi;
    assert.ok(dRatio > 0.6, `DVI drop is too brutal (${dRatio.toFixed(3)})`);
    assert.ok(!far.converted || Math.abs(far.dvi - far.baseDvi * far.timeDvi) < 1e-9,
      "the floor must not touch DVI");
  });

test("pick index: a 1st is a strong dynasty asset and a weak contender asset",
  { skip: FIELD ? false : "committed league data not present in this clone" }, () => {
    const { indexer, bridge } = FIELD!;
    const first = indexer("2027 Early 1st", priceOf(bridge, "2027 Early 1st"))!;
    const third = indexer("2027 Early 3rd", priceOf(bridge, "2027 Early 3rd"))!;
    assert.ok(first.dvi > first.cvi,
      "a future 1st must score higher on the dynasty index than the contender one");
    assert.ok(first.dvi > third.dvi, "a 1st must beat a 3rd under DVI");
    assert.ok(first.cvi > third.cvi, "a 1st must beat a 3rd under CVI");
    // the current class is not discounted at all — it drafts now
    const now = indexer(`${FIELD!.currentClass} Pick 1.03`,
      priceOf(bridge, `${FIELD!.currentClass} Early 1st`))!;
    assert.equal(now.lag, 0);
    assert.ok(Math.abs(now.timeCvi - 1) < 1e-12);
    assert.ok(Math.abs(now.timeDvi - 1) < 1e-12);
  });

test("picks in the ledger: consolidating picks beats splitting them, and the "
  + "estimate is flagged",
{ skip: FIELD ? false : "committed league data not present in this clone" }, () => {
  const { indexer, bridge } = FIELD!;
  const p1 = priceOf(bridge, "2027 Early 1st")!;
  const p3 = priceOf(bridge, "2027 Early 3rd")!;
  const led = tradeLedger(
    [pick("2027 Early 1st", p1)],
    [pick("2027 Early 3rd", p3), pick("2027 Mid 3rd", priceOf(bridge, "2027 Mid 3rd")!)],
    indexer,
  );
  assert.equal(led.a.estimated, 1);
  assert.equal(led.b.estimated, 2);
  assert.ok(led.a.raw.dvi > 0 && led.a.raw.cvi > 0,
    "a pick must no longer contribute zero to the index columns");
  assert.ok(led.adjNet.cvi > 0, "one 1st should beat two 3rds for a contender");
});

/* ========================================================================
   5. THE CONVERSION SEAM — `packageValue(values, c, at)` and `utilAt`

   The third argument to packageValue and the `utilAt` field that feeds it
   existed with no test at all, and they are the one place in the file where
   what an asset CONTRIBUTES and where its curve is READ are different
   numbers. Synthetic throughout: a fixed field and a two-band bridge, so
   these never depend on what the market did last night.
   ======================================================================== */

/** a monotone KTC→index field wide enough for `monotoneFit` (needs 20) */
const synthField = () => {
  const out: { ktc: number; dvi: number; cvi: number }[] = [];
  for (let i = 0; i < 40; i++) {
    const ktc = 400 + i * 240;                     // 400 … 9760
    out.push({ ktc, dvi: Math.min(100, ktc / 98), cvi: Math.min(100, ktc / 100) });
  }
  return out;
};

/** two bands, one drafting now and one three classes out */
const synthBridge = (): ValueBridge => ({
  picks: { ktc: [
    ["2026 Early 1st", 6000, 1.97, [0.82, 0.68, 0.59]],
    ["2029 Early 1st", 5000, 1.80, [0.75, 0.62, 0.54]],
  ] },
});

const synthIndexer = (): PickIndexer => makePickIndexer({
  players: synthField(), bridge: synthBridge(), currentClass: 2026,
})!;

test("packageValue reads the curve at `at` and still contributes the value", () => {
  const c = UTIL_CURVES.cvi;
  // 48 contributed, but the curve read at 68 — the shape a converted pick has
  const at = packageValue([48], c, [68]);
  assert.equal(at.raw, 48, "`at` must not change what the asset contributes");
  assert.ok(Math.abs(at.effective - 48 * utilization(68, c)) < 1e-12);

  // and it is strictly kinder than reading the curve at the haircut figure,
  // which is the whole reason the argument exists
  const naive = packageValue([48], c);
  assert.ok(at.effective > naive.effective,
    `reading at 68 must beat reading at 48 (${at.effective} vs ${naive.effective})`);

  // a null entry, a short array and no array at all all mean "read at value"
  assert.equal(packageValue([48], c, [null]).effective, naive.effective);
  assert.equal(packageValue([48], c, []).effective, naive.effective);
  assert.equal(packageValue([48], c, undefined).effective, naive.effective);

  // negatives clamp on BOTH sides — a negative `at` must not read below the
  // floor any more than a negative value may be rewarded
  assert.equal(packageValue([48], c, [-999]).effective, 48 * utilization(0, c));
});

test("a converted pick carries utilAt, and sideLedger honours it", () => {
  const idx = synthIndexer();
  const e = idx("2029 Early 1st", 5000)!;
  assert.ok(e.converted, "three classes out must land on the conversion floor");
  assert.ok(Math.abs(e.cvi - e.baseCvi * CVI_CONVERSION) < 1e-12);

  const priced = priceAsset(
    { kind: "pick", label: "2029 Early 1st", ktc: 5000, dvi: null, cvi: null }, idx);
  assert.equal(priced.estimated, true);
  assert.ok(Math.abs((priced.utilAt?.cvi ?? 0) - e.baseCvi) < 1e-12,
    "the CVI curve must be read at what the pick converts to");
  assert.equal(priced.utilAt?.dvi, undefined, "DVI takes no conversion floor");

  const led = sideLedger(
    [{ kind: "pick", label: "2029 Early 1st", ktc: 5000, dvi: null, cvi: null }], idx);
  assert.equal(led.picks, 1);
  assert.equal(led.estimated, 1);
  assert.ok(Math.abs(led.raw.cvi - e.cvi) < 1e-12);
  assert.ok(Math.abs(led.effective.cvi - e.cvi * utilization(e.baseCvi, UTIL_CURVES.cvi)) < 1e-12,
    "effective CVI must be the haircut value scaled at the BASE utilization");
  // the bug this guards: reading the curve at the haircut figure would say a
  // 48 never starts about a pick that buys a 68
  assert.ok(led.effective.cvi > e.cvi * utilization(e.cvi, UTIL_CURVES.cvi));
  // DVI has no `at`, so its effective is the plain curve at its own value
  assert.ok(Math.abs(led.effective.dvi - e.dvi * utilization(e.dvi, UTIL_CURVES.dvi)) < 1e-12);
});

test("a converted pick beats a player priced at the same CVI, through the ledger", () => {
  const idx = synthIndexer();
  const e = idx("2029 Early 1st", 5000)!;
  // Side A sends the pick; side B sends a PLAYER whose CVI is exactly the
  // pick's contributed figure. Raw nets to zero in that column; the pick wins
  // on the adjusted line, because it is read at what it converts to.
  const led = tradeLedger(
    [{ kind: "pick", label: "2029 Early 1st", ktc: 5000, dvi: null, cvi: null }],
    [player("same-cvi", 5000, e.dvi, e.cvi)],
    idx,
  );
  assert.ok(Math.abs(led.net.cvi) < 1e-9, "raw CVI net is zero by construction");
  assert.ok(led.adjNet.cvi > 0, "the conversion read must favour the pick");
  // the invariant still holds with `at` in play
  for (const lens of ["market", "dvi", "cvi"] as const)
    assert.ok(Math.abs(led.adjNet[lens] - (led.net[lens] + led.adj[lens])) < 1e-9,
      `${lens}: adjusted net is not net + adj`);
});

test("the class drafting now takes no conversion floor and no utilAt", () => {
  const idx = synthIndexer();
  const now = idx("2026 Pick 1.03", 6000)!;
  assert.equal(now.lag, 0);
  assert.equal(now.converted, false);
  const priced = priceAsset(
    { kind: "pick", label: "2026 Pick 1.03", ktc: 6000, dvi: null, cvi: null }, idx);
  assert.equal(priced.utilAt, undefined,
    "an undiscounted pick contributes and is read at the same figure");
});

/* ========================================================================
   ========================================================================
   SECTION TWO â€” THE SHARED SEASON HELPERS

   A SEPARATE SUBJECT IN THE SAME FILE, on purpose. `npm test` names exactly
   one path (`node --test tests/tradeModel.test.ts`), so a second file would
   not be run by CI and would rot unnoticed; package.json is not this file's
   to edit. When that command grows a glob, lift everything below into
   `tests/lib.test.ts` unchanged â€” nothing here depends on the trade math.

   Subjects: `src/lib/seasons.ts` and `src/lib/projRecord.ts`. Both are pure
   and dependency-free; their React wrappers in `lib/caps.ts` add no logic.
   ========================================================================
   ======================================================================== */

/** a franchises.json row, with the fields these helpers actually read */
const fsn = (season: string, rid: number, finish: number | null) => ({
  season, rid, name: `T${rid}`, manager: `M${rid}`,
  wins: 7, losses: 7, ties: 0, fpts: 1500, ppg: 107, war: 5,
  seed: rid, finish,
});

/** Big Dog's scheme: the franchise key IS the roster id */
const DYNASTY = {
  "1": { seasons: [fsn("2025", 1, 1), fsn("2026", 1, null)], tx: [] },
  "2": { seasons: [fsn("2025", 2, 2), fsn("2026", 2, null)], tx: [] },
  "3": { seasons: [fsn("2024", 3, 1), fsn("2025", 3, 7), fsn("2026", 3, null)], tx: [] },
};

/** Pineapple Pizza's scheme: the key is an 18-digit owner id and the roster
 *  slot is reassigned every season â€” slot 5 has been three different people */
const REDRAFT = {
  "1001613650664165376": { seasons: [fsn("2024", 5, 1)], tx: [] },
  "1261020801683947520": { seasons: [fsn("2025", 5, 2), fsn("2026", 3, null)], tx: [] },
  "1047524386078744576": { seasons: [fsn("2025", 7, 1), fsn("2026", 5, null)], tx: [] },
};

test("a season is settled only once somebody has finished first", () => {
  assert.equal(isSeasonSettled(DYNASTY, "2025"), true);
  assert.equal(isSeasonSettled(DYNASTY, "2024"), true);
  // 2026 has rows, records and seeds â€” and no champion. That is the whole
  // bug: `finish` is assigned to places 7-12 the moment the first bracket
  // game is decided, so "has finishes" is not "is over".
  assert.equal(isSeasonSettled(DYNASTY, "2026"), false);
  assert.equal(isSeasonSettled(DYNASTY, "2099"), false);
  assert.equal(isSeasonSettled(null, "2025"), false);

  // places 7-12 assigned, nobody first yet â€” still not settled
  const midBracket = {
    "1": { seasons: [fsn("2026", 1, null)], tx: [] },
    "2": { seasons: [fsn("2026", 2, 9)], tx: [] },
  };
  assert.equal(isSeasonSettled(midBracket, "2026"), false);
});

test("settled seasons come back ascending, and narrow to the caller's list", () => {
  assert.deepEqual(settledSeasons(DYNASTY), ["2024", "2025"]);
  // the caller's own order must not leak out: "the last one" has to be newest
  assert.deepEqual(settledSeasons(DYNASTY, ["2026", "2025", "2024"]), ["2024", "2025"]);
  assert.deepEqual(settledSeasons(DYNASTY, ["2026"]), []);
  assert.equal(lastSettledSeason(DYNASTY), "2025");
  assert.equal(lastSettledSeason(DYNASTY, ["2024"]), "2024");
  assert.equal(lastSettledSeason(DYNASTY, ["2026"]), null);
  assert.equal(lastSettledSeason(null), null);
  assert.deepEqual(settledSeasons(REDRAFT), ["2024", "2025"]);
});

test("seasonRow matches on the row's own rid, in both key schemes", () => {
  assert.equal(seasonRow(DYNASTY, "2025", 2)?.key, "2");
  assert.equal(seasonRow(DYNASTY, "2026", 3)?.row.season, "2026");

  // THE BUG THIS EXISTS FOR. `fr[String(rid)]` is right for the dynasty
  // league and finds nothing at all in the redraft one, where the key is an
  // owner id â€” and `Number(key)` on an 18-digit id loses precision.
  assert.equal(seasonRow(REDRAFT, "2025", 5)?.key, "1261020801683947520");
  assert.equal(seasonRow(REDRAFT, "2024", 5)?.key, "1001613650664165376");
  // the same slot, one season later, is a different franchise entirely
  assert.equal(seasonRow(REDRAFT, "2026", 5)?.key, "1047524386078744576");
  assert.equal(seasonRow(REDRAFT, "2026", 11), null);
  assert.equal(seasonRow(null, "2025", 1), null);
});

test("ridOf prefers the row's rid and falls back to the key", () => {
  assert.equal(ridOf("7", { rid: 3 }), 3);
  assert.equal(ridOf("7"), 7);          // pre-`rid` dynasty data: key IS the rid
  assert.equal(ridOf("7", null), 7);
});

/* ---- the rookie class drafting next -------------------------------------- */

const draftsWith = (rows: { season: string; kind: string }[]) => ({ "1": rows });

test("currentPickClass reads drafts.json, not a guess about the calendar", () => {
  // the roster season's rookie draft is in the books -> the NEXT class is live
  assert.equal(
    currentPickClass("2026", draftsWith([{ season: "2026", kind: "rookie" }])), 2027);
  // it is not -> this season's class is still the one being traded
  assert.equal(
    currentPickClass("2026", draftsWith([{ season: "2025", kind: "rookie" }])), 2026);
  // a STARTUP draft is not a rookie class and must not advance the year
  assert.equal(
    currentPickClass("2026", draftsWith([{ season: "2026", kind: "startup" }])), 2026);
  // no drafts.json at all (in flight, or a league that has none) declines to
  // answer rather than inventing a calendar
  assert.equal(currentPickClass("2026", null), null);
  assert.equal(currentPickClass("2026", undefined), null);
  assert.equal(currentPickClass("2026", {}), 2026);
  assert.equal(currentPickClass(null, draftsWith([])), null);
  assert.equal(currentPickClass(2026, draftsWith([])), 2026);
});

test("currentPickClass, wired to the pick indexer, dates a pick correctly", () => {
  // The shipped failure: `generated_for_season + 1` says 2026, a class that
  // has already drafted, so a 2029 pick is dated three years out when it is
  // in fact two. Feeding the real answer moves the lag by exactly one.
  const drafted = currentPickClass("2026", draftsWith([{ season: "2026", kind: "rookie" }]))!;
  const idx = makePickIndexer({
    players: synthField(), bridge: synthBridge(), currentClass: drafted,
  })!;
  assert.equal(idx("2029 Early 1st", 5000)!.lag, 2);
  assert.equal(synthIndexer()("2029 Early 1st", 5000)!.lag, 3);
});

/* ---- the projected record ------------------------------------------------ */

/** a WeekOdds with one line for roster 1 in each of `weeks` */
const odds = (weeks: number[], wp: number, mu = 130) => ({
  meta: { playoff_start: 15, model: "test", played: [], projected: weeks },
  weeks: Object.fromEntries(weeks.map(w => [String(w), { "1": { mu, sd: 24, opp: 2, wp } }])),
});

test("the projected record banks what happened and projects only what has not", () => {
  // one week played and won, thirteen ahead at a coin flip each
  const ahead = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const r = projectedRecord({
    rid: 1,
    record: { wins: 1, losses: 0, ties: 0 },
    odds: odds([1, ...ahead], 0.5) as never,
    played: [1],
    playoffStart: 15,
  });
  assert.equal(r.ahead, 13, "week 1 is played and must not be projected again");
  assert.ok(Math.abs(r.expWins - 6.5) < 1e-9);
  // THE BUG: Home sums over the unplayed weeks only and never banks the win,
  // so a 1-0 team read 6.5-6.5 out of THIRTEEN. The season is fourteen games.
  assert.ok(Math.abs(r.wins + r.losses + r.ties - 14) < 1e-9,
    `a fourteen-game season must project fourteen games, got ${r.wins + r.losses}`);
  assert.ok(Math.abs(r.wins - 7.5) < 1e-9);
  assert.equal(r.text, "7.5-6.5");
  assert.equal(r.projPts.length, 13);
});

test("an unpriced week is not a projected loss, and the playoffs are not projected", () => {
  // week 1 has a mu and NO wp â€” deliberately unpriced (week_odds.py leaves
  // week 1 without a snapshot unpriced). It must not enter the game count.
  const file = odds([2, 3], 0.6);
  file.weeks["1"] = { "1": { mu: 140, sd: 24, opp: 2 } } as never;
  file.weeks["15"] = { "1": { mu: 140, sd: 24, opp: 2, wp: 0.9 } } as never;
  const r = projectedRecord({
    rid: 1, record: { wins: 0, losses: 0, ties: 0 },
    odds: file as never, played: [], playoffStart: 15,
  });
  assert.equal(r.ahead, 2, "only the two priced regular-season weeks count");
  assert.ok(Math.abs(r.wins - 1.2) < 1e-9);
});

test("ties stay a third figure and no unplayed week can add to them", () => {
  const r = projectedRecord({
    rid: 1, record: { wins: 6, losses: 6, ties: 2 },
    odds: odds([13, 14], 0.5) as never, played: [], playoffStart: 15,
  });
  assert.equal(r.ties, 2);
  assert.ok(Math.abs(r.losses - 7) < 1e-9,
    "losses are played losses plus the complement, never games minus wins");
  assert.equal(r.text, "7.0-7.0-2");
});

test("with nothing to project the record is the played one, and says so", () => {
  const r = projectedRecord({
    rid: 1, record: { wins: 10, losses: 4, ties: 0 },
    odds: null, played: [1], playoffStart: 15,
  });
  assert.equal(r.projected, false);
  assert.equal(r.ahead, 0);
  assert.equal(r.text, "10-4");
  // a roster with no line of its own in a file that has lines for others
  const other = projectedRecord({
    rid: 9, record: { wins: 0, losses: 0, ties: 0 },
    odds: odds([2, 3], 0.5) as never, played: [], playoffStart: 15,
  });
  assert.equal(other.projected, false);
  assert.equal(other.text, "0-0");
});

test("playedWeeks counts a week only once it has an opponent score", () => {
  const rows = [
    [1, 144.8, 11, 109.1, [], []],
    [2, 0, 3, null, [], []],        // scheduled, not played
    [15, 150, 4, 120, [], []],      // playoffs
  ];
  assert.deepEqual(playedWeeks(rows as never, 15), [1]);
  assert.deepEqual(playedWeeks(undefined, 15), []);
});
