import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  CviFile, DviFile, Franchises, MatchEntry, Matchups, ProjectionsFile, Team, Weekly,
} from "../lib/types";
import { jl, jlDaily } from "../lib/data";
import { fmt, mean, ord, pct, sd } from "../lib/stats";
import { DEFAULT_LINEUP, optimalLineup, rosterSeasonOf, seasonSeg, weekIndex } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { useSeasonData } from "../lib/useSeasonData";
import DataTable, { applySort, sortCol, type Col, type Grp } from "../components/DataTable";

/**
 * TEAMS — one franchise per row, one season spine (5C).
 *
 * The spine re-scopes a single table rather than stacking modules: the roster
 * season shows the 5C board (last season's result, value now, all-time on the
 * same line), a played season shows that year's standings (absorbed from the
 * old /standings route), and All-time shows the franchise history board. One
 * navigation axis where there used to be three — value rankings, history
 * chips and an off-tab standings page.
 *
 * The League page's power table already ranks rosters by starter DVI as a
 * summary; this page owns the breakdown. If the two ever converge to the same
 * columns, cut this one.
 */
const nul = <span className="fig quiet">—</span>;

export default function FranchisesView() {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const seg = useParams().season;

  const latest = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : meta.seasons[meta.seasons.length - 1];
  const rosterSeason = rosterSeasonOf(league);
  const played = useMemo(
    () => meta.seasons.filter(s => s <= latest).slice().reverse(), [meta, latest]);

  /** "rosters" | "ALL" | a played season */
  const scope = !seg ? "rosters"
    : seg.toLowerCase() === "all" ? "ALL"
      : played.includes(seg) ? seg : "rosters";

  const chip = (label: string, to: string, on: boolean) => (
    <button key={to} type="button" className={`chip ${on ? "on" : ""}`}
      onClick={() => nav(lp(to))}>{label}</button>
  );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Teams</span>
        {chip(`${rosterSeason} rosters`, "/teams", scope === "rosters")}
        {played.map(s => chip(s, `/teams/${seasonSeg(s)}`, scope === s))}
        {chip("All-time", "/teams/all", scope === "ALL")}
      </div>
      {scope === "rosters" ? <RosterBoard latest={latest} />
        : scope === "ALL" ? <HistoryBoard />
          : <SeasonStandings season={scope} />}
    </>
  );
}

/* ---------------------------------------------------------------- 5C board */

interface BoardRow {
  rid: number; name: string; manager: string;
  rec: string | null; recPct: number | null; ppg: number | null;
  lwar: number | null; fin: number | null;
  sDvi: number; sCvi: number; age: number | null;
  allRec: string; winPct: number; titles: number;
}

