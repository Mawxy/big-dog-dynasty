import { useEffect, useMemo, useState } from "react";
import type { Matchups, PlayersMin, SeasonData, Weekly } from "../lib/types";
import { jl } from "../lib/data";
import { fmt, pct } from "../lib/stats";
import { pInfo, ownerOf, POS_COLOR, POS_CHIPS } from "../lib/league";
import { PlayerLink } from "../components/PlayerLink";
import SeasonPicker from "../components/SeasonPicker";
import AllTimePanel from "../components/AllTimePanel";
import DataTable, { applySort, sortCol, type Col, type Grp } from "../components/DataTable";

/**
 * STATS — what a player actually did, in a season that has been played.
 *
 * The forward-looking half of the old combined table (projected WAR, DVI, CVI)
 * now lives on the Value page. The split is not cosmetic: everything here is
 * keyed to a chosen season and means nothing without one, while everything on
 * Value is a single current estimate that no season qualifies. Holding both on
 * one screen forced the CVI column to be conditionally present on the roster
 * season, because a win-now number beside a 2022 stat line reads as a 2022
 * number. Separating them retires that condition.
 *
 * A consequence worth expecting: before week 1 this page is empty, because
 * there are no scored weeks to report. That is correct — the preseason answer
 * is a projection, and projections are on Value.
 */
interface Row {
  id: string; nm: string; pos: string; team: string;
  gp: number; pts: number; ppg: number; sdv: number;
  war: number; warG: number; posRank: number;
  /** weekly WAR values, regular season, week order (empty for all-time) */
  wkWar: number[];
}

/** page-wide scales, computed once and shared by every cell */
interface Ctx { gMax: number; sdMin: number; sdMax: number; warMax: number }

const GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Production", cls: "edge" },
  { id: 2, label: "Wins added", cls: "edge value" },
];

const COLS: Col<Row, Ctx>[] = [
  {
    id: "rk", label: "Rk", grp: 0, w: 48, align: "c", td: "rank",
    cell: (r, _x, i) => <>
      <span className="spine" style={{ background: POS_COLOR[r.pos] || "var(--rule)" }} />
      <span className="fig">{i + 1}</span>
    </>,
  },
  {
    id: "nm", label: "Player", grp: 0, w: 0, align: "t", td: "name", asc: true,
    sort: r => r.nm,
    cell: r => <PlayerLink pid={r.id} name={r.nm} />,
  },
  {
    id: "pos", label: "Pos", grp: 0, w: 60, align: "c", td: "c",
    cell: r => <span className={`pos ${r.pos}`}>{r.pos}{r.posRank || ""}</span>,
  },
  {
    id: "team", label: "Roster", grp: 0, w: 190, align: "t", hm: true, td: "sub hm",
    sort: r => r.team, cell: r => r.team,
  },
  {
    id: "gp", label: "GP", grp: 1, w: 48, align: "n", hm: true, edge: true,
    td: "fig quiet hm edge n", sort: r => r.gp, cell: r => r.gp,
  },
  {
    id: "pts", label: "Pts", grp: 1, w: 76, align: "n", hm: true, td: "fig hm n",
    sort: r => r.pts, cell: r => fmt(r.pts, 1),
  },
  {
    id: "ppg", label: "PPG", grp: 1, w: 66, align: "n", td: "fig strong n",
    sort: r => r.ppg, cell: r => fmt(r.ppg),
  },
  {
    id: "sdv", label: "Consistency", grp: 1, w: 112, align: "n", td: "n",
    sort: r => r.sdv,
    cell: (r, x) => (
      <div className="meter">
        <div className="track cons"><div className="fill" style={{ width: consPct(r.sdv, x.sdMin, x.sdMax) }} /></div>
        <span className="val sm">{fmt(r.sdv, 1)}</span>
      </div>
    ),
  },
  {
    id: "war", label: "WAR", grp: 2, w: 156, align: "n", edge: true, keyCol: true,
    td: "edge n", sort: r => r.war,
    cell: (r, x) => (
      <div className="meter">
        <div className="track war"><div className="fill" style={{ width: pct(r.war, x.warMax) }} /></div>
        <span className="val head-fig">{fmt(r.war, 3)}</span>
      </div>
    ),
  },
  {
    id: "warG", label: "WAR/G", grp: 2, w: 88, align: "n", hm: true, td: "fig quiet hm n",
    sort: r => r.warG, cell: r => fmt(r.warG, 3),
  },
  {
    id: "wkWar", label: "By week", grp: 2, w: 112, align: "n", hm: true, td: "hm n",
    cell: (r, x) => r.wkWar.length
      ? <ByWeek war={r.wkWar} gMax={x.gMax} />
      : <span className="fig quiet">—</span>,
  },
];

