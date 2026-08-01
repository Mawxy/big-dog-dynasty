import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { pct, fmt } from "../lib/stats";
import { ownerOf, pInfo, seasonSeg } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { useSeasonData } from "../lib/useSeasonData";
import PlayerPanel from "../components/PlayerPanel";
import AllTimePanel from "../components/AllTimePanel";
import DataTable, { applySort, sortCol } from "../components/DataTable";
import {
  BoardScope, blankRow, identityCols, usePlayerFilters,
  type BoardCtx, type PlayerCol, type PlayerRow,
} from "../components/PlayerBoard";

/**
 * STATS — what every player actually did, one played season at a time.
 *
 * The year spine is the whole screen: a played season, or all-time. It carries
 * no value columns at all, which is the point of splitting it from Value —
 * a season's record and a player's current price are measured against
 * different things and were only ever sharing a table because they shared a
 * population.
 *
 * All-time is a scope on this spine rather than a screen of its own, but it is
 * a genuinely different column set: total points replace volatility (a career
 * σ across seasons of different lengths isn't a number anyone should read),
 * and the drawer shows the career ladder instead of one season's weeks.
 */
const seasonCols = (allTime: boolean): PlayerCol[] => [
  ...identityCols(),
  {
    id: "gp", label: "GP", grp: 1, w: 6, align: "n", edge: true,
    td: "fig quiet edge n", sort: r => r.gp, cell: r => r.gp,
  },
  ...(allTime ? [{
    id: "pts", label: "Pts", grp: 1, w: 8, align: "n", hm: true,
    td: "fig hm n", sort: (r: PlayerRow) => r.pts, cell: (r: PlayerRow) => fmt(r.pts, 1),
  } as PlayerCol] : []),
  {
    id: "ppg", label: "PPG", grp: 1, w: 7, align: "n", td: "fig strong n",
    sort: r => r.ppg, cell: r => fmt(r.ppg),
  },
  ...(allTime ? [] : [{
    id: "sdv", label: "Volatility", grp: 1, w: 8, align: "n", hm: true,
    td: "fig quiet hm n", sort: (r: PlayerRow) => r.sdv, cell: (r: PlayerRow) => fmt(r.sdv, 1),
  } as PlayerCol]),
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
const GROUPS = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Production", cls: "edge" },
  { id: 2, label: "Wins added", cls: "edge value" },
];

export default function Stats() {
  const { meta, players } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const seg = useParams().season;

  const latest = meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : meta.seasons[meta.seasons.length - 1];
  /** newest first — the year a reader wants is almost always the last one played */
  const played = useMemo(
    () => meta.seasons.filter(s => s <= latest).slice().reverse(), [meta, latest]);

  /** a played season, or "ALL"; an unknown segment falls back to the latest */
  const scope = !seg ? latest
    : seg.toLowerCase() === "all" ? "ALL"
      : played.includes(seg) ? seg : latest;
  const allTime = scope === "ALL";

  const data = useSeasonData(scope);

  const [sortId, setSortId] = useState("war");
  const [dir, setDir] = useState(-1);
  const [openPid, setOpenPid] = useState<string | null>(null);
  const { bar, apply } = usePlayerFilters(() => setOpenPid(null));

  // a scope change resets to the resting order and closes the drawer
  useEffect(() => {
    setSortId("war");
    setDir(-1);
    setOpenPid(null);
  }, [scope]);

  const cols = useMemo(() => seasonCols(allTime), [allTime]);

  const { rows, count, ctx } = useMemo(() => {
    const owners = data ? ownerOf(data.teams) : {};
    let all: PlayerRow[] = (data?.summary ?? []).map(r => {
      const [id, p, gp, pts, ppg, , war, sdv] = r;
      return {
        ...blankRow(id, pInfo(players, id)[0], p, pInfo(players, id)[2]),
        team: owners[id] || "—",
        gp, pts, ppg, sdv: sdv || 0, war, warG: gp ? war / gp : 0,
      };
    });
    // floor tiny samples out of the leaderboard: a two-game cameo at 22 PPG is
    // not a season, and it outranks everyone if left in
    const gpMax = all.reduce((m, r) => Math.max(m, r.gp), 0);
    const floor = Math.round(gpMax * 0.45);
    all = all.filter(r => r.gp >= floor);

    const ctx: BoardCtx = { warMax: Math.max(0.01, ...all.map(r => r.war)) };
    // sort the FULL population first, then assign position rank from that
    // order, then filter — so RB4 stays RB4 inside the RB-only view
    const sorted = applySort(all, sortCol(cols, sortId, "war"), dir);
    const counters: Record<string, number> = {};
    sorted.forEach(r => {
      counters[r.pos] = (counters[r.pos] ?? 0) + 1;
      r.posRank = counters[r.pos];
    });
    const rs = apply(sorted);
    return { rows: rs, count: rs.length, ctx };
  }, [data, players, sortId, dir, cols, apply]);

  const onSort = (c: PlayerCol) => {
    if (c.id === "rk") { setSortId("war"); setDir(-1); return; }
    if (!c.sort) return;
    if (sortId === c.id) setDir(-dir);
    else { setSortId(c.id); setDir(c.asc ? 1 : -1); }
  };

  const yearChip = (label: string, to: string, on: boolean) => (
    <button key={to} type="button" className={`chip ${on ? "on" : ""}`}
      onClick={() => nav(lp(to))}>{label}</button>
  );

  const empty = data != null && data.summary.length === 0;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Players</span>
        <BoardScope on="stats" />
        <span className="screen-note">
          {allTime ? "All seasons" : "Regular season"} · <b>{count}</b> shown
        </span>
      </div>
      {/* the year spine: its own row, because it re-scopes the board rather
          than switching which board you are on */}
      <div className="screen-head" style={{ paddingTop: 0 }}>
        {played.map(s => yearChip(s, `/stats/${seasonSeg(s)}`, scope === s))}
        {yearChip("All-time", "/stats/all", allTime)}
      </div>
      {bar}

      {!data ? <div className="empty">Loading…</div>
        : empty ? (
          <div className="empty">
            No scored weeks yet for {scope} — the preseason answer is a projection,
            and projections are on Value.
          </div>
        ) : (
          <DataTable cols={cols} groups={GROUPS} rows={rows} ctx={ctx} rowKey={r => r.id}
            sortId={sortId} dir={dir} onSort={onSort} homeCol="rk" openKey={openPid}
            onRowClick={r => setOpenPid(openPid === r.id ? null : r.id)}
            renderDrawer={r => allTime
              ? (
                <div className="drawer">
                  <AllTimePanel pid={r.id} data={data} seasons={meta.seasons}
                    teams={data.teams} players={players} />
                </div>
              )
              : (
                <PlayerPanel pid={r.id} season={scope} teams={data.teams} players={players} />
              )} />
        )}

      <div className="tnote" style={{ padding: "10px var(--pad) 22px", marginTop: 0 }}>
        WAR = wins over the best player left out of the league's 108 startable slots ·
        {allTime
          ? " points and games are career totals across every played season"
          : <> volatility is the weekly <span className="sigma">σ</span> of fantasy points,
            so lower is steadier</>} · open a row for the week-by-week strip. Players under
        45% of the season's max games are filtered out. What a player is worth today is on
        Value.
      </div>
    </>
  );
}
