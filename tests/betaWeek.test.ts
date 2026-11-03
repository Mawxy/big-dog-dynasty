/**
 * Locks `src/beta/week.ts` — the one played-week computation League's "Last
 * week" band and the Seasons screen share. Same runner as tradeModel.test.ts:
 * Node's built-in test runner with native type stripping, no framework.
 * Fixtures are synthetic and small; each test pins one behavior the board would
 * be wrong without.
 *
 * NOT TYPECHECKED, like the other two test files (see tsconfig.test.json).
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// week.ts imports "../lib/league" the way Vite resolves it, with no extension,
// and Node's resolver needs one. Scoped to relative specifiers in this process.
registerHooks({
  resolve(spec, ctx, next) {
    return next(/^\.\.?\//.test(spec) && !/\.\w+$/.test(spec) ? `${spec}.ts` : spec, ctx);
  },
});
const { playedSlotCount, weekFigures } = await import("../src/beta/week.ts");

const row = (rid: number, pts: number, opp: number, oppPts: number) =>
  ({ rid, pts, opp, oppPts, starters: [], bench: [] });
/** three games: 1 beat 2, 3 beat 4, 5 tied 6 */
const week = () => [
  row(1, 120, 2, 100), row(2, 100, 1, 120),
  row(3, 130, 4, 110), row(4, 110, 3, 130),
  row(5, 90, 6, 90), row(6, 90, 5, 90),
];
const odds = (wps: Record<number, number>) => ({
  weeks: { 8: Object.fromEntries(Object.entries(wps).map(([r, wp]) => [r, { wp }])) },
});
const figs = (o: unknown) => weekFigures(week(), 8, o as any, null, {} as any)!;

test("a favored winner is not an upset, however low his price against the other winners", () => {
  // the 2025 week 8 shape: every winner favored, the least-liked of them at 62%
  const f = figs(odds({ 1: 0.62, 2: 0.38, 3: 0.71, 4: 0.29, 5: 0.5, 6: 0.5 }));
  assert.equal(f.upset, null);
  assert.equal(f.upsetWp, null);
  assert.equal(f.priced, true);
});

test("the upset is the winner the line liked least, among those it had under 50%", () => {
  const f = figs(odds({ 1: 0.45, 2: 0.55, 3: 0.31, 4: 0.69, 5: 0.5, 6: 0.5 }));
  assert.equal(f.upset?.rid, 3);
  assert.equal(f.upsetWp, 0.31);
});

test("a coin flip's winner is not an upset", () => {
  const f = figs(odds({ 1: 0.5, 2: 0.5, 3: 0.6, 4: 0.4, 5: 0.5, 6: 0.5 }));
  assert.equal(f.upset, null);
});

test("a tie is not an upset, even for the side the line disliked", () => {
  const f = figs(odds({ 1: 0.6, 2: 0.4, 3: 0.6, 4: 0.4, 5: 0.2, 6: 0.8 }));
  assert.equal(f.upset, null);
});

test("a week with no line says so: no odds file, and an odds file without the week", () => {
  for (const o of [null, { weeks: {} }]) {
    const f = figs(o);
    assert.equal(f.upset, null);
    assert.equal(f.priced, false);
  }
});

test("a scored week draws the slots it fielded, not today's slot list", () => {
  const eight = Array(8).fill("p");
  const nine = Array(9).fill("p");
  // Pineapple Pizza 2024: eight starters against today's nine slots
  assert.equal(playedSlotCount(9, eight), 8);
  assert.equal(playedSlotCount(9, nine), 9);
  // more starters than slots is still every starter; none on file is the list
  assert.equal(playedSlotCount(8, nine), 9);
  assert.equal(playedSlotCount(9, []), 9);
});