/** the table's resting order, and where clicking Rk returns it to */
const HOME_SORT = "war";

interface Props { data: SeasonData; season: string; seasons: string[]; players: PlayersMin; defaultMinGp: number }

export default function Players({ data, season, seasons, players, defaultMinGp }: Props) {
  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");
  const [sortId, setSortId] = useState(HOME_SORT);
  const [dir, setDir] = useState(-1);
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [wkWarMap, setWkWarMap] = useState<Record<string, number[]>>({});
  const gpFloor = defaultMinGp;

  // per-season weekly WAR for the by-week sparklines (scored seasons only)
  useEffect(() => {
    if (season === "ALL" || !data.summary.length) { setWkWarMap({}); return; }
    let live = true;
    Promise.all([
      jl<Weekly>(`${season}/weekly.json`),
      jl<Matchups>(`${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => {
      if (!live) return;
      const ps = m.playoff_start || 15;
      const map: Record<string, number[]> = {};
      for (const [pid, rows] of Object.entries(w))
        map[pid] = rows.filter(r => r[0] < ps).sort((a, b) => a[0] - b[0]).map(r => r[5]);
      setWkWarMap(map);
    }).catch(() => { if (live) setWkWarMap({}); });
    return () => { live = false; };
  }, [season, data]);

  const { rows, count, ctx } = useMemo(() => {
    const owners = ownerOf(data.teams);
    let all: Row[] = data.summary.map(r => {
      const [id, p, gp, pts, ppg, , war, sdv] = r;
      return {
        id, nm: pInfo(players, id)[0], pos: p, team: owners[id] || "—",
        gp, pts, ppg, sdv: sdv || 0, war, warG: gp ? war / gp : 0, posRank: 0,
        wkWar: wkWarMap[id] || [],
      };
    });
    const byPos: Record<string, Row[]> = {};
    all.forEach(r => (byPos[r.pos] ??= []).push(r));
    Object.values(byPos).forEach(list => {
      list.sort((a, b) => b.war - a.war);
      list.forEach((r, i) => { r.posRank = i + 1; });
    });
    if (gpFloor) all = all.filter(r => r.gp >= gpFloor);
    const ctx: Ctx = {
      gMax: Math.max(0.05, ...all.flatMap(r => r.wkWar.map(Math.abs))),
      sdMin: all.length ? Math.min(...all.map(r => r.sdv)) : 0,
      sdMax: all.length ? Math.max(...all.map(r => r.sdv)) : 1,
      warMax: Math.max(0.01, ...all.map(r => r.war)),
    };

    let rs = all;
    if (pos !== "ALL") rs = rs.filter(r => r.pos === pos);
    if (q) rs = rs.filter(r => r.nm.toLowerCase().includes(q.toLowerCase()));
    rs = applySort(rs, sortCol(COLS, sortId, HOME_SORT), dir);
    return { rows: rs, count: rs.length, ctx };
  }, [data, players, pos, q, gpFloor, sortId, dir, wkWarMap]);

  const onSort = (c: Col<Row, Ctx>) => {
    if (c.id === "rk") { setSortId(HOME_SORT); setDir(-1); return; }
    if (!c.sort) return;
    if (sortId === c.id) setDir(-dir);
    else { setSortId(c.id); setDir(c.asc ? 1 : -1); }
  };

  if (!data.summary.length)
    return (
      <>
        <div className="screen-head"><SeasonPicker /></div>
        <div className="empty">
          No scored weeks yet for this season — check back after week 1.
          Projected WAR and the value indices are on the Value page.
        </div>
      </>
    );

  const openRow = openPid ? rows.find(r => r.id === openPid) : undefined;

  return (
    <>
      <div className="screen-head">
        <SeasonPicker />
        {POS_CHIPS.map(p => (
          <button key={p} className={`chip ${pos === p ? "on" : ""}`}
            onClick={() => { setPos(p); setOpenPid(null); }}>{p === "ALL" ? "All" : p}</button>
        ))}
        <input type="search" placeholder="Search player…" value={q} onChange={e => setQ(e.target.value)} />
        <span className="screen-note">Regular season · <b>{count}</b> shown</span>
      </div>

      <DataTable cols={COLS} groups={GROUPS} rows={rows} ctx={ctx} rowKey={r => r.id}
        sortId={sortId} dir={dir} onSort={onSort} homeCol="rk" openKey={openPid}
        onRowClick={r => setOpenPid(openPid === r.id ? null : r.id)} />

      {openRow && season !== "ALL" && <PlayerDrawer r={openRow} gMax={ctx.gMax} />}
      {openRow && season === "ALL" && (
        <div className="drawer">
          <AllTimePanel pid={openRow.id} data={data} seasons={seasons} teams={data.teams} players={players} />
        </div>
      )}

      <div className="footnote">
        WAR = wins over the best player left out of the league's 108 startable slots · the consistency bar
        is longer for a steadier player — the figure beside it is the weekly <span className="sigma">σ</span> of
        fantasy points, so a low <span className="sigma">σ</span> earns a long bar
      </div>
    </>
  );
}

const consPct = (sdv: number, lo: number, hi: number) =>
  Math.round(Math.max(4, (1 - (sdv - lo) / ((hi - lo) || 1)) * 100)) + "%";

/** 86×22 zero-baseline weekly-WAR sparkline on the page-wide ±gMax scale. */
function ByWeek({ war, gMax }: { war: number[]; gMax: number }) {
  const step = 86 / 13;
  return (
    <svg width={86} height={22} viewBox="0 0 86 22" style={{ overflow: "visible", verticalAlign: "middle" }}>
      <line x1={0} y1={11} x2={86} y2={11} stroke="#2b3642" strokeWidth={1} />
      {war.map((x, j) => {
        const h = Math.max(1, Math.abs(x) / gMax * 9);
        return <rect key={j} x={(j * step + (step - 5) / 2).toFixed(1)} y={(x >= 0 ? 11 - h : 11).toFixed(1)}
          width={5} height={h.toFixed(1)} fill={x >= 0 ? "var(--acc)" : "var(--bad)"} />;
      })}
    </svg>
  );
}

/** Expanded detail drawer, rendered after the table (never as an inserted row). */
function PlayerDrawer({ r, gMax }: { r: Row; gMax: number }) {
  const w = r.wkWar;
  const zeroY = 38, step = 480 / Math.max(1, w.length);
  const best = w.length ? Math.max(...w) : 0, worst = w.length ? Math.min(...w) : 0;
  const stats: [string, string, string][] = [
    ["Season WAR", fmt(r.war, 3), "acc"],
    ["Per game", fmt(r.warG, 3), ""],
    ["Best week", fmt(best, 3), "good"],
    ["Worst week", fmt(worst, 3), worst < 0 ? "bad" : ""],
  ];
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="drawer-title">{r.nm}</span>
        <span className="pos" style={{ width: 46, background: POS_COLOR[r.pos] || "var(--rule)" }}>{r.pos}{r.posRank}</span>
        <span className="drawer-sub">
          {r.team} · {r.gp} games · {fmt(r.ppg, 1)} ppg · <span className="sigma">σ</span> {fmt(r.sdv, 1)}
        </span>
      </div>
      <div className="drawer-body">
        <div>
          <div className="chart-label">Weekly WAR contribution · fixed ±{fmt(gMax, 2)} scale, same for every player</div>
          <svg width={480} height={76} viewBox="0 0 480 76" style={{ overflow: "visible", display: "block" }}>
            <line x1={0} y1={zeroY} x2={480} y2={zeroY} stroke="#2b3642" strokeWidth={1} />
            {w.map((x, j) => {
              const h = Math.max(1, Math.abs(x) / gMax * 30);
              return <rect key={j} x={(j * step + step / 2 - 12).toFixed(1)} y={(x >= 0 ? zeroY - h : zeroY).toFixed(1)}
                width={24} height={h.toFixed(1)} fill={x >= 0 ? "var(--acc)" : "var(--bad)"} />;
            })}
          </svg>
          <div style={{ position: "relative", width: 480, height: 16, marginTop: 3 }}>
            {w.map((_, j) => (
              <div key={j} style={{ position: "absolute", left: (j * step + step / 2).toFixed(1) + "px",
                transform: "translateX(-50%)", font: "10px var(--cond)", color: "var(--dim3)" }}>{j + 1}</div>
            ))}
          </div>
        </div>
        <div className="stat-row">
          {stats.map(([k, v, c]) => (
            <div key={k}>
              <div className="stat-k">{k}</div>
              <div className={`stat-v ${c}`}>{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
