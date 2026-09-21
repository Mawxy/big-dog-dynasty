import { useMemo } from "react";
import type {
  Franchises, Matchups, PickValues, PicksOwned, Team, TradesPayload, Values,
} from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi, useProjWar, useProjWar1 } from "../lib/useIndices";
import { useCurrentPickClass, useLeagueCaps } from "../lib/caps";
import { useLeague } from "../lib/context";
import { ktcOf } from "../lib/values";
import {
  LEAGUE_TEAMS, latestSeasonOf, lineupOf, optimalLineup, rosterSeasonOf,
} from "../lib/league";
import { pickStream, ROUND_ORD } from "../lib/rosterModel";

/**
 * The derivations the beta screens share.
 *
 * Kept out of the screens because three of them price the same rosters in the
 * same four currencies and would otherwise each grow their own copy — which is
 * how the classic board ended up with the optimal-lineup sum written out in
 * three views before `pricedLineup` existed.
 */

export const TIERS = ["Early", "Mid", "Late"];
export type Tier = "Early" | "Mid" | "Late";

/* ========================================================================
   WHAT "STARTERS" MEANS — one definition, for every screen that sums one
   ======================================================================== */

/**
 * EACH CURRENCY PRICES ITS OWN BEST LEGAL LINEUP.
 *
 * There were three answers to "this franchise's starters DVI" and they
 * disagreed by up to 50 index points: the Team screen's figure strip summed
 * DVI over the DVI-optimal lineup, the Teams board summed DVI over the
 * projected-WAR lineup, and roster 9 therefore read 661 on one screen and 611
 * on the other — with four franchises swapping rank between them. A figure
 * that changes when you tap through to it is a bug the reader can see.
 *
 * THE SETTLED ANSWER IS THE CLASSIC BOARD'S, because it was already settled
 * there: PROJECT_NOTES on /teams — "each index prices its own best legal
 * lineup" — implemented by `lib/league.pricedLineup`, which `views/Franchises`
 * and `components/FranchisePage` have both read since before this shell
 * existed. The best dynasty nine and the best win-now nine are different nine
 * players, and pricing one lineup in the other's currency understates every
 * roster whose veterans and prospects split the two roles.
 *
 * THE POOL IS THE WHOLE ROSTER, TAXI AND IR INCLUDED, and that is classic's
 * rule too (`pricedLineup` pools `team.players`; `rosterModel.rosterShapes`
 * seats "every rostered player, taxi included"). A taxi body is an ASSET —
 * DVI and CVI price assets — so leaving him out would say his index value is
 * zero. The Team screen's LINEUP BAND is the one place taxi and IR are
 * dropped, and it is not an index figure at all: it is the lineup card, and
 * you cannot field a taxi player this week.
 *
 * A player the currency does not price is ABSENT from the pool rather than
 * seated at zero — the same rule `pricedLineup` follows, and the reason a
 * roster the market never covered totals `—` instead of 0.
 */
export function starterSet<T extends { id: string; pos: string }>(
  pool: readonly T[], value: (a: T) => number | null | undefined, lineup: string[],
): Set<string> {
  const priced = pool.flatMap(a => {
    const v = value(a);
    return v == null ? [] : [{ id: a.id, pos: a.pos, war: v }];
  });
  return optimalLineup(priced, lineup).starters;
}

/** the same definition, summed — the figure itself */
export function starterSum<T extends { id: string; pos: string }>(
  pool: readonly T[], value: (a: T) => number | null | undefined, lineup: string[],
): number {
  const seated = starterSet(pool, value, lineup);
  let sum = 0;
  for (const a of pool) if (seated.has(a.id)) sum += value(a) ?? 0;
  return sum;
}

/** the band note every screen showing one of these figures prints */
export const STARTERS_NOTE =
  "Each index prices its own best legal lineup — the best dynasty nine and the best win-now nine can differ";

/* ========================================================================
   PICK TIERS — where a future pick lands, inferred from its ORIGINAL owner
   ======================================================================== */

