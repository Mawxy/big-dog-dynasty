/**
 * Locks `src/lib/tradeLineage.ts` — the per-trade asset trace behind the
 * trade page. Same runner as tradeModel.test.ts: Node's built-in test runner
 * with native type stripping, no framework. Fixtures are synthetic and small;
 * each test pins one behavior the page would be wrong without.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { buildLineage, tradeId, ownStep } from "../src/lib/tradeLineage.ts";

const side = (rid: number, got: any[]) => ({ rid, team: `T${rid}`, got, war: 0, future: 0, total: 0 });
const player = (pid: string, label = `P${pid}`) => ({ kind: "player", pid, label, war: 0, future: 0 });
const pick = (ps: number, rnd: number, orig: number, pid: string | null, label: string) =>
  ({ kind: "pick", pid, label, war: 0, future: 0, ps, rnd, orig });
const trade = (ts: number, season: string, week: number, sides: any[]) => ({ ts, season, week, sides });

test("trade id is the timestamp then roster ids ascending", () => {
  assert.equal(tradeId(trade(100, "2024", 1, [side(8, []), side(3, [])]) as any), "100-3-8");
});

test("a pick is followed through a later trade, the draft, and a drop", () => {
  const t1 = trade(100, "2024", 1, [side(3, [pick(2025, 2, 5, "77", "2025 2nd → X")]), side(8, [player("10")])]);
  const t2 = trade(200, "2024", 5, [side(1, [pick(2025, 2, 5, "77", "2025 2nd → X")]), side(3, [player("11")])]);
  const own = { "77": [["2025", 0, "drafted 2.09 by Team One"], ["2025", 6, "dropped by Team One"]] };
  const L = buildLineage([t2, t1] as any, own as any, new Map());
  const [l] = L.trace(t1 as any, 3);
  assert.equal(l.from, 8);
  assert.equal(l.origin, null);
  assert.deepEqual(l.steps.map(s => s.kind), ["trade", "drafted", "dropped"]);
  const hop = l.steps[0] as any;
  assert.equal(hop.from, 3); assert.equal(hop.to, 1);
  assert.deepEqual(hop.got.map((a: any) => a.label), ["P11"]);
  assert.deepEqual(l.end, { kind: "free agent", season: "2025", week: 6 });
});

test("the sender's origin is the hop before this trade", () => {
  const t0 = trade(50, "2023", 9, [side(8, [pick(2025, 2, 5, null, "2025 2nd (not yet drafted)")]), side(2, [player("9")])]);
  const t1 = trade(100, "2024", 1, [side(3, [pick(2025, 2, 5, null, "2025 2nd (not yet drafted)")]), side(8, [player("10")])]);
  const L = buildLineage([t0, t1] as any, {} as any, new Map());
  const [l] = L.trace(t1 as any, 3);
  assert.equal(l.origin?.kind, "trade");
  assert.equal((l.origin as any).from, 2);
  assert.deepEqual(l.end, { kind: "pick", rid: 3, ps: 2025, rnd: 2 });
});

test("a drop between two trades lands between them, and a rostered player ends rostered", () => {
  const t1 = trade(100, "2024", 1, [side(3, [player("10")]), side(8, [player("20")])]);
  const t2 = trade(300, "2024", 9, [side(5, [player("10")]), side(6, [player("21")])]);
  const own = { "10": [
    ["2022", 0, "drafted 1.01 by Old Name"],
    ["2024", 1, "traded to T3 — ..."],
    ["2024", 4, "dropped by T3"],
    ["2024", 5, "waiver claim by Six Guys "],
    ["2024", 9, "traded to T5 — ..."],
  ] };
  const L = buildLineage([t1, t2] as any, own as any, new Map([["10", 5]]));
  const [l] = L.trace(t1 as any, 3);
  assert.equal(l.origin?.kind, "drafted");
  assert.deepEqual(l.steps.map(s => s.kind), ["dropped", "claimed", "trade"]);
  assert.equal((l.steps[1] as any).team, "Six Guys");
  assert.equal((l.steps[2] as any).from, 6);
  assert.deepEqual(l.end, { kind: "rostered", rid: 5 });
});

test("a commissioner move right after a trade marks it reversed", () => {
  const t1 = trade(100, "2025", 1, [side(4, [player("10")]), side(1, [player("20")])]);
  const own = { "10": [["2025", 1, "traded to T4 — ..."], ["2025", 1, "commissioner to Point Drake"]] };
  const L = buildLineage([t1] as any, own as any, new Map());
  assert.ok(L.reversed.has(tradeId(t1 as any)));
});

test("a trade of the pick is not a trade of the player it became", () => {
  // the pick asset carries the drafted player's pid; that must not put the
  // pre-draft pick trade on the player's own timeline
  const t1 = trade(100, "2024", 1, [side(3, [pick(2024, 1, 3, "77", "2024 1st → X")]), side(8, [player("10")])]);
  const own = { "77": [["2024", 0, "drafted 1.07 by T3"]] };
  const L = buildLineage([t1] as any, own as any, new Map([["77", 3]]));
  const [l] = L.trace(t1 as any, 3);
  assert.deepEqual(l.steps.map(s => s.kind), ["drafted"]);
  assert.deepEqual(l.end, { kind: "rostered", rid: 3 });
});

test("unknown ownership wording is skipped, not guessed", () => {
  assert.equal(ownStep(["2024", 1, "something new by X"], "1"), null);
  assert.equal(ownStep(["2024", 1, "signed by X"], "1")?.kind, "claimed");
});
