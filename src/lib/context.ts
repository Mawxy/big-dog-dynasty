import { createContext, useCallback, useContext } from "react";
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

/**
 * THE CLASSIC BOARD IS GONE (Max, 2026-11-04). Its old addresses —
 * `/<league>/classic/...`, the pre-league `#/players/2025` shapes and the bare
 * `/<league>/stats`-style links shared before 2026-09-02 — all forward onto
 * the beta shell through `classicToBeta` below, so a bookmark still lands.
 *
 * The redesign lab that took its slot (`/<league>/lab/...`, the C4 trial) was
 * scrapped on 2026-11-11. App.tsx drops the segment, so an old lab link lands
 * on the same screen of the board.
 */
export const CLASSIC_SEG = "classic";

/**
 * The address the beta shell answers at: `/<league>`. Provided by BetaShell;
 * every in-shell link is built from `base`.
 */
export const ShellContext = createContext<{ base: string } | null>(null);

/** the current mount's base, falling back to the live board's address for a
 *  component rendered outside any shell (none today; cheap insurance) */
export function useShellBase(): string {
  const v = useContext(ShellContext);
  const seg = leagueSeg(useLeague().league);
  return v?.base ?? `/${seg}`;
}

/**
 * A FRANCHISE KEY IS NOT ALWAYS A ROSTER ID: it is the roster_id in a dynasty
 * league and the owner's 18-digit Sleeper user_id in a redraft or keeper one.
 * The Team screen looks a franchise up strictly by roster_id, so an
 * owner-keyed franchise keeps the franchise page, mounted in the shell at
 * /franchise/<key> since the classic board was retired.
 */
export const isRid = (key: string) => /^\d{1,3}$/.test(key);

/**
 * A classic-board path, rewritten onto the beta shell's screens. Relative to
 * the shell's base, query string preserved: `/weekly/2025/6/3` ->
 * `/seasons/2025/6/3`, `/ledger` -> `/trade?scope=history`. A first segment
 * this table does not name is already a beta path and passes through.
 */
export function classicToBeta(p: string): string {
  const q = p.indexOf("?");
  const path = q < 0 ? p : p.slice(0, q);
  const search = q < 0 ? "" : p.slice(q + 1);
  const [, first = "", ...rest] = (path.startsWith("/") ? path : `/${path}`).split("/");
  const tail = rest.filter(Boolean);
  const join = (h: string, r: string[] = []) => `/${[h, ...r].join("/")}`;
  let to: string;
  switch (first) {
    case "": case "home": to = "/league"; break;
    // the two player boards and their old shared tab are one board now
    case "stats": case "value": case "players": to = "/players"; break;
    case "draft": to = join("drafts", tail); break;
    case "weekly": to = join("seasons", tail); break;
    case "standings": to = tail[0] ? join("seasons", [tail[0]]) : "/seasons"; break;
    case "playoffs": to = tail[0] ? join("seasons", [tail[0], "playoffs"]) : "/playoffs"; break;
    case "trades": to = "/trade"; break;
    case "ledger": to = "/trade?scope=history"; break;
    case "teams":
      // /teams/<season>/<rid>[/<tab>] is a franchise; /teams/<season> was that
      // year's standings; /teams and /teams/all are the franchise board
      if (tail.length >= 2 && isRid(tail[1])) to = join("team", [tail[1]]);
      else if (tail[0] && tail[0].toLowerCase() !== "all") to = join("seasons", [tail[0]]);
      else to = "/teams";
      break;
    case "franchise":
      to = tail[0] ? (isRid(tail[0]) ? join("team", [tail[0]]) : join("franchise", [tail[0]])) : "/teams";
      break;
    default: to = join(first, tail);
  }
  if (!search) return to;
  return to.includes("?") ? `${to}&${search}` : `${to}?${search}`;
}

/**
 * The path builder for a view written against the classic board's shapes
 * (Player, Draft, DraftDetail, History, Insights, FranchisePage, QuickJump,
 * PlayerLink…): takes the CLASSIC path and lands it on the matching screen of
 * the beta shell. Views keep writing
 * classic paths; only `classicToBeta` knows the renames.
 */
export function useShellPath() {
  const base = useShellBase();
  return useCallback((p: string) => `${base}${classicToBeta(p)}`, [base]);
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