/**
 * The draft slot and tier every franchise's own picks project to (Max,
 * 2026-09-02). Until now every future pick was priced Mid, "since the slot
 * depends on a finish nobody knows yet" — but the board projects that finish
 * on every League screen, and a pick's price is exactly where that projection
 * bites. So: rank the twelve franchises by projected year-one lineup WAR (the
 * same figure the power rankings sort on), and the WORST projected team
 * picks FIRST. Slot 1–4 is Early, 5–8 Mid, 9–12 Late — the same
 * floor((slot−1)/4) partition `useAssets` uses to place exact slots in tiers,
 * generalised to n/3 for a league of another size.
 *
 * Keyed by the pick's ORIGINAL franchise, never its holder: who owns a pick
 * says nothing about where it lands. The same projection stands in for every
 * future year — a 2028 pick is tiered by 2026 strength — because it is the
 * only finish the model projects; the captions say so.
 *
 * Null until rosters and projections are both in hand. A franchise the
 * projection cannot seat (no projected players) ranks last, i.e. picks Early,
 * which is what a roster with nothing on it would do.
 *
 * THE FIGURE FOLLOWS THE MODEL PICKER (2026-09-21). This ranked franchises on
 * `projections.json`'s `composite[0]` — the scalar composite, one of six
 * curves — while the League screen's power rankings, which the comment above
 * claims it agrees with, have followed the site-wide control since it was
 * built. On the default curve the two numbers are identical and on the other
 * five they are not, so flipping the model repriced every board on the site
 * except the one that decides what a pick is worth. `useProjWar1` is that
 * same year-one figure under whichever curve the reader is on; DVI supplies
 * the position, as it does everywhere a bare pid -> WAR map has to be seated.
 */
export interface PickSlot { slot: number; tier: Tier }

export function usePickTiers(): Map<number, PickSlot> | null {
  const { meta, league } = useLeague();
  const rosterSeason = rosterSeasonOf(league);
  const teams = useJson<Team[]>(`${rosterSeason}/teams.json`).data;
  const dvi = useDvi();
  const war = useProjWar1();
  return useMemo(() => {
    if (!teams || !dvi || !war) return null;
    const lineup = lineupOf(meta);
    const strength = teams.map(t => {
      const pool = t.players.flatMap(pid => {
        const d = dvi.players[pid];
        return d ? [{ id: pid, pos: d.pos, war: war[pid] ?? null }] : [];
      });
      return { rid: t.roster_id, war: starterSum(pool, p => p.war, lineup) };
    }).sort((a, b) => a.war - b.war);          // weakest first = picks first
    const n = strength.length;
    const per = n / 3;
    const out = new Map<number, PickSlot>();
    strength.forEach((s, i) => {
      const slot = i + 1;
      const k = Math.min(2, Math.floor((slot - 1) / per));
      out.set(s.rid, { slot, tier: TIERS[k] as Tier });
    });
    return out;
  }, [teams, dvi, war, meta]);
}

/** the tier a pick prices at: its original owner's projected slot, or Mid
 *  when the projection is not in hand yet */
export const tierOf = (tiers: Map<number, PickSlot> | null, orig: number): Tier =>
  tiers?.get(orig)?.tier ?? "Mid";

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
    /* THE REGULAR SEASON IS OVER once its last week has been scored, and after
       that there is no "week now in progress" in this file's vocabulary at all
       — `played` holds regular weeks only, so the next-unplayed expression runs
       off the end. Clamping it to `ps - 1` (what this did) republished a week
       that finished a month earlier, all through the playoffs. A third phase is
       the honest answer: the reader is told the postseason is on rather than
       being handed a stale week number. */
    const playoffs = !offseason && Math.max(...played) >= ps - 1;
    return {
      offseason,
      /** the postseason is under way: every regular-season week is scored */
      playoffs,
      /** the season whose RESULTS a reader should be shown */
      resultSeason: offseason ? latest : rosterSeason,
      rosterSeason, latest,
      /** the week now in progress — the first unplayed regular-season week.
       *  Null in the offseason and null once the playoffs start, both of which
       *  are states rather than weeks. */
      week: offseason || playoffs ? null : Math.max(...played) + 1,
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
  /** points for, and the best the roster could have scored (Sleeper's
   *  potential points; null in data built before it was carried) */
  pf: number; maxPf: number | null;
  played: number;
}

