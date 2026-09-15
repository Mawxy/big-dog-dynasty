import { createContext, useCallback, useContext } from "react";
import { useLocation } from "react-router-dom";
import type { LeagueEntry, Leagues, Meta, PlayersMin } from "./types";

/** `leagues` is the whole registry, not just the resolved entry: the router
 *  has to tell "this URL names another league" from "this URL names nothing",
 *  and those two want different answers (re-boot vs. bounce to the default). */
export const LeagueContext = createContext<
  { meta: Meta; players: PlayersMin; league: LeagueEntry; leagues: Leagues } | null
>(null);

export function useLeague() {
  const v = useContext(LeagueContext);
  if (!v) throw new Error("league context missing");
  return v;
}

/** The league's URL segment: alias when it has one, else the founding
 *  league_id, which every league always has. */
export const leagueSeg = (l: LeagueEntry) => l.alias || l.key || "league";

/** the classic board's mount under a league: /<league>/classic/... (Max,
 *  2026-09-02 — the beta shell took the bare league address and the classic
 *  board moved here). Every classic link goes through `useLeaguePath`, which
 *  carries this; the beta shell's links go through beta/ui `useBetaPath`. */
export const CLASSIC_SEG = "classic";

/**
 * Prefix an in-app path with the current league AND the classic board's
 * segment: `lp("/players")` -> `/big-dog/classic/players`. Every classic
 * internal link goes through this so no click has to bounce off the legacy
 * redirect. (The beta shell has its own builder, `useBetaPath`, which lands
 * on the bare league address.)
 *
 * Memoized on the league SEGMENT, which is the only thing the closure reads —
 * so the identity holds for the life of the page (switching leagues re-boots).
 * A fresh closure per render is a dependency that always changes, and it was
 * invalidating the column memos on Teams and forcing QuickJump to suppress the
 * exhaustive-deps rule to keep its typeahead off the critical path.
 */
export function useLeaguePath() {
  const seg = leagueSeg(useLeague().league);
  return useCallback(
    (p: string) => `/${seg}/${CLASSIC_SEG}${p.startsWith("/") ? p : `/${p}`}`, [seg]);
}

/**
 * Which shell a view is mounted in, read off the URL: the classic board lives
 * under /<league>/classic and the beta shell answers the bare league address.
 *
 * The classic views the beta shell mounts as its "everything else" bucket
 * (Draft, DraftDetail, Weekly, Player…) are rendered by BOTH shells, so a
 * link they build cannot be a classic link by construction — that is what
 * dropped a beta reader into /classic on the first tap of a Draft chip.
 */
export function useShell(): "classic" | "beta" {
  const seg = leagueSeg(useLeague().league);
  const { pathname } = useLocation();
  const classic = `/${seg}/${CLASSIC_SEG}`;
  return pathname === classic || pathname.startsWith(`${classic}/`) ? "classic" : "beta";
}

/** the beta shell's name for a classic view's first path segment; a segment
 *  not listed keeps its name (player, teams, history, insights…) */
const BETA_SEG: Record<string, string> = { draft: "drafts", weekly: "seasons" };

/**
 * `useLeaguePath` for a view that lives in both shells: takes the CLASSIC
 * path (`/draft/history/2025`, `/weekly/2025/6/3`, `/player/4034`) and lands
 * it in whichever shell the reader is in — `/big-dog/classic/draft/history/2025`
 * on the classic board, `/big-dog/drafts/history/2025` in the beta shell.
 * Views keep writing classic paths, so nothing at a call site changes when
 * the classic board is retired; only this table does.
 */
export function useShellPath() {
  const seg = leagueSeg(useLeague().league);
  const shell = useShell();
  return useCallback((p: string) => {
    const path = p.startsWith("/") ? p : `/${p}`;
    if (shell === "classic") return `/${seg}/${CLASSIC_SEG}${path}`;
    const [, first = "", ...rest] = path.split("/");
    const head = BETA_SEG[first] ?? first;
    return `/${seg}/${head}${rest.length ? `/${rest.join("/")}` : ""}`;
  }, [seg, shell]);
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
