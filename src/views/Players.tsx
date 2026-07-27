import { useEffect, useMemo, useState } from "react";
import type { Matchups, PlayersMin, ProjectionsFile, SeasonData, Weekly } from "../lib/types";
import { j } from "../lib/data";
import { fmt } from "../lib/stats";
import { pInfo, ownerOf } from "../lib/league";
import { useMobile } from "../lib/useWidth";
import { PlayerLink } from "../components/PlayerLink";
import PlayerPanel from "../components/PlayerPanel";
import AllTimePanel from "../components/AllTimePanel";

interface Row {
  id: string; nm: string; pos: string; team: string;
  gp: number; pts: number; ppg: number; sdv: number;
  war: number; warG: number; posRank: number;
  /** weekly WAR values, regular season, week order (empty for all-time / proj) */
  wkWar: number[];
  proj?: boolean; noPts?: boolean;
}

type Align = "c" | "t" | "n";
interface Col { label: string; key: keyof Row | null; w: number; align: Align; hm?: boolean; edge?: boolean; keyCol?: boolean; grp: 0 | 1 | 2 }
const COLS: Col[] = [
  { label: "Rk", key: null, w: 48, align: "c", grp: 0 },
  { label: "Player", key: "nm", w: 0, align: "t", grp: 0 },
  { label: "Pos", key: null, w: 60, align: "c", grp: 0 },
  { label: "Roster", key: "team", w: 190, align: "t", hm: true, grp: 0 },
  { label: "GP", key: "gp", w: 48, align: "n", hm: true, edge: true, grp: 1 },
  { label: "Pts", key: "pts", w: 76, align: "n", hm: true, grp: 1 },
  { label: "PPG", key: "ppg", w: 66, align: "n", grp: 1 },
  { label: "Consistency", key: "sdv", w: 112, align: "n", grp: 1 },
  { label: "WAR", key: "war", w: 156, align: "n", edge: true, keyCol: true, grp: 2 },
  { label: "WAR/G", key: "warG", w: 88, align: "n", hm: true, grp: 2 },
  { label: "By week", key: null, w: 112, align: "n", hm: true, grp: 2 },
];
const SORTABLE = new Set([1, 4, 5, 6, 7, 8, 9]);
const POS: Record<string, string> = { QB: "var(--qb)", RB: "var(--rb)", WR: "var(--wr)", TE: "var(--te)" };

interface Props { data: SeasonData; season: string; seasons: string[]; players: PlayersMin; defaultMinGp: number }