/* `med` / `medWins` — a record against each week's league median — were
   computed here for every standings row in both scopes and read by nothing:
   the League screen derives its own median line from the same matchups file
   (screens/League.tsx), and no table ever carried the column. Removed
   2026-09-21 along with the per-week median pass that fed them. Recover from
   git history if the schedule-luck column is ever actually built. */

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
    const rows = teams.map(t => {
      const reg = (mw.teams[String(t.roster_id)] || []).filter(e => e[0] < ps);
      const g = t.wins + t.losses + t.ties;
      return {
        rid: t.roster_id, rank: 0, team: t.team, manager: t.manager,
        wins: t.wins, losses: t.losses, ties: t.ties,
        rec: `${t.wins}-${t.losses}${t.ties ? `-${t.ties}` : ""}`,
        ppg: g ? t.fpts / g : 0,
        pf: t.fpts, maxPf: t.ppts ?? null,
        played: reg.length,
      };
    });
    /* Wins, then POINTS FOR — the same tiebreak the league seeds on, read off
       the figure the league keeps rather than rebuilt from two others. The
       product `ppg × played` reconstructed it out of a rate over GAMES PLAYED
       and a count of SCHEDULED regular-season rows, which are not the same
       denominator: in a week with a game in progress `played` is already one
       ahead of `wins + losses`, so the product ran ahead of the real total and
       could seed two teams the wrong way round. `pf` is the total. */
    const order = rows.slice().sort((a, b) => b.wins - a.wins || b.pf - a.pf);
    order.forEach((r, i) => { r.rank = i + 1; });
    return order;
  }, [teams, mw]);
}

/* ========================================================================
   ACTIVITY
   ======================================================================== */

/** A KEY THAT IS ACTUALLY UNIQUE. Sleeper batch-processes waivers, so a whole
 *  Wednesday morning of moves shares one timestamp to the millisecond and a
 *  franchise can hold several of them — `ts + team` collided, and React silently
 *  dropped every row after the first of each collision. The transaction log has
 *  no id of its own, so the id is its position in the file, which is stable for
 *  the life of a build. */
export interface ActBase { id: string; ts: number; season: string; week: number }
export interface ActTrade extends ActBase {
  kind: "trade";
  sides: { team: string; got: { label: string; pick: boolean }[] }[];
}
export interface ActMove extends ActBase {
  kind: "move";
  /** the franchise KEY (franchises.json — the roster_id, as a string, in a
   *  dynasty league and the owner's Sleeper user_id in a redraft one), so a
   *  screen about one franchise can filter by identity rather than by a name
   *  that changes most seasons */
  key: string;
  team: string;
  /** the transaction's own type, straight off the log: `waiver`,
   *  `free_agent`, `commissioner`. A boolean `waiver` flag was here instead,
   *  which made every non-waiver move read "Free agent" — including the
   *  commissioner moves both leagues carry (3 in Big Dog, 5 in Pizza), where
   *  the whole point of the row is that nobody claimed anybody. */
  type: string;
  adds: string[]; drops: string[];
}
export type Activity = ActTrade | ActMove;

/** what a roster move's `type` is called on screen. An unknown type prints
 *  itself, de-underscored, rather than being folded into a wrong label. */
export const MOVE_LABEL = (type: string): string =>
  type === "waiver" ? "Waiver"
    : type === "free_agent" ? "Free agent"
      : type === "commissioner" ? "Commissioner"
        : type.replace(/_/g, " ").replace(/^./, c => c.toUpperCase());