const BOARD_COLS: Col<BoardRow, Record<string, never>>[] = [
  {
    id: "rk", label: "Rk", grp: 0, w: 4, align: "c", td: "rank",
    cell: (_r, _x, i) => <>
      <span className="spine" style={{ background: i < 4 ? "var(--acc)" : "#2b3642" }} />
      <span className="fig">{i + 1}</span>
    </>,
  },
  {
    id: "team", label: "Franchise", grp: 0, w: 0, align: "t", td: "name", asc: true,
    sort: r => r.name, cell: r => r.name,
  },
  {
    id: "manager", label: "Manager", grp: 0, w: 9, align: "t", hm: true, td: "sub hm",
    sort: r => r.manager, cell: r => r.manager,
  },
  {
    id: "rec", label: "Rec", grp: 1, w: 7, align: "n", edge: true, td: "fig edge n",
    sort: r => r.recPct, cell: r => r.rec ?? nul,
  },
  {
    id: "ppg", label: "PPG", grp: 1, w: 6, align: "n", hm: true, td: "fig quiet hm n",
    sort: r => r.ppg, cell: r => r.ppg == null ? nul : fmt(r.ppg, 1),
  },
  {
    id: "lwar", label: "Lineup WAR", grp: 1, w: 9, align: "n", td: "fig n",
    sort: r => r.lwar, cell: r => r.lwar == null ? nul : fmt(r.lwar, 2),
  },
  // the playoff result, not the seed — a plain tabular ordinal, no tag. The
  // CHAMP treatment stays on the franchise page, where the title is the subject
  {
    id: "fin", label: "Finish", grp: 1, w: 6, align: "n", td: "fig n",
    sort: r => r.fin, asc: true,
    cell: r => r.fin == null ? nul : (
      <span style={{ color: r.fin === 1 ? "var(--acc)" : r.fin <= 6 ? "var(--txt2)" : "var(--dim)" }}>
        {ord(r.fin)}
      </span>
    ),
  },
  // starter totals, bare figures — this table sorts by an index, so nothing
  // in it is metered
  {
    id: "dvi", label: "DVI", grp: 2, w: 7, align: "n", edge: true, keyCol: true, td: "n edge",
    sort: r => r.sDvi, cell: r => <span className="head-fig sm">{fmt(r.sDvi, 0)}</span>,
  },
  {
    id: "cvi", label: "CVI", grp: 2, w: 7, align: "n", td: "n",
    sort: r => r.sCvi, cell: r => <span className="head-fig sm" style={{ color: "var(--txt2)" }}>{fmt(r.sCvi, 0)}</span>,
  },
  // context, not a verdict — uncoloured; the League power table carries the
  // green/amber age read
  {
    id: "age", label: "Age", grp: 2, w: 6, align: "n", hm: true, td: "hm n",
    sort: r => r.age, cell: r => <span style={{ color: "var(--txt2)" }}>{r.age == null ? "—" : fmt(r.age, 1)}</span>,
  },
  {
    id: "allrec", label: "Record", grp: 3, w: 9, align: "n", edge: true, td: "fig edge n",
    sort: r => r.winPct, cell: r => r.allRec,
  },
  {
    id: "titles", label: "Titles", grp: 3, w: 6, align: "n", td: "n",
    sort: r => r.titles,
    cell: r => r.titles
      ? <span className="head-fig sm" style={{ color: "var(--acc)" }}>{r.titles}</span> : nul,
  },
];