export default function Players({ data, season, seasons, players, defaultMinGp }: Props) {
  const [pos, setPos] = useState("ALL");
  const [q, setQ] = useState("");
  const [sortCol, setSortCol] = useState(8);
  const [dir, setDir] = useState(-1);
  const [openPid, setOpenPid] = useState<string | null>(null);
  const [projs, setProjs] = useState<ProjectionsFile | null>(null);
  const [wkWarMap, setWkWarMap] = useState<Record<string, number[]>>({});
  const mobile = useMobile();
  const gpFloor = defaultMinGp;

  // per-season weekly WAR for the by-week sparklines (scored seasons only)
  useEffect(() => {
    if (season === "ALL" || !data.summary.length) { setWkWarMap({}); return; }
    let live = true;
    Promise.all([
      j<Weekly>(`data/${season}/weekly.json`),
      j<Matchups>(`data/${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
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

  // preseason: no scored weeks yet — fall back to the projection model
  useEffect(() => {
    if (data.summary.length) return;
    let live = true;
    j<ProjectionsFile>("data/projections.json").then(p => { if (live) setProjs(p); }).catch(() => {});
    return () => { live = false; };
  }, [data]);
  const isProj = !data.summary.length && projs != null && String(projs.meta.roster_season) === season;

  const { rows, count, gMax, sdMin, sdMax, warMax } = useMemo(() => {
    const owners = ownerOf(data.teams);
    let all: Row[] = isProj && projs
      ? projs.players.map(p => {
        const gp = 13, war = p.composite[0] ?? 0, ppg = p.ppg ?? null;
        return {
          id: p.pid, nm: pInfo(players, p.pid)[0], pos: p.pos, team: owners[p.pid] || "—",
          gp, pts: (ppg ?? 0) * gp, ppg: ppg ?? 0, sdv: 0, war, warG: war / gp,
          posRank: 0, wkWar: [], proj: true, noPts: ppg == null,
        };
      })
      : data.summary.map(r => {
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
    const real = all.filter(r => !r.proj);
    const gMax = Math.max(0.05, ...all.flatMap(r => r.wkWar.map(Math.abs)));
    const sdMin = real.length ? Math.min(...real.map(r => r.sdv)) : 0;
    const sdMax = real.length ? Math.max(...real.map(r => r.sdv)) : 1;
    const warMax = Math.max(0.01, ...all.map(r => r.war));

    let rs = all;
    if (pos !== "ALL") rs = rs.filter(r => r.pos === pos);
    if (q) rs = rs.filter(r => r.nm.toLowerCase().includes(q.toLowerCase()));
    const k = COLS[sortCol].key;
    if (k) rs = rs.slice().sort((a, b) => typeof a[k] === "string"
      ? (a[k] as string).localeCompare(b[k] as string) * dir
      : ((a[k] as number) - (b[k] as number)) * dir);
    return { rows: rs, count: rs.length, gMax, sdMin, sdMax, warMax };
  }, [data, players, pos, q, gpFloor, sortCol, dir, isProj, projs, wkWarMap]);

  const clickCol = (i: number) => {
    if (i === 0) { setSortCol(8); setDir(-1); return; }
    if (!SORTABLE.has(i)) return;
    if (sortCol === i) setDir(-dir);
    else { setSortCol(i); setDir(i === 1 ? 1 : -1); }
  };

  if (!data.summary.length && !isProj)
    return <div className="empty">No scored weeks yet for this season — check back after week 1.</div>;

  const openRow = openPid ? rows.find(r => r.id === openPid) : undefined;
  const span = (g: 0 | 1 | 2) => COLS.filter(c => c.grp === g && !(mobile && c.hm)).length;

  return (
    <>
      <div className="screen-head">
        {["ALL", "QB", "RB", "WR", "TE"].map(p => (
          <button key={p} className={`chip ${pos === p ? "on" : ""}`}
            onClick={() => { setPos(p); setOpenPid(null); }}>{p === "ALL" ? "All" : p}</button>
        ))}
        <input type="search" placeholder="Search player…" value={q} onChange={e => setQ(e.target.value)} />
        <span className="screen-note">Regular season · <b>{count}</b> shown</span>
      </div>

      {isProj && (
        <div className="footnote" style={{ background: "var(--band)", color: "var(--dim)", textTransform: "none", letterSpacing: 0 }}>
          No scored weeks yet — showing projections for a full healthy 13-game season · σ and by-week are not projected
        </div>
      )}

      <table>
        <colgroup>
          {COLS.map((c, i) => (
            <col key={i} className={c.hm ? "hm" : undefined} style={c.w ? { width: c.w } : undefined} />
          ))}
        </colgroup>
        <thead>
          <tr className="grp">
            <th colSpan={span(0)}></th>
            <th className="edge" colSpan={span(1)}>Production</th>
            <th className="edge value" colSpan={span(2)}>Wins added</th>
          </tr>
          <tr>
            {COLS.map((c, i) => (
              <th key={i}
                className={[c.align, c.hm ? "hm" : "", c.edge ? "edge" : "", c.keyCol ? "key" : "",
                  (i === 0 || SORTABLE.has(i)) ? "sortable" : "", sortCol === i ? "sorted" : ""]
                  .filter(Boolean).join(" ")}
                onClick={() => clickCol(i)}>
                {c.label}{sortCol === i ? (dir < 0 ? " ▼" : " ▲") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={`click ${openPid === r.id ? "open" : i % 2 ? "zebra" : ""}`}
              onClick={() => setOpenPid(openPid === r.id ? null : r.id)}>
              <td className="rank">
                <span className="spine" style={{ background: POS[r.pos] || "var(--rule)" }} />
                <span className="fig">{i + 1}</span>
              </td>
              <td className="name"><PlayerLink pid={r.id} name={r.nm} /></td>
              <td className="c"><span className={`pos ${r.pos}`}>{r.pos}{r.posRank || ""}</span></td>
              <td className="sub hm">{r.team}</td>
              <td className="fig quiet hm edge n">{r.gp}</td>
              <td className="fig hm n">{r.noPts ? "—" : fmt(r.pts, 1)}</td>
              <td className="fig strong n">{r.noPts ? "—" : fmt(r.ppg)}</td>
              <td className="n">
                {r.proj ? <span className="fig quiet">—</span> : (
                  <div className="meter">
                    <div className="track cons"><div className="fill" style={{ width: consPct(r.sdv, sdMin, sdMax) }} /></div>
                    <span className="val sm">{fmt(r.sdv, 1)}</span>
                  </div>
                )}
              </td>
              <td className="edge n">
                <div className="meter">
                  <div className="track war"><div className="fill" style={{ width: pct(r.war, warMax) }} /></div>
                  <span className="val head-fig">{fmt(r.war, 3)}</span>
                </div>
              </td>
              <td className="fig quiet hm n">{fmt(r.warG, 3)}</td>
              <td className="hm last n">
                {r.wkWar.length ? <ByWeek war={r.wkWar} gMax={gMax} /> : <span className="fig quiet">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {openRow && season !== "ALL" && !openRow.proj && <PlayerDrawer r={openRow} gMax={gMax} />}
      {openRow && season === "ALL" && (
        <div className="drawer"><div className="legacy">
          <AllTimePanel pid={openRow.id} data={data} seasons={seasons} teams={data.teams} players={players} />
        </div></div>
      )}
      {openRow && season !== "ALL" && openRow.proj && (
        <div className="drawer"><div className="legacy">
          <PlayerPanel pid={openRow.id} season={season} teams={data.teams} players={players} />
        </div></div>
      )}

      <div className="footnote">
        WAR = wins over the best player left out of the league's 108 startable slots · the consistency bar
        is longer for a steadier player — the figure beside it is the weekly <span className="sigma">σ</span> of
        fantasy points, so a low <span className="sigma">σ</span> earns a long bar
      </div>
    </>
  );
}

const pct = (v: number, max: number) => Math.round((v / max) * 100) + "%";
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
        <span className="pos" style={{ width: 46, background: POS[r.pos] || "var(--rule)" }}>{r.pos}{r.posRank}</span>
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
