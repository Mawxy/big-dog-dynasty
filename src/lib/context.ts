import { createContext, useContext } from "react";
import type { LeagueEntry, Leagues, Meta, PlayersMin } from "./types";

export const LeagueContext = createContext<
  { meta: Meta; players: PlayersMin; league: LeagueEntry } | null
>(null);

export function useLeague() {
  const v = useContext(LeagueContext);
  if (!v) throw new Error("league context missing");
  return v;
}

/** The league's URL segment: alias when it has one, else the founding
 *  league_id, which every league always has. */
export const leagueSeg = (l: LeagueEntry) => l.alias || l.key || "league";

/** Prefix an in-app path with the current league. Every internal link goes
 *  through this so no click has to bounce off the legacy redirect. */
export function useLeaguePath() {
  const { league } = useLeague();
  const base = `/${leagueSeg(league)}`;
  return (p: string) => `${base}${p.startsWith("/") ? p : `/${p}`}`;
}

/**
 * Resolve a league from the registry by key OR alias, falling back to the
 * registry default.
 *
 * Key is tried first: the founding league_id is guaranteed unique and
 * permanent, while an alias is a convenience two leagues could both want. If an
 * alias is ever contested the loser simply has none, so a key lookup has to win.
 */
export function resolveLeague(reg: Leagues, want?: string): LeagueEntry {
  return (want ? reg.leagues.find(l => l.key === want) : undefined)
    || (want ? reg.leagues.find(l => l.alias === want) : undefined)
    || reg.leagues.find(l => l.key === reg.default)
    || reg.leagues[0];
}

/**
 * The registry as it would look for site data built before leagues.json
 * existed. Keeps the front end loadable against an older `data/` — the key is
 * empty because there is nothing to derive a founding id from, and nothing
 * consumes it yet.
 */
export function legacyRegistry(meta: Meta): Leagues {
  const seasons = meta.seasons;
  const entry: LeagueEntry = {
    key: "", alias: "", name: meta.league, seasons,
    latest: meta.latest ?? null,
    rosterSeason: meta.rosterSeason || seasons[seasons.length - 1],
    currentLeagueId: "", chain: {}, commissioners: [], members: [],
  };
  return { default: "", leagues: [entry] };
}
