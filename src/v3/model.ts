import { useMemo } from "react";
import type {
  Franchises, Matchups, PickValues, PicksOwned, Team, TradesPayload, Values,
} from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi, useProjWar } from "../lib/useIndices";
import { useLeague } from "../lib/context";
import { LEAGUE_TEAMS, latestSeasonOf, lineupOf, pricedLineup, rosterSeasonOf } from "../lib/league";
import { pickStream, ROUND_ORD } from "../lib/rosterModel";

/**
 * The derivations the v3 screens share.
 *
 * Kept out of the screens because three of them price the same rosters in the
 * same four currencies and would otherwise each grow their own copy — which is
 * how the classic board ended up with the optimal-lineup sum written out in
 * three views before `pricedLineup` existed.
 */

export const TIERS = ["Early", "Mid", "Late"];

/* ========================================================================
   SEASON PHASE
   ======================================================================== */

/**
 * Whether the roster season has been played yet.
 *
 * This is what drives the League screen's offseason re-weighting: Jan–Aug the
 * same modules render in a different order, because "who is winning" has no
 * answer and "who holds what" does. Derived from the data rather than from the
 * calendar — the switchover is the first scored week, which is a fact the
 * matchups file states and a month boundary only approximates.
 */
export function useSeasonPhase() {
  const { meta, league } = useLeague();
  const rosterSeason = rosterSeasonOf(league);
  const latest = latestSeasonOf(meta);
  const mw = useJson<Matchups>(`${rosterSeason}/matchups.json`).data;
  return useMemo(() => {
    const ps = mw?.playoff_start ?? 15;
    const played = new Set<number>();
    for (const list of Object.values(mw?.teams ?? {}))
      for (const e of list) if (e[0] < ps) played.add(e[0]);
    const offseason = played.size === 0;
    return {
      offseason,
      /** the season whose RESULTS a reader should be shown */
      resultSeason: offseason ? latest : rosterSeason,
      rosterSeason, latest,
      /** the week now in progress — the first unplayed regular-season week */
      week: played.size ? Math.min(ps - 1, Math.max(...played) + 1) : null,
      playoffStart: ps,
      loading: mw == null,
    };
  }, [mw, rosterSeason, latest]);
}

/* ========================================================================
   STANDINGS
   ======================================================================== */

export interface StandingRow {
  rid: number; rank: number;
  team: string; manager: string;
  wins: number; losses: number; ties: number;
  rec: string; ppg: number;
  /** record against each week's league median score — the schedule-luck
   *  signature. Null before a game is played; never 0-0, which would read as
   *  a team that went even rather than one that hasn't started. */
  med: string | null; medWins: number | null;
  played: number;
}

/**
 * A season's standings: twelve rows, ordered as the league orders them.
 *
 * Two files, not four. The classic board's standings also carry volatility,
 * lineup WAR and expected wins from the odds file, which need `weekly.json`
 * and `odds.json` on top of these — a phone screen showing five columns should
 * not pay for nine.
 */