/**
 * The league's recent moves, newest first — trades and roster moves in one
 * stream, because "what's going on" is one question.
 *
 * Trades come from trades.json (which prices them) and roster moves from each
 * franchise's transaction log. The two are merged on timestamp and nothing is
 * scored here: the feed states that a thing happened. What it was worth is the
 * trade machine's job, and the machine re-prices at today's values rather than
 * at the values on the day.
 *
 * THE ROSTER MOVES DO NOT WAIT ON THE TRADES (2026-09-21). `trades.json` is
 * written by `trade_analysis.py`, which runs for the default league and no
 * other, so in Pineapple Pizza the fetch 404s, the old `!trades` guard never
 * released, and every screen built on this hook reported that the league had
 * made no moves at all — over a transaction log holding a dozen of them in
 * the last week. The file is now REQUESTED only where the pipeline writes one
 * (`caps.trades`) and, where it is requested, it contributes when it lands and
 * is simply absent when it does not. `franchises.json` is the hook's real
 * dependency: it is the one file that answers "what happened".
 */
export function useActivity(limit: number) {
  const caps = useLeagueCaps();
  const trades = useJson<TradesPayload>(caps.trades ? "trades.json" : null).data;
  const fr = useJson<Franchises>("franchises.json").data;
  return useMemo<Activity[] | null>(() => {
    if (!fr) return null;
    const list = trades ? (Array.isArray(trades) ? trades : trades.trades) : [];
    const out: Activity[] = list.map((t, i) => ({
      kind: "trade" as const, id: `t${i}`,
      ts: t.ts, season: t.season, week: t.week,
      sides: t.sides.map(s => ({
        team: s.team,
        got: s.got.map(a => ({ label: a.label, pick: a.kind !== "player" })),
      })),
    }));
    for (const [key, f] of Object.entries(fr)) {
      const name = f.seasons[f.seasons.length - 1]?.name ?? "—";
      f.tx.forEach((tx, i) => {
        if (tx.type === "trade") return;              // already in, and priced
        out.push({
          kind: "move", id: `m${key}:${i}`, key,
          ts: tx.ts, season: tx.season, week: tx.week,
          team: name, type: tx.type,
          adds: tx.adds ?? [], drops: tx.drops ?? [],
        });
      });
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
  dvi: number | null; cvi: number | null;
  /** dynasty market price, in THIS league's KTC column (`lib/values.ktcOf`,
   *  off meta.tep) — never the base `row.ktc`. Picks have one, by tier. */
  ktc: number | null;
  /** FantasyCalc dynasty value, the second market. Players from the values
   *  feed; picks from FantasyCalc's own pick ladder, by tier. */
  fc: number | null;
  /* `d30`, the 30-day raw market delta, was carried on every one of ~900
     assets and read by nothing — the market movers modules build their own
     rows straight off values.json (beta/movers.ts), with a window the reader
     picks. Removed 2026-09-21. */
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
  const { players, meta } = useLeague();
  const pv = useJson<PickValues>("pick_values.json", "leagueDaily").data;
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const dvi = useDvi();
  const cvi = useCvi();
  const war = useProjWar();
  /** which rookie class drafts NEXT — off drafts.json, not off a guess about
   *  when pick_value.py last ran. Null while that file is in flight and in a
   *  league with no rookie picks. */
  const cur = useCurrentPickClass();

  return useMemo<Asset[] | null>(() => {
    if (!dvi || !cvi) return null;
    const pickKtc = new Map(vals?.picks?.ktc ?? []);
    const pickFc = new Map(vals?.picks?.fc ?? []);
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
        dvi: d.dvi, cvi: cvi.players[pid]?.cvi ?? null,
        // THROUGH ktcOf, never row.ktc. KTC publishes four ladders and this
        // league sits on one of them (meta.tep); the base column prices a
        // TE-premium league's tight ends in the wrong market — 8278 against
        // 9160 for the same player. Everything downstream of this hook is
        // priced off it: the baskets, the ledger's market column, and the
        // KTC->DVI/CVI fit the pick indexer runs over the player field.
        ktc: ktcOf(v, meta.tep), fc: v?.fc ?? null,
        war: war?.[pid] ?? null,
      });
    }
    /* THE CLASS DRAFTING NOW COMES OFF drafts.json (2026-09-21).
       `pv.meta.generated_for_season + 1` is a fact about when pick_value.py
       last ran, not about the calendar: on the data as shipped it reads 2025+1
       = 2026, a class that drafted in May, so the pool carried 48 "2026 Pick
       1.01–4.12" assets nobody can trade and the trade machine priced them at
       lag 0. `useCurrentPickClass` reads the recorded rookie drafts instead —
       2026's is on file, so the answer is 2027, which is also the first year
       picks_owned.json has holdings for. Null while drafts.json is in flight
       (and forever in a league with no rookie picks): the exact-slot rows wait
       rather than being labelled with a guessed year, and the tier rows still
       cover every season anyone owns a pick in. */
    if (pv) {
      const sum = (s: number[]) => s.reduce((a, x) => a + x, 0);
      const ownedYears = owned?.meta?.seasons ?? [];
      if (cur != null) for (let r = 0; r < 4; r++)
        for (let s = 1; s <= LEAGUE_TEAMS; s++) {
          const slot = `${r + 1}.${String(s).padStart(2, "0")}`;
          const tier = TIERS[Math.min(2, Math.floor((s - 1) / 4))];
          out.push({
            key: `k${cur} Pick ${slot}`, label: `${cur} Pick ${slot}`, kind: "pick",
            pid: null, pos: "PICK", nfl: "",
            dvi: null, cvi: null,
            // KTC publishes ONE pick ladder — the premium columns are a player
            // repricing and the feed carries no tiered pick board — so this is
            // the only figure available and `ktcOf` has nothing to choose from.
            ktc: pickKtc.get(`${cur} ${tier} ${ROUND_ORD[r]}`) ?? null,
            // FantasyCalc prices the class drafting now by exact slot
            fc: pickFc.get(`${cur} Pick ${slot}`) ?? null,
            war: sum(pickStream(pv, tier, r + 1)),
          });
        }
      // the TIER rows: every season a franchise holds a pick in, minus the one
      // above if it is named by slot. With no calendar yet, every owned year.
      const first = cur == null ? Math.min(...ownedYears) : cur + 1;
      const lastYear = Math.max(...(cur == null ? [] : [cur + 2]), ...ownedYears);
      for (let y = first; y <= lastYear; y++)
        for (let r = 0; r < 4; r++)
          for (const tier of TIERS)
            out.push({
              key: `k${y} ${tier} ${ROUND_ORD[r]}`, label: `${y} ${tier} ${ROUND_ORD[r]}`,
              kind: "pick", pid: null, pos: "PICK", nfl: "",
              dvi: null, cvi: null,
              ktc: pickKtc.get(`${y} ${tier} ${ROUND_ORD[r]}`) ?? null,
              fc: fcTier(pickFc, y, r + 1, tier),
              war: sum(pickStream(pv, tier, r + 1)),
            });
    }
    return out;
  }, [dvi, cvi, war, vals, pv, owned, players, meta, cur]);
}

