import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { CviFile, DviFile, EcrFile, ProjectionsFile, Team, Values } from "../lib/types";
import { jDaily, jl, jlDaily } from "../lib/data";
import { fmt, pct } from "../lib/stats";
import { ownerOf, pInfo, rosterSeasonOf, seasonSeg, POS_CHIPS, POS_COLOR } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { useSeasonData } from "../lib/useSeasonData";
import { PlayerLink } from "../components/PlayerLink";
import PlayerPanel from "../components/PlayerPanel";
import AllTimePanel from "../components/AllTimePanel";
import DataTable, { applySort, sortCol, type Col, type Grp } from "../components/DataTable";

/**
 * PLAYERS — the full-population leaderboard (4A lens switch).
 *
 * One table, one population, a lens control that swaps the numeric column
 * groups: current value, the market's read, or a played season's record. The
 * identity columns hold across lenses so rows stay recognisable. This screen
 * absorbed the old Hub / Value / Stats three-page split — /value and
 * /stats/:season redirect into the right lens.
 *
 * The Market lens is a deviation from the design handoff, which assumes no
 * market feed exists: values.json (KTC + FantasyCalc) and ecr.json are real
 * and nightly, and folding them into a lens preserves the old Value page's
 * market columns without busting the ten-column cap.
 *
 * The row drawer opens INLINE beneath the clicked row (DataTable emits it in
 * the table flow), and the position badge carries rank within position for the
 * active sort — RB4 is the fourth-best RB by whatever the table is ordered by.
 */
interface Row {
  id: string; nm: string; pos: string; nfl: string; team: string;
  /** rank within position for the ACTIVE sort — assigned after sorting */
  posRank: number;
  /* value lens */
  dvi: number | null; cvi: number | null; war1: number | null;
  /* market lens */
  ktc: number | null; fc: number | null; ecr: number | null;
  /* season lenses */
  gp: number; pts: number; ppg: number; sdv: number; war: number; warG: number;
}

interface Ctx { warMax: number }

const nul = <span className="fig quiet">—</span>;
/** indices are bare figures, never metered — clamped 0–100 scores */
const idxCell = (v: number | null) => v == null ? nul : <span className="head-fig md">{v.toFixed(1)}</span>;
const srcCell = (v: number | null, text: string) => v == null ? nul : <span className="head-fig src">{text}</span>;

const IDENTITY: Col<Row, Ctx>[] = [
  {
    id: "rk", label: "Rk", grp: 0, w: 4, align: "c", td: "rank",
    cell: (r, _x, i) => <>
      <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule)" }} />
      <span className="fig">{i + 1}</span>
    </>,
  },
  {
    id: "nm", label: "Player", grp: 0, w: 0, align: "t", td: "name", asc: true,
    sort: r => r.nm, cell: r => <PlayerLink pid={r.id} name={r.nm} />,
  },
  {
    id: "pos", label: "Pos", grp: 0, w: 6, align: "c", td: "c",
    cell: r => <span className={`pos ${r.pos}`}>{r.pos}{r.posRank || ""}</span>,
  },
  {
    id: "nfl", label: "NFL", grp: 0, w: 6, align: "c", hm: true, td: "sub hm c",
    sort: r => r.nfl, cell: r => r.nfl || "—",
  },
  {
    id: "team", label: "Roster", grp: 0, w: 14, align: "t", hm: true, td: "sub hm",
    sort: r => r.team, cell: r => r.team,
  },
];

/* Value now — DVI, CVI, projected WAR. Sorted by an index, so NO metered
 * column at all: metering anything else would imply it drove the sort. */
const VALUE_COLS: Col<Row, Ctx>[] = [
  ...IDENTITY,
  {
    id: "dvi", label: "DVI", grp: 1, w: 10, align: "n", edge: true, keyCol: true,
    td: "n edge", sort: r => r.dvi, cell: r => idxCell(r.dvi),
  },
  {
    id: "cvi", label: "CVI", grp: 1, w: 10, align: "n", td: "n",
    sort: r => r.cvi, cell: r => idxCell(r.cvi),
  },
  {
    id: "war1", label: "Proj WAR", grp: 1, w: 11, align: "n", td: "fig n",
    sort: r => r.war1, cell: r => r.war1 == null ? nul : fmt(r.war1, 3),
  },
];
const VALUE_GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Value now", cls: "edge value" },
];

/* Market — two dynasty prices in their own currencies, plus the win-now
 * consensus rank. All bare figures; none of these share a scale. */
