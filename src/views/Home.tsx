import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type {
  DynastyMovers, DynastyMoverRow, Franchises, Matchups, ProjectionsFile, Team,
  Trade, TradesPayload, Values,
} from "../lib/types";
import { useJson } from "../lib/useJson";
import { useCvi, useDvi } from "../lib/useIndices";
import { fmt, fmtWar, sgn, mean, normCdf, normInv } from "../lib/stats";
import { LEAGUE_TEAMS, lineupOf, optimalLineup, pInfo, REG_WEEKS, rosterSeasonOf, starterTotal } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { readTrades, tradeWhen } from "../lib/trades";
import { useMobile } from "../lib/useWidth";
import { PlayerLink } from "../components/PlayerLink";
import PosBadge from "../components/PosBadge";
import { RouteLink } from "../components/RouteLink";
import DataTable, { type Col, type Grp } from "../components/DataTable";
import { ktcOf } from "../lib/values";

const MODULE_ROWS = 5;
/** how deep into an index a player can rank and still be a "value play" —
 *  roughly the startable universe (100 of ~390 indexed). See valuePlays. */
const VALUE_PLAY_DEPTH = 100;

/** pad a module list to a fixed row count so paired modules measure equal */
function padTo<T>(a: T[], n: number): (T | null)[] {
  return [...a.slice(0, n), ...Array(Math.max(0, n - a.length)).fill(null)];
}

/** One power-rankings row: the two starter index totals joined to the projected
 *  record and the starter age, so the board hands DataTable one array rather
 *  than reading a second map inside a cell. */
interface PowerRow {
  rid: number; fkey: string; name: string; manager: string;
  sDvi: number; sCvi: number;
  lastRec: string; lastFin: number | null;
  /** projected record for the roster season; "—" until a schedule prices it */
  rec: string;
  /** WAR-weighted average age of the optimal starters */
  age: number | null;
}

/** the power table needs no per-render context; a shared constant rather than a
 *  `{}` literal, which would be a new object on every render and defeat
 *  DataTable's row memoization */
const NO_CTX: Record<string, never> = {};
/** The board is the front page's summary read, ranked by starters DVI, and no
 *  column declares a `sort` accessor — so no header is a control and the rank
 *  spine keeps the one order the band above it claims. Re-ranking lives on
 *  Teams, which is the breakdown board. DataTable still takes the three sort
 *  props, so they are handed in inert. */
const NO_SORT = () => {};

/**
 * League front page (2B): champion + title race hero, power rankings by
 * starter DVI, then two module rows — value plays beside market movers,
 * recent waivers beside recent trades. Paired modules share row count and
 * cell line count so they measure equal.
 */