/**
 * A future pick's FantasyCalc value BY TIER. FantasyCalc tiers only the next
 * class (`2027 1st (Early)` … `(Late)`); further years come as one round
 * value (`2028 1st`). So a tier the feed does not price is the round's raw
 * value scaled by the tier's share in the nearest year that IS tiered:
 *
 *     fc(2028, 1st, Late) = fc(2028 1st) × fc(2027 1st (Late)) ÷ fc(2027 1st)
 *
 * (Max, 2026-09-08.) A ratio rather than a difference, because the tier
 * spread narrows as the year moves out the same way the round value does.
 * Falls back to the raw round value when no year carries tiers for that
 * round, and to null when the feed has nothing at all.
 */
export function fcTier(
  fc: Map<string, number>, season: number, round: number, tier: string,
): number | null {
  const ord = ROUND_ORD[round - 1];
  const exact = fc.get(`${season} ${ord} (${tier})`);
  if (exact != null) return exact;
  const raw = fc.get(`${season} ${ord}`);
  if (raw == null) return null;
  // the nearest season with this round tiered, searching outward
  for (let d = 1; d <= 6; d++) {
    for (const y of [season - d, season + d]) {
      const t = fc.get(`${y} ${ord} (${tier})`), base = fc.get(`${y} ${ord}`);
      if (t != null && base) return Math.round(raw * t / base);
    }
  }
  return raw;
}

