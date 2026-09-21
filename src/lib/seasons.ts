import type { DraftPick, Drafts, Franchise, FranchiseSeason, Franchises } from "./types";

/**
 * WHICH SEASONS ARE OVER, WHICH ROW BELONGS TO WHOM, AND WHICH PICK CLASS IS
 * NEXT — the three questions every honors, standings and trade screen was
 * answering for itself, each slightly differently.
 *
 * DELIBERATELY PURE. Not one runtime import: only `import type`, which type
 * stripping erases. That keeps the module importable from
 * `tests/tradeModel.test.ts` under `node --test` (which resolves specifiers the
 * way Node does, not the way Vite does) and keeps these answers testable
 * without a browser. The React wrappers live in `lib/caps.ts`.
 */

/* ========================================================================
   1. SEASON ROWS, FOR BOTH KEY SCHEMES
   ======================================================================== */

/**
 * The ROSTER SLOT a franchise held in a season — the join key for
 * matchups.json, bracket.json, drafts.json and odds.json, all of which are
 * keyed "1".."12".
 *
 * `franchises.json` is keyed by the FRANCHISE KEY, which is the roster_id in a
 * dynasty league and the owner's 18-digit Sleeper user_id in a redraft one. So
 * the key is a usable rid in exactly one of the two leagues, and
 * `Number("1001613650664165376")` silently loses precision in the other. The
 * season row's own `rid` is the answer; the key is only the fallback for site
 * data built before `rid` was written, which is dynasty data by definition.
 *
 * The same expression teamHonors.ts:92 and History.tsx:199 already wrote out.
 */
export const ridOf = (key: string, s?: { rid?: number } | null): number =>
  s?.rid ?? Number(key);

/** one franchise's row for a season, or null */
export const seasonRowOf = (
  f: Franchise | null | undefined, season: string,
): FranchiseSeason | null => f?.seasons.find(s => s.season === season) ?? null;

/**
 * THE FRANCHISE THAT HELD ROSTER SLOT `rid` IN `season`.
 *
 * Never `fr[String(rid)]`: that is right for Big Dog and wrong for every
 * redraft league, where the key is an owner id and roster slot 5 belonged to
 * three different managers across three seasons. Matching on the row's own
 * `rid` within the season is right for both.
 *
 * Returns the key alongside the row because the key is the identity — it is
 * what `franchiseHonors`, the franchise page URL and `teams.json`'s `fkey` all
 * speak.
 */
export function seasonRow(
  fr: Franchises | null | undefined, season: string, rid: number | string,
): { key: string; row: FranchiseSeason } | null {
  if (!fr) return null;
  const want = Number(rid);
  if (!Number.isFinite(want)) return null;
  for (const [key, f] of Object.entries(fr)) {
    for (const s of f.seasons) {
      if (s.season === season && ridOf(key, s) === want) return { key, row: s };
    }
  }
  return null;
}

/* ========================================================================
   2. SETTLED SEASONS
   ======================================================================== */

/**
 * A SEASON IS SETTLED WHEN SOMEBODY FINISHED FIRST.
 *
 * `finish` is the split column FINISH (PROJECT_NOTES §11): places 1..N come off
 * the winners bracket, N+1.. off the regular-season standings. build_site_data
 * assigns the standings half — 7th through 12th — the moment the FIRST
 * winners-bracket game is decided, so "this season has finishes" is true a
 * fortnight before the season is over, and it is true of a season one week old
 * if the bracket ever gets written. `finish === 1` is not: nobody is first
 * until the title game is played.
 *
 * So this is the gate for every award, every "most points" and every top-seed
 * mark. An in-progress season has none of those, and the site was handing them
 * out after week one.
 */
export function isSeasonSettled(
  fr: Franchises | null | undefined, season: string,
): boolean {
  if (!fr) return false;
  for (const f of Object.values(fr))
    for (const s of f.seasons)
      if (s.season === season && s.finish === 1) return true;
  return false;
}

/**
 * Every settled season, ascending. `only` narrows to a caller's own list (the
 * seasons a screen is showing) and keeps that list's order out of it — the
 * answer is always ascending, because "the last one" has to mean the newest.
 */
export function settledSeasons(
  fr: Franchises | null | undefined, only?: readonly string[],
): string[] {
  if (!fr) return [];
  const seen = new Set<string>();
  for (const f of Object.values(fr))
    for (const s of f.seasons) if (s.finish === 1) seen.add(s.season);
  const out = only ? only.filter(s => seen.has(s)) : [...seen];
  return out.sort((a, b) => Number(a) - Number(b));
}

/** the newest settled season, or null when none is */
export function lastSettledSeason(
  fr: Franchises | null | undefined, only?: readonly string[],
): string | null {
  const all = settledSeasons(fr, only);
  return all.length ? all[all.length - 1] : null;
}

/* ========================================================================
   3. THE ROOKIE CLASS DRAFTING NEXT
   ======================================================================== */

/** has this season's rookie draft been recorded? The signal BetaShell's
 *  `draftPending` already reads, inverted. `startup` drafts are not a class. */
export const rookieDraftRecorded = (
  drafts: Drafts | null | undefined, season: string,
): boolean => Object.values(drafts ?? {}).some(picks =>
  picks.some((p: DraftPick) => p.season === season && p.kind === "rookie"));

/**
 * THE NEXT UNDRAFTED ROOKIE CLASS — the pick year the trade machine should be
 * pricing as lag 0.
 *
 * Both shells derive this as `pick_values.meta.generated_for_season + 1`, which
 * is a guess about when pick_value.py last ran rather than a fact about the
 * draft. On the data as shipped it yields 2026 — a class that drafted in May —
 * so 48 phantom "2026 Pick" assets sit in the trade pool at lag 0, and the
 * answer flips wrong again in the other direction the next time that script
 * reruns.
 *
 * drafts.json states it instead: the roster season's own class if its rookie
 * draft has not been recorded, the season after if it has. Null when
 * drafts.json has not landed (or the league has none — a redraft league has no
 * rookie picks to price), which is what the pick indexer already takes to mean
 * "no calendar", and is the same null the call sites pass today.
 */
export function currentPickClass(
  rosterSeason: string | number | null | undefined,
  drafts: Drafts | null | undefined,
): number | null {
  // `Number(null)` is 0 and `Number("")` is 0, and both are finite — so the
  // absent cases are rejected before the conversion, not after it
  if (rosterSeason == null || rosterSeason === "" || !drafts) return null;
  const n = Number(rosterSeason);
  if (!Number.isFinite(n)) return null;
  return rookieDraftRecorded(drafts, String(n)) ? n + 1 : n;
}
