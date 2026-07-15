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
