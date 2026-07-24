import { useEffect, useState } from "react";
import type { Absences, Meta, Ownership, PlayerShard, PlayersMin, Projection as ProjRec, SleeperProj, SummaryRow, Team, Values, Weekly, WeeklyRow } from "../lib/types";
import { j, jDaily } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean } from "../lib/stats";
import { pInfo } from "../lib/league";
import PosBadge from "./PosBadge";
import SeasonBoxes from "./SeasonBoxes";
import WarTrend from "./WarTrend";
import Projection from "./Projection";
import OwnershipHistory from "./OwnershipHistory";
import QuickJump from "./QuickJump";

interface SeasonBlock {
  season: string; team: string | null; manager: string | null;
  sum: SummaryRow | null; weeks: WeeklyRow[];
  abs: Record<string, string>;
}
const ABS_LABEL: Record<string, string> = { BYE: "Bye", DNP: "DNP", NR: "Not rostered" };
interface Props { pid: string; players: PlayersMin; meta: Meta; back: () => void }

export default function PlayerPage({ pid, players, meta, back }: Props) {
  const [blocks, setBlocks] = useState<SeasonBlock[] | null>(null);
  const [own, setOwn] = useState<Ownership>({});
  const [vals, setVals] = useState<Values | null>(null);
  const [warRank, setWarRank] = useState<{ season: string; rank: number } | null>(null);
  const [dvi, setDvi] = useState<{ dvi: number; rank: number } | null>(null);
  const [proj, setProj] = useState<ProjRec | null>(null);
  const [sproj, setSproj] = useState<SleeperProj | null>(null);
  const [projYears, setProjYears] = useState<number[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    (async () => {
      const seasons = meta.seasons;
      const [sums, weeks, teams, absences, ownership] = await Promise.all([
        Promise.all(seasons.map(s => j<SummaryRow[]>(`data/${s}/summary.json`).catch(() => [] as SummaryRow[]))),
        Promise.all(seasons.map(s => j<Weekly>(`data/${s}/weekly.json`).catch(() => ({} as Weekly)))),
        Promise.all(seasons.map(s => j<Team[]>(`data/${s}/teams.json`).catch(() => [] as Team[]))),
        Promise.all(seasons.map(s => j<Absences>(`data/${s}/absence.json`).catch(() => ({} as Absences)))),
        j<Ownership>("data/ownership.json").catch(() => ({} as Ownership)),
      ]);
      jDaily<Values>("data/values.json").then(v => { if (live) setVals(v); }).catch(() => {});
      jDaily<{ players: Record<string, { dvi: number; rank: number }> }>("data/dvi.json")
        .then(d => { if (live) setDvi(d.players[pid] ?? null); }).catch(() => {});
      // one ~2 KB shard instead of all of projections.json + proj_sleeper.json;
      // a 404 just means no projection, and Projection falls back to WarTrend
      j<PlayerShard>(`data/player/${pid}.json`).then(sh => {
        if (!live) return;
        setProj(sh.proj);
        setProjYears(sh.years);
        setSproj(sh.sproj);
      }).catch(() => {});
      if (!live) return;
      const bl = seasons.map((s, i): SeasonBlock => {
        const t = teams[i].find(x => x.players.includes(pid));
        return {
          season: s, team: t?.team ?? null, manager: t?.manager ?? null,
          sum: sums[i].find(r => r[0] === pid) ?? null,
          weeks: (weeks[i][pid] || []).slice().sort((a, b) => a[0] - b[0]),
          abs: absences[i][pid] || {},
        };
      }).filter(b => b.sum || b.weeks.length || b.team);
      setBlocks(bl.reverse());   // newest season first
      // WAR positional rank from the most recent season with data
      let wr: { season: string; rank: number } | null = null;
      for (let i = seasons.length - 1; i >= 0; i--) {
        const r = sums[i].find(x => x[0] === pid);
        if (r) {
          const rank = 1 + sums[i].filter(x => x[1] === r[1] && x[6] > r[6]).length;
          wr = { season: seasons[i], rank };
          break;
        }
      }
      setWarRank(wr);
      setOwn(ownership);
    })();
    return () => { live = false; };
  }, [pid, meta]);

  const [nm, pos, nfl] = pInfo(players, pid);
  if (!blocks) return <div className="empty">Loading player…</div>;

  const allPts = blocks.flatMap(b => b.weeks.map(w => w[1]));
  const gp = blocks.reduce((s, b) => s + (b.sum?.[2] || 0), 0);
  const pts = blocks.reduce((s, b) => s + (b.sum?.[3] || 0), 0);
  const waa = blocks.reduce((s, b) => s + (b.sum?.[5] || 0), 0);
  const war = blocks.reduce((s, b) => s + (b.sum?.[6] || 0), 0);
  // current owner = the LATEST season's roster only (blocks are newest-first).
  // Using find(b => b.team) reported the most recent season a player was EVER
  // rostered, so a dropped player never showed as a free agent.
  const owner = blocks[0]?.team;
  const trend = blocks.slice().reverse().filter(b => b.sum)
    .map(b => ({ season: b.season, WAR: b.sum![6], WAA: b.sum![5] }));

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="back" onClick={back} style={{ display: "inline-block" }}>← back</span>
        <QuickJump />
      </div>
      <div id="teamDetail">
        <h2>{nm}{" "}
          <span className={`pos ${pos}`}
            title={warRank ? `${pos}${warRank.rank} by WAR at his position, ${warRank.season} season` : pos}>
            {pos}{warRank?.rank ?? ""}
          </span>
          {warRank && <span style={{ color: "var(--dim)", fontSize: 12 }}> by {warRank.season} WAR</span>}
          {nfl && <span style={{ color: "var(--dim)", fontSize: 14 }}> {nfl}</span>}
          {dvi && <span title="Dynasty Value Index"
            style={{ marginLeft: 10, fontSize: 13, fontWeight: 600, padding: "2px 9px",
                     borderRadius: 6, background: "var(--accent, #4a9)", color: "#0b0f14",
                     verticalAlign: "middle" }}>
            DVI {dvi.dvi.toFixed(1)}<span style={{ opacity: .7 }}> · #{dvi.rank}</span></span>}</h2>
        <div className="mgr">
          {owner ? <>owned by <span className="own">{owner}</span></> : "free agent"}
          {gp > 0 && <> · {gp} games · {fmt(pts / gp, 1)} ppg · σ {fmt(sd(allPts), 1)}
            {" · career WAA "}<span className={clsOf(waa)}>{fmt(waa, 3)}</span>
            {" · career WAR "}<span className={clsOf(war)}>{fmt(war, 3)}</span></>}
        </div>
      </div>
      <MarketValue vals={vals} pid={pid} pos={pos} proj={proj} />
      <div className="wkflex" style={{ marginBottom: 24 }}>
        <div>
          <table style={{ width: "auto" }}>
            <thead><tr>
              <th>Season</th><th style={{ textAlign: "left" }}>Fantasy team</th><th>GP</th><th>Pts</th><th>PPG</th>
              <th><span style={{ textTransform: "none" }}>σ</span></th><th>WAA</th><th>WAR</th>
            </tr></thead>
            <tbody>
              {blocks.map(b => (
                <tr key={b.season} style={{ cursor: "default" }}>
                  <td>{b.season}</td>
                  <td style={{ textAlign: "left", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }} title={b.team ? `${b.team} (${b.manager})` : ""}>
                    {b.team || "—"}{b.manager && <span style={{ color: "var(--dim)" }}> · {b.manager}</span>}
                  </td>
                  <td>{b.sum?.[2] ?? 0}</td>
                  <td>{fmt(b.sum?.[3] ?? 0, 1)}</td>
                  <td>{fmt(b.sum?.[4] ?? 0)}</td>
                  <td>{fmt(sd(b.weeks.map(w => w[1])), 1)}</td>
                  <td className={clsOf(b.sum?.[5] ?? 0)}>{fmt(b.sum?.[5] ?? 0, 3)}</td>
                  <td className={clsOf(b.sum?.[6] ?? 0)}>{fmt(b.sum?.[6] ?? 0, 3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="wkright">
          <OwnershipHistory events={own[pid] || []} />
        </div>
      </div>
      <div className="wkflex" style={{ gap: 40, marginBottom: 22 }}>
        <div style={{ flex: "1 1 460px", minWidth: 340, maxWidth: 760 }}>
          {proj && projYears.length
            ? <Projection p={proj} sleeper={sproj} years={projYears}
                trend={trend.map(t => ({ season: t.season, WAR: t.WAR }))} />
            : <WarTrend data={trend} />}
        </div>
        <div style={{ flex: "1 1 420px", minWidth: 340, maxWidth: 720 }}>
          <SeasonBoxes domain={meta.ptsRange}
          rows={blocks.map(b => ({ season: b.season, values: b.weeks.map(w => w[1]) }))} />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, margin: "8px 0 12px" }}>
        <h3 style={{ margin: 0 }}>Season detail</h3>
        <span className="tlink" style={{ fontSize: 12 }} onClick={() => setCollapsed(new Set())}>expand all</span>
        <span className="tlink" style={{ fontSize: 12 }}
          onClick={() => setCollapsed(new Set(blocks.map(b => b.season)))}>collapse all</span>
      </div>
      <div className="seasongrid">
        {blocks.filter(b => b.weeks.length).map(b => {
          const wpts = b.weeks.map(w => w[1]);
          const closed = collapsed.has(b.season);
          const toggle = () => setCollapsed(prev => {
            const next = new Set(prev);
            next.has(b.season) ? next.delete(b.season) : next.add(b.season);
            return next;
          });
          return (
            <div key={b.season} className="scard">
              <div className="shead" onClick={toggle}>
                <span className="chev">{closed ? "▶" : "▼"}</span>
                <b>{b.season}</b>
                <span className="tname" title={b.team ?? ""}>{b.team || "unrostered"}</span>
                {b.manager && <span style={{ color: "var(--dim)", fontSize: 12.5, flexShrink: 0 }}>({b.manager})</span>}
              </div>
              <div className="ssub">
                {b.weeks.length} games · {fmt(mean(wpts), 1)} ppg · σ {fmt(sd(wpts), 1)}
                {b.sum && <> · WAR <span className={clsOf(b.sum[6])}>{fmt(b.sum[6], 3)}</span></>}
              </div>
              {!closed && <div className="wkwrap">
                <table className="wktbl">
                  <thead><tr><th>Week</th><th>Pts</th><th>vs Avg</th><th>vs Repl</th><th>WAA</th><th>WAR</th></tr></thead>
                  <tbody>
                    {[...new Set([...b.weeks.map(w => w[0]), ...Object.keys(b.abs).map(Number)])]
                      .sort((x, y) => x - y)
                      .map(wk => {
                        const w = b.weeks.find(r => r[0] === wk);
                        if (!w) return (
                          <tr key={wk}>
                            <td>W{wk}</td>
                            <td colSpan={5} style={{ color: "var(--dim)", fontStyle: "italic", textAlign: "left" }}>
                              {ABS_LABEL[b.abs[wk]] ?? b.abs[wk]}
                            </td>
                          </tr>
                        );
                        return (
                          <tr key={wk}>
                            <td>W{w[0]}</td><td><b>{fmt(w[1], 1)}</b></td>
                            <td className={clsOf(w[2])}>{sgn(w[2], 1)}</td>
                            <td className={clsOf(w[3])}>{sgn(w[3], 1)}</td>
                            <td className={clsOf(w[4])}>{sgn(w[4])}</td>
                            <td className={clsOf(w[5])}>{sgn(w[5])}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

/** One-line model-vs-market comparison: our projected 3-yr composite WAR
 *  against the market-implied WAR (mean of available sources). The gap is the
 *  buy/sell signal — green when the model is higher on the player than the
 *  market, red when lower, dim when they roughly agree (±0.25 WAR).
 *  Both numbers are precomputed into values.json by value_bridge.py. */
function Verdict({ model, ktc, fc }: { model: number | null; ktc: number | null; fc: number | null }) {
  const imps = [ktc, fc].filter((x): x is number => x != null);
  if (model == null || !imps.length) return null;
  const mkt = imps.reduce((a, b) => a + b, 0) / imps.length;
  const diff = model - mkt;
  const label = Math.abs(diff) <= 0.25 ? "in line with the market"
    : diff > 0 ? "model higher than the market" : "model lower than the market";
  return (
    <div style={{ fontSize: 12.5, margin: "2px 0 4px", color: "var(--dim)" }}
      title="model = 3-yr composite projection; market = mean market-implied WAR across sources">
      model <b style={{ color: "var(--txt)" }}>{sgn(model, 2)}</b> WAR/3yr
      {" vs market-implied "}<b style={{ color: "var(--txt)" }}>{sgn(mkt, 2)}</b>
      {" → "}
      <span className={Math.abs(diff) <= 0.25 ? undefined : clsOf(diff)}>
        {label} ({sgn(diff, 2)})
      </span>
    </div>
  );
}

function MarketValue({ vals, pid, pos, proj }: {
  vals: Values | null; pid: string; pos: string; proj: ProjRec | null;
}) {
  const v = vals?.players[pid];
  if (!v || (!v.ktc && !v.fc)) return null;
  const num = (n: number) => n.toLocaleString("en-US");
  const implied = (src: "ktc" | "fc"): number | null => v.impWar?.[src] ?? null;
  const closestPick = (list?: [string, number][], val?: number) => {
    if (!list?.length || val == null) return null;
    let best = list[0];
    for (const pk of list)
      if (Math.abs(pk[1] - val) < Math.abs(best[1] - val)) best = pk;
    return best;
  };
  const dim = { color: "var(--dim)" } as const;
  const row = (label: string, val?: number, pickList?: [string, number][],
    ovr?: number, posRank?: number, trends?: Record<string, number>,
    imp?: number | null) => {
    if (val == null) return null;
    const pk = closestPick(pickList, val);
    return (
      <>
        <div style={dim}>{label}</div>
        <div><b style={{ color: "var(--txt)" }}>{num(val)}</b></div>
        <div style={{ ...dim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={pk ? `closest pick: ${pk[0]} is worth ${num(pk[1])} — player is ${val === pk[1] ? "even with it" : `${num(Math.abs(val - pk[1]))} ${val > pk[1] ? "above" : "below"}`}` : ""}>
          {pk ? <>≈ {pk[0]} <span style={{ opacity: .8 }}>({num(pk[1])})</span></> : "N/A"}
        </div>
        <div style={dim}>{ovr != null ? `OVR ${ovr}` : "N/A"}</div>
        <div style={dim}>{posRank != null ? `${pos}${posRank}` : "N/A"}</div>
        <div title="market-implied 3-yr WAR: this value run through the league's value→WAR curve (Bridge B)">
          {imp == null
            ? <span style={dim}>N/A</span>
            : <><span style={dim}>≙ </span><span className={clsOf(imp)}>{sgn(imp, 2)}</span><span style={dim}> WAR</span></>}
        </div>
        {[7, 14, 30].map(d => {
          const t = trends?.[String(d)];
          return (
            <div key={d}>
              <span style={dim}>{d}d </span>
              {t == null
                ? <span style={dim}>N/A</span>
                : t === 0
                  ? <span style={dim}>0</span>
                  : <span className={t > 0 ? "num good" : "num bad"}>{t > 0 ? "▲" : "▼"}{num(Math.abs(t))}</span>}
            </div>
          );
        })}
      </>
    );
  };
  return (
    <div className="wkwrap" style={{ margin: "-6px 0 16px" }}>
      <div style={{
        display: "grid", fontSize: 13, lineHeight: 1.9, columnGap: 14,
        gridTemplateColumns: "100px 58px minmax(150px,195px) 66px 52px 94px 82px 82px 86px",
        width: "fit-content",
      }}>
        {row("KeepTradeCut", v.ktc, vals?.picks?.ktc, v.ktcRank, v.ktcPosRank, v.ktcT, implied("ktc"))}
        {row("FantasyCalc", v.fc, vals?.picks?.fc, v.fcRank, v.fcPosRank, v.fcT, implied("fc"))}
      </div>
      <Verdict model={v.modelWar ?? proj?.total_comp ?? null} ktc={implied("ktc")} fc={implied("fc")} />
      {vals?.fetched && <div style={{ color: "var(--dim)", fontSize: 11.5 }}>market values as of {vals.fetched}</div>}
    </div>
  );
}
