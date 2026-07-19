import type { PlayersMin, Team, Weekly } from "./types";

export const pInfo = (players: PlayersMin, pid: string): [string, string, string] =>
  players[pid] ?? [`#${pid}`, "?", ""];

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
const FLEX_SLOTS: Record<string, string[]> = {
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

/**
 * Positional finish: rank within each position by `val`, descending.
 * Returns id -> rank, so 1 is the best at that position (RB1, WR3, ...).
 */
export function posRanks<T>(
  rows: T[], idOf: (r: T) => string, posOf: (r: T) => string, valOf: (r: T) => number,
): Map<string, number> {
  const byPos = new Map<string, T[]>();
  for (const r of rows) {
    const p = posOf(r);
    const arr = byPos.get(p);
    if (arr) arr.push(r); else byPos.set(p, [r]);
  }
  const out = new Map<string, number>();
  for (const arr of byPos.values()) {
    arr.sort((a, b) => valOf(b) - valOf(a));
    arr.forEach((r, i) => out.set(idOf(r), i + 1));
  }
  return out;
}

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