function RosterBoard({ latest }: { latest: string }) {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const rosterSeason = rosterSeasonOf(league);
  const [fr, setFr] = useState<Franchises | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [dvi, setDvi] = useState<DviFile | null>(null);
  const [cvi, setCvi] = useState<CviFile | null>(null);
  const [projs, setProjs] = useState<ProjectionsFile | null>(null);
  const [sortId, setSortId] = useState("dvi");
  const [dir, setDir] = useState(-1);

  useEffect(() => {
    let live = true;
    const set = <T,>(f: (v: T) => void) => (v: T) => { if (live) f(v); };
    jl<Franchises>("franchises.json").then(set(setFr)).catch(() => {});
    jl<Team[]>(`${rosterSeason}/teams.json`).then(set(setTeams)).catch(() => {});
    jlDaily<DviFile>("dvi.json").then(set(setDvi)).catch(() => {});
    jlDaily<CviFile>("cvi.json").then(set(setCvi)).catch(() => {});
    jl<ProjectionsFile>("projections.json").then(set(setProjs)).catch(() => {});
    return () => { live = false; };
  }, [rosterSeason]);

  /**
   * Starters = the roster's best legal lineup optimised IN that currency, not
   * the lineup as set. Each index gets its own optimal lineup: the best
   * win-now nine and the best dynasty nine can differ, and pricing one lineup
   * in the other's currency would understate every roster whose veterans and
   * prospects split the two roles.
   */
  const rows = useMemo<BoardRow[] | null>(() => {
    if (!teams || !dvi || !cvi || !fr) return null;
    const lineup = meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP;
    const ageOf = new Map((projs?.players ?? []).map(p => [p.pid, p.age]));
    const price = (t: Team, idx: Record<string, { pos: string }>, of: (pid: string) => number) => {
      const pool = t.players.filter(p => idx[p])
        .map(p => ({ id: p, pos: idx[p].pos, war: of(p) }));
      return optimalLineup(pool, lineup);
    };
    return teams.map(t => {
      const d = price(t, dvi.players, p => dvi.players[p].dvi);
      const c = price(t, cvi.players, p => cvi.players[p].cvi);
      const sDvi = d.slots.reduce((a, sl) => a + (sl.player?.war ?? 0), 0);
      const sCvi = c.slots.reduce((a, sl) => a + (sl.player?.war ?? 0), 0);
      // average age of the best nine by DVI — context, not a verdict
      const ages = d.slots.map(sl => sl.player && ageOf.get(sl.player.id))
        .filter((a): a is number => a != null);
      const f = fr[String(t.roster_id)];
      const cur = f?.seasons[f.seasons.length - 1];
      const sn = f?.seasons.find(s => s.season === latest);
      const all = (f?.seasons ?? []).reduce(
        (a, s) => ({ w: a.w + s.wins, l: a.l + s.losses, t: a.t + (s.ties || 0) }),
        { w: 0, l: 0, t: 0 });
      const games = all.w + all.l + all.t;
      const g = sn ? sn.wins + sn.losses + (sn.ties || 0) : 0;
      return {
        rid: t.roster_id, name: cur?.name ?? t.team, manager: cur?.manager ?? t.manager,
        rec: sn ? `${sn.wins}-${sn.losses}${sn.ties ? `-${sn.ties}` : ""}` : null,
        recPct: sn && g ? (sn.wins + (sn.ties || 0) / 2) / g : null,
        ppg: sn?.ppg ?? null, lwar: sn?.war ?? null, fin: sn?.finish ?? null,
        sDvi, sCvi, age: ages.length ? mean(ages) : null,
        allRec: `${all.w}-${all.l}${all.t ? `-${all.t}` : ""}`,
        winPct: games ? (all.w + all.t / 2) / games : 0,
        titles: (f?.seasons ?? []).filter(s => s.finish === 1).length,
      };
    });
  }, [teams, dvi, cvi, fr, projs, meta, latest]);

  const groups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label: `${latest} season`, cls: "edge" },
    { id: 2, label: `Value now · ${rosterSeason}`, cls: "edge value" },
    { id: 3, label: "All-time", cls: "edge" },
  ];

  const sorted = useMemo(
    () => rows ? applySort(rows, sortCol(BOARD_COLS, sortId, "dvi"), dir) : null,
    [rows, sortId, dir]);

  const onSort = (c: Col<BoardRow, Record<string, never>>) => {
    if (c.id === "rk") { setSortId("dvi"); setDir(-1); return; }
    if (!c.sort) return;
    if (sortId === c.id) setDir(-dir);
    else { setSortId(c.id); setDir(c.asc ? 1 : -1); }
  };

  if (!sorted) return <div className="empty">Loading rosters…</div>;
  return (
    <>
      <DataTable cols={BOARD_COLS} groups={groups} rows={sorted} ctx={{}}
        rowKey={r => String(r.rid)} sortId={sortId} dir={dir} onSort={onSort}
        homeCol="rk" onRowClick={r => nav(lp(`/franchise/${r.rid}`))} />
      <div className="tnote" style={{ padding: "10px var(--pad) 22px", marginTop: 0 }}>
        Sorted by starters DVI — every header re-sorts, a row opens the franchise page.
        Lineup WAR is what the manager actually fielded in {latest}, so it separates a
        roster that was good from one that was well managed. Starters DVI and CVI each
        price the roster's best legal lineup in their own index — the best dynasty nine
        and the best win-now nine can differ — and age is the average of the best nine
        by DVI. Finish is the playoff result, not the seed.
      </div>
    </>
  );
}

/* ------------------------------------------------- a played season's table */

interface StandRow {
  rid: number; seed: number; team: string; manager: string;
  wins: number; fpts: number; rec: string; med: string; luck: number;
  ppg: number; sdv: number; war: number; ent: MatchEntry[];
}
interface StandCtx { warMax: number }

const luckStr = (l: number) => (l > 0 ? "+" : l < 0 ? "−" : "") + Math.abs(l);
const luckColor = (l: number) => l === 0 ? "var(--dim)" : l > 0 ? "var(--good)" : "var(--bad)";