const MARKET_COLS: Col<Row, Ctx>[] = [
  ...IDENTITY,
  {
    id: "ktc", label: "KTC", grp: 1, w: 10, align: "n", edge: true, keyCol: true,
    td: "n edge", sort: r => r.ktc, cell: r => srcCell(r.ktc, r.ktc?.toLocaleString() ?? ""),
  },
  {
    id: "fc", label: "FantasyCalc", grp: 1, w: 11, align: "n", td: "n",
    sort: r => r.fc, cell: r => srcCell(r.fc, r.fc?.toLocaleString() ?? ""),
  },
  // a RANK: lower is better, sorts ascending first, unranked falls last
  {
    id: "ecr", label: "ECR", grp: 2, w: 10, align: "n", edge: true, asc: true,
    td: "n edge", sort: r => r.ecr, cell: r => srcCell(r.ecr, String(r.ecr)),
  },
];
const MARKET_GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Dynasty market", cls: "edge value" },
  { id: 2, label: "Consensus", cls: "edge" },
];

/* A played season — what the player actually did. WAR is the one metered
 * column; volatility is a bare σ figure (the header says what it is). */
const seasonCols = (allTime: boolean): Col<Row, Ctx>[] => [
  ...IDENTITY,
  {
    id: "gp", label: "GP", grp: 1, w: 6, align: "n", edge: true,
    td: "fig quiet edge n", sort: r => r.gp, cell: r => r.gp,
  },
  ...(allTime ? [{
    id: "pts", label: "Pts", grp: 1, w: 8, align: "n", hm: true,
    td: "fig hm n", sort: (r: Row) => r.pts, cell: (r: Row) => fmt(r.pts, 1),
  } as Col<Row, Ctx>] : []),
  {
    id: "ppg", label: "PPG", grp: 1, w: 7, align: "n", td: "fig strong n",
    sort: r => r.ppg, cell: r => fmt(r.ppg),
  },
  ...(allTime ? [] : [{
    id: "sdv", label: "Volatility", grp: 1, w: 8, align: "n", hm: true,
    td: "fig quiet hm n", sort: (r: Row) => r.sdv, cell: (r: Row) => fmt(r.sdv, 1),
  } as Col<Row, Ctx>]),
  {
    id: "war", label: "WAR", grp: 2, w: 15, align: "n", edge: true, keyCol: true,
    td: "n edge", sort: r => r.war,
    cell: (r, x) => (
      <div className="meter-row">
        <div className="meter"><i style={{ width: pct(Math.max(0, r.war), x.warMax) }} /></div>
        <span className="fig">{fmt(r.war, 3)}</span>
      </div>
    ),
  },
  {
    id: "warG", label: "WAR/G", grp: 2, w: 8, align: "n", hm: true,
    td: "fig quiet hm n", sort: r => r.warG, cell: r => fmt(r.warG, 3),
  },
];
const SEASON_GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Production", cls: "edge" },
  { id: 2, label: "Wins added", cls: "edge value" },
];

