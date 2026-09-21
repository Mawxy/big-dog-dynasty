/**
 * outlook.ts — the in-season view of a full-season projection.
 *
 * Every curve's year 1 in projections_matrix.json is a FULL-SEASON figure for
 * the roster season. That is what the models want as an input, and it is the
 * wrong thing to show a reader in week 4: by then four weeks of that season
 * are a settled fact with a realized WAR attached, and the projection is still
 * quoting all fourteen.
 *
 *     outlook = banked + year1 * remaining_frac
 *
 * The pipeline publishes the two facts and this file does the arithmetic:
 *
 *   * projections_matrix.json `meta.inseason` — {season, weeks_played,
 *     reg_weeks, remaining_frac} — present only while year 1 of the projection
 *     IS the roster season and that season is underway but unfinished. Absent
 *     (or null) in the offseason, where the outlook is simply the projection.
 *   * each row's `banked` — his realized regular-season WAR to date, and `gp`,
 *     the games behind it. Both ride along inside a player shard's `mx`, and
 *     shard_players.py copies them (with the block) to the shard's top level,
 *     so a player page needs no second fetch.
 *
 * NOTHING HERE RE-PRICES A PLAYER. DVI, CVI, the value bridge and the trade
 * machine keep reading the un-prorated year-1 WAR: banked WAR has no trade
 * value, and an index that shrank to it by week 14 would price every asset at
 * nothing in December. This is a presentation of the season, not a valuation.
 *
 * KEEP IN LOCKSTEP with scripts/inseason.py, which owns the same formula for
 * the pipeline (`outlook`, `reg_weeks`, `weeks_played`, `remaining_frac`,
 * `banked_war`) and writes the block this file reads. Pure: no fetching, no
 * React, no imports.
 */

/** projections_matrix.json's `meta.inseason`, and a shard's `inseason`. */
export type InSeason = {
  /** the roster season these weeks belong to — year 1 of every curve */
  season: number;
  /** scored REGULAR-season weeks in the books; a week in progress is not one */
  weeks_played: number;
  /** the league's regular season, playoff_start - 1 (14 for Big Dog) */
  reg_weeks: number;
  /** (reg_weeks - weeks_played) / reg_weeks, in [0, 1] */
  remaining_frac: number;
};

/** The two per-player facts the matrix row and the shard both carry. */
export type BankedRow = {
  /** realized regular-season WAR to date in the roster season */
  banked?: number | null;
  /** games played to date behind that figure */
  gp?: number | null;
};

/**
 * Is this a usable block? A null, an absent key, or a block whose fraction is
 * out of range reads as "no in-season view" rather than as a reason to publish
 * a prorated number nobody can defend.
 */
export function isInSeason(x: InSeason | null | undefined): x is InSeason {
  return (
    !!x &&
    typeof x.remaining_frac === "number" &&
    Number.isFinite(x.remaining_frac) &&
    x.remaining_frac >= 0 &&
    x.remaining_frac <= 1
  );
}

/**
 * banked + year1 * remaining_frac — what to show for the season being played.
 *
 * Mirrors `outlook()` in scripts/inseason.py:
 *   * no block (offseason, or year 1 is not the roster season) -> `y1`
 *     unchanged. There is nothing banked to add and nothing to take away.
 *   * `y1` null -> null. No projection, no outlook — never fall back to the
 *     banked figure alone, which would print a number the model never said.
 *   * `banked` null/undefined -> 0. He has no row in the season summary, which
 *     means he has not dressed for anyone: a real zero, not a missing value.
 *
 * Unrounded on purpose; format at the call site.
 */
export function outlookY1(
  y1: number | null,
  banked: number | null | undefined,
  inseason: InSeason | null | undefined,
): number | null {
  if (y1 == null || !Number.isFinite(y1)) return null;
  if (!isInSeason(inseason)) return y1;
  const have = typeof banked === "number" && Number.isFinite(banked) ? banked : 0;
  return have + y1 * inseason.remaining_frac;
}

/** Weeks of the regular season still to be played. */
export function weeksLeft(inseason: InSeason | null | undefined): number | null {
  if (!isInSeason(inseason)) return null;
  return Math.max(0, inseason.reg_weeks - inseason.weeks_played);
}

/**
 * How to label the figure, so a reader is never shown a prorated number under
 * the same heading as a full-season one: "2026 outlook · 1 wk banked".
 * Empty string out of season — there is nothing to say, because nothing moved.
 */
export function outlookLabel(inseason: InSeason | null | undefined): string {
  if (!isInSeason(inseason)) return "";
  const n = inseason.weeks_played;
  return `${inseason.season} outlook · ${n} wk${n === 1 ? "" : "s"} banked`;
}

/** The long form for a tooltip: what is banked and what is still projected. */
export function outlookNote(inseason: InSeason | null | undefined): string {
  if (!isInSeason(inseason)) return "";
  const left = inseason.reg_weeks - inseason.weeks_played;
  return (
    `${inseason.weeks_played} of ${inseason.reg_weeks} weeks played — ` +
    `banked WAR plus ${left}/${inseason.reg_weeks} of the ${inseason.season} projection`
  );
}
