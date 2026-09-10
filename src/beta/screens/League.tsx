import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import type {
  BracketFile, Drafts, Franchises, Matchups, PlayersMin, ProjectionsFile,
  SleeperProjFile, SummaryRow, Team, Values, WeekOdds, Weekly,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { jl } from "../../lib/data";
import { useLeague } from "../../lib/context";
import { fmt, mean, normCdf, normInv, ord } from "../../lib/stats";
import {
  POS_CHIPS, POS_COLOR, SLOT_LABEL, latestSeasonOf, lineupOf, optimalLineup, pInfo, rosterSeasonOf,
} from "../../lib/league";
import { RouteLink } from "../../components/RouteLink";
import PlayoffBracket from "../../components/PlayoffBracket";
import { HonorSprite } from "../../components/HonorMarks";
import TeamHonorMarks from "../../components/TeamHonorMarks";
import { franchiseHonors, teamHonorTotals, useTeamHonors } from "../../lib/teamHonors";
import DraftBoardGrid from "../../components/DraftBoardGrid";
import { buildHistory } from "../../lib/draftHistory";
import { useSeasonPhase, useStandings } from "../model";
import { useLiveScores, useNflScoreboard, type LiveSide, type Scoreboard } from "../../lib/liveScores";
import Moved from "../moved";
import {
  DynTable, dynNote, GapTable, MarketTable, marketNote, MODULE_MIN_VALUE,
  useDynMovers, useGapRows, useMarketMovers,
} from "../movers";
import {
  Band, DataError, fmtWar, IdCell, NUL, Spine, Strip, TapRow, useBetaPath, type Figure,
} from "../ui";
import ScopeControl, { ALL_SEASONS, useScope, type ScopeSeason } from "../Scope";
import "./league.css";

/**
 * LEAGUE — the claim, the board, and what moved.
 *
 * ONE TENSE PER VIEW, and the scope control is the only thing that changes it.
 *
 *   Current  the roster season and nothing else: this week's matchups and
 *            last week's figures, the power rankings, the last seven days,
 *            then win-now vs dynasty and the two market reads.
 *   History  one settled season and nothing else: its champion, its final
 *            standings by seed, its WAR leaders.
 *
 * The rule is load-bearing rather than decorative. This league's roster season
 * is unplayed all offseason, so `useSeasonPhase().resultSeason` points at LAST
 * year — which is exactly why nothing under Current reads it. The version of
 * this screen being replaced put a 2026 figure strip over 2025's final
 * standings and called the pair "League"; two years pretending to be one is the
 * failure the scope control exists to end.
 *
 * The band ORDER is the design. The claim first, then the board the claim is
 * about, then what changed since the reader last looked, and only then the
 * three modules that would read identically on any board in the world.
 */

/** the four lineup positions, in the lineup's order — POS_CHIPS less its
 *  "ALL" filter chip, so there is one list of positions on the site */
const POSITIONS = POS_CHIPS.filter(p => p !== "ALL");

/** rows per half of a split module — five is what fits under a band without
 *  the second half starting off-screen */
const MODULE_ROWS = 5;

/** THE BAND'S WAY OUT (Max, 2026-09-08): a module that shows five of a
 *  longer list says so in its own header, where the note would sit, and the
 *  link opens the whole list on the Movers screen. */
function ViewAll({ to, label = "View all →" }: { to: string; label?: string }) {
  return <RouteLink to={to} className="lgx-all">{label}</RouteLink>;
}

/** An em dash OUTSIDE a table. ui.tsx's NUL rides `.nul`, which beta.css scopes
 *  to `.v3tbl td`; a basket figure and a champion block are not table cells. */
const DASH = <span className="lgx-nul">—</span>;

export default function League() {
  const { meta, league } = useLeague();
  const latest = latestSeasonOf(meta);
  const fr = useJson<Franchises>("franchises.json").data;

  /** the SETTLED seasons, newest first. Sliced at `latest` rather than filtered
   *  by string comparison: the roster season sits in meta.seasons too, and it
   *  has no result to show. */
  const played = useMemo(() => {
    const i = meta.seasons.indexOf(latest);
    return (i < 0 ? meta.seasons : meta.seasons.slice(0, i + 1)).slice().reverse();
  }, [meta.seasons, latest]);

  // "All-time" is a row in the picker (Max, 2026-09-02): every franchise's
  // record across the league's life, and the career WAR leaders
  const [scope, setScope] = useScope(played, { allowAll: true });

  /* The picker's per-season note — "champion · record", so choosing a year is
     reading a history table rather than picking a number off a list. From
     franchises.json because it is ONE file carrying every season's finish; the
     alternative is a bracket.json per year, four fetches to fill a sheet most
     readers never open. */
  const seasons = useMemo<ScopeSeason[]>(() => played.map(id => {
    const won = fr && Object.values(fr)
      .flatMap(f => f.seasons)
      .find(s => s.season === id && s.finish === 1);
    return won
      ? { id, note: `${won.name} · ${won.wins}-${won.losses}${won.ties ? `-${won.ties}` : ""}` }
      : { id };
  }), [played, fr]);

  return (
    <>
      <ScopeControl value={scope} onChange={setScope} seasons={seasons} allTime />
      {/* keyed on the season so switching years resets the screen rather than
          rendering one year's champion over another's standings for a frame */}
      {scope.scope === "history"
        ? (scope.season === ALL_SEASONS
          ? <AllTimeView played={played} />
          : <HistoryView key={scope.season} season={scope.season} />)
        : <CurrentView rosterSeason={rosterSeasonOf(league)} />}
    </>
  );
}

/* ========================================================================
   CURRENT — the roster season
   ======================================================================== */

/* ========================================================================
   THIS WEEK / LAST WEEK — the top of the League screen
   ======================================================================== */

/**
 * THE TWO WEEKS A READER ACTUALLY ASKS ABOUT (Max, 2026-09-02), in place of
 * the dated outlook paragraph that used to lead the screen.
 *
 * THIS WEEK is the week in progress — or, before the season, week 1 — as six
 * matchup cards: each side's name and its pregame win probability and
 * projected total from odds.json (week_odds.py's own line, no lookahead).
 * Once the week is scored the card shows the points instead and the winner
 * takes the accent. Every card taps through to that week on Seasons.
 *
 * LAST WEEK is the most recent scored regular-season week — of the roster
 * season once one has been played, of the last finished season before that,
 * which is why the band names its season — as a four-figure strip: top score,
 * low score, the upset (the winner the line liked least), and the week's WAR
 * leader among players who were actually started.
 *
 * Nothing here is prose and nothing is authored: both bands are read off the
 * files the nightly refresh rewrites, so they cannot go stale the way a
 * written verdict did.
 */
/**
 * THE BOOK'S OWN JUICE, measured (Max, 2026-09-02). data/vig_model.json —
 * scripts/vig_model.py, off every NFL closing moneyline nflverse carries —
 * tabulates, by the favorite's FAIR probability, what books actually posted
 * on the favorite and on the dog, hold included. A fair 63% favorite is
 * not quoted at −170/+170; it is quoted at whatever the table says books
 * quote 63% favorites at, which is what makes our line read like a line.
 */
interface VigModel {
  meta: { hold_median: number | null; min_n?: number };
  bins: { p: number; n: number; fav: number | null; dog: number | null; hold: number | null }[];
}

/** implied probability -> American moneyline, as books quote them (Max,
 *  2026-09-03): whole numbers on the working range, the nearest ten once a
 *  line is big (past ±550 the last digit is noise nobody prices), the
 *  nearest hundred past ±1000, the nearest thousand past ±10000, and futures (`step` 5) to the nearest five
 *  throughout, which is how a futures board reads. No cap: a 99% side prints −9900, which is the line. Only the
 *  degenerate ends are guarded, since 0 and 1 have no moneyline at all. */
const toMl = (q: number, step = 1): string => {
  const c = Math.min(0.9999, Math.max(0.0001, q));
  const ml = c >= 0.5 ? -100 * c / (1 - c) : 100 * (1 - c) / c;
  // rounding coarsens with the price: tens past ±550, hundreds past ±1000,
  // thousands past ±10000
  const unit = Math.abs(ml) > 10000 ? 1000 : Math.abs(ml) > 1000 ? 100 : Math.abs(ml) > 550 ? 10 : step;
  const r = Math.round(ml / unit) * unit;
  return r > 0 ? `+${r}` : String(r);
};

/** the flat fallback hold when no measured table has loaded: the value that
 *  makes a coin flip exactly −110/−110 */
const HOLD = 110 / 210 / 0.5 - 1;

/**
 * THE POWER METHOD: raise both fair probabilities to one power k < 1 until
 * they sum to 1 + hold. Unlike a multiplier it never pushes a favorite past
 * 100% — it loads the dog, which is what a real board does to a heavy line.
 * k is monotone in the sum, so bisection finds it.
 */
function juice(fair: number, hold: number): [number, number] {
  const total = 1 + hold;
  let lo = 0.3, hi = 1;
  for (let i = 0; i < 40; i++) {
    const k = (lo + hi) / 2;
    if (Math.pow(fair, k) + Math.pow(1 - fair, k) > total) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return [Math.pow(fair, k), Math.pow(1 - fair, k)];
}

/**
 * Both sides' moneylines for a matchup, from the model's win probability for
 * side A. With the measured table: the favorite's fair probability is looked
 * up among the bins that have real games behind them (interpolating between
 * 1% bins) and each side takes the POSTED probability books assign at that
 * strength. Past the last populated bin — NFL books never see a 95% favorite,
 * a fantasy league does every week — the line is extended with the power
 * method at the book's own hold for its heaviest favorites, rather than
 * flattening at the last row. Without the table: the power method at −110.
 */
function lines(pA: number, vig: VigModel | null, step = 1): [string, string] {
  const aFav = pA >= 0.5;
  const fair = aFav ? pA : 1 - pA;
  const minN = vig?.meta.min_n ?? 25;
  const bins = vig?.bins.filter(b => b.fav != null && b.dog != null && b.n >= minN) ?? [];
  let fav: number, dog: number;
  if (bins.length >= 2 && fair <= bins[bins.length - 1].p) {
    const x = Math.max(bins[0].p, fair);
    let i = bins.findIndex(b => b.p >= x);
    if (i <= 0) i = 1;
    const lo = bins[i - 1], hi = bins[i];
    const w = hi.p === lo.p ? 0 : (x - lo.p) / (hi.p - lo.p);
    fav = lo.fav! + (hi.fav! - lo.fav!) * w;
    dog = lo.dog! + (hi.dog! - lo.dog!) * w;
  } else {
    const hold = bins.length ? (bins[bins.length - 1].hold ?? vig?.meta.hold_median ?? HOLD) : HOLD;
    [fav, dog] = juice(fair, hold);
  }
  return aFav ? [toMl(fav, step), toMl(dog, step)] : [toMl(dog, step), toMl(fav, step)];
}

/** a point spread to the half, signed for the side it is quoted on */
const spread = (mine: number, theirs: number): string => {
  const d = Math.round((theirs - mine) * 2) / 2;
  return d === 0 ? "PK" : d > 0 ? `+${d}` : String(d);
};

function WeekBands({ rosterSeason }: { rosterSeason: string }) {
  const { players, meta, league } = useLeague();
  const betaPath = useBetaPath();
  /* THE OPEN CARD (Max, 2026-09-09): tapping a game opens a drawer under it
     with the two lineups slot by slot — who is favored where. One open at a
     time; the full matchup page is a link inside the drawer. */
  const [openGame, setOpenGame] = useState<string | null>(null);
  const phase = useSeasonPhase();
  const resultSeason = phase.resultSeason;

  const mwQ = useJson<Matchups>(`${rosterSeason}/matchups.json`);
  const oddsQ = useJson<WeekOdds>(`${rosterSeason}/odds.json`);
  const teams = useJson<Team[]>(`${rosterSeason}/teams.json`).data;
  // the result season's files: the same files when a week of the roster
  // season has been played, the previous season's before that
  const mwR = useJson<Matchups>(`${resultSeason}/matchups.json`).data;
  const oddsR = useJson<WeekOdds>(`${resultSeason}/odds.json`).data;
  const weeklyR = useJson<Weekly>(`${resultSeason}/weekly.json`).data;
  const teamsR = useJson<Team[]>(`${resultSeason}/teams.json`).data;
  // the measured vig: a global file, one fit for every league
  const vig = useJson<VigModel>("data/vig_model.json").data;
  // STARS TO WATCH: each side's highest-projected starter this week, off
  // Sleeper's per-week lines; once the week is scored, its top scorer instead
  const sproj = useJson<SleeperProjFile>("proj_sleeper.json").data;
  const weeklyNow = useJson<Weekly>(`${rosterSeason}/weekly.json`).data;

  const nameOf = (list: Team[] | null | undefined, rid: number) =>
    list?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;
  /** whose roster a player is on — that season's end-of-season roster, which
   *  is the closest thing the data has; null when nobody holds him */
  const teamOf = (list: Team[] | null | undefined, pid: string) =>
    list?.find(t => t.players.includes(pid))?.team ?? null;

  /* ---- this week -------------------------------------------------------- */
  const thisWeek = useMemo(() => {
    const mw = mwQ.data;
    if (!mw) return null;
    const ps = mw.playoff_start || 15;
    // the week in progress, else the first week anyone is scheduled for
    const scheduled = Object.keys(mw.schedule ?? {}).map(Number).filter(w => w < ps).sort((a, b) => a - b);
    const wk = phase.week ?? scheduled[0] ?? null;
    if (wk == null) return null;
    // scored entries for the week, by roster
    const scored = new Map<number, { pts: number; opp: number | null; oppPts: number | null }>();
    for (const [rid, list] of Object.entries(mw.teams)) {
      const e = list.find(x => x[0] === wk);
      if (e) scored.set(Number(rid), { pts: e[1], opp: e[2], oppPts: e[3] });
    }
    // pairings: the schedule's, else derived from the scored entries
    let pairs: [number, number][] = mw.schedule?.[String(wk)] ?? [];
    if (!pairs.length) {
      const seen = new Set<number>();
      for (const [rid, e] of scored) {
        if (seen.has(rid) || e.opp == null) continue;
        seen.add(rid); seen.add(e.opp); pairs.push([rid, e.opp]);
      }
    }
    const line = oddsQ.data?.weeks[String(wk)] ?? {};
    const played = pairs.length > 0 && pairs.every(([a, b]) => scored.has(a) && scored.has(b));

    // NO STAR TO WATCH (Max, 2026-09-10): the card carried each side's
    // top projected / top scoring starter under the figure; it was noise
    // beside a line and a score, and the drawer has every slot anyway.
    const games = pairs.map(([a, b]) => ({
      a: { rid: a, wp: line[String(a)]?.wp ?? null, mu: line[String(a)]?.mu ?? null, sd: line[String(a)]?.sd ?? null, pts: scored.get(a)?.pts ?? null },
      b: { rid: b, wp: line[String(b)]?.wp ?? null, mu: line[String(b)]?.mu ?? null, sd: line[String(b)]?.sd ?? null, pts: scored.get(b)?.pts ?? null },
    }));
    // THE LEAGUE MEDIAN (Max, 2026-09-09): the middle score of every team's
    // figure this week — points once played, the projected total before.
    // The line a median-win league pays on, and the line every team is over
    // or under regardless.
    const figs = games.flatMap(g => [g.a, g.b])
      .map(x => (played ? x.pts : x.mu)).filter((v): v is number => v != null)
      .sort((x, y) => x - y);
    const median = figs.length
      ? figs.length % 2 ? figs[(figs.length - 1) / 2] : (figs[figs.length / 2 - 1] + figs[figs.length / 2]) / 2
      : null;
    return { wk, played, games, median };
  }, [mwQ.data, oddsQ.data, phase.week]);

  /* ---- live (Max, 2026-09-10) --------------------------------------------
     The week in progress, from Sleeper, once a minute: points so far on
     each side, the top scorer so far under it, the running margin in the
     middle. Only between the first kickoff and the pipeline scoring the
     week; before anyone has scored the cards stay pregame, and once the
     file carries the week it is the record and nothing is fetched. */
  const leagueId = league.chain?.[rosterSeason] ?? league.currentLeagueId ?? null;
  const live = useLiveScores(leagueId, thisWeek?.wk ?? null, !!thisWeek && !thisWeek.played);
  const isLive = !!live?.started && !thisWeek?.played;
  const liveOf = (rid: number): LiveSide | null => live?.sides[String(rid)] ?? null;
  /* ---- the live line (Max, 2026-09-10) -----------------------------------
     The projection and the odds move with the games. Per starter: his game
     still to come, his week projection; under way, points so far plus the
     projection's share for the time left; over, his points, full stop. A
     side's live total is the sum, its variance the pregame sd² scaled by
     the share of its projected points still to be played, and the win
     probability is the same normal the pregame line is quoted from —
     Φ((muA − muB) / sqrt(varA + varB)). The scoreboard is ESPN's; without
     it the pregame line stands. */
  // fetched all week, not only once live: pregame the drawer shows each
  // man's kickoff, which is worth a request on its own
  const board = useNflScoreboard(rosterSeason, thisWeek?.wk ?? null, !!thisWeek && !thisWeek.played);
  const liveLine = useCallback((rid: number, sd: number | null): { mu: number; v: number } | null => {
    const ls = liveOf(rid);
    if (!ls || !board) return null;
    let mu = 0, projAll = 0, projLeft = 0;
    for (const pid of ls.starters) {
      if (!pid || pid === "0") continue;
      const wk = thisWeek?.wk ?? 0;
      const proj = sproj?.players[pid]?.wk?.[String(wk)] ?? sproj?.players[pid]?.ppg ?? 0;
      const act = ls.ppts[pid] ?? 0;
      const clock = board[pInfo(players, pid)[2]];
      // no game on the board: a bye, or a code the board does not know —
      // his points are what they are and the projection still to come
      const rem = clock ? clock.remaining : act > 0 ? 0 : 1;
      mu += act + rem * proj;
      projAll += proj; projLeft += rem * proj;
    }
    const share = projAll > 0 ? projLeft / projAll : 0;
    const v = (sd ?? 0) ** 2 * share;
    return { mu, v };
  }, [board, live, sproj, players, thisWeek?.wk]);

  /** the league median of the points so far, while live */
  const liveMedian = useMemo(() => {
    if (!isLive || !live || !thisWeek) return null;
    const figs = thisWeek.games.flatMap(g => [g.a.rid, g.b.rid])
      .map(rid => live.sides[String(rid)]?.pts).filter((v): v is number => v != null)
      .sort((x, y) => x - y);
    if (!figs.length) return null;
    return figs.length % 2 ? figs[(figs.length - 1) / 2] : (figs[figs.length / 2 - 1] + figs[figs.length / 2]) / 2;
  }, [isLive, live, thisWeek]);

  /* ---- slot by slot ------------------------------------------------------
     A side's starting lineup as the manager set it (matchups.set, or the
     scored entry's starters once played), one entry per starting slot in
     the league's lineup order; before a lineup is set, the roster's best
     projected lineup. Each slot carries its week figure: the actual score
     once played, Sleeper's per-week projection before. A bye or an empty
     slot is a real 0.0 — that IS the weakness. */
  const slotsOf = useCallback((rid: number, wk: number, played: boolean, ls: LiveSide | null = null): SlotEntry[] => {
    const mw = mwQ.data;
    const lineup = lineupOf(meta).filter(sl => !["BN", "IR", "TAXI"].includes(sl));
    const projOf = (pid: string): number => sproj?.players[pid]?.wk?.[String(wk)] ?? 0;
    const val = (pid: string): number => {
      // live: points so far, off Sleeper's read of the week in progress
      if (ls) return ls.ppts[pid] ?? 0;
      if (played) return weeklyNow?.[pid]?.find(x => x[0] === wk)?.[1] ?? 0;
      return projOf(pid);
    };
    /** the projection under a result, and whether it was missed (Max,
     *  2026-09-10): red only once his game is over — a slow first half is
     *  not a miss yet */
    const result = (pid: string, v: number): Pick<SlotEntry, "proj" | "over" | "miss" | "est"> => {
      if (!ls && !played) return {};
      // no line for the week (an older week the projections file has
      // dropped): nothing to hit, so nothing under the figure
      if (sproj?.players[pid]?.wk?.[String(wk)] == null) return { est: v, over: played };
      const proj = projOf(pid);
      const clock = board?.[pInfo(players, pid)[2]];
      const over = played || clock?.state === "post";
      // the share of his game still to play: none once over, all before
      // kickoff, the clock's in between; no game on the board reads off
      // whether he has scored
      const rem = over ? 0 : clock ? clock.remaining : v > 0 ? 0 : 1;
      return { proj, over, miss: over && v < proj, est: v + rem * proj };
    };
    const e = mw?.teams[String(rid)]?.find(x => x[0] === wk);
    let set: string[] | null = ls?.starters.length ? ls.starters
      : e?.[4]?.length ? e[4]
      : mw?.set?.week === wk ? mw.set.starters[String(rid)] ?? null : null;
    if (set && set.length !== lineup.length) set = null;
    if (set) {
      return lineup.map((slot, i) => {
        const pid = set![i];
        const real = pid && pid !== "0";
        const v = real ? val(pid) : 0;
        return { slot, pid: real ? pid : null, v, ...(real ? result(pid, v) : {}) };
      });
    }
    const roster = teams?.find(t => t.roster_id === rid)?.players ?? [];
    const pool = roster.map(pid => ({ id: pid, pos: pInfo(players, pid)[1], war: val(pid) }))
      .filter(p => p.pos);
    return optimalLineup(pool, lineup).slots.map(sl => ({
      slot: sl.slot, pid: sl.player?.id ?? null, v: sl.player?.war ?? 0,
      ...(sl.player ? result(sl.player.id, sl.player.war) : {}),
    }));
  }, [mwQ.data, meta, weeklyNow, sproj, teams, players, board]);

  /* ---- last week -------------------------------------------------------- */
  const lastWeek = useMemo(() => {
    if (!mwR) return null;
    const ps = mwR.playoff_start || 15;
    let wk = 0;
    for (const list of Object.values(mwR.teams))
      for (const e of list) if (e[0] < ps && e[0] > wk) wk = e[0];
    if (!wk) return null;
    const rows: { rid: number; pts: number; opp: number | null; oppPts: number | null; starters: string[] }[] = [];
    for (const [rid, list] of Object.entries(mwR.teams)) {
      const e = list.find(x => x[0] === wk);
      if (e) rows.push({ rid: Number(rid), pts: e[1], opp: e[2], oppPts: e[3], starters: e[4] ?? [] });
    }
    if (!rows.length) return null;
    const top = rows.reduce((m, r) => (r.pts > m.pts ? r : m));
    const low = rows.reduce((m, r) => (r.pts < m.pts ? r : m));
    // THE UPSET: the winner the pregame line liked least. Ties are not upsets.
    const line = oddsR?.weeks[String(wk)] ?? {};
    const winners = rows.filter(r => r.oppPts != null && r.pts > r.oppPts && line[String(r.rid)]?.wp != null);
    const upset = winners.length
      ? winners.reduce((m, r) => (line[String(r.rid)].wp! < line[String(m.rid)].wp! ? r : m))
      : null;
    // THE CLOSEST SCORE (Max, 2026-09-08): the week's narrowest margin, each
    // game counted once from its winner's side. A tie is a margin of zero.
    let closest: { rid: number; pts: number; opp: number; oppPts: number } | null = null;
    for (const r of rows) {
      if (r.opp == null || r.oppPts == null || r.pts < r.oppPts) continue;
      if (!closest || r.pts - r.oppPts < closest.pts - closest.oppPts)
        closest = { rid: r.rid, pts: r.pts, opp: r.opp, oppPts: r.oppPts };
    }
    // THE WEEK'S TOP SCORE AT EACH POSITION, bench or starter (Max,
    // 2026-09-08): weekly.json scores every rostered player, so a 40 left on
    // a bench counts — it is a fact about the week, whoever sat him.
    const posTop: Record<string, { pid: string; pts: number } | null> = {};
    if (weeklyR) {
      for (const [pid, wrows] of Object.entries(weeklyR)) {
        const w = wrows.find(x => x[0] === wk);
        if (!w) continue;
        const pos = pInfo(players, pid)[1];
        const cur = posTop[pos];
        if (!cur || w[1] > cur.pts) posTop[pos] = { pid, pts: w[1] };
      }
    }
    return { wk, top, low, upset, upsetWp: upset ? line[String(upset.rid)].wp! : null, closest, posTop };
  }, [mwR, oddsR, weeklyR, players]);

  const seasonsRoute = (season: string, wk: number) => betaPath(`/seasons/${season}/${wk}`);
  const twSeason = rosterSeason;
  const lwSeason = resultSeason;

  return (
    <>
      <Band label={thisWeek ? `This week · ${twSeason} wk ${thisWeek.wk}` : "This week"}
        note={thisWeek?.played ? "Final"
          : isLive ? "Live · points so far, projection and odds moving with the games"
          : "Pregame line"} />
      {mwQ.error ? <DataError what="Schedule didn't load" />
        : !thisWeek ? <div className="empty">{mwQ.loading ? "Loading…" : "No week scheduled."}</div> : (
        <div className="lgx-games">
          {(isLive ? liveMedian : thisWeek.median) != null && (
            <div className="lgx-median">
              <span className="k">League median</span>
              <span className="v">{fmt((isLive ? liveMedian : thisWeek.median) as number, 1)}</span>
              <span className="s">{thisWeek.played ? "of the week's scores" : isLive ? "of the points so far" : "of the projected totals"}</span>
            </div>
          )}
          {thisWeek.games.map(g => {
            // while live, the figures are the points so far and the leader
            // takes the accent the winner takes at the final
            const la = isLive ? liveOf(g.a.rid) : null, lb = isLive ? liveOf(g.b.rid) : null;
            const ptsA = la ? la.pts : g.a.pts, ptsB = lb ? lb.pts : g.b.pts;
            const aWon = ptsA != null && ptsB != null && ptsA > ptsB;
            const bWon = ptsA != null && ptsB != null && ptsB > ptsA;
            /* THE LINE, THE WAY A BOOK WOULD QUOTE IT (Max, 2026-09-02): each
               side's moneyline is its figure; the spread and the total sit in
               the middle block between them, the way a scoreboard card posts
               them, with the spread quoted from the favorite's side and an
               arrow pointing at it. Under each name: the star to watch. After
               kickoff the figures are the points and the middle reads Final. */
            const total = g.a.mu != null && g.b.mu != null ? fmt(g.a.mu + g.b.mu, 1) : null;
            const aFav = (g.a.wp ?? 0) >= (g.b.wp ?? 0);
            const favSide = aFav ? g.a : g.b, dogSide = aFav ? g.b : g.a;
            const sp = favSide.mu != null && dogSide.mu != null ? spread(favSide.mu, dogSide.mu) : null;
            const [mlA, mlB] = g.a.wp != null ? lines(g.a.wp, vig) : [null, null];
            const side = (x: typeof g.a, ls: LiveSide | null, ml: string | null, won: boolean, right: boolean, lml: string | null = null) => {
              const pts = ls ? ls.pts : x.pts;
              // live: the re-projected total; pregame: the line's
              const ll = ls ? liveLine(x.rid, x.sd) : null;
              const mu = ll ? ll.mu : x.mu;
              return (
                <div className={`side${right ? " r" : ""}${won ? " won" : ""}`}>
                  <div className="nm">{nameOf(teams, x.rid)}</div>
                  <div className="fig">{pts != null ? fmt(pts, 1) : ml ?? DASH}</div>
                  {/* the side's projected total, pregame and live (Max,
                      2026-09-09): the figure the line is made from, under the
                      line it makes — and, once live, the pace to beat. */}
                  {x.pts == null && mu != null && (
                    <div className="proj"><span className="k">Proj</span> {fmt(mu, 1)}</div>
                  )}
                  {/* the moneyline, live (Max, 2026-09-10): the points took
                      the figure, so the odds move down here — the same line
                      the card quoted pregame, re-priced off the live win
                      probability with the same vig */}
                  {lml && (
                    <div className="proj"><span className="k">ML</span> {lml}</div>
                  )}
                </div>
              );
            };
            // the running margin, while live — the spread's live counterpart
            const lm = la && lb ? la.pts - lb.pts : null;
            // the live line: re-projected totals and the win probability
            // from them, or null while the scoreboard has not landed
            const llA = la ? liveLine(g.a.rid, g.a.sd) : null;
            const llB = lb ? liveLine(g.b.rid, g.b.sd) : null;
            const lwp = llA && llB
              ? (llA.v + llB.v > 0 ? normCdf((llA.mu - llB.mu) / Math.sqrt(llA.v + llB.v))
                : llA.mu > llB.mu ? 1 : llA.mu < llB.mu ? 0 : 0.5)
              : null;
            const lTotal = llA && llB ? fmt(llA.mu + llB.mu, 1) : null;
            const [lmlA, lmlB] = lwp != null ? lines(lwp, vig) : [null, null];
            // THE CARD OPENS ITS DRAWER (Max, 2026-09-09) — slot by slot,
            // inline, under the card. The matchup page is the link inside it.
            const key = `${g.a.rid}-${g.b.rid}`;
            const isOpen = openGame === key;
            return [
              <button key={key} type="button" className={`lgx-game${isOpen ? " open" : ""}`}
                aria-expanded={isOpen}
                onClick={() => setOpenGame(isOpen ? null : key)}>
                {side(g.a, la, mlA, aWon, false, lmlA)}
                <div className="mid">
                  {thisWeek.played ? <span className="k">Final</span> : (
                    <>
                      {/* live: the margin so far over the pregame spread, so
                          the read is "up 8, was favored by 3" */}
                      {lm != null ? (
                        <>
                          <span className="k lgx-live">Live</span>
                          <span className="v edge">
                            <span className="ar">{lm > 0 ? "◂" : ""}</span>
                            <span className="n">{fmt(Math.abs(lm), 1)}</span>
                            <span className="ar">{lm < 0 ? "▸" : ""}</span>
                          </span>
                          {/* the odds now: the favorite's chance, arrow at
                              him — the moneyline's live form, one figure */}
                          <span className="k">Win</span>
                          <span className="v edge">
                            <span className="ar">{lwp != null && lwp >= 0.5 ? "◂" : ""}</span>
                            <span className="n">{lwp != null ? `${Math.round(Math.max(lwp, 1 - lwp) * 100)}%` : DASH}</span>
                            <span className="ar">{lwp != null && lwp < 0.5 ? "▸" : ""}</span>
                          </span>
                          <span className="k">Total</span>
                          <span className="v">{lTotal ?? total ?? DASH}</span>
                        </>
                      ) : (
                        <>
                          <span className="k">Spread</span>
                          {/* the figure holds the center; the arrow takes a fixed
                              slot either side, so spreads line up down the column */}
                          <span className="v edge">
                            <span className="ar">{sp && aFav ? "◂" : ""}</span>
                            <span className="n">{sp ?? DASH}</span>
                            <span className="ar">{sp && !aFav ? "▸" : ""}</span>
                          </span>
                          <span className="k">Total</span>
                          <span className="v">{total ?? DASH}</span>
                        </>
                      )}
                    </>
                  )}
                </div>
                {side(g.b, lb, mlB, bWon, true, lmlB)}
              </button>,
              isOpen && (
                <SlotDrawer key={`${key}-drawer`}
                  a={{ rid: g.a.rid, name: nameOf(teams, g.a.rid), slots: slotsOf(g.a.rid, thisWeek.wk, thisWeek.played, la) }}
                  b={{ rid: g.b.rid, name: nameOf(teams, g.b.rid), slots: slotsOf(g.b.rid, thisWeek.wk, thisWeek.played, lb) }}
                  played={thisWeek.played} live={!!la && !!lb} players={players} board={board}
                  to={`${seasonsRoute(twSeason, thisWeek.wk)}/${g.a.rid}`} />
              ),
            ];
          })}
        </div>
      )}

      <Band label={lastWeek ? `Last week · ${lwSeason} wk ${lastWeek.wk}` : "Last week"}
        note="Regular season" />
      {/* FOUR EVEN CELLS over the four position blocks below (`.lgx-even`),
          so the two rows read as one grid. THE THREE FIGURES THAT EARN A
          COLOUR (Max, 2026-09-08): the top score is the week's positive, the
          low its negative, the upset its caution — the semantic tokens the
          rest of the board already gives those three facts. The margin stays
          neutral: a close game is not good or bad for anyone. */}
      {!lastWeek ? <div className="empty">{mwR ? "No week played yet." : "Loading…"}</div> : (
        <div className="lgx-even">
        <Strip figures={[
          { key: "top", label: "Top score",
            value: <span className="lgx-good">{fmt(lastWeek.top.pts, 1)}</span>,
            sub: nameOf(teamsR, lastWeek.top.rid), to: seasonsRoute(lwSeason, lastWeek.wk) },
          { key: "low", label: "Low score",
            value: <span className="lgx-bad">{fmt(lastWeek.low.pts, 1)}</span>,
            sub: nameOf(teamsR, lastWeek.low.rid), to: seasonsRoute(lwSeason, lastWeek.wk) },
          { key: "upset", label: "Upset",
            value: lastWeek.upset && lastWeek.upsetWp != null
              ? <span className="lgx-warn">{`${Math.round(lastWeek.upsetWp * 100)}%`}</span> : DASH,
            sub: lastWeek.upset
              ? `${nameOf(teamsR, lastWeek.upset.rid)} beat ${lastWeek.upset.opp != null ? nameOf(teamsR, lastWeek.upset.opp) : "—"}`
              : "no winner beat the line",
            to: seasonsRoute(lwSeason, lastWeek.wk) },
          { key: "close", label: "Closest score",
            value: lastWeek.closest ? fmt(lastWeek.closest.pts - lastWeek.closest.oppPts, 1) : DASH,
            // "X beat Y, 123.2–121.1": the same grammar as the upset line, so
            // the two sides read as one game rather than two facts
            sub: lastWeek.closest
              ? `${nameOf(teamsR, lastWeek.closest.rid)} beat ${nameOf(teamsR, lastWeek.closest.opp)}, ${fmt(lastWeek.closest.pts, 1)}–${fmt(lastWeek.closest.oppPts, 1)}`
              : "no scored game",
            to: seasonsRoute(lwSeason, lastWeek.wk) },
        ]} />
        </div>
      )}
      {/* the week's best at each position, bench or starter — the same four
          blocks the season and all-time views carry, scoped to one week */}
      {lastWeek && (
        <PosLeaders
          leaders={POSITIONS.map(pos => {
            const t = lastWeek.posTop[pos];
            return t ? { pid: t.pid, value: `${fmt(t.pts, 1)} pts`,
              note: teamOf(teamsR, t.pid) ?? "unrostered" } : null;
          })}
          settled={!!weeklyR}
          empty={pos => `no ${pos} scored`} />
      )}
    </>
  );
}

/* ---- the matchup drawer ------------------------------------------------- */

interface SlotSide {
  rid: number; name: string;
  slots: SlotEntry[];
}
interface SlotEntry {
  slot: string; pid: string | null;
  /** the slot's figure: projection pregame, points so far live, points at the final */
  v: number;
  /** his projection, when the figure is a result (live or final) */
  proj?: number;
  /** his game is over (or the week is): the figure is settled */
  over?: boolean;
  /** what the slot is worth right now — points once over, the projection
   *  before kickoff, points so far plus the projection's share of the time
   *  left in between. The edge is quoted on this. */
  est?: number;
  /** settled under the projection. Not a miss while he is still playing. */
  miss?: boolean;
}

/**
 * THE SLOT LABEL, INKED BY POSITION (Max, 2026-09-09). QB / RB / WR / TE take
 * their own color. A flex slot is spelled out in the colors of what it can
 * hold, letter by letter: FLX is F in RB, L in WR, X in TE; SFLX adds S in
 * QB. The one place the board puts a position color on type, and the
 * letters are a legend for it.
 */
function SlotTag({ slot }: { slot: string }) {
  const label = SLOT_LABEL[slot] ?? slot;
  const single = POS_COLOR[slot];
  if (single) return <span className="slot" style={{ color: single }}>{label}</span>;
  const FLEX_INK: Record<string, string[]> = {
    FLX: ["RB", "WR", "TE"],
    SFLX: ["QB", "RB", "WR", "TE"],
  };
  const inks = FLEX_INK[label];
  if (!inks || inks.length !== label.length) return <span className="slot">{label}</span>;
  return (
    <span className="slot">
      {label.split("").map((ch, i) => (
        <span key={i} style={{ color: POS_COLOR[inks[i]] }}>{ch}</span>
      ))}
    </span>
  );
}

/**
 * SLOT BY SLOT: the two lineups side by side, one row per starting slot,
 * the slot's label and the margin between them in the middle. The higher
 * figure takes the accent, so a column of gold down one side IS the read —
 * where each roster is strong, where it is thin. A margin under half a
 * point is a push and takes no side. Pregame the figures are Sleeper's
 * per-week projections; played, they are the points. The foot sums both.
 */
/** a player's NFL game this week, for the line under his name: "vs PHI ·
 *  Sun 1:00 PM" before kickoff, "@ KC · Q3 4:12" during, "vs PHI · Final"
 *  after; "Bye" when the board has no game for his team */
function gameLine(team: string, board: Scoreboard | null): string {
  if (!board) return "";
  const g = board[team];
  if (!g) return "Bye";
  const who = `${g.home ? "vs" : "@"} ${g.opp}`;
  if (g.state !== "pre") return `${who} · ${g.detail || (g.state === "post" ? "Final" : "Live")}`;
  const d = g.date ? new Date(g.date) : null;
  const when = d && !isNaN(d.getTime())
    ? d.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
    : g.detail;
  return `${who} · ${when}`;
}

function SlotDrawer({ a, b, played, live = false, players, board, to }: {
  a: SlotSide; b: SlotSide; played: boolean;
  /** the week in progress: the figures are points so far */
  live?: boolean;
  players: PlayersMin;
  /** the NFL scoreboard, for each man's game under his name */
  board: Scoreboard | null;
  to: string;
}) {
  const PUSH = 0.5;
  const n = Math.max(a.slots.length, b.slots.length);
  const totA = a.slots.reduce((t, x) => t + x.v, 0);
  const totB = b.slots.reduce((t, x) => t + x.v, 0);
  /* THE NAME, HIS CLUB, HIS GAME (Max, 2026-09-10): the club as a tag
     after the name, and under it who he plays and when — the reason a slot
     reads 0.0 is usually "Sun 4:25 PM", and the drawer should say so. */
  const who = (pid: string | null) => {
    if (!pid) return <span className="n1">—</span>;
    const [name, , team] = pInfo(players, pid);
    const gl = gameLine(team, board);
    return (
      <>
        <span className="n1">{name}{team && <span className="tg">{team}</span>}</span>
        {gl && <span className="n2">{gl}</span>}
      </>
    );
  };
  const cell = (x: SlotEntry | undefined, win: boolean, right: boolean) => (
    <div className={`sd-side${right ? " r" : ""}${win ? " win" : ""}`}>
      <span className="nm">{x ? who(x.pid) : "—"}</span>
      <span className="vs">
        {/* the figure goes red once he has settled short of the projection
            under it (Max, 2026-09-10) — the result is what missed */}
        <span className={`v${x?.miss ? " miss" : ""}`}>{x ? fmt(x.v, 1) : DASH}</span>
        {x?.proj != null && <span className="p">{fmt(x.proj, 1)}</span>}
      </span>
    </div>
  );
  // the totals' projections, and whether a side finished short of its own
  const hasProj = a.slots.some(x => x.proj != null) || b.slots.some(x => x.proj != null);
  const projA = a.slots.reduce((t, x) => t + (x.proj ?? 0), 0);
  const projB = b.slots.reduce((t, x) => t + (x.proj ?? 0), 0);
  const settled = (side: SlotSide) => side.slots.every(x => x.pid == null || x.over);
  const missA = hasProj && totA < projA && settled(a);
  const missB = hasProj && totB < projB && settled(b);
  /* THE ARROW IS QUOTED ON WHAT EACH SLOT IS WORTH RIGHT NOW (Max,
     2026-09-10): a man who has played, his points; one who has not, his
     projection; one mid-game, his points so far plus the projection's share
     of the time left. So a 22.4 in the books faces a 15.1 still to come, and
     once both are done the edge is simply who did better. The totals row is
     the sum of the same. */
  const edgeVal = (x: SlotEntry | undefined): number => x?.est ?? x?.v ?? 0;
  const edgeA = a.slots.reduce((t, x) => t + edgeVal(x), 0);
  const edgeB = b.slots.reduce((t, x) => t + edgeVal(x), 0);
  return (
    <div className="lgx-drawer">
      <div className="sd-head">
        <span className="k">{played ? "Slot by slot · final" : live ? "Slot by slot · live" : "Slot by slot · projected"}</span>
        <RouteLink to={to} className="lgx-all">Full matchup →</RouteLink>
      </div>
      {Array.from({ length: n }, (_, i) => {
        const x = a.slots[i], y = b.slots[i];
        const d = edgeVal(x) - edgeVal(y);
        const push = Math.abs(d) < PUSH;
        return (
          <div className="sd-row" key={i}>
            {cell(x, !push && d > 0, false)}
            <div className="sd-mid">
              <SlotTag slot={x?.slot ?? y?.slot ?? ""} />
              {/* the figure holds the center; the arrow sits in its own
                  fixed slot either side of it, so a margin lines up down the
                  column whichever way it points */}
              <span className={`edge${push ? " push" : ""}`}>
                <span className="ar">{!push && d > 0 ? "◂" : ""}</span>
                <span className="n">{push ? "even" : fmt(Math.abs(d), 1)}</span>
                <span className="ar">{!push && d < 0 ? "▸" : ""}</span>
              </span>
            </div>
            {cell(y, !push && d < 0, true)}
          </div>
        );
      })}
      <div className="sd-row sd-tot">
        <div className={`sd-side${edgeA > edgeB ? " win" : ""}`}>
          <span className="nm">{a.name}</span>
          <span className="vs">
            <span className={`v${missA ? " miss" : ""}`}>{fmt(totA, 1)}</span>
            {hasProj && <span className="p">{fmt(projA, 1)}</span>}
          </span>
        </div>
        <div className="sd-mid">
          <span className="slot">Total</span>
          <span className="edge">
            <span className="ar">{edgeA > edgeB ? "◂" : ""}</span>
            <span className="n">{fmt(Math.abs(edgeA - edgeB), 1)}</span>
            <span className="ar">{edgeB > edgeA ? "▸" : ""}</span>
          </span>
        </div>
        <div className={`sd-side r${edgeB > edgeA ? " win" : ""}`}>
          <span className="nm">{b.name}</span>
          <span className="vs">
            <span className={`v${missB ? " miss" : ""}`}>{fmt(totB, 1)}</span>
            {hasProj && <span className="p">{fmt(projB, 1)}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ========================================================================
   STANDINGS — who is winning, with the odds of what comes next
   ======================================================================== */

/**
 * The roster season's actual table (Max, 2026-09-02) — the screen had power
 * rankings, which say who is BEST, and nowhere that said who is WINNING. The
 * league's own order (wins, then points), each row's record with points per
 * game under it, and two odds from the season simulation week_odds.py runs
 * on the same per-week lines: the chance of making the playoffs and of
 * winning the title. Before week 1 every record is 0-0 and the odds are the
 * whole story; as weeks land the record takes over and the odds narrow.
 *
 * The odds are a Monte Carlo over the remaining schedule, seeded the way the
 * league seeds, through a Sleeper bracket that reseeds — not a guess, but a
 * model, and the caption says which. They vanish once the regular season is
 * over because the bracket page then knows more than any simulation.
 */
/** A FUTURES BOOK'S OVERROUND. A title market is one price per team, twelve
 *  of them, and books run the twelve implied probabilities to roughly 125%
 *  rather than the ~102–105% of a two-way line. The same power method as the
 *  matchup fallback spreads it: one exponent k < 1 across every team's fair
 *  probability until the sum hits the target, so the favorite is shaded
 *  less than a flat multiplier would and no long shot goes to zero. */
const FUTURES_BOOK = 1.25;
/** THE LONGEST PRICE A BOARD POSTS (Max, 2026-09-03): +50000, which is what
 *  the books have the Dolphins at to win Super Bowl LXI this season. Every
 *  team gets a price — a side the simulation never saw win is the Dolphins,
 *  not a blank — and a near-certainty is capped at the same figure the other
 *  way. */
const FUTURES_CAP = 50000;
const capMl = (ml: string): string => {
  const n = Number(ml);
  return n > FUTURES_CAP ? `+${FUTURES_CAP}` : n < -FUTURES_CAP ? `-${FUTURES_CAP}` : ml;
};
function futuresLines(fair: Record<string, number>): Record<string, string> {
  const ps = Object.values(fair).filter(p => p > 0);
  if (!ps.length) return Object.fromEntries(Object.keys(fair).map(rid => [rid, `+${FUTURES_CAP}`]));
  let lo = 0.2, hi = 1;
  for (let i = 0; i < 40; i++) {
    const k = (lo + hi) / 2;
    if (ps.reduce((a, p) => a + Math.pow(p, k), 0) > FUTURES_BOOK) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  return Object.fromEntries(Object.entries(fair).map(([rid, p]) =>
    [rid, p > 0 ? capMl(toMl(Math.pow(p, k), 5)) : `+${FUTURES_CAP}`]));
}

function Standings({ rosterSeason }: { rosterSeason: string }) {
  const betaPath = useBetaPath();
  const rows = useStandings(rosterSeason);
  const oddsQ = useJson<WeekOdds>(`${rosterSeason}/odds.json`);
  const sim = oddsQ.data?.season?.teams ?? null;
  /* BEFORE WEEK 1 every row is 0-0 with 0 points and the league's order is
     no order at all — roster id, which says nothing. Until a game has been
     played the table sits in projected-finish order (playoff odds, then title
     odds) and the ordinal is that projection; from week 1 the league's own
     tiebreak takes over and never looks back. */
  const ordered = useMemo(() => {
    if (!rows) return null;
    if (rows.some(r => r.played > 0) || !sim) return rows;
    return rows.slice()
      .sort((a, b) => (sim[String(b.rid)]?.playoff ?? 0) - (sim[String(a.rid)]?.playoff ?? 0)
        || (sim[String(b.rid)]?.title ?? 0) - (sim[String(a.rid)]?.title ?? 0))
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }, [rows, sim]);
  const preseason = !!rows && !rows.some(r => r.played > 0);
  return (
    <>
      <Band label={`Standings · ${rosterSeason}`}
        note={preseason && sim ? "Nothing played yet · in projected-finish order"
          : "Wins, then points · Max PF is the best lineup every week"} />
      {!ordered ? <div className="empty">Loading…</div> : (
        <table className="v3tbl lgx-grid lgx-wrap">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              {/* ONE GRID WITH THE POWER RANKINGS BELOW (Max, 2026-09-02): the
                  last three figure columns sit at 18 / 18 / 20 on every League
                  table, so this table's W-L, Playoff and Title fall exactly
                  under that one's Proj W-L, Starters WAR and Market. PPG is a
                  fourth column on desktop, where there is room for it, and
                  stays on the record's sub-line on a phone. */}
              <th className="n lgx-desk" style={{ width: "14%" }}>W-L</th>
              <th className="n" style={{ width: "18%" }}><span className="lgx-desk">PPG</span><span className="lgx-phone">W-L</span></th>
              {/* PF AND MAX PF (Max, 2026-09-09), in place of the odds, which
                  moved to Power rankings: what the roster scored and what it
                  could have with its best lineup every week. The gap between
                  them is the lineup-setting tax. */}
              <th className="n" style={{ width: "18%" }}>PF</th>
              <th className="n" style={{ width: "20%" }}>Max PF</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((r, i) => {
              const o = sim?.[String(r.rid)];
              return (
                <TapRow key={r.rid} to={betaPath(`/team/${r.rid}`)} className={i % 2 ? "zebra" : ""}>
                  {/* the accent marks the title favorite, the one claim this
                      table makes beyond the order itself */}
                  {/* THE SEED LINE ON THE SPINE (Max, 2026-09-09): seeds 1–2
                      hold a first-round bye and take the accent, 3–6 are in
                      and take --good, the rest are out and take the rule.
                      A six-team, two-bye bracket is this league's shape. */}
                  <Spine rank={r.rank}
                    color={r.rank <= 2 ? "var(--acc)" : r.rank <= 6 ? "var(--good)" : undefined}
                    top={!!sim && !!o && o.title === Math.max(...Object.values(sim).map(x => x.title)) && o.title > 0} />
                  <IdCell name={r.team} sub={r.manager} to={betaPath(`/team/${r.rid}`)} />
                  <td className="n lgx-desk"><span className="f hd">{r.rec}</span></td>
                  <td className="n">
                    <span className="f hd lgx-phone">{r.rec}</span>
                    <span className="f lgx-desk">{r.played ? fmt(r.ppg, 1) : NUL}</span>
                    <div className="idc-s r lgx-phone">{r.played ? `${fmt(r.ppg, 1)} ppg` : "no games"}</div>
                  </td>
                  <td className="n"><span className="f">{r.played ? fmt(r.pf, 1) : NUL}</span></td>
                  <td className="n">
                    <span className="f">{r.played && r.maxPf != null ? fmt(r.maxPf, 1) : NUL}</span>
                    {/* the share of the ceiling the lineups captured */}
                    <div className="idc-s r">
                      {r.played && r.maxPf ? `${Math.round(r.pf / r.maxPf * 100)}%` : ""}
                    </div>
                  </td>
                </TapRow>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

/** One power-rankings row. Everything on it prices the roster season: the
 *  lineup is year-one composite WAR, the record is that lineup run through the
 *  published schedule. Nothing here is a figure from a settled year. */
interface PowerRow {
  rid: number; team: string; manager: string;
  /** best legal lineup summed on YEAR-ONE composite WAR — not the three-year
   *  dynasty total the trade machine carries, because this table is about a
   *  season and that figure is about an asset */
  war: number;
  /** schedule-aware projected wins, and the record they read as. Null — never
   *  a heuristic 7-7 — when no schedule is published. */
  wins: number | null; rec: string | null;
  /** projected points per game: the mean of the team's projected weekly
   *  totals in odds.json (the same lines the matchup cards and the season
   *  simulation price). Null before the odds file has a projected week. */
  ppg: number | null;
}

function CurrentView({ rosterSeason }: { rosterSeason: string }) {
  const { meta, players } = useLeague();
  const betaPath = useBetaPath();
  const phase = useSeasonPhase();

  const teamsQ = useJson<Team[]>(`${rosterSeason}/teams.json`);
  const teams = teamsQ.data;
  const projQ = useJson<ProjectionsFile>("projections.json");
  const proj = projQ.data;
  const mw = useJson<Matchups>(`${rosterSeason}/matchups.json`).data;
  // the per-week lines, for projected points per game on the power table
  const oddsW = useJson<WeekOdds>(`${rosterSeason}/odds.json`).data;
  // this season's WAR so far, for the four position blocks. A 404 before the
  // first scored week is a season that has not started, not a failure.
  const sumNowQ = useJson<SummaryRow[]>(`${rosterSeason}/summary.json`);
  const seasonPos = useMemo(() => {
    const rows = sumNowQ.data;
    if (!rows) return null;
    return POSITIONS.map(pos => {
      const best = rows.filter(r => r[1] === pos && typeof r[6] === "number")
        .sort((a, b) => b[6] - a[6])[0];
      return best && best[6] > 0
        ? { pid: best[0], value: `${fmtWar(best[6])} WAR`,
          note: `${best[2]} game${best[2] === 1 ? "" : "s"} · ${rosterSeason} so far` }
        : null;
    });
  }, [sumNowQ.data, rosterSeason]);
  // the market prices a FORMAT, not a league — global files, global scope
  const valsQ = useJson<Values>("data/values.json", "globalDaily");
  const vals = valsQ.data;
  const dyn = useDynMovers();

  const lineup = lineupOf(meta);
  /* THE ODDS ON THE POWER TABLE (Max, 2026-09-09), moved from Standings:
     playoff and title chances from the season simulation, priced the way a
     book would — a yes/no market at the measured two-way vig for the
     playoffs, a juiced futures board for the title — with the fair
     percentage under each price so the model's own figure is never hidden
     behind the book's. */
  const sim = oddsW?.season?.teams ?? null;
  const vig = useJson<VigModel>("data/vig_model.json").data;
  const titleLines = useMemo(() => sim
    ? futuresLines(Object.fromEntries(Object.entries(sim).map(([rid, o]) => [rid, o.title])))
    : {}, [sim]);
  const pct = (v: number | undefined) =>
    v == null ? NUL : v >= 0.995 ? ">99%" : v < 0.005 && v > 0 ? "<1%" : `${Math.round(v * 100)}%`;

  /**
   * Per-franchise projected strength and record for the roster season.
   *
   * A PORT, not a shared hook: the same derivation lives in views/Home.tsx's
   * `power` memo, and beta/model.ts belongs to another agent this wave. When
   * the two shells reconverge this belongs beside `useTeamValues` — which
   * prices the THREE-YEAR total and so cannot stand in for it.
   *
   * Win probabilities come off the published schedule through the same z-score
   * conversion the standings page uses. Byes are ignored, which is honest for a
   * front-page read and would not be for the model.
   */
  const power = useMemo<PowerRow[] | null>(() => {
    if (!teams || !proj) return null;
    const byPid = new Map(proj.players.map(p => [p.pid, p]));
    const built = teams.map(t => {
      const pool = t.players.map(p => byPid.get(p))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map(p => ({ id: p.pid, pos: p.pos, war: p.composite?.[0] ?? 0 }));
      const starters = optimalLineup(pool, lineup).slots
        .flatMap(s => s.player ? [s.player] : []);
      return {
        rid: t.roster_id, team: t.team, manager: t.manager,
        war: starters.reduce((a, p) => a + p.war, 0),
      };
    });
    const meanWar = mean(built.map(b => b.war));
    const warOf = new Map(built.map(b => [b.rid, b.war]));
    const z = (w: number) => normInv(0.5 + Math.min(0.45, Math.max(-0.45, (w - meanWar) / 13)));
    const ps = mw?.playoff_start || 15;
    const games: Record<number, number[]> = {};
    for (const [wk, pairs] of Object.entries(mw?.schedule ?? {})) {
      if (+wk >= ps) continue;
      for (const [a, b] of pairs) { (games[a] ??= []).push(b); (games[b] ??= []).push(a); }
    }
    // projected ppg: mean projected weekly total across the projected weeks
    const ppgOf = (rid: number): number | null => {
      const mus = Object.values(oddsW?.weeks ?? {})
        .map(w => w[String(rid)]).filter(x => x?.proj && x.mu != null).map(x => x.mu);
      return mus.length ? mean(mus) : null;
    };
    return built.map(b => {
      const opps = games[b.rid] ?? [];
      // NO SCHEDULE, NO RECORD. Home.tsx falls back to a strength-only estimate
      // here; on this screen the projected record is a column of its own, and a
      // fabricated figure in a column is indistinguishable from a real one. So
      // it reads —.
      const ppg = ppgOf(b.rid);
      if (!opps.length) return { ...b, wins: null, rec: null, ppg };
      const wins = opps.reduce((a, o) => a + normCdf(z(b.war) - z(warOf.get(o) ?? meanWar)), 0);
      return { ...b, wins, rec: `${fmt(wins, 1)}-${fmt(opps.length - wins, 1)}`, ppg };
    }).sort((a, b) => b.war - a.war);
  }, [teams, proj, mw, lineup, oddsW]);

  const leader = power?.[0] ?? null;


  /* ---- the three mover modules -------------------------------------------
     Computed in `../movers` and shared with the Movers screen, so the five
     rows here are the head of exactly the list "View all" opens. */
  const mvm = useGapRows(teams);
  const movers = useMarketMovers(vals);

  return (
    <>
      {/* ---- 1. this week / last week ------------------------------------ */}
      <WeekBands rosterSeason={rosterSeason} />

      {/* ---- 1b. standings ----------------------------------------------- */}
      <Standings rosterSeason={rosterSeason} />

      {/* ---- 2. power rankings ------------------------------------------- */}
      <Band label={`Power rankings · ${rosterSeason}`}
        note="Ordered by projected starter WAR · odds from the season simulation"
        right={<ViewAll to={betaPath("/teams")} label="Teams →" />} />
      {/* A FAILED FETCH IS NOT A SLOW ONE. Without the error arm the band
          claims to be loading projections that are never coming, for the life
          of the page. */}
      {teamsQ.error || projQ.error
        ? <DataError what="Power rankings didn't load" />
        : !power ? <div className="empty">Loading projections…</div> : (
        <table className="v3tbl lgx-grid lgx-wrap">
          <thead>
            <tr>
              {/* No header on this table is a control. The band above claims one
                  order and the rank spine keeps it — the same call Home.tsx's
                  power table makes. Re-ranking lives on the rankings board. */}
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              {/* ONE COLUMN GRID for every table on this screen (Max, 2026-09-02):
                  figure columns are 18 / 18 / 20 from the left of the figures,
                  so a three-figure table and a two-figure table put their last
                  two values in the same place and the eye reads down the
                  screen as one board. Declared on the header cells, the fixed
                  layout's authority. */}
              {/* the same grid as Standings above: a desktop-only fourth
                  column, then 18 / 18 / 20. On a phone the projected ppg
                  folds under the projected record, as ppg does under W-L. */}
              <th className="n lgx-desk" style={{ width: "14%" }}>Proj W-L</th>
              <th className="n" style={{ width: "18%" }}><span className="lgx-desk">Proj PPG</span><span className="lgx-phone">Proj W-L</span></th>
              {/* no Starters WAR column (Max, 2026-09-09): the order says
                  it, and the figure itself lives on the Teams board the band
                  links to. The odds take the 18 / 20 slots of the grid. */}
              <th className="n" style={{ width: "18%" }}>Playoff</th>
              <th className="n" style={{ width: "20%" }}>Title</th>
            </tr>
          </thead>
          <tbody>
            {power.map((r, i) => (
              <TapRow key={r.rid} to={betaPath(`/team/${r.rid}`)}
                className={i % 2 ? "zebra" : ""}>
                {/* ONE ACCENT, and the verdict above already spent it on this
                    franchise. The gold ordinal is the same claim in the same
                    color, not a second one; every other spine takes the
                    inactive rule. */}
                <Spine rank={i + 1} top={i === 0} />
                <IdCell name={r.team} sub={r.manager} to={betaPath(`/team/${r.rid}`)} />
                <td className="n lgx-desk"><span className="f">{r.rec ?? NUL}</span></td>
                <td className="n">
                  <span className="f lgx-phone">{r.rec ?? NUL}</span>
                  <span className="f lgx-desk">{r.ppg != null ? fmt(r.ppg, 1) : NUL}</span>
                  {/* "ppg", not "proj ppg": the phone's 18% column is ~60px
                      of text and "152.8 proj ppg" ellipsised at "pr…". The
                      header above it says Proj, so the sub-line needn't. */}
                  <div className="idc-s r lgx-phone">{r.ppg != null ? `${fmt(r.ppg, 1)} ppg` : ""}</div>
                </td>
                {/* the odds, each with its fair percentage under the price */}
                {(() => {
                  const o = sim?.[String(r.rid)];
                  return (
                    <>
                      <td className="n">
                        <span className="f">{o ? capMl(lines(o.playoff, vig, 5)[0]) : NUL}</span>
                        <div className="idc-s r">{o ? pct(o.playoff) : ""}</div>
                      </td>
                      <td className="n">
                        <span className="f">{o ? titleLines[String(r.rid)] ?? NUL : NUL}</span>
                        <div className="idc-s r">{o ? pct(o.title) : ""}</div>
                      </td>
                    </>
                  );
                })()}
              </TapRow>
            ))}
          </tbody>
        </table>
      )}

      {/* ---- 2b. the season's four positions (Max, 2026-09-08) --------------
          Most WAR at each position THIS season, off the roster season's own
          summary — the same blocks the all-time view shows for careers, so a
          reader watches the year's leaders grow and change hands week to week.
          Before week one the summary is empty and every block reads —. */}
      <Band label={`Top performers · ${rosterSeason}`}
        note="Most WAR at each position this season, regular season only · updates weekly" />
      <PosLeaders
        leaders={seasonPos}
        settled={sumNowQ.data != null || sumNowQ.error}
        empty={pos => `no ${pos} scored yet`} />

      {/* ---- 3. what moved -----------------------------------------------
          Shared with the Team screen (`../moved`), which renders the same
          module filtered to one franchise (Max, 2026-09-08). */}
      <Moved />

      {/* ---- 4. win now vs dynasty --------------------------------------- */}
      <Band label="Win now vs dynasty" note="CVI prices this season, DVI the horizon"
        right={<ViewAll to={betaPath("/movers/value")} />} />
      {teamsQ.error
        ? <DataError what="Rosters didn't load" />
        : !mvm ? <div className="empty">Loading…</div>
        : <GapTable rows={mvm} limit={MODULE_ROWS} />}

      {/* ---- 5. dynasty movers ------------------------------------------- */}
      <Band label="Dynasty movers" note={dynNote(dyn)}
        right={<ViewAll to={betaPath("/movers/dynasty")} />} />
      {!dyn ? <div className="empty">Waiting on the trade-corpus refresh…</div>
        : <DynTable dyn={dyn} limit={MODULE_ROWS} />}

      {/* ---- 6. market movers -------------------------------------------- */}
      <Band label="Market movers" note={`${marketNote(movers)} · ${MODULE_MIN_VALUE.toLocaleString()}+ value`}
        right={<ViewAll to={betaPath("/movers/market")} />} />
      {valsQ.error
        ? <DataError what="Market didn't load" />
        : !movers ? <div className="empty">Waiting on the nightly market pull…</div>
        : <MarketTable movers={movers} limit={MODULE_ROWS} minValue={MODULE_MIN_VALUE} />}

      {/* the freshness line, kept when the paragraph around it went (Max,
          2026-09-02): when the market was fetched and when the board was
          built are the two dates a reader needs to trust a figure */}
      <div className="tnote screen">
        Market fetched {vals?.fetched ?? meta.updated} · board built {meta.updated}.
      </div>
    </>
  );
}

/* ========================================================================
   HISTORY — one settled season
   ======================================================================== */

/**
 * A season that has finished.
 *
 * NO MARKET PRICE ANYWHERE UNDER A RESULTS BAND, and no roster-season figure of
 * any kind. What a player would fetch today is a fact about 2026; putting it
 * beside a 2023 result invites the reader to grade the past against a price
 * that did not exist yet. Even the identity sub-lines obey it — a player's NFL
 * club comes from players_min, which is CURRENT, so the sub-line here names the
 * fantasy franchise that held him at that season's end instead.
 */
/* ========================================================================
   ALL-TIME — every season at once
   ======================================================================== */

/** one franchise's whole record */
interface AllTimeRow {
  rid: number; team: string; manager: string;
  /** franchises.json key — what the honor index is filed under */
  fkey: string;
  seasons: number; wins: number; losses: number; ties: number;
  fpts: number; ppg: number;
  /** Max PF summed over the seasons that carry it; null when none does */
  ppts: number | null;
  /** mean playoff-inclusive finish over the seasons that have one, and the
   *  best of them */
  avgFinish: number | null;
  bestFinish: number | null;
  titles: number;
  /** seasons finished as a top-2 seed — a first-round bye */
  byes: number;
}

/** one player's career in this league */
/**
 * THE FOUR POSITION LEADERS as a row of blocks — QB · RB · WR · TE in the
 * lineup's order (Max, 2026-09-08). All-time feeds it career WAR; Current
 * feeds it the roster season's WAR so far, so the same four blocks grow and
 * change hands week by week. The spine carries the position colour, as it
 * does on every row of the site; the name stays in primary ink.
 *
 * `leaders` is null until the source has loaded (blank blocks, not dashes —
 * a dash is a claim); a null entry once it has is a position with nobody
 * scored yet, and reads `empty(pos)`.
 */
function PosLeaders({ leaders, settled, empty }: {
  /** per position, in POSITIONS order: the player, his headline figure
   *  already formatted with its unit ("2.31 WAR", "48.6 pts"), and a note */
  leaders: ({ pid: string; value: string; note: string } | null)[] | null;
  settled: boolean;
  empty: (pos: string) => string;
}) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  return (
    <div className="lgx-pos4">
      {POSITIONS.map((pos, i) => {
        const row = leaders?.[i] ?? null;
        return (
          <div className="lgx-mvp" key={pos}
            style={{ "--pos-c": POS_COLOR[pos] ?? "var(--rule-2)" } as CSSProperties}>
            <span className="lgx-posspine" />
            <div className="k">Top {pos}</div>
            {row
              ? <RouteLink to={betaPath(`/player/${row.pid}`)} className="nm">
                  {pInfo(players, row.pid)[0]}
                </RouteLink>
              : <span className="nm">{settled ? DASH : "\u00a0"}</span>}
            <div className="sub">
              {row ? `${row.value} · ${row.note}` : settled ? empty(pos) : "\u00a0"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface CareerRow {
  pid: string; pos: string; gp: number; pts: number; war: number; seasons: number;
  /** first and last league season he scored in — the years, not a count */
  first: string; last: string;
  /** his best single season's WAR, and which season it was */
  best: number; bestSeason: string;
}

/** a player's record in the games he STARTED, regular season and elimination
 *  playoff games apart. A win is the franchise's win that week; he was in the
 *  lineup, so it is on his line. */
interface StarterRecord {
  w: number; l: number; t: number;
  pw: number; pl: number; pt: number;
  /** his points in elimination games while starting, and how many weeks
   *  that is — bracket.json `stars`, cut to the same games as the record */
  ppts: number; pg: number;
}

/**
 * Every franchise's record across the league's life, and the career WAR
 * leaders (Max, 2026-09-02). franchises.json already carries each franchise's
 * per-season line, so the table is a sum; the leaders need every played
 * season's summary.json, fetched together once.
 *
 * ORDERED BY WIN PERCENTAGE, then points — the tiebreak the league seeds on,
 * over a career. Average finish is the mean of the seasons that HAVE a finish
 * (a season without one is not a mid-table finish, it is no finish), and the
 * franchise's name and manager are its most recent, since that is who the
 * reader will look for.
 */
function AllTimeView({ played }: { played: string[] }) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const frQ = useJson<Franchises>("franchises.json");
  const fr = frQ.data;
  // titles, top seeds, points crowns, playoff trips — the marks the Team page
  // shows, beside each franchise's name in the standings (desktop only)
  const honorIdx = useTeamHonors(played);

  const rows = useMemo<AllTimeRow[] | null>(() => {
    if (!fr) return null;
    const out: AllTimeRow[] = [];
    for (const [key, f] of Object.entries(fr)) {
      const ss = f.seasons.filter(x => played.includes(x.season) && (x.wins + x.losses + x.ties > 0));
      if (!ss.length) continue;
      // named as it is TODAY: the newest entry of all, roster season included,
      // not the newest played one — a franchise renamed this offseason should
      // be found under the name on its door
      const last = f.seasons.slice().sort((a, b) => b.season.localeCompare(a.season))[0];
      const fins = ss.map(x => x.finish).filter((x): x is number => x != null);
      const wins = ss.reduce((a, x) => a + x.wins, 0);
      const losses = ss.reduce((a, x) => a + x.losses, 0);
      const ties = ss.reduce((a, x) => a + x.ties, 0);
      const fpts = ss.reduce((a, x) => a + x.fpts, 0);
      // Max PF over the seasons Sleeper priced a best lineup for — a partial
      // sum is still the right denominator for the share, per season
      const withMax = ss.filter(x => x.ppts != null);
      const ppts = withMax.length ? withMax.reduce((a, x) => a + (x.ppts as number), 0) : null;
      const games = wins + losses + ties;
      out.push({
        rid: last.rid ?? Number(key), team: last.name, manager: last.manager, fkey: key,
        seasons: ss.length, wins, losses, ties, fpts, ppts,
        ppg: games ? fpts / games : 0,
        avgFinish: fins.length ? mean(fins) : null,
        bestFinish: fins.length ? Math.min(...fins) : null,
        titles: fins.filter(x => x === 1).length,
        byes: ss.filter(x => x.seed != null && x.seed <= 2).length,
      });
    }
    const pct = (r: AllTimeRow) => (r.wins + r.ties / 2) / Math.max(1, r.wins + r.losses + r.ties);
    return out.sort((a, b) => pct(b) - pct(a) || b.fpts - a.fpts);
  }, [fr, played]);

  /* every played season's summary, together. Not useJson: the hook count would
     follow the season count, and four small files in one Promise.all is what
     the classic board's All-time mode does anyway. */
  const [sums, setSums] = useState<Record<string, SummaryRow[]> | null | "error">(null);
  useEffect(() => {
    let dead = false;
    Promise.all(played.map(s => jl<SummaryRow[]>(`${s}/summary.json`).then(r => [s, r] as const)))
      .then(all => { if (!dead) setSums(Object.fromEntries(all)); })
      .catch(() => { if (!dead) setSums("error"); });
    return () => { dead = true; };
  }, [played]);

  /* every played season's bracket, for the postseason ledger. Missing files
     are a season without a scored bracket, not an error — the star is summed
     over whatever exists. */
  const [brs, setBrs] = useState<Record<string, BracketFile | null> | null>(null);
  useEffect(() => {
    let dead = false;
    Promise.all(played.map(s =>
      jl<BracketFile>(`${s}/bracket.json`).catch(() => null).then(b => [s, b] as const)))
      .then(all => { if (!dead) setBrs(Object.fromEntries(all)); });
    return () => { dead = true; };
  }, [played]);

  /* every played season's matchups, for the starters' records — who was in
     the lineup each week, and whether the franchise won it */
  const [mws, setMws] = useState<Record<string, Matchups | null> | null>(null);
  useEffect(() => {
    let dead = false;
    Promise.all(played.map(s =>
      jl<Matchups>(`${s}/matchups.json`).catch(() => null).then(m => [s, m] as const)))
      .then(all => { if (!dead) setMws(Object.fromEntries(all)); });
    return () => { dead = true; };
  }, [played]);

  /* ---- W-L as a starter (Max, 2026-09-09) --------------------------------
     Per player, every week he was in a starting lineup: the franchise's result
     that week goes on his line. Regular season is every week before the
     playoffs. Playoff games are ELIMINATION games only — the bracket file says
     which winners-bracket game a franchise played each week, and placement
     games (`p` set, other than the title game at p=1) and the consolation
     bracket are left out, the same cut the franchise ledger below makes. A
     season without a bracket file adds no playoff games; the regular season
     still counts. */
  const starts = useMemo<Record<string, StarterRecord> | null>(() => {
    if (!mws || !brs) return null;
    const acc: Record<string, StarterRecord> = {};
    const at = (pid: string) =>
      (acc[pid] ??= { w: 0, l: 0, t: 0, pw: 0, pl: 0, pt: 0, ppts: 0, pg: 0 });
    for (const s of played) {
      const mw = mws[s];
      if (!mw) continue;
      const br = brs[s];
      // franchise -> the weeks it played an elimination game
      const elim = new Map<number, Set<number>>();
      for (const g of br?.winners ?? []) {
        if (g.p != null && g.p !== 1) continue;
        for (const rid of [g.t1, g.t2]) {
          if (rid == null) continue;
          (elim.get(rid) ?? elim.set(rid, new Set()).get(rid)!).add(g.week);
        }
      }
      // his playoff points: every elimination week he started, off `stars`
      for (const [pid, st] of Object.entries(br?.stars ?? {})) {
        const weeks = elim.get(st.rid);
        if (!weeks) continue;
        for (const [wk, pts] of Object.entries(st.wk)) {
          if (!weeks.has(Number(wk))) continue;
          const r = at(pid); r.ppts += pts; r.pg++;
        }
      }
      for (const [ridS, entries] of Object.entries(mw.teams)) {
        const rid = Number(ridS);
        for (const [week, pts, , opp, starters] of entries) {
          if (opp == null || !starters?.length) continue;
          const post = week >= mw.playoff_start;
          if (post && !elim.get(rid)?.has(week)) continue;
          const res: "w" | "l" | "t" = pts > opp ? "w" : pts < opp ? "l" : "t";
          for (const pid of starters) {
            if (!pid || pid === "0") continue;
            const r = at(pid);
            if (post) r[`p${res}`]++; else r[res]++;
          }
        }
      }
    }
    return acc;
  }, [mws, brs, played]);

  /* ---- the postseason ledger (Max, 2026-09-09) ---------------------------
     Per franchise, across every scored bracket: appearances (took the field
     in a winners-bracket game — a bye still plays in round two), the record
     in ELIMINATION games (placement games decide 3rd and 5th, not a title,
     and are left out), and titles (the championship game's winner). Ordered
     by titles, then playoff wins, then appearances. Byes (top-2 seeds, so a
     first-round pass) come off the season rows, not the bracket. */
  const playoffs = useMemo(() => {
    if (!brs || !rows) return null;
    const acc = new Map<number, { apps: number; w: number; l: number; titles: number; pts: number; g: number }>();
    const at = (rid: number) => {
      let r = acc.get(rid);
      if (!r) { r = { apps: 0, w: 0, l: 0, titles: 0, pts: 0, g: 0 }; acc.set(rid, r); }
      return r;
    };
    for (const br of Object.values(brs)) {
      if (!br) continue;
      const seen = new Set<number>();
      for (const g of br.winners) {
        for (const t of [g.t1, g.t2]) if (t != null && !seen.has(t)) { seen.add(t); at(t).apps++; }
        const elim = g.p == null || g.p === 1;
        if (!elim || g.w == null || g.l == null) continue;
        at(g.w).w++; at(g.l).l++;
        if (g.p === 1) at(g.w).titles++;
        // points per playoff game, elimination games only, both sides
        if (g.t1 != null && g.t1_pts != null) { at(g.t1).pts += g.t1_pts; at(g.t1).g++; }
        if (g.t2 != null && g.t2_pts != null) { at(g.t2).pts += g.t2_pts; at(g.t2).g++; }
      }
    }
    return rows
      .map(r => ({ ...r, po: acc.get(r.rid) ?? { apps: 0, w: 0, l: 0, titles: 0, pts: 0, g: 0 } }))
      .sort((a, b) => b.po.titles - a.po.titles || b.po.w - a.po.w || b.po.apps - a.po.apps || a.team.localeCompare(b.team));
  }, [brs, rows]);


  /**
   * THE PLAYOFF STAR (Max, 2026-09-08): most postseason WIN SHARES across
   * every bracket — each elimination game hands out exactly 1.0 to the winning
   * side (playoff_wpa.py `ws`), so this is wins in the bracket, credited by
   * how much of each win was his. Raw shares rather than the round-weighted
   * or season-scaled scores, because a career total wants a unit that adds
   * across years: a win in 2022 is a win in 2025.
   */
  const star = useMemo(() => {
    if (!brs) return null;
    const acc = new Map<string, { pid: string; ws: number; runs: number }>();
    for (const b of Object.values(brs)) {
      for (const [pid, w] of Object.entries(b?.wpa ?? {})) {
        if (w.ws == null) continue;
        const c = acc.get(pid) ?? { pid, ws: 0, runs: 0 };
        c.ws += w.ws; c.runs += 1;
        acc.set(pid, c);
      }
    }
    // NO FRANCHISE on a career mark (Max, 2026-09-08): the shares were earned
    // across postseasons and often across rosters, and naming one of them
    // credits it with the rest. The season view's MVP names his team because
    // there it is one season, one roster.
    return [...acc.values()].sort((a, b) => b.ws - a.ws)[0] ?? null;
  }, [brs]);

  /** every player's career line, WAR descending — the leaders table is its
   *  head, the position blocks its per-position heads */
  const careers = useMemo<CareerRow[] | null>(() => {
    if (!sums || sums === "error") return null;
    const acc = new Map<string, CareerRow>();
    // oldest first, so the position on the row is the most recent season's
    for (const s of played.slice().reverse()) {
      for (const r of sums[s] ?? []) {
        const c = acc.get(r[0]) ?? {
          pid: r[0], pos: r[1], gp: 0, pts: 0, war: 0, seasons: 0, first: s, last: s,
          best: -Infinity, bestSeason: s,
        };
        c.pos = r[1]; c.gp += r[2]; c.pts += r[3]; c.war += r[6]; c.seasons += 1; c.last = s;
        if (r[6] > c.best) { c.best = r[6]; c.bestSeason = s; }
        acc.set(r[0], c);
      }
    }
    return [...acc.values()].sort((a, b) => b.war - a.war);
  }, [sums, played]);
  const leaders = useMemo(() => careers?.slice(0, 15) ?? null, [careers]);

  /** THE POSITION LEADERS (Max, 2026-09-08): most career WAR at each of the
   *  four positions, in the lineup's own order. Off the full career list, not
   *  the fifteen-row table — a position's best can sit well outside it. */
  const posLeaders = useMemo(() => {
    if (!careers) return null;
    return POSITIONS.map(pos => ({ pos, row: careers.find(c => c.pos === pos) ?? null }));
  }, [careers]);

  const span = played.length ? `${played[played.length - 1]}–${played[0]}` : "";

  /** THE BIG DOG: most career WAR across every league season — the head of
   *  the career leaders table below, lifted to the top so the all-time view
   *  opens on its two players the way a season opens on its champion. */
  const bigDog = leaders?.[0] ?? null;

  return (
    <>
      {/* the symbol sheet the honor marks draw from — once per view */}
      <HonorSprite />
      {/* ---- the two career marks (Max, 2026-09-08) --------------------------
          The season view's MVP pair, at career scale: WAR over every regular
          season, win shares over every bracket. Same blocks, same ink; the
          accent stays on the title-holders' ordinals in the standings below. */}
      <div className="lgx-mvps">
        <div className="lgx-mvp">
          <div className="k">The Big Dog</div>
          {bigDog
            ? <RouteLink to={betaPath(`/player/${bigDog.pid}`)} className="nm">
                {pInfo(players, bigDog.pid)[0]}
              </RouteLink>
            : <span className="nm">{sums === "error" ? DASH : "\u00a0"}</span>}
          <div className="sub">
            {bigDog
              ? `${fmtWar(bigDog.war)} career WAR · ${bigDog.seasons} season${bigDog.seasons === 1 ? "" : "s"} · ${bigDog.pos}`
              : sums === "error" ? "career WAR didn't load" : "\u00a0"}
          </div>
        </div>
        <div className="lgx-mvp">
          <div className="k">Playoff Star</div>
          {star
            ? <RouteLink to={betaPath(`/player/${star.pid}`)} className="nm">
                {pInfo(players, star.pid)[0]}
              </RouteLink>
            : <span className="nm">{brs ? DASH : "\u00a0"}</span>}
          <div className="sub">
            {star
              ? `${fmt(star.ws, 1)} playoff win shares · ${star.runs} postseason${star.runs === 1 ? "" : "s"} · ${pInfo(players, star.pid)[1]}`
              : brs ? "no scored brackets" : "\u00a0"}
          </div>
        </div>
      </div>

      {/* ---- the four positions ------------------------------------------
          Most career WAR at each, QB · RB · WR · TE in the lineup's order. */}
      <Band label="Top performers · all-time"
        note="Most career WAR at each position across every league season" />
      <PosLeaders
        leaders={posLeaders?.map(x => x.row && ({ pid: x.row.pid, value: `${fmtWar(x.row.war)} WAR`,
          note: `${x.row.seasons} season${x.row.seasons === 1 ? "" : "s"} · ${x.row.gp} games` })) ?? null}
        settled={!!careers} empty={pos => `no ${pos} scored`} />

      <Band label="All-time standings"
        note={`${span} · regular season · ordered by win percentage, then points`} />
      {frQ.error ? <DataError what="Franchise history didn't load" />
        : !rows ? <div className="empty">Loading…</div> : (
        <table className="v3tbl lgx-grid lgx-wrap">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              <th className="n" style={{ width: "18%" }}>W-L</th>
              <th className="n" style={{ width: "18%" }}>Points</th>
              <th className="n" style={{ width: "20%" }}>Avg finish</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <TapRow key={r.rid} to={betaPath(`/team/${r.rid}`)} className={i % 2 ? "zebra" : ""}>
                {/* the accent marks titles won, in the one place the screen
                    spends it: the ordinal of every franchise with a ring */}
                <Spine rank={i + 1} top={r.titles > 0} />
                {/* the sub-line is the manager and nothing else (Max, 2026-09-09):
                    franchises are not split at owner changes, so a season count
                    was the same on every row, and the honor marks beside the
                    name say what each franchise won — "N titles" repeated the
                    trophy. The phone keeps the gold spine for a ring. */}
                <IdCell name={r.team} to={betaPath(`/team/${r.rid}`)}
                  mark={(() => {
                    const m = teamHonorTotals(franchiseHonors(honorIdx, r.fkey));
                    return m.length ? <TeamHonorMarks marks={m} size={15} /> : null;
                  })()}
                  sub={r.manager} />
                <td className="n">
                  <span className="f hd">{r.wins}-{r.losses}{r.ties ? `-${r.ties}` : ""}</span>
                  <div className="idc-s r">{fmt(r.ppg, 1)} ppg</div>
                </td>
                <td className="n">
                  <span className="f">{Math.round(r.fpts).toLocaleString()}</span>
                  {/* Max PF under the points (Max, 2026-09-09): the ceiling the
                      lineups were chasing, blank until the data carries it */}
                  <div className="idc-s r">
                    {r.ppts ? `${Math.round(r.ppts).toLocaleString()} max` : ""}
                  </div>
                </td>
                <td className="n">
                  <span className="f">{r.avgFinish == null ? NUL : fmt(r.avgFinish, 1)}</span>
                  {/* the best of those finishes under the mean (Max, 2026-09-09) */}
                  <div className="idc-s r">
                    {r.bestFinish == null ? "" : `best ${ord(r.bestFinish)}`}
                  </div>
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}

      <Band label="Playoffs · all-time"
        note={`${span} · elimination games only · byes are top-2 seeds · titles, then playoff wins`} />
      {!brs ? <div className="empty">Loading…</div>
        : !playoffs ? <div className="empty">Loading…</div>
        : !Object.values(brs).some(Boolean) ? <div className="empty">No scored brackets yet.</div> : (
        <table className="v3tbl lgx-grid lgx-wrap">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              {/* the full word (Max, 2026-09-09); wider so it fits a phone */}
              <th className="n" style={{ width: "24%" }}>Appearances</th>
              <th className="n" style={{ width: "18%" }}>W-L</th>
              <th className="n" style={{ width: "20%" }}>Titles</th>
            </tr>
          </thead>
          <tbody>
            {playoffs.map((r, i) => (
              <TapRow key={r.rid} to={betaPath(`/team/${r.rid}`)} className={i % 2 ? "zebra" : ""}>
                <Spine rank={i + 1} top={r.po.titles > 0} />
                {/* the sub-line is the manager, as in the standings above — a
                    season count was the same on every row */}
                <IdCell name={r.team} to={betaPath(`/team/${r.rid}`)} sub={r.manager} />
                <td className="n">
                  <span className="f">{r.po.apps || NUL}</span>
                  {/* first-round byes under the appearances (Max, 2026-09-09) */}
                  <div className="idc-s r">{r.byes ? `${r.byes} bye${r.byes === 1 ? "" : "s"}` : ""}</div>
                </td>
                <td className="n">
                  <span className="f hd">{r.po.apps ? `${r.po.w}-${r.po.l}` : NUL}</span>
                  <div className="idc-s r">{r.po.g ? `${fmt(r.po.pts / r.po.g, 1)} ppg` : ""}</div>
                </td>
                <td className="n">
                  <span className={`f${r.po.titles ? " acc" : ""}`}>{r.po.titles || NUL}</span>
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}

      <Band label="Career WAR leaders"
        note="Regular-season WAR on this league's own scoring, summed over every season · W-L and ppg in the games he started" />
      {sums === "error" ? <DataError what="Career WAR didn't load" />
        : !leaders ? <div className="empty">Loading…</div> : (
        <table className="v3tbl lgx-grid">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className="n" style={{ width: "22%" }}>Regular season</th>
              <th className="n" style={{ width: "18%" }}>Playoffs</th>
              <th className="n" style={{ width: "20%" }}>WAR</th>
            </tr>
          </thead>
          <tbody>
            {leaders.map((r, i) => {
              const sr = starts?.[r.pid];
              // the record cells stay blank, not em-dashed, until the matchups
              // land: "no games" is a claim the fetch in flight cannot make
              const rec = (w: number, l: number, t: number) =>
                w + l + t ? `${w}-${l}${t ? `-${t}` : ""}` : NUL;
              return (
                <TapRow key={r.pid} to={betaPath(`/player/${r.pid}`)} className={i % 2 ? "zebra" : ""}>
                  <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                  {/* the years he was in the league, not a count of them
                      (Max, 2026-09-09): "2022–2025" places a career; "4
                      seasons" does not */}
                  <IdCell name={pInfo(players, r.pid)[0]} to={betaPath(`/player/${r.pid}`)}
                    sub={`${r.pos} · ${r.first === r.last ? r.first : `${r.first}–${r.last}`}`} />
                  {/* the record over his points per start (Max, 2026-09-09) —
                      the same W-L-over-ppg cell the standings use */}
                  <td className="n">
                    <span className="f">{starts ? rec(sr?.w ?? 0, sr?.l ?? 0, sr?.t ?? 0) : ""}</span>
                    <div className="idc-s r">{r.gp ? `${fmt(r.pts / r.gp, 1)} ppg` : ""}</div>
                  </td>
                  <td className="n">
                    <span className="f">{starts ? rec(sr?.pw ?? 0, sr?.pl ?? 0, sr?.pt ?? 0) : ""}</span>
                    <div className="idc-s r">{sr?.pg ? `${fmt(sr.ppts / sr.pg, 1)} ppg` : ""}</div>
                  </td>
                  <td className="n">
                    <span className="f hd">{fmtWar(r.war)}</span>
                    {/* his best single season under the career total (Max, 2026-09-09) */}
                    <div className="idc-s r">{`${fmtWar(r.best)} · ${r.bestSeason}`}</div>
                  </td>
                </TapRow>
              );
            })}
          </tbody>
        </table>
      )}

    </>
  );
}

function HistoryView({ season }: { season: string }) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const rows = useStandings(season);
  /* the QUERY, not just its data: an em dash is a claim ("there is no such
     figure") and a fetch in flight is not entitled to make it, so the champion
     block waits on `loading` rather than on `data`. A 404 settles loading to
     false with `error` set — a season with results but no bracket file then
     falls through to franchises.json below, which is the right behavior. */
  const brq = useJson<BracketFile>(`${season}/bracket.json`);
  const br = brq.data;
  const fr = useJson<Franchises>("franchises.json").data;
  const sumQ = useJson<SummaryRow[]>(`${season}/summary.json`);
  const sum = sumQ.data;
  /* already fetched by useStandings — same path, so the cache serves it, and
     its `error` therefore doubles as the standings' error: useStandings builds
     `rows` from this file and that season's matchups, so a null `rows` with
     this query failed is a failure rather than a wait. */
  const teamsQ = useJson<Team[]>(`${season}/teams.json`);
  const teams = teamsQ.data;
  // the draft that stocked this season, off the same file and the same model
  // the Drafts screen reads — one board, two screens
  const drafts = useJson<Drafts>("drafts.json").data;
  const draftHist = useMemo(() => (drafts ? buildHistory(drafts, fr) : null), [drafts, fr]);
  const draftRows = draftHist?.rowsBy[season];
  const draftKind = draftHist?.kindOf[season];
  // the season's week-by-week record — team scores from matchups, player
  // scores from weekly (regular season; WAR is only scored there), and the
  // bracket's own `stars` for the postseason player line
  const mws = useJson<Matchups>(`${season}/matchups.json`).data;
  const wkly = useJson<Weekly>(`${season}/weekly.json`).data;
  const best = useMemo(() => {
    const ps = mws?.playoff_start ?? 15;
    let teamWeek: { rid: number; week: number; pts: number } | null = null;
    for (const [rid, list] of Object.entries(mws?.teams ?? {})) {
      for (const e of list) {
        if (e[0] >= ps || e[1] == null) continue;
        if (!teamWeek || e[1] > teamWeek.pts) teamWeek = { rid: Number(rid), week: e[0], pts: e[1] };
      }
    }
    let playerWeek: { pid: string; week: number; pts: number } | null = null;
    for (const [pid, list] of Object.entries(wkly ?? {})) {
      for (const w of list) {
        if (w[0] >= ps) continue;
        if (!playerWeek || w[1] > playerWeek.pts) playerWeek = { pid, week: w[0], pts: w[1] };
      }
    }
    // the bracket: winners' rounds only — a consolation game is not a playoff
    // performance, and `stars` is already scoped to the winners' weeks
    let playoffTeam: { rid: number; week: number; pts: number } | null = null;
    for (const g of br?.winners ?? []) {
      for (const [rid, pts] of [[g.t1, g.t1_pts], [g.t2, g.t2_pts]] as [number | null, number | null][]) {
        if (rid == null || pts == null) continue;
        if (!playoffTeam || pts > playoffTeam.pts) playoffTeam = { rid, week: g.week, pts };
      }
    }
    let playoffPlayer: { pid: string; week: number; pts: number } | null = null;
    for (const [pid, st] of Object.entries(br?.stars ?? {})) {
      for (const [wk, pts] of Object.entries(st.wk)) {
        if (!playoffPlayer || pts > playoffPlayer.pts) playoffPlayer = { pid, week: Number(wk), pts };
      }
    }
    return { teamWeek, playerWeek, playoffTeam, playoffPlayer };
  }, [mws, wkly, br]);

  /** the title game, and which of its two point totals belongs to the winner */
  const title = useMemo(() => {
    const g = br?.winners.find(x => x.p === 1);
    if (!g || g.w == null) return null;
    const first = g.t1 === g.w;
    return {
      rid: g.w, loser: g.l, week: g.week,
      pts: first ? g.t1_pts : g.t2_pts,
      oppPts: first ? g.t2_pts : g.t1_pts,
    };
  }, [br]);

  /** the champion where no bracket file exists. franchises.json records the
   *  finish independently, so a season with results but no bracket still names
   *  a winner rather than rendering an empty block. */
  const fallback = useMemo(() => {
    if (!fr) return null;
    for (const [rid, f] of Object.entries(fr)) {
      const s = f.seasons.find(x => x.season === season);
      if (s?.finish === 1) return { rid: Number(rid), name: s.name };
    }
    return null;
  }, [fr, season]);

  const champRid = title?.rid ?? fallback?.rid ?? null;
  const champ = rows?.find(r => r.rid === champRid) ?? null;
  const champName = champ?.team
    ?? (champRid != null ? br?.names[String(champRid)] : null)
    ?? fallback?.name ?? null;

  const finishOf = (rid: number) =>
    fr?.[String(rid)]?.seasons.find(s => s.season === season)?.finish ?? null;

  /* THE SEASON'S FOUR SUPERLATIVES (Max, 2026-09-08), in place of the
     champion's own seed / record / median / title-game line — which repeated
     the standings row two bands down. These are facts about the YEAR, not
     the winner: the biggest week any team put up, the biggest single game any
     player had, and the same two inside the bracket.

     DASH, NOT NUL. `Strip` renders `.v3strip .cell` divs and beta.css scopes
     `.nul` to `.v3tbl td`, so a NUL in here is an unstyled em dash sitting at
     figure weight in primary ink — a missing figure shouting louder than the
     ones that exist. DASH is the same glyph in decorative ink, defined at the
     top of this file for exactly this. */
  const teamName = (rid: number) =>
    rows?.find(r => r.rid === rid)?.team ?? br?.names[String(rid)] ?? `Roster ${rid}`;
  const figures: Figure[] = [
    { key: "bestwk", label: "Best week",
      value: best.teamWeek ? fmt(best.teamWeek.pts, 1) : DASH,
      sub: best.teamWeek ? `${teamName(best.teamWeek.rid)} · wk ${best.teamWeek.week}` : "regular season · team",
      to: best.teamWeek ? betaPath(`/seasons/${season}/${best.teamWeek.week}`) : undefined },
    { key: "bestgm", label: "Best game",
      value: best.playerWeek ? fmt(best.playerWeek.pts, 1) : DASH,
      sub: best.playerWeek ? `${pInfo(players, best.playerWeek.pid)[0]} · wk ${best.playerWeek.week}` : "regular season · player",
      to: best.playerWeek ? betaPath(`/player/${best.playerWeek.pid}`) : undefined },
    { key: "bestpo", label: "Best playoff game",
      value: best.playoffPlayer ? fmt(best.playoffPlayer.pts, 1) : DASH,
      sub: best.playoffPlayer ? `${pInfo(players, best.playoffPlayer.pid)[0]} · wk ${best.playoffPlayer.week}` : "bracket · player",
      to: best.playoffPlayer ? betaPath(`/player/${best.playoffPlayer.pid}`) : undefined },
    { key: "bestpot", label: "Best playoff week",
      value: best.playoffTeam ? fmt(best.playoffTeam.pts, 1) : DASH,
      sub: best.playoffTeam ? `${teamName(best.playoffTeam.rid)} · wk ${best.playoffTeam.week}` : "bracket · team",
      to: best.playoffTeam ? betaPath(`/seasons/${season}/${best.playoffTeam.week}`) : undefined },
  ];

  /** the season's WAR leaders. Position and games come from that season's own
   *  summary row, so both are facts about the year on screen. */
  const leaders = useMemo(() => {
    if (!sum) return null;
    const owner: Record<string, string> = {};
    for (const t of teams ?? []) for (const p of t.players) owner[p] = t.team;
    return sum.slice()
      .sort((a, b) => b[6] - a[6])
      .slice(0, 10)
      .map(r => ({ pid: r[0], pos: r[1], gp: r[2], war: r[6], team: owner[r[0]] ?? null }));
  }, [sum, teams]);

  /** THE TWO MVPs (Max, 2026-09-08). SEASON: most regular-season WAR in the
   *  league — the same fact the player honors call `mvp`, off the same summary
   *  row, so the crown on his page and the name here cannot disagree. PLAYOFF:
   *  the bracket's own MVP score (playoff_wpa.py — win probability added
   *  across the elimination games, round-weighted, 100 = that year's best
   *  run), so the winner is whoever the file scores 100. Each carries his
   *  franchise from that season, not today's. */
  const seasonMvp = leaders?.[0] ?? null;
  const playoffMvp = useMemo(() => {
    if (!br?.wpa) return null;
    let best: { pid: string; mvp: number; mvpp: number | null; rid: number } | null = null;
    for (const [pid, w] of Object.entries(br.wpa)) {
      if (w.mvp == null) continue;
      if (!best || w.mvp > best.mvp) best = { pid, mvp: w.mvp, mvpp: w.mvpp ?? null, rid: w.rid };
    }
    return best;
  }, [br]);

  return (
    <>
      {/* ---- the champion -------------------------------------------------
          Gated on the fetch, not on the data: an em dash is a claim, and a
          champion block full of them while the files are still in flight makes
          a claim the screen is about to contradict. */}
      {teamsQ.error ? <DataError what={`${season} didn't load`} />
        : !rows || brq.loading ? <div className="empty">Loading {season}…</div> : <>
        <div className="lgx-champ">
          <div className="k">{season} champion</div>
          {champName && champRid != null
            ? <RouteLink to={betaPath(`/team/${champRid}`)} className="nm">{champName}</RouteLink>
            : <span className="nm">{DASH}</span>}
          {/* the non-breaking space is load-bearing, the same way it is in
              ui.tsx's identity sub-line: a manager-less block would collapse
              to zero height and the name above it would jump */}
          <div className="sub">{champ?.manager ?? " "}</div>
        </div>
        {/* THE SEASON'S TWO PLAYERS, beside each other under the champion
            (Max, 2026-09-08). Neither takes the accent — the title already
            spent it — and the two are different questions: a regular season
            of WAR against three weeks of the bracket. A block with nothing to
            name reads — rather than dropping out, so the row keeps its shape
            year to year. */}
        <div className="lgx-mvps">
          <div className="lgx-mvp">
            <div className="k">Season MVP</div>
            {seasonMvp
              ? <RouteLink to={betaPath(`/player/${seasonMvp.pid}`)} className="nm">
                  {pInfo(players, seasonMvp.pid)[0]}
                </RouteLink>
              : <span className="nm">{DASH}</span>}
            <div className="sub">
              {seasonMvp
                ? `${fmtWar(seasonMvp.war)} WAR · ${[seasonMvp.pos, seasonMvp.team].filter(Boolean).join(" · ")}`
                : "no scored season"}
            </div>
          </div>
          <div className="lgx-mvp">
            <div className="k">Playoff MVP</div>
            {playoffMvp
              ? <RouteLink to={betaPath(`/player/${playoffMvp.pid}`)} className="nm">
                  {pInfo(players, playoffMvp.pid)[0]}
                </RouteLink>
              : <span className="nm">{DASH}</span>}
            <div className="sub">
              {playoffMvp
                ? [
                  playoffMvp.mvpp != null ? `MVP index ${Math.round(playoffMvp.mvpp)}` : null,
                  pInfo(players, playoffMvp.pid)[1],
                  br?.names[String(playoffMvp.rid)] ?? null,
                ].filter(Boolean).join(" · ")
                : "no bracket scoring"}
            </div>
          </div>
        </div>
        <Strip figures={figures} />
      </>}

      {/* ---- final standings ---------------------------------------------- */}
      <Band label={`${season} final standings`}
        note="# is the playoff seed — regular-season record, then points" />
      {teamsQ.error ? <DataError what={`${season} standings didn't load`} />
        : !rows ? <div className="empty">Loading {season}…</div> : (
        <table className="v3tbl lgx-grid lgx-wrap">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              <th className="n" style={{ width: "18%" }}>W-L</th>
              <th className="n" style={{ width: "18%" }}>PPG</th>
              <th className="n" style={{ width: "20%" }}>Finish</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const fin = finishOf(r.rid);
              return (
                <TapRow key={r.rid} to={betaPath(`/team/${r.rid}`)}
                  className={i % 2 ? "zebra" : ""}>
                  {/* ONE ACCENT, and the champion block above spent it. The
                      gold ordinal marks the same franchise rather than a second
                      one — which is also why this table carries no playoff
                      cutline rule: the Finish column already states who played
                      on, and a gold rule under 6th would be a second claim in
                      the same color. */}
                  <Spine rank={r.rank} top={r.rid === champRid} />
                  <IdCell name={r.team} sub={r.manager} to={betaPath(`/team/${r.rid}`)} />
                  <td className="n"><span className="f hd">{r.rec}</span></td>
                  <td className="n"><span className="f">{r.played ? fmt(r.ppg, 1) : NUL}</span></td>
                  <td className="n">
                    <span className={`f${fin === 1 ? " acc" : ""}`}>{fin ? ord(fin) : NUL}</span>
                  </td>
                </TapRow>
              );
            })}
          </tbody>
        </table>
      )}

      {/* ---- WAR leaders --------------------------------------------------- */}
      <Band label={`${season} WAR leaders`}
        note="Wins above replacement on this league's own scoring · regular season" />
      {sumQ.error ? <DataError what={`${season} WAR leaders didn't load`} />
        : !leaders ? <div className="empty">Loading {season}…</div> : (
        <table className="v3tbl lgx-grid">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className="n" style={{ width: "18%" }}>GP</th>
              <th className="n" style={{ width: "20%" }}>WAR</th>
            </tr>
          </thead>
          <tbody>
            {leaders.map((r, i) => (
              <TapRow key={r.pid} to={betaPath(`/player/${r.pid}`)}
                className={i % 2 ? "zebra" : ""}>
                <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                <IdCell name={pInfo(players, r.pid)[0]}
                  sub={[r.team, r.pos].filter(Boolean).join(" · ")}
                  to={betaPath(`/player/${r.pid}`)} />
                <td className="n"><span className="f q">{r.gp}</span></td>
                <td className="n">
                  {/* no meter — see the power-rankings table */}
                  <span className="f hd">{fmtWar(r.war)}</span>
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}

      {/* ---- the bracket (Max, 2026-09-08) --------------------------------
          The season's playoff tree, as the Seasons screen draws it — every
          game a head-to-head card, placement games under the tree in the
          column of the week they were played. The same component, so the two
          screens cannot disagree about a score. A season with no bracket file
          (unplayed, or predating the writer) simply has no band. */}
      {br && br.winners.length > 0 && (
        <>
          <Band label={`${season} playoffs`}
            note={`Winners' bracket from week ${br.playoff_start} · tap a game for that week`} />
          <PlayoffBracket season={season} bracket={br} />
        </>
      )}

      {/* ---- the draft board (Max, 2026-09-08) ----------------------------
          The draft that stocked this season — the rookie draft of its
          offseason, or the startup for the league's first year — as the
          Sleeper-style board the Drafts screen draws: rounds down, slots
          across, cells tinted by position. Rendered from drafts.json through
          the same `buildHistory` the Drafts screen uses, so the board here IS
          that board. Traded picks say who used them. */}
      {draftRows && draftRows.length > 0 && (
        <>
          <Band label={`${season} ${draftKind === "rookie" ? "rookie draft" : "startup draft"}`}
            note={`${draftRows.length} picks · columns are the original holders of each first-round pick · a cell names the franchise that made the pick when it was not theirs`}
            right={<ViewAll to={betaPath(`/drafts/history/${season}`)} />} />
          <DraftBoardGrid rows={draftRows} />
        </>
      )}

      <div className="tnote screen">
        Every figure on this screen is {season}'s own. No market price appears anywhere under
        a result: what a player would fetch today is a fact about this year, not about that
        one, and the two do not belong on the same page. The franchise beside a player is
        whoever held him when {season} ended — rosters move mid-season and the file records
        the last state, not each week's.
      </div>
    </>
  );
}