export default function PlayersHub() {
  const { meta, players, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const seg = useParams().season;

  const latest = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : meta.seasons[meta.seasons.length - 1];
  const rosterSeason = rosterSeasonOf(league);
  const played = useMemo(
    () => meta.seasons.filter(s => s <= latest).slice().reverse(), [meta, latest]);

  /** "value" | "market" | "ALL" | a played season */
  const lens = !seg ? "value"
    : seg === "market" ? "market"
      : seg.toLowerCase() === "all" ? "ALL"
        : played.includes(seg) ? seg : "value";
  const isSeasonLens = lens !== "value" && lens !== "market";

  const data = useSeasonData(isSeasonLens ? lens : null);

  // value/market sources — fetched only when one of those lenses is up
  const [projs, setProjs] = useState<ProjectionsFile | null>(null);
  const [dvi, setDvi] = useState<DviFile | null>(null);
  const [cvi, setCvi] = useState<CviFile | null>(null);
  const [vals, setVals] = useState<Values | null>(null);
  const [ecr, setEcr] = useState<EcrFile | null>(null);
  const [curTeams, setCurTeams] = useState<Team[] | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (isSeasonLens || ready) return;
    let live = true;
    Promise.allSettled([
      jl<ProjectionsFile>("projections.json"),
      jlDaily<DviFile>("dvi.json"),
      jlDaily<CviFile>("cvi.json"),
      // global files: the market and the consensus price a format, not a league
      jDaily<Values>("data/values.json"),
      jDaily<EcrFile>("data/ecr.json"),
      jl<Team[]>(`${rosterSeason}/teams.json`),
    ]).then(([p, d, c, v, e, t]) => {
      if (!live) return;
      if (p.status === "fulfilled") setProjs(p.value);
      if (d.status === "fulfilled") setDvi(d.value);
      if (c.status === "fulfilled") setCvi(c.value);
      if (v.status === "fulfilled") setVals(v.value);
      if (e.status === "fulfilled") setEcr(e.value);
      if (t.status === "fulfilled") setCurTeams(t.value);
      setReady(true);
    });
    return () => { live = false; };
  }, [isSeasonLens, ready, rosterSeason]);

  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");
  const [sortId, setSortId] = useState("dvi");
  const [dir, setDir] = useState(-1);
  const [openPid, setOpenPid] = useState<string | null>(null);

  const homeSort = lens === "value" ? "dvi" : lens === "market" ? "ktc" : "war";
  // a lens change resets to that lens's resting order and closes the drawer
  useEffect(() => {
    setSortId(homeSort);
    setDir(-1);
    setOpenPid(null);
  }, [lens, homeSort]);

  const cols = lens === "value" ? VALUE_COLS
    : lens === "market" ? MARKET_COLS
      : seasonCols(lens === "ALL");
  const groups = lens === "value" ? VALUE_GROUPS
    : lens === "market" ? MARKET_GROUPS : SEASON_GROUPS;

  const { rows, count, ctx } = useMemo(() => {
    const blank = (id: string, nm: string, p: string): Row => ({
      id, nm, pos: p, nfl: pInfo(players, id)[2], team: "—", posRank: 0,
      dvi: null, cvi: null, war1: null, ktc: null, fc: null, ecr: null,
      gp: 0, pts: 0, ppg: 0, sdv: 0, war: 0, warG: 0,
    });
    let all: Row[];
    if (isSeasonLens) {
      const owners = data ? ownerOf(data.teams) : {};
      all = (data?.summary ?? []).map(r => {
        const [id, p, gp, pts, ppg, , war, sdv] = r;
        return {
          ...blank(id, pInfo(players, id)[0], p), team: owners[id] || "—",
          gp, pts, ppg, sdv: sdv || 0, war, warG: gp ? war / gp : 0,
        };
      });
      // floor tiny samples out of the leaderboard, same 45%-of-max rule the
      // old Stats page used
      const gpMax = all.reduce((m, r) => Math.max(m, r.gp), 0);
      const floor = Math.round(gpMax * 0.45);
      all = all.filter(r => r.gp >= floor);
    } else {
      // union, not intersection: DVI scores players with no projection, and
      // dropping either side would make the lens disagree with its source
      const byId = new Map<string, Row>();
      const owners = curTeams ? ownerOf(curTeams) : {};
      for (const p of projs?.players ?? []) {
        byId.set(p.pid, {
          ...blank(p.pid, p.name, p.pos),
          war1: p.composite?.[0] ?? null,
        });
      }
      for (const [pid, r] of Object.entries(dvi?.players ?? {})) {
        const row = byId.get(pid) ?? blank(pid, r.name, r.pos);
        row.dvi = r.dvi;
        byId.set(pid, row);
      }
      for (const [pid, r] of Object.entries(cvi?.players ?? {})) {
        const row = byId.get(pid) ?? blank(pid, r.name, r.pos);
        row.cvi = r.cvi;
        byId.set(pid, row);
      }
      // prices attach to known players, never create rows — values.json is
      // global and would otherwise flood the page with unrostered players
      for (const [pid, r] of Object.entries(vals?.players ?? {})) {
        const row = byId.get(pid);
        if (!row) continue;
        row.ktc = r.ktc ?? null;
        row.fc = r.fc ?? null;
      }
      const slug = Object.keys(ecr?.formats ?? {})[0];
      if (slug) for (const [pid, byFmt] of Object.entries(ecr?.players ?? {})) {
        const row = byId.get(pid);
        const e = byFmt[slug];
        if (row && e) row.ecr = e.ecr ?? null;
      }
      all = [...byId.values()];
      all.forEach(r => { r.team = owners[r.id] || "—"; });
    }

    const ctx: Ctx = { warMax: Math.max(0.01, ...all.map(r => r.war)) };
    // sort the FULL population first, then assign position rank from that
    // order, then filter — so RB4 stays RB4 inside the RB-only view
    const sorted = applySort(all, sortCol(cols, sortId, homeSort), dir);
    const counters: Record<string, number> = {};
    sorted.forEach(r => {
      counters[r.pos] = (counters[r.pos] ?? 0) + 1;
      r.posRank = counters[r.pos];
    });
    let rs = sorted;
    if (pos !== "ALL") rs = rs.filter(r => r.pos === pos);
    if (q) rs = rs.filter(r => r.nm.toLowerCase().includes(q.toLowerCase()));
    return { rows: rs, count: rs.length, ctx };
  }, [isSeasonLens, data, projs, dvi, cvi, vals, ecr, curTeams, players, pos, q, sortId, dir, cols, homeSort]);

  const onSort = (c: Col<Row, Ctx>) => {
    if (c.id === "rk") { setSortId(homeSort); setDir(-1); return; }
    if (!c.sort) return;
    if (sortId === c.id) setDir(-dir);
    else { setSortId(c.id); setDir(c.asc ? 1 : -1); }
  };

  const lensChip = (label: string, to: string, on: boolean) => (
    <button key={to} type="button" className={`chip ${on ? "on" : ""}`}
      onClick={() => nav(lp(to))}>{label}</button>
  );

  const note = lens === "value"
    ? <>{dvi?.generated ? `Priced ${dvi.generated} · ` : ""}<b>{count}</b> shown</>
    : lens === "market"
      ? <>{vals?.fetched ? `Market ${vals.fetched} · ` : ""}<b>{count}</b> shown</>
      : lens === "ALL"
        ? <>All seasons · <b>{count}</b> shown</>
        : <>Regular season · <b>{count}</b> shown</>;

  const loading = isSeasonLens ? !data : !ready;
  const emptySeason = isSeasonLens && data != null && data.summary.length === 0;

  const renderDrawer = (r: Row) =>
    lens === "ALL"
      ? data && (
        <div className="drawer">
          <AllTimePanel pid={r.id} data={data} seasons={meta.seasons}
            teams={data.teams} players={players} />
        </div>
      )
      : (
        <PlayerPanel pid={r.id} season={isSeasonLens ? lens : latest}
          teams={(isSeasonLens ? data?.teams : curTeams) ?? []} players={players} />
      );

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Players</span>
        {lensChip("Value now", "/players", lens === "value")}
        {lensChip("Market", "/players/market", lens === "market")}
        {played.map(s => lensChip(s, `/players/${seasonSeg(s)}`, lens === s))}
        {lensChip("All-time", "/players/all", lens === "ALL")}
        <span className="screen-note">{note}</span>
      </div>
      <div className="screen-head" style={{ paddingTop: 0 }}>
        {POS_CHIPS.map(p => (
          <button key={p} className={`chip ${pos === p ? "on" : ""}`}
            onClick={() => { setPos(p); setOpenPid(null); }}>{p === "ALL" ? "All" : p}</button>
        ))}
        <input type="search" placeholder="Search player…" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      {loading ? <div className="empty">Loading…</div>
        : emptySeason ? (
          <div className="empty">
            No scored weeks yet for {lens} — the preseason answer is a projection,
            and projections are in the Value now lens.
          </div>
        ) : (
          <DataTable cols={cols} groups={groups} rows={rows} ctx={ctx} rowKey={r => r.id}
            sortId={sortId} dir={dir} onSort={onSort} homeCol="rk" openKey={openPid}
            onRowClick={r => setOpenPid(openPid === r.id ? null : r.id)}
            renderDrawer={renderDrawer} />
        )}

      <div className="tnote" style={{ padding: "10px var(--pad) 22px", marginTop: 0 }}>
        {lens === "value" && <>
          DVI prices the dynasty horizon and CVI the coming season — both 0–100 indices,
          bare figures by design. Proj WAR is the model's composite for the coming season.
          A DVI with no market behind it is still scored on whatever signals remain, so a
          low figure can mean "cheap" or "barely measured". The position badge carries
          rank within position for the active sort.
        </>}
        {lens === "market" && <>
          KTC and FantasyCalc are dynasty market prices in their own currencies — never
          blended, since where they disagree is the point. ECR is the FantasyPros expert
          consensus rank, where 1 is best. Each player page carries the full market read,
          including what the market implies in WAR.
        </>}
        {isSeasonLens && <>
          WAR = wins over the best player left out of the league's 108 startable slots ·
          volatility is the weekly <span className="sigma">σ</span> of fantasy points, so
          lower is steadier · open a row for the week-by-week strip. Players under 45% of
          the season's max games are filtered out.
        </>}
      </div>
    </>
  );
}