export function useStandings(season: string | null) {
  const teams = useJson<Team[]>(season ? `${season}/teams.json` : null).data;
  const mw = useJson<Matchups>(season ? `${season}/matchups.json` : null).data;
  return useMemo<StandingRow[] | null>(() => {
    if (!teams || !mw) return null;
    const ps = mw.playoff_start || 15;
    // each regular-season week's league median score
    const weekPts: Record<number, number[]> = {};
    for (const list of Object.values(mw.teams))
      for (const e of list) if (e[0] < ps) (weekPts[e[0]] ??= []).push(e[1]);
    const medians: Record<number, number> = {};
    for (const [wk, pts] of Object.entries(weekPts)) {
      const v = pts.slice().sort((a, b) => a - b), n = v.length;
      medians[+wk] = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }
    const rows = teams.map(t => {
      const reg = (mw.teams[String(t.roster_id)] || []).filter(e => e[0] < ps);
      let mwin = 0, mloss = 0, mtie = 0;
      for (const e of reg) {
        const m = medians[e[0]];
        if (m == null) continue;
        e[1] > m ? mwin++ : e[1] < m ? mloss++ : mtie++;
      }
      const g = t.wins + t.losses + t.ties;
      return {
        rid: t.roster_id, rank: 0, team: t.team, manager: t.manager,
        wins: t.wins, losses: t.losses, ties: t.ties,
        rec: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`,
        ppg: g ? t.fpts / g : 0,
        med: reg.length ? `${mwin}-${mloss}${mtie ? `-${mtie}` : ""}` : null,
        medWins: reg.length ? mwin : null,
        played: reg.length,
      };
    });
    // wins, then points — the same tiebreak the league seeds on
    const order = rows.slice().sort((a, b) =>
      b.wins - a.wins || b.ppg * b.played - a.ppg * a.played);
    order.forEach((r, i) => { r.rank = i + 1; });
    return order;
  }, [teams, mw]);
}

/* ========================================================================
   ACTIVITY
   ======================================================================== */

export interface ActTrade {
  kind: "trade"; ts: number; season: string; week: number;
  sides: { team: string; got: { label: string; pick: boolean }[] }[];
}
export interface ActMove {
  kind: "move"; ts: number; season: string; week: number;
  team: string; waiver: boolean; adds: string[]; drops: string[];
}
export type Activity = ActTrade | ActMove;

/**
 * The league's recent moves, newest first — trades and roster moves in one
 * stream, because "what's going on" is one question.
 *
 * Trades come from trades.json (which prices them) and roster moves from each
 * franchise's transaction log. The two are merged on timestamp and nothing is
 * scored here: the feed states that a thing happened. What it was worth is the
 * trade machine's job, and the machine re-prices at today's values rather than
 * at the values on the day.
 */
export function useActivity(limit = 12) {
  const trades = useJson<TradesPayload>("trades.json").data;
  const fr = useJson<Franchises>("franchises.json").data;
  return useMemo<Activity[] | null>(() => {
    if (!trades || !fr) return null;
    const list = Array.isArray(trades) ? trades : trades.trades;
    const out: Activity[] = list.map(t => ({
      kind: "trade" as const, ts: t.ts, season: t.season, week: t.week,
      sides: t.sides.map(s => ({
        team: s.team,
        got: s.got.map(a => ({ label: a.label, pick: a.kind !== "player" })),
      })),
    }));
    for (const f of Object.values(fr)) {
      const name = f.seasons[f.seasons.length - 1]?.name ?? "—";
      for (const tx of f.tx) {
        if (tx.type === "trade") continue;            // already in, and priced
        out.push({
          kind: "move", ts: tx.ts, season: tx.season, week: tx.week,
          team: name, waiver: tx.type === "waiver",
          adds: tx.adds ?? [], drops: tx.drops ?? [],
        });
      }
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }, [trades, fr, limit]);
}

/* ========================================================================
   ASSETS — every player and pick, priced in every currency the site holds
   ======================================================================== */

export interface Asset {
  key: string; label: string;
  kind: "player" | "pick";
  pid: string | null;
  pos: string; nfl: string;
  age: number | null;
  dvi: number | null; cvi: number | null;
  /** dynasty market price (KTC). Picks have one, by tier. */
  ktc: number | null;
  /** 30-day raw market delta. RAW VALUE, never a rank delta — a rank delta is
   *  a statement about everyone else moving. Players only; the pick feed
   *  publishes no trend. */
  d30: number | null;
  /** players: projected 3-yr WAR under the current model curve.
   *  picks: Bridge A's slot/tier realized-WAR stream, summed. */
  war: number | null;
}

/**
 * The trade machine's whole population: every projected player plus a generic
 * pick for every slot and tier.
 *
 * The pick half is lifted from the classic Trade Calculator, which is the one
 * place on the site that already knows how to price a pick nobody has made yet:
 * current-year picks by exact slot (Bridge A knows each), future years by
 * Early/Mid/Late tier out to the last season anyone owns picks in. The KTC join
 * is the label itself, since the market publishes tiers in exactly that shape.
 *
 * NOTE THE ASYMMETRY, and say it out loud in the UI: a pick has a market price
 * and a WAR stream but NO index. DVI and CVI are computed from a projection,
 * and a pick has no player to project until it converts. A ledger that summed
 * DVI across a package containing picks would silently value them at zero.
 */
export function useAssets() {
  const { players } = useLeague();
  const pv = useJson<PickValues>("pick_values.json", "leagueDaily").data;
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const dvi = useDvi();
  const cvi = useCvi();
  const war = useProjWar();

  return useMemo<Asset[] | null>(() => {
    if (!dvi || !cvi) return null;
    const pickKtc = new Map(vals?.picks?.ktc ?? []);
    const out: Asset[] = [];
    // the population is the index's, not the roster's: DVI covers every player
    // the model prices, which is what lets an unrostered player be dropped into
    // a hypothetical
    for (const [pid, d] of Object.entries(dvi.players)) {
      const info = players[pid];
      const v = vals?.players?.[pid];
      out.push({
        key: `p${pid}`, label: d.name, kind: "player", pid,
        pos: d.pos, nfl: info?.[2] ?? "",
        age: null,
        dvi: d.dvi, cvi: cvi.players[pid]?.cvi ?? null,
        ktc: v?.ktc ?? null, d30: v?.ktcT?.["30"] ?? null,
        war: war?.[pid] ?? null,
      });
    }
    if (pv) {
      const cur = pv.meta.generated_for_season + 1;      // current rookie class
      const sum = (s: number[]) => s.reduce((a, x) => a + x, 0);
      for (let r = 0; r < 4; r++)
        for (let s = 1; s <= LEAGUE_TEAMS; s++) {
          const slot = `${r + 1}.${String(s).padStart(2, "0")}`;
          const tier = TIERS[Math.min(2, Math.floor((s - 1) / 4))];
          out.push({
            key: `k${cur} Pick ${slot}`, label: `${cur} Pick ${slot}`, kind: "pick",
            pid: null, pos: "PICK", nfl: "", age: null,
            dvi: null, cvi: null,
            ktc: pickKtc.get(`${cur} ${tier} ${ROUND_ORD[r]}`) ?? null, d30: null,
            war: sum(pickStream(pv, tier, r + 1)),
          });
        }
      const lastYear = Math.max(cur + 2, ...(owned?.meta?.seasons ?? []));
      for (let y = cur + 1; y <= lastYear; y++)
        for (let r = 0; r < 4; r++)
          for (const tier of TIERS)
            out.push({
              key: `k${y} ${tier} ${ROUND_ORD[r]}`, label: `${y} ${tier} ${ROUND_ORD[r]}`,
              kind: "pick", pid: null, pos: "PICK", nfl: "", age: null,
              dvi: null, cvi: null,
              ktc: pickKtc.get(`${y} ${tier} ${ROUND_ORD[r]}`) ?? null, d30: null,
              war: sum(pickStream(pv, tier, r + 1)),
            });
    }
    return out;
  }, [dvi, cvi, war, vals, pv, owned, players]);
}

/**
 * The exact rookie-pick slot a future pick is worth, e.g. "2028 1st ≈ 1.02".
 *
 * A future pick is priced as a TIER, and "2028 Mid 2nd" means nothing to most
 * readers; the current year's board is the ruler everyone in a dynasty league
 * already has calibrated. FantasyCalc is the only feed that publishes a
 * slot-by-slot ladder, so it supplies both sides of this comparison —
 * BOTH SIDES, which is the whole point. Pricing the tier in KTC and then
 * looking that figure up on FantasyCalc's ladder compares two currencies and
 * lands on a slot by coincidence.
 *
 * FantasyCalc labels tiers `2027 1st (Early)` and slots `2026 Pick 1.01`.
 */
export function nearestPick(
  vals: Values | null, season: number, round: number, tier: string,
): string | null {
  const fc = vals?.picks?.fc;
  if (!fc) return null;
  const price = new Map(fc).get(`${season} ${ROUND_ORD[round - 1]} (${tier})`);
  if (price == null) return null;
  const ladder = fc.filter(([l]) => /Pick \d\.\d\d$/.test(l));
  if (!ladder.length) return null;
  let best = ladder[0], gap = Math.abs(ladder[0][1] - price);
  for (const row of ladder) {
    const g = Math.abs(row[1] - price);
    if (g < gap) { gap = g; best = row; }
  }
  return best[0].replace(/^.*Pick /, "");
}

/* ========================================================================
   TEAM VALUATION — the Rankings screen's Teams scope
   ======================================================================== */

export interface TeamVal {
  rid: number; team: string; manager: string;
  /** best legal lineup, summed in each currency. Starters, not roster: depth
   *  is a real asset but it does not start, and a rankings board answers
   *  "who's best" rather than "who owns most". */
  war: number; dvi: number; cvi: number;
  /** whole-roster market, players plus the picks they hold — a market price is
   *  what the asset would fetch, and a pick fetches something */
  market: number;
  /** 30-day raw market delta over the same population */
  market30: number;
}

export function useTeamValues(season: string) {
  const { meta } = useLeague();
  const teams = useJson<Team[]>(`${season}/teams.json`).data;
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const dvi = useDvi();
  const cvi = useCvi();
  const war = useProjWar();

  return useMemo<TeamVal[] | null>(() => {
    if (!teams || !dvi || !cvi || !war) return null;
    const lineup = lineupOf(meta);
    const pickKtc = new Map(vals?.picks?.ktc ?? []);
    // projected WAR arrives as pid -> number with no position, and the lineup
    // optimizer needs one to seat a player. DVI's position is the right source:
    // it is the position the figure was computed for.
    const warIdx: Record<string, { pos: string; v: number }> = {};
    for (const [pid, d] of Object.entries(dvi.players)) {
      const w = war[pid];
      if (w != null) warIdx[pid] = { pos: d.pos, v: w };
    }
    return teams.map(t => {
      let market = 0, market30 = 0;
      for (const pid of t.players) {
        const v = vals?.players?.[pid];
        if (!v?.ktc) continue;
        market += v.ktc;
        market30 += v.ktcT?.["30"] ?? 0;
      }
      // picks the franchise holds. Priced by tier off the original owner's
      // finish — which nobody knows yet, so every future pick is priced Mid.
      // Stated in the screen's caption; a Mid assumption applied uniformly
      // shifts every team the same way and leaves the ORDER honest.
      for (const p of owned?.owned?.[String(t.roster_id)] ?? [])
        market += pickKtc.get(`${p.season} Mid ${ROUND_ORD[p.round - 1]}`) ?? 0;
      return {
        rid: t.roster_id, team: t.team, manager: t.manager,
        war: pricedLineup(t, warIdx, (_p, r) => r.v, lineup).starters,
        dvi: pricedLineup(t, dvi.players, (_p, r) => r.dvi, lineup).starters,
        cvi: pricedLineup(t, cvi.players, (_p, r) => r.cvi, lineup).starters,
        market, market30,
      };
    });
  }, [teams, dvi, cvi, war, vals, owned, meta]);
}

/** Dense 1..n ranks over a numeric key, highest first. */
export function rankMap<T>(rows: T[], key: (r: T) => number, id: (r: T) => string | number) {
  const order = rows.slice().sort((a, b) => key(b) - key(a));
  const m = new Map<string | number, number>();
  order.forEach((r, i) => m.set(id(r), i + 1));
  return m;
}