/* `nearestPick` lived here: "2028 Mid 2nd ≈ 1.02", a future pick's tier price
   looked up on FantasyCalc's slot-by-slot ladder so a reader could read it in
   the ruler he already has calibrated. It ALWAYS RETURNED NULL — the feed
   publishes no such ladder. data/values.json's `picks.fc` is 24 rows, every
   one of them a round or a tier (`2027 1st`, `2027 1st (Early)`); the only
   `Pick x.yy` labels on the site are KeepTradeCut's, and pricing a tier in one
   currency to look it up in another lands on a slot by coincidence, which is
   the reason this read both ends off one feed in the first place. So the Team
   screen's "≈ 1.02" line under a pick's market figure has never rendered.
   Removed 2026-09-21 with its one call site; the idea needs a slot ladder
   before it needs code. */

/* ========================================================================
   TEAM VALUATION — the Rankings screen's Teams scope
   ======================================================================== */

export interface TeamVal {
  rid: number; team: string; manager: string;
  /** best legal lineup, summed in each index's OWN currency — `starterSum`,
   *  the one definition. Starters, not roster: depth is a real asset but it
   *  does not start, and a rankings board answers "who's best" rather than
   *  "who owns most". */
  dvi: number; cvi: number;
  /** whole-roster market, players plus the picks they hold — a market price is
   *  what the asset would fetch, and a pick fetches something */
  market: number;
}

/* `war` and `market30` were on this row and read by nothing: the Team screen
   takes dvi / cvi / market off it and prints its own lineup WAR from the band
   two sections below (the lineup card, taxi and IR excluded), and no screen
   ever showed a team-level 30-day market delta. `war` also cost the hook a
   `useProjWar` gate, so a league with no projections got null for the market
   rank it could have had. Removed 2026-09-21. */

export function useTeamValues(season: string) {
  const { meta } = useLeague();
  const teams = useJson<Team[]>(`${season}/teams.json`).data;
  const owned = useJson<PicksOwned>("picks_owned.json").data;
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  const dvi = useDvi();
  const cvi = useCvi();
  const tiers = usePickTiers();

  return useMemo<TeamVal[] | null>(() => {
    if (!teams || !dvi || !cvi) return null;
    const lineup = lineupOf(meta);
    const pickKtc = new Map(vals?.picks?.ktc ?? []);
    return teams.map(t => {
      let market = 0;
      for (const pid of t.players) {
        const v = vals?.players?.[pid];
        // THIS LEAGUE'S KTC COLUMN, not the base one. A roster's market total
        // summed off `row.ktc` prices every tight end on it in a market this
        // league does not play in, and a superflex TE-premium roster is exactly
        // where that gap is worth hundreds of points.
        const k = ktcOf(v, meta.tep);
        if (!k) continue;
        market += k;
      }
      // picks the franchise holds, priced by tier off the ORIGINAL owner's
      // projected finish (usePickTiers) — Mid only until the projection lands
      for (const p of owned?.owned?.[String(t.roster_id)] ?? [])
        market += pickKtc.get(`${p.season} ${tierOf(tiers, p.orig)} ${ROUND_ORD[p.round - 1]}`) ?? 0;
      // each index over its OWN best legal lineup — `starterSum`, the same
      // rule the Teams board reads and the same one classic's Value board has
      // always used (lib/league.pricedLineup)
      const pool = t.players.map(pid => ({ id: pid, pos: dvi.players[pid]?.pos ?? "?" }));
      return {
        rid: t.roster_id, team: t.team, manager: t.manager,
        dvi: starterSum(pool, p => dvi.players[p.id]?.dvi, lineup),
        cvi: starterSum(
          pool.map(p => ({ ...p, pos: cvi.players[p.id]?.pos ?? p.pos })),
          p => cvi.players[p.id]?.cvi, lineup),
        market,
      };
    });
  }, [teams, dvi, cvi, vals, owned, meta, tiers]);
}

/** Dense 1..n ranks over a numeric key, highest first. */
export function rankMap<T>(rows: T[], key: (r: T) => number, id: (r: T) => string | number) {
  const order = rows.slice().sort((a, b) => key(b) - key(a));
  const m = new Map<string | number, number>();
  order.forEach((r, i) => m.set(id(r), i + 1));
  return m;
}
