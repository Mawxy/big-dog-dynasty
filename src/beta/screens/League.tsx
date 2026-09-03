import { Fragment, useEffect, useMemo, useState } from "react";
import type {
  BracketFile, DynastyMovers, Franchises, Matchups, ProjectionsFile,
  SummaryRow, Team, Trade, TradesPayload, Values, WeekOdds, Weekly,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useCvi, useDvi } from "../../lib/useIndices";
import { jl } from "../../lib/data";
import { useLeague } from "../../lib/context";
import { fmt, mean, normCdf, normInv, ord, sgn } from "../../lib/stats";
import {
  POS_COLOR, latestSeasonOf, lineupOf, optimalLineup, pInfo, rosterSeasonOf,
} from "../../lib/league";
import { ktcOf } from "../../lib/values";
import { readTrades, tradeWhen } from "../../lib/trades";
import { RouteLink } from "../../components/RouteLink";
import { useActivity, useSeasonPhase, useStandings, type ActMove } from "../model";
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

/** rows per half of a split module — five is what fits under a band without
 *  the second half starting off-screen */
const MODULE_ROWS = 5;

/** the "what moved" window, in days. A week, because that is the cadence a
 *  reader checks a league on. The band's LABEL changes with the season; the
 *  window never does. */
const WINDOW_DAYS = 7;



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
function WeekBands({ rosterSeason }: { rosterSeason: string }) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
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

  const nameOf = (list: Team[] | null | undefined, rid: number) =>
    list?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;

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
    return {
      wk, played,
      games: pairs.map(([a, b]) => ({
        a: { rid: a, wp: line[String(a)]?.wp ?? null, mu: line[String(a)]?.mu ?? null, pts: scored.get(a)?.pts ?? null },
        b: { rid: b, wp: line[String(b)]?.wp ?? null, mu: line[String(b)]?.mu ?? null, pts: scored.get(b)?.pts ?? null },
      })),
    };
  }, [mwQ.data, oddsQ.data, phase.week]);

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
    // THE WEEK'S WAR LEADER, among players who were STARTED — a bench 40 is
    // a fact about a bench, not about the week
    const startedBy = new Map<string, number>();
    for (const r of rows) for (const pid of r.starters) if (pid && pid !== "0") startedBy.set(pid, r.rid);
    let best: { pid: string; war: number; rid: number } | null = null;
    if (weeklyR) {
      for (const [pid, wrows] of Object.entries(weeklyR)) {
        const rid = startedBy.get(pid);
        if (rid == null) continue;
        const w = wrows.find(x => x[0] === wk);
        if (w && (!best || w[5] > best.war)) best = { pid, war: w[5], rid };
      }
    }
    return { wk, top, low, upset, upsetWp: upset ? line[String(upset.rid)].wp! : null, best };
  }, [mwR, oddsR, weeklyR]);

  const seasonsRoute = (season: string, wk: number) => betaPath(`/seasons/${season}/${wk}`);
  const twSeason = rosterSeason;
  const lwSeason = resultSeason;

  return (
    <>
      <Band label={thisWeek ? `This week · ${twSeason} wk ${thisWeek.wk}` : "This week"}
        note={thisWeek?.played ? "Final" : "Pregame line · projected total"} />
      {mwQ.error ? <DataError what="Schedule didn't load" />
        : !thisWeek ? <div className="empty">{mwQ.loading ? "Loading…" : "No week scheduled."}</div> : (
        <div className="lgx-games">
          {thisWeek.games.map(g => {
            const aWon = g.a.pts != null && g.b.pts != null && g.a.pts > g.b.pts;
            const bWon = g.a.pts != null && g.b.pts != null && g.b.pts > g.a.pts;
            const side = (x: typeof g.a, won: boolean, right: boolean) => (
              <div className={`side${right ? " r" : ""}${won ? " won" : ""}`}>
                <div className="nm">{nameOf(teams, x.rid)}</div>
                <div className="fig">
                  {x.pts != null ? fmt(x.pts, 1)
                    : x.wp != null ? `${Math.round(x.wp * 100)}%` : DASH}
                </div>
                <div className="sub">
                  {x.pts != null ? (won ? "won" : "") : x.mu != null ? `proj ${fmt(x.mu, 1)}` : ""}
                </div>
              </div>
            );
            return (
              <RouteLink key={`${g.a.rid}-${g.b.rid}`} className="lgx-game"
                to={seasonsRoute(twSeason, thisWeek.wk)}>
                {side(g.a, aWon, false)}
                <div className="vs">{thisWeek.played ? "" : "vs"}</div>
                {side(g.b, bWon, true)}
              </RouteLink>
            );
          })}
        </div>
      )}

      <Band label={lastWeek ? `Last week · ${lwSeason} wk ${lastWeek.wk}` : "Last week"}
        note="Regular season" />
      {!lastWeek ? <div className="empty">{mwR ? "No week played yet." : "Loading…"}</div> : (
        <Strip figures={[
          { key: "top", label: "Top score", value: fmt(lastWeek.top.pts, 1),
            sub: nameOf(teamsR, lastWeek.top.rid), to: seasonsRoute(lwSeason, lastWeek.wk) },
          { key: "low", label: "Low score", value: fmt(lastWeek.low.pts, 1),
            sub: nameOf(teamsR, lastWeek.low.rid), to: seasonsRoute(lwSeason, lastWeek.wk) },
          { key: "upset", label: "Upset",
            value: lastWeek.upset && lastWeek.upsetWp != null ? `${Math.round(lastWeek.upsetWp * 100)}%` : DASH,
            sub: lastWeek.upset
              ? `${nameOf(teamsR, lastWeek.upset.rid)} beat ${lastWeek.upset.opp != null ? nameOf(teamsR, lastWeek.upset.opp) : "—"}`
              : "no winner beat the line",
            to: seasonsRoute(lwSeason, lastWeek.wk) },
          { key: "war", label: "WAR leader",
            value: lastWeek.best ? fmtWar(lastWeek.best.war) : DASH, acc: !!lastWeek.best,
            sub: lastWeek.best
              ? `${pInfo(players, lastWeek.best.pid)[0]} · ${nameOf(teamsR, lastWeek.best.rid)}`
              : (weeklyR ? "no starter scored" : "loading…"),
            to: lastWeek.best ? betaPath(`/player/${lastWeek.best.pid}`) : undefined },
        ]} />
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
}

/** one win-now-vs-dynasty row: the two indices and the gap between them */
interface GapRow {
  pid: string; name: string; pos: string; nfl: string;
  dvi: number; cvi: number; gap: number;
}

/** how deep into the startable universe a value play may sit — the classic
 *  board's VALUE_PLAY_DEPTH, restated so the two shells qualify the same way */
const VALUE_PLAY_DEPTH = 100;

/** one market-mover row */
interface MoverRow {
  pid: string; name: string; pos: string; nfl: string; price: number; d: number;
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
  const tradesFile = useJson<TradesPayload>("trades.json").data;
  // the market prices a FORMAT, not a league — global files, global scope
  const valsQ = useJson<Values>("data/values.json", "globalDaily");
  const vals = valsQ.data;
  const dyn = useJson<DynastyMovers>("data/dynasty_movers.json", "globalDaily").data;
  /* The window is a span of TIME and useActivity's argument is a row count, so
     it is asked for far more rows than it will show and then filtered by
     timestamp. 400 covers seven days with years of slack — this league's whole
     transaction history is about 1,650 rows. */
  const acts = useActivity(400);

  const lineup = lineupOf(meta);

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
    return built.map(b => {
      const opps = games[b.rid] ?? [];
      // NO SCHEDULE, NO RECORD. Home.tsx falls back to a strength-only estimate
      // here; on this screen the projected record is a column of its own, and a
      // fabricated figure in a column is indistinguishable from a real one. So
      // it reads —.
      if (!opps.length) return { ...b, wins: null, rec: null };
      const wins = opps.reduce((a, o) => a + normCdf(z(b.war) - z(warOf.get(o) ?? meanWar)), 0);
      return { ...b, wins, rec: `${fmt(wins, 1)}-${fmt(opps.length - wins, 1)}` };
    }).sort((a, b) => b.war - a.war);
  }, [teams, proj, mw, lineup]);

  const leader = power?.[0] ?? null;


  /* ---- the last seven days -------------------------------------------- */

  /** the window's opening edge, fixed for the life of the mount so the memo
   *  below is not recomputed on every render by a moving `Date.now()` */
  const since = useMemo(() => Date.now() - WINDOW_DAYS * 86400000, []);

  const trades = useMemo<Trade[]>(
    () => (tradesFile ? readTrades(tradesFile).trades : []), [tradesFile]);

  const recent = useMemo(() => {
    const inWindow = trades.filter(t => t.ts >= since && t.sides.length >= 2);
    /* BIGGEST BY WHAT. trades.json prices a side three ways and all three are
       frozen at the trade: `expThen` (projected WAR), `mktThen` (KTC) and
       `fcThen`. Market points are the only one most sides carry and the only
       one whose magnitude compares across deals, so "biggest" is the largest
       side's at-trade market price.

       A MAX over sides rather than a sum, and the reason is no longer that a
       pick-only side is unpriced — the snapshot has priced picks at their
       mid-tier ladder key since 2026-08-21. It is that the two sides of a deal
       are two readings of ONE size, not two halves of it: summing them would
       rank a trade above an identical one where the picks went the other way,
       and one priced side is enough to size a deal where the other still
       carries an asset the history cannot reach. */
    const size = (t: Trade) => Math.max(0, ...t.sides.map(s => s.mktThen ?? 0));
    const biggest = inWindow.length
      ? inWindow.slice().sort((a, b) => size(b) - size(a) || b.ts - a.ts)[0]
      : null;
    const moves = (acts ?? [])
      .filter((a): a is ActMove => a.kind === "move" && a.ts >= since);
    return {
      trades: inWindow.length, biggest, moves,
      // whether the "biggest" claim is actually sized by anything, or whether
      // every side of every trade in the window is unpriced
      sized: biggest ? size(biggest) > 0 : false,
    };
  }, [trades, acts, since]);

  const [openMoves, setOpenMoves] = useState(false);

  /* ---- win now vs dynasty ------------------------------------------------ */

  /**
   * WHO IS A WIN-NOW PLAYER AND WHO IS A DYNASTY PLAYER (Max, 2026-09-02): the
   * largest disagreements between our two indices, among rostered players.
   * CVI prices the coming season and DVI the dynasty horizon, so a player far
   * above his DVI on CVI is worth more to a contender than a rebuilder, and
   * the reverse is a stash. This band used to compare the model's WAR to the
   * market's implied WAR — a fact about the market, not about the roster —
   * which was the wrong question for the League screen.
   *
   * The classic board's value-plays rules, restated so the two shells qualify
   * the same population: a WIN-NOW row needs a CVI rank inside the startable
   * top 100 (or the gap is only age); a DYNASTY row needs a DVI rank inside
   * it and a redraft ECR rank, so a player known to give nothing this year
   * does not read as a stash. Gap is CVI minus DVI, signed, in index points.
   */
  const dvi = useDvi();
  const cvi = useCvi();
  const mvm = useMemo(() => {
    if (!dvi || !cvi || !teams) return null;
    const owned = new Set(teams.flatMap(t => t.players));
    const rows: (GapRow & { dRank: number; cRank: number; ecr?: number })[] = [];
    for (const [pid, dr] of Object.entries(dvi.players)) {
      const cr = cvi.players[pid];
      const info = players[pid];
      if (!cr || !info || !owned.has(pid)) continue;
      rows.push({
        pid, name: info[0], pos: dr.pos, nfl: info[2],
        dvi: dr.dvi, cvi: cr.cvi, gap: cr.cvi - dr.dvi,
        dRank: dr.rank, cRank: cr.rank, ecr: cr.ecr,
      });
    }
    rows.sort((a, b) => b.gap - a.gap);
    return {
      now: rows.filter(r => r.gap > 0 && r.cRank <= VALUE_PLAY_DEPTH).slice(0, MODULE_ROWS),
      later: rows.filter(r => r.gap < 0 && r.ecr != null && r.dRank <= VALUE_PLAY_DEPTH)
        .slice(-MODULE_ROWS).reverse(),
    };
  }, [dvi, cvi, teams, players]);

  /* ---- market movers ---------------------------------------------------- */

  /** KeepTradeCut's seven-day change. The VALUE is priced in this league's
   *  TE-premium column through `ktcOf`; the TREND stays the base feed's,
   *  because KTC publishes no per-tier trends — direction and magnitude read
   *  the same either way. */
  const movers = useMemo(() => {
    if (!vals) return null;
    const rows: MoverRow[] = [];
    for (const [pid, v] of Object.entries(vals.players)) {
      const info = players[pid];
      const price = ktcOf(v, meta.tep);
      const d = v.ktcT?.["7"];
      if (!info || price == null || d == null || d === 0) continue;
      rows.push({ pid, name: info[0], pos: info[1], nfl: info[2], price, d });
    }
    rows.sort((a, b) => b.d - a.d);
    return {
      up: rows.filter(r => r.d > 0).slice(0, MODULE_ROWS),
      down: rows.filter(r => r.d < 0).slice(-MODULE_ROWS).reverse(),
    };
  }, [vals, players, meta.tep]);

  const windowFrom = new Date(since)
    .toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <>
      {/* ---- 1. this week / last week ------------------------------------ */}
      <WeekBands rosterSeason={rosterSeason} />

      {/* ---- 2. power rankings ------------------------------------------- */}
      <Band label={`Power rankings · ${rosterSeason}`}
        note="Projected starter WAR — the best legal lineup, not the lineup as set" />
      {/* A FAILED FETCH IS NOT A SLOW ONE. Without the error arm the band
          claims to be loading projections that are never coming, for the life
          of the page. */}
      {teamsQ.error || projQ.error
        ? <DataError what="Power rankings didn't load" />
        : !power ? <div className="empty">Loading projections…</div> : (
        <table className="v3tbl lgx-grid">
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
              <th className="n" style={{ width: "18%" }}>Move</th>
              <th className="n" style={{ width: "18%" }}>Proj rec</th>
              <th className="n" style={{ width: "20%" }}>Starters WAR</th>
            </tr>
          </thead>
          <tbody>
            {power.map((r, i) => (
              <TapRow key={r.rid} to={betaPath(`/team/${r.rid}`)}
                className={i % 2 ? "zebra" : ""}>
                {/* ONE ACCENT, and the verdict above already spent it on this
                    franchise. The gold ordinal is the same claim in the same
                    colour, not a second one; every other spine takes the
                    inactive rule. */}
                <Spine rank={i + 1} top={i === 0} />
                <IdCell name={r.team} sub={r.manager} to={betaPath(`/team/${r.rid}`)} />
                {/* MOVE IS UNKNOWN, NOT ZERO, and not an invented arrow. The
                    pipeline publishes no prior ranking to difference against:
                    dvi.json, cvi.json and index_models.json each hold one
                    night's figures with no history, values_history.json is
                    per-player market price and nothing else, and no script in
                    scripts/ writes a franchise ordinal over time. So every row
                    reads —, and the caption under the table says why. */}
                <td className="n">{NUL}</td>
                <td className="n"><span className="f">{r.rec ?? NUL}</span></td>
                <td className="n">
                  {/* NO METER (Max, 2026-09-02): the WAR bar that filled with
                      the figure read as a dashboard gauge on this board, not a
                      statistic. The sort column is the headline weight and
                      the ordinal spine carries the order. */}
                  <span className="f hd">{fmtWar(r.war)}</span>
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}

      {/* ---- 3. what moved ----------------------------------------------- */}
      <Band label={phase.offseason ? `Last ${WINDOW_DAYS} days` : "Since Sunday"}
        note={`Trades and roster moves since ${windowFrom}`} />
      {recent.biggest ? <BigTrade trade={recent.biggest} sized={recent.sized} /> : (
        /* A QUIET BAND, not an empty table. A week with no trades in it is a
           fact about the league, and a header over twelve pixels of nothing is
           the wrong way to state it. */
        <div className="lgx-quiet">
          No trades in the last {WINDOW_DAYS} days.{" "}
          {recent.moves.length
            ? `${recent.moves.length} roster move${recent.moves.length === 1 ? "" : "s"} went through — the count below opens them.`
            : "Nothing went through at all, which is a fact about the league rather than a gap in the data."}
        </div>
      )}
      <div className="lgx-counts">
        <div className="lgx-count">
          <span className="k">Trades</span>
          <span className="v">{recent.trades}</span>
          {/* the league ledger: every trade this league has ever made, scored */}
          <RouteLink to={betaPath("/trade?scope=history")} className="go">All →</RouteLink>
        </div>
        <div className="lgx-count">
          <span className="k">Roster moves</span>
          <span className="v">{recent.moves.length}</span>
          {/* Opens IN PLACE rather than linking out. Waivers and free agents
              have no destination of their own in this shell — the League screen
              is where they have always been shown — and a link to a page that
              does not exist is worse than a disclosure that does. */}
          {recent.moves.length > 0 && (
            <button type="button" className="go" aria-expanded={openMoves}
              onClick={() => setOpenMoves(v => !v)}>
              {openMoves ? "Close ▴" : "All ▾"}
            </button>
          )}
        </div>
      </div>
      {openMoves && (
        <div className="v3-feed">
          {recent.moves.map(a => (
            /* the ACTIVITY'S OWN ID, not ts+team. Sleeper batch-processes
               waivers, so a whole Wednesday's claims share one timestamp to the
               millisecond and one franchise can hold several of them — the old
               key collided and React silently dropped every row after the first
               of each collision, which read as moves that never happened. */
            <div className="v3-act" key={a.id}>
              <div className="when">
                <span>{tradeWhen(a.ts)}</span>
                <span>{a.waiver ? "Waiver" : "Free agent"}</span>
              </div>
              <div className="v3-wv">
                <span className="add"><span className="k">Add</span>{a.adds.join(", ") || "—"}</span>
                <span className="drop"><span className="k">Drop</span>{a.drops.join(", ") || "—"}</span>
              </div>
              <div className="idc-s lgx-who">{a.team}</div>
            </div>
          ))}
        </div>
      )}

      {/* ---- 4. win now vs dynasty --------------------------------------- */}
      <Band label="Win now vs dynasty" note="CVI prices this season, DVI the horizon" />
      {teamsQ.error
        ? <DataError what="Rosters didn't load" />
        : !mvm ? <div className="empty">Loading…</div> : (
        <table className="v3tbl lgx-grid">
          {/* THE GROUP LABEL IS THE HEADER ROW (Max, 2026-09-02). A column header
              row above a group band above the rows put a strip of nothing
              between "Value" and the first value. Each group now opens with
              one row that is both: the label and its note sit in the identity
              column's header cell, the figure headers repeat beside it, and
              the values start on the next line. The first group's row is the
              table's first row, which is what the fixed layout takes its
              column widths from — so it carries the width hints, and it holds
              no colspan. */}
            {([
              ["Win now", mvm.now],
              ["Dynasty", mvm.later],
            ] as const).map(([label, list]) => (
              <tbody key={label}>
                <tr className="lgx-cols">
                  <th className="c sp">#</th>
                  <th className="t"><span className="k">{label}</span></th>
                  <th className="n" style={{ width: "18%" }}>DVI</th>
                  <th className="n" style={{ width: "18%" }}>CVI</th>
                  <th className="n" style={{ width: "20%" }}>Gap</th>
                </tr>
                {list.map((r, i) => (
                  <TapRow key={r.pid} to={betaPath(`/player/${r.pid}`)}
                    className={i % 2 ? "zebra" : ""}>
                    <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                    <IdCell name={r.name}
                      sub={[r.nfl || null, r.pos].filter(Boolean).join(" · ")}
                      to={betaPath(`/player/${r.pid}`)} />
                    <td className="n"><span className="f">{fmt(r.dvi, 1)}</span></td>
                    <td className="n"><span className="f">{fmt(r.cvi, 1)}</span></td>
                    {/* the sign is the whole claim, and `.f.up` / `.f.down` are
                        the tokens the board already spends on a signed figure.
                        Legal here and nowhere near a trade ledger: a gap is a
                        direction of travel, not a verdict about who won. */}
                    <td className="n">
                      <span className={`f hd ${r.gap > 0 ? "up" : "down"}`}>{sgn(r.gap, 1)}</span>
                    </td>
                  </TapRow>
                ))}
              </tbody>
            ))}
        </table>
      )}

      {/* ---- 5. dynasty movers ------------------------------------------- */}
      <Band label="Dynasty movers"
        note={dyn
          ? `Last ${dyn.meta.window_days} days, ${dyn.meta.leagues?.toLocaleString() ?? "—"} leagues`
          : undefined} />
      {!dyn ? <div className="empty">Waiting on the trade-corpus refresh…</div> : (
        <table className="v3tbl lgx-grid">
          {/* THE GROUP LABEL IS THE HEADER ROW (Max, 2026-09-02). A column header
              row above a group band above the rows put a strip of nothing
              between "Value" and the first value. Each group now opens with
              one row that is both: the label and its note sit in the identity
              column's header cell, the figure headers repeat beside it, and
              the values start on the next line. The first group's row is the
              table's first row, which is what the fixed layout takes its
              column widths from — so it carries the width hints, and it holds
              no colspan. */}
            {([
              ["Going over value", dyn.overpaid],
              ["Going under value", dyn.underpaid],
            ] as const).map(([label, list]) => (
              <tbody key={label}>
                <tr className="lgx-cols">
                  <th className="c sp">#</th>
                  <th className="t"><span className="k">{label}</span></th>
                  <th className="n" style={{ width: "18%" }}>Value</th>
                  <th className="n" style={{ width: "18%" }}>Paid</th>
                  <th className="n" style={{ width: "20%" }}>Δ</th>
                </tr>
                {list.slice(0, MODULE_ROWS).map((r, i) => (
                  <TapRow key={`${label}${r.pid}`} to={betaPath(`/player/${r.pid}`)}
                    className={i % 2 ? "zebra" : ""}>
                    <Spine rank={i + 1} color={r.pos ? POS_COLOR[r.pos] : undefined} />
                    <IdCell name={r.name}
                      sub={[r.team, r.pos, `${r.n} trades`].filter(Boolean).join(" · ")}
                      to={betaPath(`/player/${r.pid}`)} />
                    {/* Value and Paid on the same ramp (Max, 2026-09-02): the
                        KTC value was on the quiet ramp to let Paid lead, and it
                        read as a smaller number rather than a quieter one. The
                        Δ column is the headline; these two are its inputs. */}
                    <td className="n"><span className="f">{r.value.toLocaleString()}</span></td>
                    <td className="n"><span className="f">{r.avg_paid.toLocaleString()}</span></td>
                    <td className="n">
                      <span className={`f hd ${r.avg_delta > 0 ? "up" : "down"}`}>
                        {r.avg_pct == null ? NUL : `${sgn(r.avg_pct, 0)}%`}
                      </span>
                    </td>
                  </TapRow>
                ))}
              </tbody>
            ))}
        </table>
      )}

      {/* ---- 6. market movers -------------------------------------------- */}
      <Band label="Market movers" note="KeepTradeCut, 7-day change in points" />
      {valsQ.error
        ? <DataError what="Market didn't load" />
        : !movers ? <div className="empty">Waiting on the nightly market pull…</div> : (
        <table className="v3tbl lgx-grid">
          {/* THE GROUP LABEL IS THE HEADER ROW (Max, 2026-09-02). A column header
              row above a group band above the rows put a strip of nothing
              between "Value" and the first value. Each group now opens with
              one row that is both: the label and its note sit in the identity
              column's header cell, the figure headers repeat beside it, and
              the values start on the next line. The first group's row is the
              table's first row, which is what the fixed layout takes its
              column widths from — so it carries the width hints, and it holds
              no colspan. */}
            {([
              ["Rising", movers.up],
              ["Falling", movers.down],
            ] as const).map(([label, list]) => (
              <tbody key={label}>
                <tr className="lgx-cols">
                  <th className="c sp">#</th>
                  <th className="t"><span className="k">{label}</span></th>
                  <th className="n" style={{ width: "18%" }}>Value</th>
                  <th className="n" style={{ width: "20%" }}>7d</th>
                </tr>
                {list.map((r, i) => (
                  <TapRow key={`${label}${r.pid}`} to={betaPath(`/player/${r.pid}`)}
                    className={i % 2 ? "zebra" : ""}>
                    <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                    <IdCell name={r.name}
                      sub={[r.nfl || null, r.pos].filter(Boolean).join(" · ")}
                      to={betaPath(`/player/${r.pid}`)} />
                    <td className="n"><span className="f">{r.price.toLocaleString()}</span></td>
                    <td className="n">
                      <span className={`f hd ${r.d > 0 ? "up" : "down"}`}>{sgn(r.d, 0)}</span>
                    </td>
                  </TapRow>
                ))}
              </tbody>
            ))}
        </table>
      )}

      {/* the freshness line, kept when the paragraph around it went (Max,
          2026-09-02): when the market was fetched and when the board was
          built are the two dates a reader needs to trust a figure */}
      <div className="tnote screen">
        Market fetched {vals?.fetched ?? meta.updated} · board built {meta.updated}.
      </div>
    </>
  );
}

/* ---- the window's biggest trade ------------------------------------------ */

/**
 * One trade, two neutral baskets.
 *
 * BOTH SIDES ARE NAMED and each lists what it GETS — the two-basket comparison
 * (SKILL §5) — and both take the same ink. Colouring one side would declare a
 * winner, which is exactly what the ledger refuses to declare.
 *
 * WHAT THE FIGURES ARE, AND WHY THEY ARE NOT INDICES. The plan asked for a
 * per-side DVI/CVI swing and the pipeline does not publish one: trades.json
 * carries `war`, `future`, `total`, plus the frozen-at-the-trade `expThen`
 * (projected WAR), `mktThen` (KTC) and `fcThen`, and no index at any level.
 * Summing today's DVI over a side would be worse than absent — a pick has a
 * price and a WAR stream but NO index, so a package containing one silently
 * values it at zero, and the side of the most recent trade here took two 2027
 * picks and would have read 0.0. So the card shows the two frozen figures the
 * file does publish, labelled "then" so they cannot be read as today's price.
 */
function BigTrade({ trade, sized }: { trade: Trade; sized: boolean }) {
  const betaPath = useBetaPath();
  return (
    <a className="v3-act lgx-trade" href={`#${betaPath(`/trade?load=${trade.ts}`)}`}>
      <div className="when">
        {/* the DATE, not "season · week": in the offseason every trade carries
            week 1, and a card headed "2026 · WK 1" in August names a week that
            has not happened */}
        <span>{tradeWhen(trade.ts)}</span>
        <span>{sized ? "Biggest trade" : "Latest trade"}</span>
        {/* `?load=<ts>` opens this deal's own row in the ledger — the Trade
            screen consumes the param, flips itself to the history scope and
            drops it. It is NOT the builder any more: the builder draws from
            current rosters, so the label says where the tap lands. */}
        <span className="go">Ledger →</span>
      </div>
      <div className="v3-baskets">
        {trade.sides.map(s => (
          <div className="bk" key={s.rid}>
            <div className="who">{s.team} gets</div>
            {s.got.map((g, j) => (
              <div className={`it${g.kind !== "player" ? " pick" : ""}`} key={j}>{g.label}</div>
            ))}
            <div className="lgx-bkfig">
              <span className="k">Proj WAR then</span>
              <span className="v">{s.expThen != null ? fmtWar(s.expThen) : DASH}</span>
            </div>
            <div className="lgx-bkfig">
              <span className="k">KTC then</span>
              <span className="v">{s.mktThen != null ? s.mktThen.toLocaleString() : DASH}</span>
            </div>
          </div>
        ))}
      </div>
    </a>
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
  seasons: number; wins: number; losses: number; ties: number;
  fpts: number; ppg: number;
  /** mean playoff-inclusive finish over the seasons that have one */
  avgFinish: number | null;
  titles: number;
}

/** one player's career in this league */
interface CareerRow { pid: string; pos: string; gp: number; war: number; seasons: number }

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
      const games = wins + losses + ties;
      out.push({
        rid: last.rid ?? Number(key), team: last.name, manager: last.manager,
        seasons: ss.length, wins, losses, ties, fpts,
        ppg: games ? fpts / games : 0,
        avgFinish: fins.length ? mean(fins) : null,
        titles: fins.filter(x => x === 1).length,
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

  const leaders = useMemo<CareerRow[] | null>(() => {
    if (!sums || sums === "error") return null;
    const acc = new Map<string, CareerRow>();
    // oldest first, so the position on the row is the most recent season's
    for (const s of played.slice().reverse()) {
      for (const r of sums[s] ?? []) {
        const c = acc.get(r[0]) ?? { pid: r[0], pos: r[1], gp: 0, war: 0, seasons: 0 };
        c.pos = r[1]; c.gp += r[2]; c.war += r[6]; c.seasons += 1;
        acc.set(r[0], c);
      }
    }
    return [...acc.values()].sort((a, b) => b.war - a.war).slice(0, 15);
  }, [sums, played]);

  const span = played.length ? `${played[played.length - 1]}–${played[0]}` : "";

  return (
    <>
      <Band label="All-time standings"
        note={`${span} · regular season · ordered by win percentage, then points`} />
      {frQ.error ? <DataError what="Franchise history didn't load" />
        : !rows ? <div className="empty">Loading…</div> : (
        <table className="v3tbl lgx-grid">
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
                <IdCell name={r.team} to={betaPath(`/team/${r.rid}`)}
                  sub={[r.manager, `${r.seasons} season${r.seasons === 1 ? "" : "s"}`,
                    r.titles ? `${r.titles} title${r.titles === 1 ? "" : "s"}` : null]
                    .filter(Boolean).join(" · ")} />
                <td className="n">
                  <span className="f hd">{r.wins}-{r.losses}{r.ties ? `-${r.ties}` : ""}</span>
                  <div className="idc-s r">{fmt(r.ppg, 1)} ppg</div>
                </td>
                <td className="n"><span className="f">{Math.round(r.fpts).toLocaleString()}</span></td>
                <td className="n">
                  <span className="f">{r.avgFinish == null ? NUL : fmt(r.avgFinish, 1)}</span>
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}

      <Band label="Career WAR leaders"
        note="Regular-season WAR on this league's own scoring, summed over every season" />
      {sums === "error" ? <DataError what="Career WAR didn't load" />
        : !leaders ? <div className="empty">Loading…</div> : (
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
              <TapRow key={r.pid} to={betaPath(`/player/${r.pid}`)} className={i % 2 ? "zebra" : ""}>
                <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                <IdCell name={pInfo(players, r.pid)[0]} to={betaPath(`/player/${r.pid}`)}
                  sub={`${r.pos} · ${r.seasons} season${r.seasons === 1 ? "" : "s"}`} />
                <td className="n"><span className="f q">{r.gp}</span></td>
                <td className="n"><span className="f hd">{fmtWar(r.war)}</span></td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}

      <div className="tnote screen">
        Records and points are regular season only, summed over every season the franchise
        played; average finish is the mean of its playoff-inclusive finishes, over the seasons
        that have one. A franchise is named as it is today. Career WAR is the plain sum of each
        season's regular-season WAR — no market price appears under a result.
      </div>
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
     falls through to franchises.json below, which is the right behaviour. */
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
  const runnerUp = rows?.find(r => r.rid === title?.loser) ?? null;
  const champName = champ?.team
    ?? (champRid != null ? br?.names[String(champRid)] : null)
    ?? fallback?.name ?? null;

  /** SEED, DERIVED — never a row's position in an array. useStandings orders on
   *  wins then points, which is the tiebreak the league seeds on, and its
   *  `rank` is that ordinal. bracket.json publishes the seeding independently
   *  and the two agree in every season this league has played; the file is only
   *  consulted when the standings cannot supply the champion's row at all. */
  const seed = champ?.rank ?? (champRid != null ? br?.seeds[String(champRid)] ?? null : null);

  const finishOf = (rid: number) =>
    fr?.[String(rid)]?.seasons.find(s => s.season === season)?.finish ?? null;

  /* DASH, NOT NUL. `Strip` renders `.v3strip .cell` divs and beta.css scopes
     `.nul` to `.v3tbl td`, so a NUL in here is an unstyled em dash sitting at
     figure weight in primary ink — a missing figure shouting louder than the
     ones that exist. DASH is the same glyph in decorative ink, defined at the
     top of this file for exactly this. */
  const figures: Figure[] = [
    { key: "seed", label: "Seed", value: seed != null ? ord(seed) : DASH,
      sub: "regular-season finish" },
    { key: "rec", label: "Record", value: champ?.rec ?? DASH,
      sub: champ?.played ? `${fmt(champ.ppg, 1)} ppg` : undefined },
    { key: "med", label: "Vs median", value: champ?.med ?? DASH,
      sub: "against each week's league median" },
    { key: "final", label: "Title game",
      value: title && title.pts != null && title.oppPts != null
        ? `${fmt(title.pts, 1)}–${fmt(title.oppPts, 1)}` : DASH,
      sub: title
        ? `beat ${runnerUp?.team ?? (title.loser != null ? br?.names[String(title.loser)] : null) ?? "—"} · wk ${title.week}`
        : undefined },
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
        <Strip figures={figures} />
      </>}

      {/* ---- final standings ---------------------------------------------- */}
      <Band label={`${season} final standings`}
        note="# is the playoff seed — regular-season record, then points" />
      {teamsQ.error ? <DataError what={`${season} standings didn't load`} />
        : !rows ? <div className="empty">Loading {season}…</div> : (
        <table className="v3tbl lgx-grid">
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
                      the same colour. */}
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
