import { useEffect, useState } from "react";
import type { Meta, Ownership, PlayersMin, SummaryRow, Team, Weekly, WeeklyRow } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean } from "../lib/stats";
import { pInfo } from "../lib/league";
import PosBadge from "./PosBadge";
import BoxPlot from "./BoxPlot";
import OwnershipHistory from "./OwnershipHistory";

interface SeasonBlock { season: string; team: string | null; manager: string | null; sum: SummaryRow | null; weeks: WeeklyRow[] }
interface Props { pid: string; players: PlayersMin; meta: Meta; back: () => void }

export default function PlayerPage({ pid, players, meta, back }: Props) {
  const [blocks, setBlocks] = useState<SeasonBlock[] | null>(null);
  const [own, setOwn] = useState<Ownership>({});
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    (async () => {
      const seasons = meta.seasons;
      const [sums, weeks, teams, ownership] = await Promise.all([
        Promise.all(seasons.map(s => j<SummaryRow[]>(`data/${s}/summary.json`).catch(() => [] as SummaryRow[]))),
        Promise.all(seasons.map(s => j<Weekly>(`data/${s}/weekly.json`).catch(() => ({} as Weekly)))),
        Promise.all(seasons.map(s => j<Team[]>(`data/${s}/teams.json`).catch(() => [] as Team[]))),
        j<Ownership>("data/ownership.json").catch(() => ({} as Ownership)),
      ]);
      if (!live) return;
      const bl = seasons.map((s, i): SeasonBlock => {
        const t = teams[i].find(x => x.players.includes(pid));
        return {
          season: s, team: t?.team ?? null, manager: t?.manager ?? null,
          sum: sums[i].find(r => r[0] === pid) ?? null,
          weeks: (weeks[i][pid] || []).slice().sort((a, b) => a[0] - b[0]),
        };
      }).filter(b => b.sum || b.weeks.length || b.team);
      setBlocks(bl.reverse());   // newest season first
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
  const owner = blocks.find(b => b.team)?.team;

  return (
    <>
      <span className="back" onClick={back}>← back</span>
      <div id="teamDetail">
        <h2>{nm} <PosBadge pos={pos} />{nfl && <span style={{ color: "var(--dim)", fontSize: 14 }}> {nfl}</span>}</h2>
        <div className="mgr">
          {owner ? <>owned by <span className="own">{owner}</span></> : "free agent"}
          {gp > 0 && <> · {gp} games · {fmt(pts / gp, 1)} ppg · σ {fmt(sd(allPts), 1)}
            {" · career WAA "}<span className={clsOf(waa)}>{fmt(waa, 3)}</span>
            {" · career WAR "}<span className={clsOf(war)}>{fmt(war, 3)}</span></>}
        </div>
      </div>
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
          <BoxPlot values={allPts} label="Weekly points spread (career)" />
          <OwnershipHistory events={own[pid] || []} />
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
                    {b.weeks.map(w => (
                      <tr key={w[0]}>
                        <td>W{w[0]}</td><td><b>{fmt(w[1], 1)}</b></td>
                        <td className={clsOf(w[2])}>{sgn(w[2], 1)}</td>
                        <td className={clsOf(w[3])}>{sgn(w[3], 1)}</td>
                        <td className={clsOf(w[4])}>{sgn(w[4])}</td>
                        <td className={clsOf(w[5])}>{sgn(w[5])}</td>
                      </tr>
                    ))}
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
