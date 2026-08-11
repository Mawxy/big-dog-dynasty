import type { PlayersMin, Team, Weekly } from "./types";

export const pInfo = (players: PlayersMin, pid: string): [string, string, string] =>
  players[pid] ?? [`#${pid}`, "?", ""];

/** position -> badge/spine color. One copy — the same map was pasted into
 *  seven files before this. Callers pick their own fallback for non-core. */
export const POS_COLOR: Record<string, string> = {
  QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)",
};

/** the position-filter chip row every leaderboard shares */
export const POS_CHIPS = ["ALL", "QB", "RB", "WR", "TE"];

/**
 * League shape — the seam a second league would have to cut.
 *
 * Nothing derives these yet: `meta` carries the lineup, the seasons and the
 * taxi size, but neither the regular-season length nor the team count. They
 * were a `14` and a `12` written into eleven files; here they are at least
 * named, in one place, and greppable the day meta grows the fields.
 *
 * Where a screen already holds a season's matchups.json, derive from its
 * `playoff_start` instead — that is data, and this is an assumption.
 */
/** regular-season weeks. Equivalent to `playoff_start - 1` where that is known */
export const REG_WEEKS = 14;
/** franchises in the league; also how wide a draft round is */
export const LEAGUE_TEAMS = 12;

/** Whose rosters to read for "who owns this player". Current rosters unless a
 *  past season is being viewed — never `latest`, which lags a full year behind
 *  through the offseason. Takes the league registry entry. */
export const rosterSeasonOf = (l: { seasons: string[]; rosterSeason?: string }) =>
  l.rosterSeason && l.seasons.includes(l.rosterSeason)
    ? l.rosterSeason
    : l.seasons[l.seasons.length - 1];

/** Newest season that actually has data — what every stats view defaults to.
 *  `latest` is only trusted when the season list agrees it exists; otherwise
 *  the newest listed season stands in. The counterpart to rosterSeasonOf:
 *  `latest` for what happened, `rosterSeason` for who owns whom. */
export const latestSeasonOf = (l: { seasons: string[]; latest?: string }) =>
  l.latest && l.seasons.includes(l.latest)
    ? l.latest
    : l.seasons[l.seasons.length - 1];

export function ownerOf(teams: Team[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const t of teams) for (const p of t.players) m[p] = t.team;
  return m;
}

/** pid -> week -> [WAA, WAR] */
export function weekIndex(weekly: Weekly): Record<string, Record<number, [number, number]>> {
  const idx: Record<string, Record<number, [number, number]>> = {};
  for (const [pid, rows] of Object.entries(weekly))
    for (const w of rows) (idx[pid] ??= {})[w[0]] = [w[4], w[5]];
  return idx;
}

/** season -> URL segment ("ALL" -> "all") */
export const seasonSeg = (s: string) => s === "ALL" ? "all" : s;

/** Multi-position slots -> what they accept. Mirrors FLEX_SLOTS in
 *  scripts/sleeper_war.py; keep the two in step. */
export const FLEX_SLOTS: Record<string, string[]> = {
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  FLEX: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};
/** narrowest slot first, so a wide slot can't strand a narrow one */
const FLEX_ORDER = Object.keys(FLEX_SLOTS).sort((a, b) => FLEX_SLOTS[a].length - FLEX_SLOTS[b].length);
const NON_STARTING = new Set(["BN", "IR", "TAXI"]);
/** used until meta.rosterPositions exists (site data predating that field) */
export const DEFAULT_LINEUP = ["QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX", "SUPER_FLEX"];

/** The league's starting-lineup shape, with the fallback for site data written
 *  before meta carried it. Six call sites wrote this ternary out. */
export const lineupOf = (m: { rosterPositions?: string[] }) =>
  m.rosterPositions?.length ? m.rosterPositions : DEFAULT_LINEUP;

/** Sleeper-style short labels for lineup slots */
export const SLOT_LABEL: Record<string, string> = {
  QB: "QB", RB: "RB", WR: "WR", TE: "TE",
  FLEX: "FLX", SUPER_FLEX: "SFLX", WRRB_FLEX: "W/R", REC_FLEX: "W/T",
};

export interface LineupSlot<T> { slot: string; player: T | null }

/**
 * Greedy best lineup: fill dedicated position slots by value, then flex slots
 * narrowest-first. Same algorithm the WAR engine uses league-wide, applied to
 * one roster.
 *
 * Returns slots in LINEUP ORDER (QB, RB, RB, WR, ... FLEX, SF) the way Sleeper
 * displays them — not sorted by value — with the player filling each, or null
 * if the roster can't fill it. `starters` is the chosen ids for bench splitting.
 */
export function optimalLineup<T extends { id: string; pos: string; war: number }>(
  players: T[], lineup: string[] = DEFAULT_LINEUP,
): { slots: LineupSlot<T>[]; starters: Set<string> } {
  const slots: LineupSlot<T>[] = lineup
    .filter(s => !NON_STARTING.has(s))
    .map(s => ({ slot: s, player: null }));

  const pool = [...players].sort((a, b) => b.war - a.war);
  const starters = new Set<string>();
  const leftovers: T[] = [];
  for (const p of pool) {                       // dedicated slots first
    const s = slots.find(x => x.player === null && x.slot === p.pos);
    if (s) { s.player = p; starters.add(p.id); } else leftovers.push(p);
  }
  for (const p of leftovers) {                  // then flex, narrowest first
    for (const name of FLEX_ORDER) {
      if (!FLEX_SLOTS[name].includes(p.pos)) continue;
      const s = slots.find(x => x.player === null && x.slot === name);
      if (s) { s.player = p; starters.add(p.id); break; }
    }
  }
  return { slots, starters };
}

/** a lineup pool entry: whatever the currency, optimalLineup only wants this */
export interface Priced { id: string; pos: string; war: number }

/**
 * A team's best legal lineup priced in one index, with both totals.
 *
 * Three screens wrote this out — the League dashboard, the Franchises board
 * and the franchise page — each building the same pool from a dvi/cvi file,
 * running the same optimizer and summing the same slots. `starters` answers
 * quality, `roster` answers depth, and a player the index does not cover is
 * absent from both rather than counted as zero.
 *
 * The index's own `pos` is used, not the roster's: it is the position the
 * figure was computed for, so a pool built from it can't seat a player in a
 * slot his price was never measured in.
 */
export function pricedLineup<V extends { pos: string }>(
  team: Team, index: Record<string, V>, valueOf: (pid: string, row: V) => number,
  lineup?: string[],
): { pool: Priced[]; slots: LineupSlot<Priced>[]; starters: number; roster: number } {
  const pool: Priced[] = [];
  for (const pid of team.players) {
    const row = index[pid];
    if (row) pool.push({ id: pid, pos: row.pos, war: valueOf(pid, row) });
  }
  const { slots } = optimalLineup(pool, lineup);
  return {
    pool, slots,
    starters: slots.reduce((a, s) => a + (s.player?.war ?? 0), 0),
    roster: pool.reduce((a, p) => a + p.war, 0),
  };
}

/** just the starters figure — the best legal lineup, summed in one currency */
export const starterTotal = <V extends { pos: string }>(
  team: Team, index: Record<string, V>, valueOf: (pid: string, row: V) => number,
  lineup?: string[],
) => pricedLineup(team, index, valueOf, lineup).starters;