function SeasonStandings({ season }: { season: string }) {
  const { league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const data = useSeasonData(season);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [err, setErr] = useState(false);
  const [reload, setReload] = useState(0);
  const [openRid, setOpenRid] = useState<number | null>(null);
  const [sortId, setSortId] = useState("seed");
  const [dir, setDir] = useState(1);

  useEffect(() => {
    let live = true;
    setErr(false);
    setOpenRid(null);
    setSortId("seed");
    setDir(1);
    Promise.all([
      jl<Weekly>(`${season}/weekly.json`),
      jl<Matchups>(`${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [season, reload, league]);

  const rows = useMemo<StandRow[]>(() => {
    if (!data || !mw || !weekly) return [];
    const wkIdx = weekIndex(weekly);
    const ps = mw.playoff_start || 15;
    const weekPts: Record<number, number[]> = {};
    for (const list of Object.values(mw.teams))
      for (const e of list) if (e[0] < ps) (weekPts[e[0]] ??= []).push(e[1]);
    const medians: Record<number, number> = {};
    for (const [wk, pts] of Object.entries(weekPts)) {
      const v = pts.slice().sort((a, b) => a - b), n = v.length;
      medians[+wk] = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }
    const rs = data.teams.map(t => {
      const ent = mw.teams[String(t.roster_id)] || [];
      const reg = ent.filter(e => e[0] < ps);
      const pts = reg.map(e => e[1]);
      let war = 0;
      for (const e of reg) for (const p of e[4]) {
        const v = wkIdx[p]?.[e[0]];
        if (v) war += v[1];
      }
      let mwin = 0, mloss = 0, mtie = 0;
      for (const e of reg) {
        const m = medians[e[0]];
        if (m == null) continue;
        e[1] > m ? mwin++ : e[1] < m ? mloss++ : mtie++;
      }
      const g = t.wins + t.losses + t.ties;
      return {
        rid: t.roster_id, seed: 0, team: t.team, manager: t.manager,
        wins: t.wins, fpts: t.fpts,
        rec: `${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}`,
        med: `${mwin}-${mloss}${mtie ? "-" + mtie : ""}`, luck: t.wins - mwin,
        ppg: pts.length ? mean(pts) : (g ? t.fpts / g : 0),
        sdv: sd(pts), war, ent,
      };
    });
    const seedOrder = rs.slice().sort((a, b) => b.wins - a.wins || b.fpts - a.fpts);
    rs.forEach(r => { r.seed = seedOrder.indexOf(r) + 1; });
    return rs;
  }, [data, mw, weekly]);

  const cols = useMemo<Col<StandRow, StandCtx>[]>(() => [
    {
      id: "seed", label: "Seed", grp: 0, w: 5, align: "c", td: "rank", asc: true,
      sort: r => r.seed,
      cell: r => <>
        <span className="spine" style={{ background: r.seed <= 6 ? "var(--acc)" : "#2b3642" }} />
        <span className="fig">{r.seed}</span>
      </>,
    },
    {
      id: "team", label: "Franchise", grp: 0, w: 0, align: "t", td: "name", asc: true,
      sort: r => r.team,
      cell: r => (
        <span className="tlink"
          onClick={e => { e.stopPropagation(); nav(lp(`/franchise/${r.rid}`)); }}>
          {r.team}
        </span>
      ),
    },
    {
      id: "manager", label: "Manager", grp: 0, w: 11, align: "t", hm: true, td: "sub hm",
      sort: r => r.manager, cell: r => r.manager,
    },
    {
      id: "rec", label: "Record", grp: 1, w: 8, align: "n", edge: true, td: "edge n",
      sort: r => r.wins * 10000 + r.fpts,
      cell: r => <span style={{ font: "600 20px/1 var(--cond)" }}>{r.rec}</span>,
    },
    {
      id: "med", label: "Vs median", grp: 1, w: 9, align: "n", hm: true,
      td: "fig quiet hm n", sort: r => r.luck, cell: r => r.med,
    },
    {
      id: "luck", label: "Luck", grp: 1, w: 7, align: "n", td: "n",
      sort: r => r.luck,
      cell: r => <span style={{ font: "600 15px/1.4 var(--cond)", color: luckColor(r.luck) }}>{luckStr(r.luck)}</span>,
    },
    {
      id: "ppg", label: "PPG", grp: 2, w: 8, align: "n", edge: true, td: "fig strong edge n",
      sort: r => r.ppg, cell: r => fmt(r.ppg, 1),
    },
    {
      id: "sdv", label: "Volatility", grp: 2, w: 8, align: "n", hm: true,
      td: "fig quiet hm n", sort: r => r.sdv, cell: r => fmt(r.sdv, 1),
    },
    {
      id: "war", label: "Lineup WAR", grp: 2, w: 16, align: "n", keyCol: true, td: "n",
      sort: r => r.war,
      cell: (r, x) => (
        <div className="meter-row">
          <div className="meter"><i style={{ width: pct(Math.max(0, r.war), x.warMax) }} /></div>
          <span className="fig">{fmt(r.war, 3)}</span>
        </div>
      ),
    },
  ], [nav, lp]);

  const groups: Grp[] = [
    { id: 0, label: "", cls: "" },
    { id: 1, label: "Results", cls: "edge" },
    { id: 2, label: "Scoring & value", cls: "edge value" },
  ];

  const ctx: StandCtx = { warMax: Math.max(0.01, ...rows.map(r => r.war)) };
  const sorted = useMemo(
    () => applySort(rows, sortCol(cols, sortId, "seed"), dir), [rows, cols, sortId, dir]);

  const onSort = (c: Col<StandRow, StandCtx>) => {
    if (!c.sort) return;
    if (sortId === c.id) setDir(-dir);
    else { setSortId(c.id); setDir(c.asc ? 1 : -1); }
  };

  if (err) return (
    <div className="empty">Couldn't load team data.{" "}
      <button className="retry" onClick={() => setReload(n => n + 1)}>Retry</button>
    </div>
  );
  if (!data || !mw || !weekly) return <div className="empty">Loading…</div>;
  if (!data.summary.length) return (
    <div className="empty">
      No scored weeks for {season} yet — the roster board is the preseason read.
    </div>
  );

  const tnames: Record<number, string> = {};
  data.teams.forEach(t => { tnames[t.roster_id] = t.team; });
  const ps = mw.playoff_start || 15;

  return (
    <>
      <DataTable cols={cols} groups={groups} rows={sorted} ctx={ctx}
        rowKey={r => String(r.rid)} sortId={sortId} dir={dir} onSort={onSort}
        homeCol="seed" openKey={openRid != null ? String(openRid) : null}
        onRowClick={r => setOpenRid(openRid === r.rid ? null : r.rid)}
        renderDrawer={r => <TeamDrawer r={r} tnames={tnames} ps={ps} />} />
      <div className="tnote" style={{ padding: "10px var(--pad) 22px", marginTop: 0 }}>
        Playoffs from week {ps}, top 6 seeds. Vs median is the record against each
        week's league median score; luck is actual wins minus median wins. Lineup WAR
        sums each week's real starters, measured against the league-wide optimal pool.
        Open a row for the week-by-week results.
      </div>
    </>
  );
}

/** One season as a wrap of week cards, inline beneath the clicked row. */
function TeamDrawer({ r, tnames, ps }: { r: StandRow; tnames: Record<number, string>; ps: number }) {
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="drawer-title">{r.team}</span>
        <span className="drawer-sub">{r.manager} · {r.rec} · {fmt(r.ppg, 1)} ppg · lineup WAR {fmt(r.war, 3)}</span>
      </div>
      <div className="week-grid">
        {r.ent.filter(e => e[0] < ps).map(e => {
          const [wk, pts, opp, oppPts] = e;
          const res = oppPts == null ? "—" : pts > oppPts ? "W" : pts < oppPts ? "L" : "T";
          const cls = res === "W" ? "win" : res === "L" ? "loss" : "";
          return (
            <div key={wk} className={`week-card ${cls}`}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span className="wk">W{wk}</span>
                <span className="res" style={{ color: res === "W" ? "var(--good)" : res === "L" ? "var(--bad)" : "var(--dim)" }}>{res}</span>
              </div>
              <div className="score">{fmt(pts, 1)}</div>
              <div className="opp">vs {opp != null ? tnames[opp] || "?" : "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- all-time */

interface HistRow {
  rid: number; name: string; manager: string;
  allRec: string; winPct: number; seasons: number;
  best: number | null; bestSeason: string | null; titles: number;
}

const HIST_COLS: Col<HistRow, Record<string, never>>[] = [
  {
    id: "rk", label: "Rk", grp: 0, w: 4, align: "c", td: "rank",
    cell: (_r, _x, i) => <>
      <span className="spine" style={{ background: "#2b3642" }} />
      <span className="fig">{i + 1}</span>
    </>,
  },
  {
    id: "team", label: "Franchise", grp: 0, w: 0, align: "t", td: "name", asc: true,
    sort: r => r.name, cell: r => r.name,
  },
  {
    id: "manager", label: "Manager", grp: 0, w: 12, align: "t", hm: true, td: "sub hm",
    sort: r => r.manager, cell: r => r.manager,
  },
  {
    id: "allrec", label: "All-time record", grp: 1, w: 12, align: "n", edge: true,
    td: "fig edge n", sort: r => r.winPct, cell: r => r.allRec,
  },
  {
    id: "winPct", label: "Win %", grp: 1, w: 8, align: "n", keyCol: true, td: "fig n",
    sort: r => r.winPct, cell: r => `${fmt(r.winPct * 100, 0)}%`,
  },
  {
    id: "seasons", label: "Seasons", grp: 1, w: 8, align: "n", hm: true,
    td: "fig quiet hm n", sort: r => r.seasons, cell: r => r.seasons,
  },
  {
    id: "best", label: "Best", grp: 2, w: 9, align: "n", edge: true, asc: true,
    td: "edge n", sort: r => r.best,
    cell: r => r.best == null ? nul : (
      <>
        <span className="fig" style={{ color: r.best === 1 ? "var(--acc)" : "var(--txt2)" }}>{ord(r.best)}</span>
        <div style={{ font: "400 11.5px/1.4 var(--sans)", color: "var(--dim)" }}>{r.bestSeason}</div>
      </>
    ),
  },
  {
    id: "titles", label: "Titles", grp: 2, w: 7, align: "n", td: "n",
    sort: r => r.titles,
    cell: r => r.titles
      ? <span className="head-fig sm" style={{ color: "var(--acc)" }}>{r.titles}</span> : nul,
  },
];

const HIST_GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Record", cls: "edge" },
  { id: 2, label: "Finishes", cls: "edge" },
];

function HistoryBoard() {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [fr, setFr] = useState<Franchises | null>(null);
  const [sortId, setSortId] = useState("winPct");
  const [dir, setDir] = useState(-1);

  useEffect(() => {
    let live = true;
    jl<Franchises>("franchises.json").then(f => { if (live) setFr(f); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const rows = useMemo<HistRow[] | null>(() => {
    if (!fr) return null;
    return Object.entries(fr).map(([rid, f]) => {
      const all = f.seasons.reduce(
        (a, sn) => ({ w: a.w + sn.wins, l: a.l + sn.losses, t: a.t + (sn.ties || 0) }),
        { w: 0, l: 0, t: 0 });
      const games = all.w + all.l + all.t;
      const bestSn = f.seasons.filter(sn => sn.finish != null)
        .reduce<(typeof f.seasons)[number] | null>(
          (b, sn) => !b || sn.finish! < b.finish! || (sn.finish === b.finish && sn.season > b.season)
            ? sn : b, null);
      const cur = f.seasons[f.seasons.length - 1];
      return {
        rid: +rid, name: cur?.name ?? "—", manager: cur?.manager ?? "—",
        allRec: `${all.w}-${all.l}${all.t ? `-${all.t}` : ""}`,
        winPct: games ? (all.w + all.t / 2) / games : 0,
        seasons: f.seasons.filter(sn => sn.wins + sn.losses > 0).length,
        best: bestSn?.finish ?? null, bestSeason: bestSn?.season ?? null,
        titles: f.seasons.filter(sn => sn.finish === 1).length,
      };
    });
  }, [fr]);

  const sorted = useMemo(
    () => rows ? applySort(rows, sortCol(HIST_COLS, sortId, "winPct"), dir) : null,
    [rows, sortId, dir]);

  const onSort = (c: Col<HistRow, Record<string, never>>) => {
    if (c.id === "rk") { setSortId("winPct"); setDir(-1); return; }
    if (!c.sort) return;
    if (sortId === c.id) setDir(-dir);
    else { setSortId(c.id); setDir(c.asc ? 1 : -1); }
  };

  if (!sorted) return <div className="empty">Loading history…</div>;
  return (
    <>
      <DataTable cols={HIST_COLS} groups={HIST_GROUPS} rows={sorted} ctx={{}}
        rowKey={r => String(r.rid)} sortId={sortId} dir={dir} onSort={onSort}
        homeCol="rk" onRowClick={r => nav(lp(`/franchise/${r.rid}`))} />
      <div className="tnote" style={{ padding: "10px var(--pad) 22px", marginTop: 0 }}>
        All-time spans every season the franchise has played; win % counts a tie as
        half a win. Best is the franchise's best playoff finish and the year it
        happened. A row opens the franchise page — roster, strengths, picks and
        transaction history.
      </div>
    </>
  );
}
