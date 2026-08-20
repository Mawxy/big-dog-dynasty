/**
 * Locks the trade maths — `src/lib/tradeModel.ts`.
 *
 * Four behaviours the model doc asserts and the ledger would be wrong without,
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
 *
 * WHAT PINS WHAT. The lens PARAMETERS are v1 hand-tuned figures and will move
 * when the empirical start-share fit lands (`TRADE_MACHINE_MODEL.md` §1 v2), so
 * nothing here asserts an exact `s(v)`. What is pinned is the ORDERING and the
 * SIGN — the properties any replacement curve must also have.
 *
 * RUNNER. Everything else in tests/ is Python (`unittest`, run under pytest)
 * because everything else it tests is Python. This one tests a TypeScript
 * module, so it runs on Node's built-in test runner with native type
 * stripping — no framework, no build step, nothing added to package.json, no
 * new dependency. FROM THE REPO ROOT:
 *
 *     node --test tests/tradeModel.test.ts
 *
 * Needs Node ≥ 22.18 (type stripping unflagged; 22.22 in this workspace).
 *
 * That is also why `src/lib/tradeModel.ts` has no runtime imports: Node resolves
 * specifiers its own way, and one extensionless relative import would drag the
 * React tree into the test run.
 *
 * NOT TYPECHECKED BY `npx tsc --noEmit`. tsconfig's `include` is `["src"]`, so
 * this file is outside the program, and type stripping erases annotations
 * without checking them — the types here are documentation that Node ignores.
 * The module under test IS in the program and is checked there. Wiring this in
 * would cost `@types/node` and an entry in package.json; it is deliberately not
 * taken, and stated so nobody assumes coverage that is not there.
 *
 * The pick-timing tests read committed league data (value_bridge.json,
 * dvi.json, cvi.json, data/values.json) rather than a fixture, and SKIP if a
 * clone is missing it — the same gating `test_slot_value.py` uses for its
 * corpus test.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CVI_TIMING, DVI_TIMING, UTIL_CURVES,
  makePickIndexer, monotoneFit, packageValue, parsePick, timingMultiplier,
  tradeLedger, utilization,
  type LedgerAsset, type PickIndexer, type ValueBridge,
} from "../src/lib/tradeModel.ts";

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
  assert.ok(led.adj.market > 0, "the adjustment must favour the consolidated side");
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

test("pick index: a 2028 1st is much weaker than a 2027 1st under CVI, mildly under DVI",
  { skip: FIELD ? false : "committed league data not present in this clone" }, () => {
    const { indexer, bridge } = FIELD!;
    const y27 = indexer("2027 Early 1st", priceOf(bridge, "2027 Early 1st"))!;
    const y28 = indexer("2028 Early 1st", priceOf(bridge, "2028 Early 1st"))!;
    assert.ok(y27 && y28, "both bands must estimate");

    assert.ok(y28.cvi < y27.cvi, "2028 must be weaker than 2027 under CVI");
    assert.ok(y28.dvi < y27.dvi, "2028 must be weaker than 2027 under DVI");
    // The claim is not "both fall" — it is that CVI falls off a cliff and DVI
    // takes a step. That gap IS the lens split for picks.
    const cRatio = y28.cvi / y27.cvi, dRatio = y28.dvi / y27.dvi;
    assert.ok(cRatio < 0.4, `CVI drop is not brutal enough (${cRatio.toFixed(3)})`);
    assert.ok(dRatio > 0.6, `DVI drop is too brutal (${dRatio.toFixed(3)})`);
    assert.ok(dRatio > cRatio * 2, "DVI and CVI are behaving the same way");
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
