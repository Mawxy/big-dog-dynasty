import { Fragment, useMemo, useState } from "react";
import type {
  BracketFile, DynastyMovers, Franchises, Insights, Matchups, ProjectionsFile,
  SummaryRow, Team, Trade, TradesPayload, Values,
} from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { fmt, fmtWar, mean, meterWidth, normCdf, normInv, ord, sgn } from "../../lib/stats";
import {
  POS_COLOR, latestSeasonOf, lineupOf, optimalLineup, pInfo, rosterSeasonOf,
} from "../../lib/league";
import { ktcOf } from "../../lib/values";
import { readTrades, tradeWhen } from "../../lib/trades";
import { RouteLink } from "../../components/RouteLink";
import { useActivity, useSeasonPhase, useStandings, type ActMove } from "../model";
import {
  Band, DataError, IdCell, NUL, Spine, Strip, TapRow, useBetaPath, type Figure,
} from "../ui";
import ScopeControl, { useScope, type ScopeSeason } from "../Scope";
import "./league.css";

/**
 * LEAGUE — the claim, the board, and what moved.
 *
 * ONE TENSE PER VIEW, and the scope control is the only thing that changes it.
 *
 *   Current  the roster season and nothing else: the written verdict on the
 *            league's best team, the power rankings that price it, the last
 *            seven days, then the three reads that price the market.
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

/**
 * The market price below which a model-vs-market gap is noise.
 *
 * The value bridge is a monotone fit from market points to WAR, and at the foot
 * of the board it extrapolates off a handful of observations — it will happily
 * claim a 467-point veteran is worth four wins more than the market says. 2000
 * is not a number invented here: it is `dynasty_movers.py`'s own `min_value`,
 * so the two market bands on this screen qualify their populations the same way
 * instead of each picking a floor.
 */
const MARKET_FLOOR = 2000;

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

  const [scope, setScope] = useScope(played);

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
      <ScopeControl value={scope} onChange={setScope} seasons={seasons} />
      {/* keyed on the season so switching years resets the screen rather than
          rendering one year's champion over another's standings for a frame */}
      {scope.scope === "history"
        ? <HistoryView key={scope.season} season={scope.season} />
        : <CurrentView rosterSeason={rosterSeasonOf(league)} />}
    </>
  );
}

/* ========================================================================
   CURRENT — the roster season
   ======================================================================== */

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