export default function Home() {
  const { meta, players, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  // MOBILE.md M5 — the League page's lists render as records at ≤640px; the
  // hero blocks stack and the equal-height pairing rules stop applying
  const mobile = useMobile();

  const rosterSeason = rosterSeasonOf(league);

  const fr = useJson<Franchises>("franchises.json").data;
  const proj = useJson<ProjectionsFile>("projections.json").data;
  const teams = useJson<Team[]>(`${rosterSeason}/teams.json`).data;
  const mw = useJson<Matchups>(`${rosterSeason}/matchups.json`).data;
  // model-aware: these follow the masthead's projection-model control
  const dvi = useDvi();
  const cvi = useCvi();
  // the market prices a format, not a league
  const vals = useJson<Values>("data/values.json", "globalDaily").data;
  // cross-league trade market: who is going for more/less than his value
  const dyn = useJson<DynastyMovers>("data/dynasty_movers.json", "globalDaily").data;
  const tradesFile = useJson<TradesPayload>("trades.json").data;
  const trades = useMemo<Trade[]>(
    () => (tradesFile ? readTrades(tradesFile).trades : []), [tradesFile]);

  const lineup = lineupOf(meta);

  /** the reigning champion's full season row */
  const champ = useMemo(() => {
    if (!fr || !league.latest) return null;
    for (const [fkey, f] of Object.entries(fr)) {
      const sn = f.seasons.find(s => s.season === league.latest && s.finish === 1);
      if (sn) return { fkey, s: sn };
    }
    return null;
  }, [fr, league]);

  /**
   * Per-franchise projected strength, record and starter age for the roster
   * season: optimal lineup on year-one composite WAR, win probabilities from
   * the published schedule via the same z-score conversion the standings
   * page uses (byes ignored — this is a front-page read, not the model).
   */
  const power = useMemo(() => {
    if (!teams || !proj) return null;
    const byPid = new Map(proj.players.map(p => [p.pid, p]));
    const built = teams.map(t => {
      const pool = t.players.map(p => byPid.get(p))
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map(p => ({ id: p.pid, pos: p.pos, war: p.composite?.[0] ?? 0, age: p.age }));
      const { slots } = optimalLineup(pool, lineup);
      const starters = slots.flatMap(s => s.player ? [s.player] : []);
      const war = starters.reduce((a, p) => a + p.war, 0);
      const wsum = starters.reduce((a, p) => a + Math.max(p.war, 0.01), 0);
      const age = wsum ? starters.reduce((a, p) => a + p.age * Math.max(p.war, 0.01), 0) / wsum : null;
      return { rid: t.roster_id, war, age };
    });
    const meanWar = mean(built.map(b => b.war));
    const warOf = new Map(built.map(b => [b.rid, b.war]));
    const z = (w: number) => normInv(0.5 + Math.min(0.45, Math.max(-0.45, (w - meanWar) / 13)));
    const ps = mw?.playoff_start || 15;
    const games: Record<number, number[]> = {};
    for (const [wkS, pairs] of Object.entries(mw?.schedule ?? {})) {
      if (+wkS >= ps) continue;
      for (const [a, b] of pairs) {
        (games[a] ??= []).push(b);
        (games[b] ??= []).push(a);
      }
    }
    return new Map(built.map(b => {
      const opps = games[b.rid] ?? [];
      const wins = opps.length
        ? opps.reduce((a, o) => a + normCdf(z(b.war) - z(warOf.get(o) ?? meanWar)), 0)
        : Math.min(REG_WEEKS, Math.max(0, REG_WEEKS / 2 + (b.war - meanWar) * (REG_WEEKS / 13)));
      const n = opps.length || REG_WEEKS;
      return [b.rid, { ...b, wins, rec: `${fmt(wins, 1)}-${fmt(n - wins, 1)}` }];
    }));
  }, [teams, proj, mw, lineup]);

  /** starters totals per franchise in each index currency */
  const indexRows = useMemo(() => {
    if (!teams || !dvi || !cvi || !fr) return null;
    return teams.map(t => {
      const key = t.fkey ?? String(t.roster_id);
      const f = fr[key];
      const cur = f?.seasons[f.seasons.length - 1];
      const lastSn = f?.seasons.find(s => s.season === league.latest);
      return {
        rid: t.roster_id, fkey: key,
        name: cur?.name ?? t.team, manager: cur?.manager ?? t.manager,
        sDvi: starterTotal(t, dvi.players, (_p, r) => r.dvi, lineup),
        sCvi: starterTotal(t, cvi.players, (_p, r) => r.cvi, lineup),
        lastRec: lastSn ? `${lastSn.wins}-${lastSn.losses}${lastSn.ties ? `-${lastSn.ties}` : ""}` : "—",
        lastFin: lastSn?.finish ?? null,
      };
    }).sort((a, b) => b.sDvi - a.sDvi);
  }, [teams, dvi, cvi, fr, league, lineup]);

  const titleRace = useMemo(() => {
    if (!indexRows) return null;
    return indexRows.slice().sort((a, b) => b.sCvi - a.sCvi).slice(0, 4);
  }, [indexRows]);

  /** the power table's rows: the index totals with the projected record and
   *  starter age joined on. The projection is optional — it needs the schedule
   *  and the projections file, and the board still ranks without them. */
  const powerRows = useMemo<PowerRow[] | null>(() => {
    if (!indexRows) return null;
    return indexRows.map(r => {
      const p = power?.get(r.rid);
      return { ...r, rec: p?.rec ?? "—", age: p?.age ?? null };
    });
  }, [indexRows, power]);

  /** rostered owner per pid, for movers and value plays */
  const ownerOfPid = useMemo(() => {
    const m = new Map<string, string>();
    if (teams) for (const t of teams) for (const p of t.players) m.set(p, t.team);
    return m;
  }, [teams]);

  /** largest DVI-minus-CVI disagreements among rostered players.
   *
   *  The raw gap is dominated by KNOWN news, not tradeable disagreement: a
   *  season-ending injury or a benching craters CVI while DVI (a dynasty
   *  index, correctly) holds, so the unfiltered sell-high list was Higgins /
   *  Pearsall / McCarthy — players everyone already knows are done for the
   *  year. Two guards fix that:
   *
   *  - sell high requires an ECR rank (absence from the redraft consensus =
   *    known to give you nothing this year) AND a top-VALUE_PLAY_DEPTH DVI
   *    rank — a sell-high needs meaningful dynasty value to sell, which is
   *    what keeps deep stash QBs (huge relative gap, no market) off the list.
   *  - buy low symmetrically requires a top-VALUE_PLAY_DEPTH CVI rank: a
   *    buy-low has to be currently startable, or the gap is just age.
   */
  const valuePlays = useMemo(() => {
    if (!dvi || !cvi) return null;
    const rows: { pid: string; pos: string; name: string; d: number; c: number; gap: number; ecr?: number; dRank: number; cRank: number }[] = [];
    for (const [pid, dr] of Object.entries(dvi.players)) {
      const cr = cvi.players[pid];
      if (!cr || !ownerOfPid.has(pid)) continue;
      rows.push({ pid, pos: dr.pos, name: dr.name, d: dr.dvi, c: cr.cvi, gap: dr.dvi - cr.cvi, ecr: cr.ecr, dRank: dr.rank, cRank: cr.rank });
    }
    rows.sort((a, b) => b.gap - a.gap);
    return {
      sell: rows.filter(r => r.gap > 0 && r.ecr != null && r.dRank <= VALUE_PLAY_DEPTH).slice(0, MODULE_ROWS),
      buy: rows.filter(r => r.gap < 0 && r.cRank <= VALUE_PLAY_DEPTH).reverse().slice(0, MODULE_ROWS),
    };
  }, [dvi, cvi, ownerOfPid]);

  /** KeepTradeCut 7-day movement, rostered players only. Values price in this
   *  league's TE-premium column; the trend stays the base feed's (KTC ships no
   *  per-tier trends) — direction and magnitude read the same. */
  const movers = useMemo(() => {
    if (!vals) return null;
    const rows: { pid: string; val: number; d: number }[] = [];
    for (const [pid, v] of Object.entries(vals.players)) {
      const val = ktcOf(v, meta.tep);
      if (!ownerOfPid.has(pid) || val == null) continue;
      const d = v.ktcT?.["7"];
      if (d == null || d === 0) continue;
      rows.push({ pid, val, d });
    }
    rows.sort((a, b) => b.d - a.d);
    return {
      up: rows.filter(r => r.d > 0).slice(0, MODULE_ROWS),
      down: rows.filter(r => r.d < 0).reverse().slice(0, MODULE_ROWS),
    };
  }, [vals, ownerOfPid, meta]);

  const waivers = useMemo(() => {
    if (!fr) return [];
    return Object.entries(fr).flatMap(([rid, f]) => {
      const cur = f.seasons[f.seasons.length - 1];
      return f.tx.filter(t => t.type !== "trade").map(t => ({
        ...t, rid: +rid, team: cur?.name ?? "—", manager: cur?.manager ?? "",
      }));
    }).sort((a, b) => b.ts - a.ts).slice(0, MODULE_ROWS);
  }, [fr]);

  /**
   * Newest trades, one record per trade.
   *
   * The dedupe key is NOT the bare timestamp: `ts` is a Sleeper transaction
   * time and two trades processed in the same batch carry the same one — the
   * fact views/Ledger.tsx already keys around. Deduping on it silently dropped
   * the second real trade out of the feed. The participating rosters are what
   * tell two same-second trades apart, so they join the key, which then doubles
   * as the React key the rows need.
   */
  const recentTrades = useMemo(() => {
    const seen = new Set<string>();
    const out: (Trade & { key: string })[] = [];
    for (const t of trades.slice().sort((a, b) => b.ts - a.ts)) {
      const key = `${t.ts}:${t.sides.map(s => s.rid).slice().sort((a, b) => a - b).join("-")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...t, key });
      if (out.length === MODULE_ROWS) break;
    }
    return out;
  }, [trades]);

  const nTeams = teams?.length ?? LEAGUE_TEAMS;
  const sf = meta.rosterPositions?.includes("SUPER_FLEX") ? "superflex" : "1QB";
  const phase = league.latest === rosterSeason ? "in season" : "offseason";
  const pricedAt = dvi?.generated?.slice(0, 10) ?? meta.updated;

  const lede = champ ? (() => {
    const s = champ.s;
    const top = s.top ? pInfo(players, s.top.pid)[0] : null;
    return `${s.name} took the ${s.season} title at ${s.wins}-${s.losses}`
      + `${s.ties ? `-${s.ties}` : ""}, scoring ${fmt(s.ppg, 1)} points a week on a lineup `
      + `worth ${fmtWar(s.war)} WAR against the optimal pool`
      + (top && s.top ? `. ${top} carried the biggest share at ${fmtWar(s.top.war)} WAR.` : ".");
  })() : null;

  /** last played season's column header, and its key on a records line */
  const lastKey = league.latest ?? "Last";

  /**
   * The power rankings as one registry.
   *
   * The roles are what the phone rendering used to be a hand-rolled copy of:
   * the rank is the spine, the franchise the identity with its manager as the
   * sub-line, starters DVI the headline figure (it is the order the board is
   * in), and CVI, last season's record and the projected one the three micros.
   * Starter age has no role and drops off the record — it is on Teams.
   *
   * Both index figures are bare: they are clamped 0–100 scores, and this board
   * is ordered by one of them, so nothing here is metered (SKILL §3).
   */
  const powerCols = useMemo<Col<PowerRow, Record<string, never>>[]>(() => [
    {
      id: "rk", label: "Rk", grp: 0, w: 5, align: "c", td: "spine-cell", role: "spine",
      cell: (_r, _x, i) => <>
        <span className="spine" style={{ background: i < 4 ? "var(--acc)" : "var(--rule-2)" }} />
        <span className={`rank${i < 4 ? " top" : ""}`}>{i + 1}</span>
      </>,
    },
    {
      // the row navigates on click, but a click is not the only way in: the
      // franchise name is a real anchor, like the standings board's team cell,
      // so a keyboard and a new tab both reach the same page
      id: "team", label: "Franchise", grp: 0, w: 23, align: "t", td: "t name",
      role: "identity",
      cell: r => (
        <RouteLink to={lp(`/franchise/${r.fkey}`)} className="blocklink">{r.name}</RouteLink>
      ),
    },
    {
      // NOT flagged `hm`: a column that is drops off the record entirely, and
      // the manager is the identity block's sub-line there. The class stays on
      // the cell, which is all the desktop table ever used it for — below 640px
      // this board is records, not a squeezed table.
      id: "manager", label: "Manager", grp: 0, w: 13, align: "t", td: "t sub hm",
      role: "sub", cell: r => r.manager,
    },
    {
      id: "dvi", label: "Starters DVI", grp: 1, w: 11, align: "n", edge: true, keyCol: true,
      td: "n edge", role: "headline", microKey: "DVI",
      cell: r => <span className="head-fig sm">{fmt(r.sDvi, 0)}</span>,
    },
    {
      id: "cvi", label: "Starters CVI", grp: 1, w: 11, align: "n", td: "n",
      role: "micro", microKey: "CVI",
      cell: r => (
        <span className="head-fig sm" style={{ color: "var(--txt2)" }}>{fmt(r.sCvi, 0)}</span>
      ),
    },
    {
      // the champion's record goes gold — a figure, never a pill inside a dense
      // numeric row. The tint sits on the figure rather than on the cell:
      // DataTable owns the <td>, and the ink lands in the same place.
      id: "last", label: lastKey, grp: 2, w: 12, align: "n", edge: true, td: "n fig edge",
      role: "micro", microKey: lastKey,
      cell: r => (
        <span style={r.lastFin === 1 ? { color: "var(--acc)" } : undefined}
          title={r.lastFin === 1 ? `${league.latest} champion` : undefined}>
          {r.lastRec}
        </span>
      ),
    },
    {
      id: "proj", label: `Proj ${rosterSeason}`, grp: 2, w: 13, align: "n", td: "n fig",
      role: "micro", microKey: "Proj", cell: r => r.rec,
    },
    {
      id: "age", label: "Starter age", grp: 3, w: 12, align: "n", hm: true, td: "n fig hm",
      cell: r => (
        <span style={{
          color: r.age == null ? "var(--dim3)"
            : r.age <= 25.5 ? "var(--good)" : r.age >= 27 ? "var(--warn)" : "var(--txt2)",
        }}>
          {r.age == null ? "—" : fmt(r.age, 1)}
        </span>
      ),
    },
  ], [lp, lastKey, league.latest, rosterSeason]);

  /* Starters carries the key figure and takes the accent; the two records are
     read against it. Starter age keeps a band of its own rather than joining
     either — it is neither an index nor a record — and an unlabeled one,
     because giving it a divider would draw a rule the board never had. */
  const powerGroups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label: `Starters · ${rosterSeason}`, cls: "edge value" },
    { id: 2, label: "Record", cls: "edge" },
    { id: 3, label: "", cls: "" },
  ];

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{league.name}</span>
        <span style={{ font: "400 14px/1 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--dim)" }}>
          {nTeams} teams · {sf} · established {league.seasons[0]} · {phase}
        </span>
        <span className="screen-note">Priced {pricedAt}</span>
      </div>

      {/* ---- hero: champion + title race ---- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18, padding: "2px var(--pad) 0" }}>
        <div className="panel" style={{ margin: 0 }}>
          {/* the champion block is where a reader arrives asking "who won" —
              so the year-by-year history hangs off it rather than off a band
              of its own, which would sit above the power rankings band and
              read as two headers with nothing between them */}
          <div className="chart-label" style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span>Reigning champion · {league.latest ?? "—"}</span>
            <button type="button" className="dlink" onClick={() => nav(lp("/history"))}>
              League summary
            </button>
          </div>
          {!champ ? <div className="empty">No completed season yet.</div> : <>
            {/* the champion's name opens his franchise — a real anchor, so it
                is reachable by keyboard and openable in a new tab */}
            <RouteLink to={lp(`/franchise/${champ.fkey}`)} className="blocklink"
              style={{ font: `700 ${mobile ? 32 : 40}px/1.05 var(--cond)`, letterSpacing: ".02em", textTransform: "uppercase", color: "var(--acc)" }}>
              {champ.s.name}
            </RouteLink>
            <div style={{ font: "400 14px/1.4 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--dim)", marginTop: 5 }}>
              {champ.s.manager} · {champ.s.wins}-{champ.s.losses}{champ.s.ties ? `-${champ.s.ties}` : ""} · {fmt(champ.s.ppg, 1)} ppg
            </div>
            <div style={{ display: "flex", marginTop: 14 }}>
              <div className="figcell">
                <div className="figkey">Lineup WAR</div>
                <div className="figval">{fmtWar(champ.s.war)}</div>
                <div className="figsub">actual starters, {champ.s.season}</div>
              </div>
              <div className="figcell">
                <div className="figkey">Top player</div>
                <div className="figval" style={{ fontSize: 20, lineHeight: 1.35 }}>
                  {champ.s.top
                    ? <PlayerLink pid={champ.s.top.pid} name={pInfo(players, champ.s.top.pid)[0]} />
                    : "—"}
                </div>
                <div className="figsub">{champ.s.top ? `${fmtWar(champ.s.top.war)} WAR` : ""}</div>
              </div>
            </div>
            {lede && (
              <div style={{ borderTop: "1px solid var(--rule)", marginTop: 14, paddingTop: 10, font: "400 13.5px/1.6 var(--sans)", color: "var(--txt2)", textWrap: "pretty" }}>
                {lede}
              </div>
            )}
          </>}
        </div>

        <div className="panel" style={{ margin: 0, borderTopColor: "var(--rule-2)" }}>
          <div className="chart-label">Title race · {rosterSeason} · top 4 by starter CVI</div>
          {!titleRace ? <div className="empty">Loading indices…</div> : titleRace.map((r, i) => (
            // the whole row is the link to that franchise, so it is an anchor
            // rather than a div with a click handler no keyboard could reach
            <RouteLink key={r.rid} to={lp(`/franchise/${r.fkey}`)} className="blocklink"
              style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "9px 0", borderTop: i ? "1px solid var(--hair)" : "none" }}>
              <span style={{ font: "600 17px/1 var(--cond)", color: "var(--dim)", flex: "0 0 16px" }}>{i + 1}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ font: "600 14px/1.35 var(--sans)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>{r.manager}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ font: "600 15px/1.3 var(--cond)", fontVariantNumeric: "tabular-nums" }}>
                  {power?.get(r.rid)?.rec ?? "—"}
                </div>
                <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>proj record</div>
              </div>
              <div style={{ textAlign: "right", flex: "0 0 58px" }}>
                <div className="head-fig sm">{fmt(r.sCvi, 0)}</div>
                <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>starter CVI</div>
              </div>
            </RouteLink>
          ))}
        </div>
      </div>

      {/* ---- power rankings ---- */}
      <div style={{ marginTop: 18 }}>
        <div className="band">
          <span className="band-label">Power rankings</span>
          <span className="band-note">Ranked by starters DVI — the roster season's best legal dynasty lineup, not last season's record</span>
          <button type="button" className="dlink" style={{ marginLeft: 12 }}
            onClick={() => nav(lp(`/teams/${league.latest ?? rosterSeason}`))}>
            Standings
          </button>
        </div>
        {!powerRows ? <div className="empty">Loading indices…</div> : (
          /* records at ≤640px (MOBILE.md M5): the same registry, re-read as
             two-line records rather than a second hand-rolled copy of it */
          <DataTable cols={powerCols} groups={powerGroups} rows={powerRows} ctx={NO_CTX}
            label="Power rankings by starters DVI"
            rowKey={r => String(r.rid)} sortId="" dir={-1} onSort={NO_SORT}
            onRowClick={r => nav(lp(`/franchise/${r.fkey}`))}
            recordsOnMobile recordsClass="t3" />
        )}
      </div>

      {/* ---- module row 1: value plays as twin panels ----
          The dynasty-movers pattern is the house style for a population split
          by sign (settled with Max, 2026-08-20): one side per panel, the two
          panels structurally identical twins (§4 — same header treatment,
          same row count, same cell line count). */}
      <div className="feeds" style={{ padding: "18px var(--pad) 0" }}>
        {([
          ["Value plays · sell high", valuePlays?.sell],
          ["Value plays · buy low", valuePlays?.buy],
        ] as const).map(([label, list]) => (
          <div className="feed-panel" key={label}>
            {/* label only — twin bands carry no notes, because two notes of
                different lengths wrap differently and push the twin tables
                out of alignment. Methodology lives in the page footnotes. */}
            <div className="band" style={{ borderTop: "none" }}>
              <span className="band-label">{label}</span>
            </div>
            {mobile ? (
              <div className="records flat">
                {(list ?? []).map((r, i) => (
                  <div key={r.pid} className={`rec${i % 2 ? " zebra" : ""}`}>
                    <div className="rec-l1">
                      <span className="rec-id">
                        <PosBadge pos={r.pos} />{" "}
                        <PlayerLink pid={r.pid} name={r.name} />
                      </span>
                      <span className="rec-fig">{sgn(r.gap, 1)}</span>
                      <span className="rec-key">Gap</span>
                    </div>
                    <div className="rec-l2">
                      <span className="mic"><span className="mk">DVI</span><span className="mv">{fmt(r.d, 1)}</span></span>
                      <span className="mic"><span className="mk">CVI</span><span className="mv">{fmt(r.c, 1)}</span></span>
                    </div>
                  </div>
                ))}
                {!(list ?? []).length && <div className="empty">—</div>}
              </div>
            ) : (
              <table style={{ tableLayout: "fixed" }} aria-label={label}>
                <thead>
                  <tr>
                    <th scope="col" className="c" style={{ width: "14%" }}>Pos</th>
                    <th scope="col" className="t" style={{ width: "42%" }}>Player</th>
                    <th scope="col" className="n" style={{ width: "14%" }}>DVI</th>
                    <th scope="col" className="n" style={{ width: "14%" }}>CVI</th>
                    <th scope="col" className="n" style={{ width: "16%" }}>Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {padTo(list ?? [], MODULE_ROWS).map((r, i) => r ? (
                    <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
                      <td className="c"><PosBadge pos={r.pos} /></td>
                      <td className="t name"><PlayerLink pid={r.pid} name={r.name} /></td>
                      <td className="n fig">{fmt(r.d, 1)}</td>
                      <td className="n fig">{fmt(r.c, 1)}</td>
                      <td className="n fig strong last">{sgn(r.gap, 1)}</td>
                    </tr>
                  ) : (
                    <tr key={`e${label}${i}`} className={i % 2 ? "zebra" : ""}>
                      <td className="c fig quiet">—</td>
                      <td className="t fig quiet">—</td>
                      <td className="n fig quiet">—</td>
                      <td className="n fig quiet">—</td>
                      <td className="n fig quiet last">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      {/* ---- module row 1a: market movers as twin panels ---- */}
      <div className="feeds" style={{ padding: "18px var(--pad) 0" }}>
        {([
          ["Market movers · rising", movers?.up],
          ["Market movers · falling", movers?.down],
        ] as const).map(([label, list]) => (
          <div className="feed-panel" key={label}>
            <div className="band" style={{ borderTop: "none" }}>
              <span className="band-label">{label}</span>
            </div>
            {mobile ? (
              <div className="records flat">
                {(list ?? []).map((r, i) => (
                  <div key={r.pid} className={`rec${i % 2 ? " zebra" : ""}`}>
                    <div className="rec-l1">
                      <span className="rec-id">
                        <PosBadge pos={pInfo(players, r.pid)[1]} />{" "}
                        <PlayerLink pid={r.pid} name={pInfo(players, r.pid)[0]} />
                      </span>
                      <span className="rec-fig" style={{ color: r.d > 0 ? "var(--good)" : "var(--bad)" }}>
                        {sgn(r.d, 0)}
                      </span>
                      <span className="rec-key">7d</span>
                    </div>
                    <div className="rec-l2">
                      <span className="mic"><span className="mk">Value</span>
                        <span className="mv">{r.val.toLocaleString("en-US")}</span></span>
                    </div>
                  </div>
                ))}
                {!(list ?? []).length && <div className="empty">—</div>}
              </div>
            ) : (
              <table style={{ tableLayout: "fixed" }} aria-label={label}>
                <thead>
                  <tr>
                    <th scope="col" className="c" style={{ width: "14%" }}>Pos</th>
                    <th scope="col" className="t" style={{ width: "42%" }}>Player</th>
                    <th scope="col" className="n" style={{ width: "22%" }}>Value</th>
                    <th scope="col" className="n" style={{ width: "22%" }}>7d</th>
                  </tr>
                </thead>
                <tbody>
                  {padTo(list ?? [], MODULE_ROWS).map((r, i) => r ? (
                    <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
                      <td className="c"><PosBadge pos={pInfo(players, r.pid)[1]} /></td>
                      <td className="t name"><PlayerLink pid={r.pid} name={pInfo(players, r.pid)[0]} /></td>
                      <td className="n fig">{r.val.toLocaleString("en-US")}</td>
                      <td className="n fig strong last" style={{ color: r.d > 0 ? "var(--good)" : "var(--bad)" }}>
                        {sgn(r.d, 0)}
                      </td>
                    </tr>
                  ) : (
                    <tr key={`e${label}${i}`} className={i % 2 ? "zebra" : ""}>
                      <td className="c fig quiet">—</td>
                      <td className="t fig quiet">—</td>
                      <td className="n fig quiet">—</td>
                      <td className="n fig quiet last">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!vals && (
              <div className="tnote" style={{ padding: "8px 10px 10px" }}>
                Waiting on the nightly market pull — values fill in when the KeepTradeCut feed lands.
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ---- module row 1b: dynasty movers, cross-league trade market ----
          The pattern-setter: twin panels split by sign. Packages are priced by
          the trade machine's market lens (KTC band, consolidation-adjusted),
          and the Δ is a percentage of the player's own value on that same
          scale, so a 2,400-point back and a 9,000-point QB are
          commensurable. */}
      <div className="feeds" style={{ padding: "18px var(--pad) 0" }}>
        {([
          [`Dynasty movers · going over value · last ${dyn?.meta.window_days ?? 7} days`, dyn?.overpaid],
          [`Dynasty movers · going under value · last ${dyn?.meta.window_days ?? 7} days`, dyn?.underpaid],
        ] as const).map(([label, list]) => (
          <div className="feed-panel" key={label}>
            <div className="band" style={{ borderTop: "none" }}>
              <span className="band-label">{label}</span>
            </div>
            {mobile ? (
              <div className="records flat">
                {(list ?? []).map((r: DynastyMoverRow, i: number) => (
                  <div key={r.pid} className={`rec${i % 2 ? " zebra" : ""}`}>
                    <div className="rec-l1">
                      <span className="rec-id">
                        {r.pos && <><PosBadge pos={r.pos} />{" "}</>}
                        <PlayerLink pid={r.pid} name={r.name} />
                      </span>
                      <span className="rec-fig" style={{ color: r.avg_delta > 0 ? "var(--good)" : "var(--bad)" }}>
                        {r.avg_pct == null ? "—" : `${sgn(r.avg_pct, 0)}%`}
                      </span>
                      <span className="rec-key">vs value</span>
                    </div>
                    <div className="rec-l2">
                      <span className="mic"><span className="mk">Value</span>
                        <span className="mv">{r.value.toLocaleString("en-US")}</span></span>
                      <span className="mic"><span className="mk">Paid</span>
                        <span className="mv">{r.avg_paid.toLocaleString("en-US")}</span></span>
                      <span className="mic"><span className="mk">Trades</span>
                        <span className="mv">{r.n}</span></span>
                    </div>
                  </div>
                ))}
                {!(list ?? []).length && <div className="empty">—</div>}
              </div>
            ) : (
              <table style={{ tableLayout: "fixed" }} aria-label={label}>
                <thead>
                  <tr>
                    <th scope="col" className="c" style={{ width: "12%" }}>Pos</th>
                    <th scope="col" className="t" style={{ width: "34%" }}>Player</th>
                    <th scope="col" className="n" style={{ width: "10%" }}>Trades</th>
                    <th scope="col" className="n" style={{ width: "15%" }}>Value</th>
                    <th scope="col" className="n" style={{ width: "15%" }}>Paid</th>
                    <th scope="col" className="n" style={{ width: "14%" }}>Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {padTo(list ?? [], MODULE_ROWS).map((r, i) => r ? (
                    <tr key={r.pid} className={i % 2 ? "zebra" : ""}>
                      <td className="c">{r.pos ? <PosBadge pos={r.pos} /> : "—"}</td>
                      <td className="t name"><PlayerLink pid={r.pid} name={r.name} /></td>
                      <td className="n fig">{r.n}</td>
                      <td className="n fig">{r.value.toLocaleString("en-US")}</td>
                      <td className="n fig">{r.avg_paid.toLocaleString("en-US")}</td>
                      <td className="n fig strong last" style={{ color: r.avg_delta > 0 ? "var(--good)" : "var(--bad)" }}>
                        {r.avg_pct == null ? "—" : `${sgn(r.avg_pct, 0)}%`}
                      </td>
                    </tr>
                  ) : (
                    <tr key={`ed${label}${i}`} className={i % 2 ? "zebra" : ""}>
                      {[0, 1, 2, 3, 4, 5].map(k => (
                        <td key={k} className={`${k === 0 ? "c" : k === 1 ? "t" : "n"} fig quiet${k === 5 ? " last" : ""}`}>—</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {!dyn && (
              <div className="tnote" style={{ padding: "8px 10px 10px" }}>
                Waiting on the trade-corpus refresh — movers fill in when dynasty_movers.json lands.
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ---- module row 2: recent waivers + recent trades ---- */}
      <div className="feeds" style={{ padding: "18px var(--pad) 0" }}>
        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Recent waivers</span>
          </div>
          {mobile ? (
            /* records: the team is the subject; the adds and drops each take
               their own full-width line (this is what .feed-stack used to do) */
            <div className="records flat">
              {waivers.map((w, i) => (
                <div key={`${w.ts}${i}`} className={`rec${i % 2 ? " zebra" : ""}`}>
                  <div className="rec-l1">
                    <span className="rec-id">
                      {w.team}
                      <span className="rec-sub">
                        {w.manager} · {w.season.slice(2)} W{w.week} · {w.type === "waiver" ? "waiver" : "free agent"}
                      </span>
                    </span>
                  </div>
                  {!!w.adds?.length && (
                    <div className="rec-line" style={{ color: "var(--good)" }}>+ {w.adds.join(", ")}</div>
                  )}
                  {!!w.drops?.length && (
                    <div className="rec-line" style={{ color: "var(--drop)" }}>− {w.drops.join(", ")}</div>
                  )}
                </div>
              ))}
              {!waivers.length && <div className="empty">—</div>}
            </div>
          ) : (
            <table style={{ tableLayout: "fixed" }} aria-label="Recent waivers, league-wide">
              <thead>
                <tr>
                  <th scope="col" className="t" style={{ width: "13%" }}>Week</th>
                  <th scope="col" className="t" style={{ width: "27%" }}>Team</th>
                  <th scope="col" className="t" style={{ width: "30%" }}>Added</th>
                  <th scope="col" className="t" style={{ width: "30%" }}>Dropped</th>
                </tr>
              </thead>
              <tbody>
                {padTo(waivers, MODULE_ROWS).map((w, i) => w ? (
                  <tr key={`${w.ts}${i}`} className={i % 2 ? "zebra" : ""}>
                    <td className="t">
                      <div className="two-line">
                        <span className="fig">{w.season.slice(2)} W{w.week}</span><br />
                        <span style={{ font: "600 10.5px/1.45 var(--cond)", letterSpacing: ".12em", color: "var(--dim3)" }}>
                          {w.type === "waiver" ? "WAIVER" : "FA"}
                        </span>
                      </div>
                    </td>
                    <td className="t">
                      <div className="two-line">
                        <span style={{ font: "600 13px/1.45 var(--sans)" }}>{w.team}</span><br />
                        <span style={{ font: "400 11.5px/1.45 var(--sans)", color: "var(--dim)" }}>{w.manager}</span>
                      </div>
                    </td>
                    <td className="t sub">
                      <div className="two-line" style={{ color: "var(--good)" }}>
                        {w.adds?.length ? w.adds.join(", ") : "—"}
                      </div>
                    </td>
                    <td className="t sub last">
                      <div className="two-line" style={{ color: "var(--drop)" }}>
                        {w.drops?.length ? w.drops.join(", ") : "—"}
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={`ew${i}`} className={i % 2 ? "zebra" : ""}>
                    {[0, 1, 2, 3].map(k => (
                      <td key={k} className={`t fig quiet${k === 3 ? " last" : ""}`}>
                        <div className="two-line">—</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="feed-panel">
          <div className="band" style={{ borderTop: "none" }}>
            <span className="band-label">Recent trades</span>
            <button type="button" className="dlink" style={{ marginLeft: 12 }}
              onClick={() => nav(lp("/ledger"))}>
              Ledger
            </button>
          </div>
          {mobile ? (
            /* records: stacked, a trade reads as four lines alternating
               franchise and haul — the left rule marks where each side starts */
            <div className="records flat">
              {recentTrades.map((t, i) => (
                <div key={t.key} className={`rec${i % 2 ? " zebra" : ""}`}>
                  <div className="rec-l1">
                    <span className="rec-id" style={{ font: "600 11px/1.4 var(--cond)", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--dim)" }}>
                      {t.season.slice(2)} W{t.week} · {tradeWhen(t.ts).replace(`, ${t.season}`, "").toUpperCase()}
                    </span>
                  </div>
                  {[0, 1].map(k => {
                    const sd = t.sides[k];
                    return (
                      <div key={k} className="rec-side">
                        <div className="side-team">{sd?.team ?? "—"}</div>
                        <div className="side-got">
                          {sd?.got.map(a => a.label.split(" → ")[0]).join(" · ") || "—"}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
              {!recentTrades.length && <div className="empty">—</div>}
            </div>
          ) : (
          <table style={{ tableLayout: "fixed" }} aria-label="Recent trades">
            <thead>
              <tr>
                <th scope="col" className="t" style={{ width: "13%" }}>Week</th>
                <th scope="col" className="t" style={{ width: "43%" }}>Gets</th>
                <th scope="col" className="t" style={{ width: "44%" }}>Gets</th>
              </tr>
            </thead>
            <tbody>
              {padTo(recentTrades, MODULE_ROWS).map((t, i) => t ? (
                <tr key={t.key} className={i % 2 ? "zebra" : ""}>
                  <td className="t">
                    <div className="two-line">
                      <span className="fig">{t.season.slice(2)} W{t.week}</span><br />
                      <span style={{ font: "600 10.5px/1.45 var(--cond)", letterSpacing: ".12em", color: "var(--dim3)" }}>
                        {tradeWhen(t.ts).replace(`, ${t.season}`, "").toUpperCase()}
                      </span>
                    </div>
                  </td>
                  {[0, 1].map(k => {
                    const sd = t.sides[k];
                    return (
                      <td key={k} className={`t${k === 1 ? " last" : ""}`}>
                        <div className="two-line">
                          <span style={{ font: "600 12px/1.45 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase" }}>
                            {sd?.team ?? "—"}
                          </span><br />
                          <span style={{ font: "400 12px/1.45 var(--sans)", color: "var(--txt2)" }}>
                            {sd?.got.map(a => a.label.split(" → ")[0]).join(" · ") || "—"}
                          </span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ) : (
                <tr key={`et${i}`} className={i % 2 ? "zebra" : ""}>
                  {[0, 1, 2].map(k => (
                    <td key={k} className={`t fig quiet${k === 2 ? " last" : ""}`}>
                      <div className="two-line">—</div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      </div>

      <div className="footnote">
        Starter indices price each roster's best legal lineup in that index · value plays (DVI vs CVI, index points) cover rostered players ranked inside the startable top 100 — sell-highs also need a redraft ECR rank, so players known to be out for the year don't read as market inefficiency · market movers (KTC 7-day change) cover rostered players only
      </div>
      <div className="footnote">
        Dynasty movers: trades from the last {dyn?.meta.window_days ?? 7} days across {dyn?.meta.leagues?.toLocaleString("en-US") ?? "—"} crawled superflex leagues · face KTC values, TE-premium-matched per league · packages carry the trade model's consolidation adjustment on non-centerpiece assets · centerpiece attribution · min {dyn?.meta.min_n ?? 3} trades
      </div>
    </>
  );
}
