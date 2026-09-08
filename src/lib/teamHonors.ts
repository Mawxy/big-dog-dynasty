import { useEffect, useState } from "react";
import type { BracketFile, Franchises } from "./types";
import { jl } from "./data";

/**
 * Franchise honor marks — the four things a franchise season can earn (Max,
 * 2026-09-08), the team-page counterpart of a player's career honors.
 *
 *   title    won the championship game                    trophy, gold
 *   top      most regular-season points in the league     gem, turquoise
 *   seed     finished the regular season first (1 seed)   crown, red
 *   playoff  made the playoff bracket                      star
 *
 * Every mark is computed from data already on the site — franchises.json for
 * finish, seed and points, each season's bracket for who actually played in
 * the winners' rounds — and nothing is hand-maintained. Rendered rarest first:
 * one title a year, one top seed's crown, one points gem, then the bracket.
 *
 * The four SHAPES are the player sprite's (components/HonorMarks HonorSprite):
 * the same trophy, crown, gem and star, coloured for the franchise ladder. A
 * reader who knows the player marks reads these at sight.
 */
export type TeamHonorKey = "title" | "top" | "seed" | "playoff";

export const TEAM_HONOR_ORDER: TeamHonorKey[] = ["title", "seed", "top", "playoff"];

export const TEAM_HONOR_LABEL: Record<TeamHonorKey, string> = {
  title: "Champion",
  top: "Most points",
  seed: "No. 1 seed",
  playoff: "Playoffs",
};

export const TEAM_HONOR_NOTE: Record<TeamHonorKey, string> = {
  title: "won the championship game",
  top: "most regular-season points in the league that season",
  seed: "finished the regular season as the top seed",
  playoff: "made the playoff bracket",
};

/** which sprite symbol draws each mark — `#hm-<symbol>` in HonorSprite */
export const TEAM_HONOR_SYMBOL: Record<TeamHonorKey, string> = {
  title: "champ", top: "elite", seed: "king", playoff: "bar",
};

/** what a franchise earned in one season */
export interface TeamSeasonHonors { season: string; keys: TeamHonorKey[] }

export interface TeamHonorIndex {
  /** franchise key -> season -> keys */
  byKey: Record<string, Record<string, TeamHonorKey[]>>;
}

/** how many seeds make the bracket when a season's bracket file is missing —
 *  this league's setting; only a fallback, the bracket itself is the record */
const PLAYOFF_SEEDS_FALLBACK = 6;

let pending: Promise<TeamHonorIndex> | null = null;

/**
 * Build the whole-league franchise honor index once per page load.
 *
 * Playoff appearances come off the BRACKET, not off a seed cut-off: a team is
 * in the playoffs if it played a winners'-bracket game (a bye still lands it in
 * round two), which stays right if the league ever changes how many teams
 * qualify. A season whose bracket has not been written falls back to the seed.
 */
export function loadTeamHonors(seasons: string[]): Promise<TeamHonorIndex> {
  if (pending) return pending;
  pending = (async () => {
    const [fr, brackets] = await Promise.all([
      jl<Franchises>("franchises.json").catch(() => ({} as Franchises)),
      Promise.all(seasons.map(s =>
        jl<BracketFile>(`${s}/bracket.json`).catch(() => null))),
    ]);
    const bracketOf = new Map(seasons.map((s, i) => [s, brackets[i]]));

    const byKey: TeamHonorIndex["byKey"] = {};
    const add = (key: string, season: string, k: TeamHonorKey) => {
      const bag = ((byKey[key] ??= {})[season] ??= []);
      if (!bag.includes(k)) bag.push(k);
    };

    // every franchise's row for each season, so "most points" has the whole
    // league to compare against
    const bySeason: Record<string, { key: string; rid: number; fpts: number; seed: number | null; finish: number | null }[]> = {};
    for (const [key, f] of Object.entries(fr)) {
      for (const s of f.seasons) {
        // a season nobody has played yet has nothing to award
        if (s.wins + s.losses + s.ties === 0) continue;
        (bySeason[s.season] ??= []).push({
          key, rid: s.rid ?? Number(key), fpts: s.fpts, seed: s.seed, finish: s.finish,
        });
      }
    }

    for (const [season, rows] of Object.entries(bySeason)) {
      const br = bracketOf.get(season);
      // who played a winners'-bracket game — the record of a playoff appearance
      const inBracket = new Set<number>();
      for (const g of br?.winners ?? []) {
        if (g.t1 != null) inBracket.add(g.t1);
        if (g.t2 != null) inBracket.add(g.t2);
      }
      const most = rows.reduce((a, b) => (b.fpts > a.fpts ? b : a));
      for (const r of rows) {
        if (r.finish === 1) add(r.key, season, "title");
        if (r === most && r.fpts > 0) add(r.key, season, "top");
        if (r.seed === 1) add(r.key, season, "seed");
        const played = br ? inBracket.has(r.rid)
          : r.seed != null && r.seed <= PLAYOFF_SEEDS_FALLBACK;
        if (played) add(r.key, season, "playoff");
      }
    }
    return { byKey };
  })();
  return pending;
}

/** one franchise's honors, newest season first */
export function franchiseHonors(idx: TeamHonorIndex | null, key: string): TeamSeasonHonors[] {
  const bag = idx?.byKey[key];
  if (!bag) return [];
  return Object.entries(bag)
    .map(([season, keys]) => ({ season, keys: TEAM_HONOR_ORDER.filter(k => keys.includes(k)) }))
    .sort((a, b) => Number(b.season) - Number(a.season));
}

/** totals per mark, in render order */
export function teamHonorTotals(rows: TeamSeasonHonors[]): [TeamHonorKey, number][] {
  const n: Partial<Record<TeamHonorKey, number>> = {};
  for (const r of rows) for (const k of r.keys) n[k] = (n[k] ?? 0) + 1;
  return TEAM_HONOR_ORDER.filter(k => n[k]).map(k => [k, n[k] as number]);
}

/** the index, for a component: null until it lands */
export function useTeamHonors(seasons: string[]): TeamHonorIndex | null {
  const [idx, setIdx] = useState<TeamHonorIndex | null>(null);
  useEffect(() => {
    let live = true;
    loadTeamHonors(seasons).then(i => { if (live) setIdx(i); }).catch(() => {});
    return () => { live = false; };
  }, [seasons]);
  return idx;
}