/** one model-vs-market row */
interface GapRow {
  pid: string; name: string; pos: string; nfl: string;
  price: number; model: number; imp: number; gap: number;
}

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
  const ins = useJson<Insights>("insights.json").data;
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
  const maxWar = power?.[0]?.war || 1;

  /* THE WRITTEN CLAIM belongs to whoever the board actually puts first, which
     is why it is read off `power` rather than off a rank parsed out of the
     file. insights.json's `head` string carries its own ordering ("#1 now",
     written 2026-07-20) and this league has traded since; rendering that line
     verbatim above a live table would put two different rankings on one screen.
     So the prose is quoted and dated, and every figure beside it is this run's. */
  const verdict = leader && ins ? ins.teams[String(leader.rid)] ?? null : null;

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

  /* ---- model vs market -------------------------------------------------- */

  /**
   * The model's three-year WAR against the WAR the market's price implies.
   *
   * This is the value-plays module's question asked of the right two numbers.
   * views/Home.tsx still ranks by the raw DVI-minus-CVI gap, which compares two
   * of our own indices to each other and never consults a price at all — the
   * known gap SKILL §8 names. Both figures here ship precomputed in values.json
   * (`modelWar`, `impWar.ktc`, written by value_bridge.py), so the whole band
   * costs one fetch the screen was making anyway.
   *
   * SIGN CONVENTION, stated in the group bands so it cannot be misread: a
   * NEGATIVE gap means the market pays more than the model does, which is the
   * sell-high side.
   */
  const mvm = useMemo(() => {
    if (!vals) return null;
    const rows: GapRow[] = [];
    for (const [pid, v] of Object.entries(vals.players)) {
      const info = players[pid];
      const price = ktcOf(v, meta.tep);
      const model = v.modelWar, imp = v.impWar?.ktc;
      // no players_min entry means nothing on this board can name him or link
      // to him; a row reading "#13291" is worse than one fewer row
      if (!info || model == null || imp == null || price == null || price < MARKET_FLOOR) continue;
      rows.push({
        pid, name: info[0], pos: info[1], nfl: info[2],
        price, model, imp, gap: model - imp,
      });
    }
    rows.sort((a, b) => b.gap - a.gap);
    return {
      sell: rows.filter(r => r.gap < 0).slice(-MODULE_ROWS).reverse(),
      buy: rows.filter(r => r.gap > 0).slice(0, MODULE_ROWS),
    };
  }, [vals, players, meta.tep]);

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
      {/* ---- 1. the verdict ---------------------------------------------- */}
      {verdict && leader && ins && (
        <div className="verdict lgx-verdict">
          <div className="k">{ins.meta.season} outlook · {leader.team}</div>
          <div className="meta">
            Top of the board · proj {leader.rec ?? "—"} · starters {fmtWar(leader.war)} WAR
            {" · "}written {ins.meta.generated}
          </div>
          <div className="body">{verdict.text}</div>
        </div>
      )}

      {/* ---- 2. power rankings ------------------------------------------- */}
      <Band label={`Power rankings · ${rosterSeason}`}
        note="Projected starter WAR — the best legal lineup, not the lineup as set" />
      {/* A FAILED FETCH IS NOT A SLOW ONE. Without the error arm the band
          claims to be loading projections that are never coming, for the life
          of the page. */}
      {teamsQ.error || projQ.error
        ? <DataError what="Power rankings didn't load" />
        : !power ? <div className="empty">Loading projections…</div> : (
        <table className="v3tbl">
          <thead>
            <tr>
              {/* No header on this table is a control. The band above claims one
                  order and the rank spine keeps it — the same call Home.tsx's
                  power table makes. Re-ranking lives on the rankings board. */}
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              <th className="n" style={{ width: "12%" }}>Move</th>
              <th className="n" style={{ width: "17%" }}>Proj rec</th>
              <th className="n" style={{ width: "27%" }}>Starters WAR</th>
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
                  {/* THE ONE METERED COLUMN here, and it is the sort column.
                      Legal because WAR is unbounded; DVI and CVI are clamped
                      0–100 and a bar would only restate them. */}
                  <div className="lgx-meter">
                    <span className="bar"><i style={{ width: meterWidth(r.war, maxWar) }} /></span>
                    <span className="f">{fmtWar(r.war)}</span>
                  </div>
                </td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}
      <div className="tnote screen">
        Ranked by the projected WAR of each roster's best legal lineup in {rosterSeason}, on
        year-one composite projections. The record folds in the published schedule, so a team
        can out-rank a better record or the reverse — that difference is the schedule and
        nothing else. Move would be the change since the last nightly refresh, and the
        pipeline ships no prior ranking to difference against, so it reads —. Playoff and
        title odds are not shown at all: nothing published carries a per-team season
        simulation, and odds.json holds pregame lines for single matchups only.
      </div>

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

      {/* ---- the turn: everything below prices the market, not this league */}
      <div className="lgx-turn">
        <b>The market</b>
        The three bands below price the whole dynasty market — every player the feeds cover,
        not the twelve rosters above. They would read the same on any superflex board, which
        is what makes them worth reading before a trade: they are the outside opinion this
        league's own figures are not.
      </div>

      {/* ---- 4. model vs market ------------------------------------------ */}
      <Band label="Model vs market"
        note={`Three-year WAR, ours against the price · ${MARKET_FLOOR.toLocaleString()}+ market value`} />
      {/* "Waiting on the nightly pull" is a claim about a fetch that is still
          coming. Once values.json has failed it is the wrong sentence — the
          reader is waiting on nothing. */}
      {valsQ.error
        ? <DataError what="Market didn't load" />
        : !mvm ? <div className="empty">Waiting on the nightly market pull…</div> : (
        <table className="v3tbl">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className="n" style={{ width: "18%" }}>Model</th>
              <th className="n" style={{ width: "18%" }}>Market</th>
              <th className="n" style={{ width: "20%" }}>Gap</th>
            </tr>
          </thead>
          <tbody>
            {([
              ["Sell high", "The market pays more than the model does", mvm.sell],
              ["Buy low", "The model pays more than the market does", mvm.buy],
            ] as const).map(([label, note, list]) => (
              <Fragment key={label}>
                <tr className="lgx-grp">
                  <td colSpan={5}>
                    <span className="k">{label}</span><span className="n">{note}</span>
                  </td>
                </tr>
                {list.map((r, i) => (
                  <TapRow key={r.pid} to={betaPath(`/player/${r.pid}`)}
                    className={i % 2 ? "zebra" : ""}>
                    <Spine rank={i + 1} color={POS_COLOR[r.pos]} />
                    <IdCell name={r.name}
                      sub={[r.nfl || null, r.pos].filter(Boolean).join(" · ")}
                      to={betaPath(`/player/${r.pid}`)} />
                    <td className="n"><span className="f">{fmtWar(r.model)}</span></td>
                    <td className="n"><span className="f q">{fmtWar(r.imp)}</span></td>
                    {/* the sign is the whole claim, and `.f.pos` / `.f.neg` are
                        the tokens the board already spends on a signed figure.
                        Legal here and nowhere near a trade ledger: a gap is a
                        direction of travel, not a verdict about who won. */}
                    <td className="n">
                      <span className={`f hd ${r.gap > 0 ? "pos" : "neg"}`}>{sgn(r.gap)}</span>
                    </td>
                  </TapRow>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {/* ---- 5. dynasty movers ------------------------------------------- */}
      <Band label="Dynasty movers"
        note={dyn
          ? `What packages actually changed hands for · last ${dyn.meta.window_days} days, ${dyn.meta.leagues?.toLocaleString() ?? "—"} leagues`
          : "What packages actually changed hands for"} />
      {!dyn ? <div className="empty">Waiting on the trade-corpus refresh…</div> : (
        <table className="v3tbl">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className="n" style={{ width: "18%" }}>Value</th>
              <th className="n" style={{ width: "18%" }}>Paid</th>
              <th className="n" style={{ width: "16%" }}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {([
              ["Going over value", "Packages beat the price", dyn.overpaid],
              ["Going under value", "Packages fell short of it", dyn.underpaid],
            ] as const).map(([label, note, list]) => (
              <Fragment key={label}>
                <tr className="lgx-grp">
                  <td colSpan={5}>
                    <span className="k">{label}</span><span className="n">{note}</span>
                  </td>
                </tr>
                {list.slice(0, MODULE_ROWS).map((r, i) => (
                  <TapRow key={`${label}${r.pid}`} to={betaPath(`/player/${r.pid}`)}
                    className={i % 2 ? "zebra" : ""}>
                    <Spine rank={i + 1} color={r.pos ? POS_COLOR[r.pos] : undefined} />
                    <IdCell name={r.name}
                      sub={[r.team, r.pos, `${r.n} trades`].filter(Boolean).join(" · ")}
                      to={betaPath(`/player/${r.pid}`)} />
                    <td className="n"><span className="f q">{r.value.toLocaleString()}</span></td>
                    <td className="n"><span className="f">{r.avg_paid.toLocaleString()}</span></td>
                    <td className="n">
                      <span className={`f hd ${r.avg_delta > 0 ? "pos" : "neg"}`}>
                        {r.avg_pct == null ? NUL : `${sgn(r.avg_pct, 0)}%`}
                      </span>
                    </td>
                  </TapRow>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {/* ---- 6. market movers -------------------------------------------- */}
      <Band label="Market movers" note="KeepTradeCut, 7-day change in points" />
      {valsQ.error
        ? <DataError what="Market didn't load" />
        : !movers ? <div className="empty">Waiting on the nightly market pull…</div> : (
        <table className="v3tbl">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className="n" style={{ width: "24%" }}>Value</th>
              <th className="n" style={{ width: "22%" }}>7d</th>
            </tr>
          </thead>
          <tbody>
            {([
              ["Rising", "Bid up over the week", movers.up],
              ["Falling", "Bid down over the week", movers.down],
            ] as const).map(([label, note, list]) => (
              <Fragment key={label}>
                <tr className="lgx-grp">
                  <td colSpan={4}>
                    <span className="k">{label}</span><span className="n">{note}</span>
                  </td>
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
                      <span className={`f hd ${r.d > 0 ? "pos" : "neg"}`}>{sgn(r.d, 0)}</span>
                    </td>
                  </TapRow>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      <div className="tnote screen">
        Model is the projection model's three-year WAR; Market is the WAR the KeepTradeCut
        price implies through the value bridge — so the gap is one currency, not two, and it
        is WAR rather than points. Dynasty movers is a crawl of real trades in other superflex
        leagues, priced in face market points with the trade model's consolidation adjustment
        on everything but the centerpiece: it says what packages changed hands for, not what a
        player is worth. Nothing on this screen is a figure from a settled season — the
        history scope above is where those live. Market fetched{" "}
        {vals?.fetched ?? meta.updated} · board built {meta.updated}.
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
  const maxWar = leaders?.[0]?.war || 1;

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
        <table className="v3tbl">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Franchise</th>
              <th className="n" style={{ width: "16%" }}>W-L</th>
              <th className="n" style={{ width: "16%" }}>PPG</th>
              <th className="n" style={{ width: "18%" }}>Finish</th>
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
        <table className="v3tbl">
          <thead>
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className="n" style={{ width: "14%" }}>GP</th>
              <th className="n" style={{ width: "34%" }}>WAR</th>
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
                  {/* metered, and the only metered column here: WAR is
                      unbounded and it is what the table is sorted by */}
                  <div className="lgx-meter">
                    <span className="bar"><i style={{ width: meterWidth(r.war, maxWar) }} /></span>
                    <span className="f">{fmtWar(r.war)}</span>
                  </div>
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
