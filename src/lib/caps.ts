import { useMemo } from "react";
import type { Drafts, Franchises, LeagueEntry } from "./types";
import { useLeague } from "./context";
import { useJson } from "./useJson";
import { currentPickClass, lastSettledSeason, settledSeasons } from "./seasons";

/**
 * WHAT THIS LEAGUE HAS — and the React layer over `lib/seasons.ts`.
 *
 * `LeagueEntry.kind` has carried a docstring since the registry was written
 * ("gates market display and franchise keying") and NOTHING has ever read it.
 * The consequence is a second league that renders "Loading…" forever on every
 * screen built around a file its pipeline never produces: Pineapple Pizza has
 * no projections, indices, drafts, trades, odds, usage or shards, so the
 * fetches 404, the state stays null, and `!data ? "Loading…"` is a permanent
 * claim that something is on its way.
 *
 * THE DERIVATION IS THE PIPELINE'S OWN SHAPE, not a probe. PROJECT_NOTES
 * states it: "Pineapple Pizza coverage is pull → WAR → build only… every
 * downstream step defaults to Big Dog." Every one of those downstream scripts
 * runs for the registry's DEFAULT league and no other, so "is this the default
 * league" answers the file question exactly, from data already in hand, with
 * no extra fetch and no 404 to read. `kind` answers the second question —
 * whether dynasty prices and rookie picks mean anything here — which is true
 * of a keeper league whose pipeline coverage is thin and false of a redraft
 * league whose coverage is complete.
 *
 * WHEN THE REGISTRY GROWS A FEATURE LIST, this function reads that instead and
 * nothing at a call site changes. That is most of why it exists.
 */
export interface LeagueCaps {
  /** dvi.json / cvi.json / index_models.json — the DVI and CVI columns */
  indices: boolean;
  /** projections.json, projections_matrix.json, projections_knn_hybrid.json */
  projections: boolean;
  /** player/<pid>.json — the player page's projection rail */
  shards: boolean;
  /** trades.json + trade_snapshots.json — the Ledger */
  trades: boolean;
  /** drafts.json — the Draft screens and the rookie-class signal */
  drafts: boolean;
  /** <season>/odds.json + proj_history.json — projected records, win curves */
  odds: boolean;
  /** <season>/usage.json — the Maxalytics lens */
  usage: boolean;
  /** pick_values.json, picks_owned.json — rookie picks as tradeable assets */
  picks: boolean;
  /** dynasty market prices (KTC / FantasyCalc) describe this league's assets */
  market: boolean;
}

const NONE: LeagueCaps = {
  indices: false, projections: false, shards: false, trades: false,
  drafts: false, odds: false, usage: false, picks: false, market: false,
};

/**
 * `leagueCaps(league, defaultKey)` — synchronous, allocation-light, no fetch.
 *
 * `defaultKey` is `leagues.default` from the registry. A league with an empty
 * key is the legacy single-league registry (`legacyRegistry`), which describes
 * data built before the restructure: that data is Big Dog's, so it gets
 * everything.
 */
export function leagueCaps(
  league: Pick<LeagueEntry, "key" | "kind">, defaultKey: string,
): LeagueCaps {
  const full = !league.key || league.key === defaultKey;
  // absent `kind` is pre-registry data, which is the dynasty league
  const dynasty = (league.kind ?? "dynasty") !== "redraft";
  return {
    ...NONE,
    indices: full, projections: full, shards: full,
    trades: full, drafts: full, odds: full, usage: full,
    picks: full && dynasty,
    market: dynasty,
  };
}

/** the current league's capabilities — the hook form, memoized on the two
 *  registry fields it reads so it is stable across renders */
export function useLeagueCaps(): LeagueCaps {
  const { league, leagues } = useLeague();
  return useMemo(
    () => leagueCaps(league, leagues.default), [league, leagues.default]);
}

/* ========================================================================
   THE SEASON HOOKS
   ======================================================================== */

/** `franchises.json`, which half the site already holds — one shared fetch */
const useFranchises = () => useJson<Franchises>("franchises.json").data;

export interface SettledSeasons {
  /** every settled season in the league's list, ascending */
  seasons: string[];
  /** the newest of them, or null */
  last: string | null;
  /** whether a season is over — the honors gate */
  isSettled: (season: string) => boolean;
  /** false while franchises.json is in flight: `seasons` is empty because
   *  nothing has landed, not because nothing has been won */
  ready: boolean;
}

/**
 * Which of this league's seasons are actually over — see
 * `lib/seasons.ts#isSeasonSettled` for what "over" means and why `finish` on
 * its own does not answer it.
 */
export function useSettledSeasons(only?: readonly string[]): SettledSeasons {
  const fr = useFranchises();
  const { meta } = useLeague();
  const list = only ?? meta.seasons;
  return useMemo(() => {
    const seasons = settledSeasons(fr, list);
    const set = new Set(seasons);
    return {
      seasons,
      last: lastSettledSeason(fr, list),
      isSettled: (s: string) => set.has(s),
      ready: fr != null,
    };
  }, [fr, list]);
}

/**
 * The rookie class drafting next, off drafts.json — null while that file is in
 * flight and in a league that has none. See `lib/seasons.ts#currentPickClass`
 * for why `pick_values.meta.generated_for_season + 1` is the wrong answer.
 */
export function useCurrentPickClass(): number | null {
  const { league } = useLeague();
  const caps = useLeagueCaps();
  const drafts = useJson<Drafts>(caps.drafts ? "drafts.json" : null).data;
  return useMemo(
    () => currentPickClass(league.rosterSeason, drafts),
    [league.rosterSeason, drafts]);
}
