import { useEffect, useState } from "react";
import type { Franchise, Franchises, PlayersMin, SummaryRow, Team } from "../lib/types";
import { j } from "../lib/data";
import { fmt, clsOf } from "../lib/stats";
import { pInfo } from "../lib/league";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";

function ord(n: number) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
const finishLabel = (f: number | null) =>
  f == null ? "—" : f === 1 ? "🏆 Champion" : f === 2 ? "Runner-up" : ord(f);

const TXF: [string, string][] = [["all", "All"], ["trade", "Trades"], ["add", "Adds"], ["drop", "Drops"]];

export default function FranchisePage({ rid, players, back }:
  { rid: number; players: PlayersMin; back: () => void }) {
  const [fr, setFr] = useState<Franchise | null | undefined>(undefined);
  const [txFilter, setTxFilter] = useState("all");
  const [txSeason, setTxSeason] = useState("all");
  const [rosterSeason, setRosterSeason] = useState<string | null>(null);
  const [roster, setRoster] = useState<{ team: Team; sum: Map<string, SummaryRow> } | null>(null);

  useEffect(() => {
    let live = true;
    j<Franchises>("data/franchises.json").then(f => {
      if (!live) return;
      const rec = f[String(rid)] ?? null;
      setFr(rec);
      if (rec?.seasons.length) setRosterSeason(rec.seasons[rec.seasons.length - 1].season);
    }).catch(() => { if (live) setFr(null); });
    return () => { live = false; };
  }, [rid]);

  useEffect(() => {
    if (!rosterSeason) return;
    let live = true;
    Promise.all([
      j<Team[]>(`data/${rosterSeason}/teams.json`),
      j<SummaryRow[]>(`data/${rosterSeason}/summary.json`).catch(() => [] as SummaryRow[]),
    ]).then(([teams, sum]) => {
      if (!live) return;
      const team = teams.find(t => t.roster_id === rid) || null;
      setRoster(team ? { team, sum: new Map(sum.map(s => [s[0], s])) } : null);
    });
    return () => { live = false; };
  }, [rosterSeason, rid]);

  if (fr === undefined) return <div className="empty">Loading franchise…</div>;
  if (!fr) return <div className="empty">No franchise history found.</div>;

  const seasons = fr.seasons;
  const latest = seasons[seasons.length - 1];
  const former = [...new Set(seasons.map(s => s.name))].filter(n => n !== latest.name);
  const txSeasons = [...new Set(fr.tx.map(t => t.season))].sort().reverse();
  const txs = fr.tx.slice().sort((a, b) => b.ts - a.ts).filter(t =>
    (txSeason === "all" || t.season === txSeason) && (
      txFilter === "all" ? true
        : txFilter === "trade" ? t.type === "trade"
          : txFilter === "add" ? !!t.adds?.length
            : !!t.drops?.length));

  return (
    <>
      <span className="back" onClick={back}>← all teams</span>
      <div id="teamDetail">
        <h2>{latest.name}</h2>
        <div className="mgr">
          {latest.manager}
          {former.length > 0 && <span style={{ color: "var(--dim)" }}> · formerly {former.join(", ")}</span>}
        </div>

        <h3 style={{ margin: "16px 0 6px" }}>Year by year</h3>
        <table style={{ width: "auto" }}>
          <thead><tr>
            <th>Season</th><th style={{ textAlign: "left" }}>Team</th><th>Record</th>
            <th>Seed</th><th>Finish</th><th>PPG</th><th>WAR</th>
            <th style={{ textAlign: "left" }}>Top WAR</th>
            <th style={{ textAlign: "left" }}>Low starter</th>
          </tr></thead>
          <tbody>
            {seasons.slice().reverse().map(s => (
              <tr key={s.season} style={{ cursor: "default" }}>
                <td>{s.season}</td>
                <td style={{ textAlign: "left" }}>{s.name}
                  {s.manager !== latest.manager && <span style={{ color: "var(--dim)" }}> · {s.manager}</span>}</td>
                <td>{s.wins}-{s.losses}{s.ties ? `-${s.ties}` : ""}</td>
                <td style={{ color: "var(--dim)" }}>{s.seed ?? "—"}</td>
                <td>{finishLabel(s.finish)}</td>
                <td>{fmt(s.ppg, 1)}</td>
                <td className={clsOf(s.war)}>{fmt(s.war, 2)}</td>
                <td style={{ textAlign: "left" }}>{s.top
                  ? <><PlayerLink pid={s.top.pid} name={pInfo(players, s.top.pid)[0]} />{" "}
                    <span className={clsOf(s.top.war)}>{fmt(s.top.war, 2)}</span></> : "—"}</td>
                <td style={{ textAlign: "left" }}>{s.low
                  ? <><PlayerLink pid={s.low.pid} name={pInfo(players, s.low.pid)[0]} />{" "}
                    <span className={clsOf(s.low.war)}>{fmt(s.low.war, 2)}</span></> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "22px 0 8px", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Transactions</h3>
          <div style={{ display: "flex", gap: 6 }}>
            {TXF.map(([k, l]) => (
              <span key={k} className={`chip ${txFilter === k ? "on" : ""}`}
                style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => setTxFilter(k)}>{l}</span>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {["all", ...txSeasons].map(s => (
              <span key={s} className={`chip ${txSeason === s ? "on" : ""}`}
                style={{ fontSize: 12, padding: "2px 10px" }} onClick={() => setTxSeason(s)}>
                {s === "all" ? "All yrs" : s}</span>
            ))}
          </div>
        </div>
        <div style={{ maxWidth: 720 }}>
          {txs.length === 0 ? <div style={{ color: "var(--dim)" }}>none</div> : txs.map((t, i) => (
            <div key={i} className="ownevt">
              <span className="ownwk">{t.season} W{t.week}</span>
              {t.type === "trade"
                ? <>traded with <b style={{ color: "var(--txt)" }}>{(t.with || []).join(", ")}</b>
                  {t.got?.length ? <> — got {t.got.join(", ")}</> : null}
                  {t.gave?.length ? <>; gave {t.gave.join(", ")}</> : null}</>
                : <>{t.adds?.length ? <>added {t.adds.join(", ")}</> : null}
                  {t.adds?.length && t.drops?.length ? "; " : ""}
                  {t.drops?.length ? <>dropped {t.drops.join(", ")}</> : null}
                  {t.type === "waiver" && <span style={{ color: "var(--dim)" }}> · waiver</span>}</>}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "22px 0 8px" }}>
          <h3 style={{ margin: 0 }}>Roster</h3>
          <select value={rosterSeason ?? ""} onChange={e => setRosterSeason(e.target.value)}
            style={{ background: "var(--card)", border: "1px solid var(--line)", color: "var(--txt)", padding: "4px 8px", borderRadius: 8 }}>
            {seasons.slice().reverse().map(s => <option key={s.season} value={s.season}>{s.season}</option>)}
          </select>
        </div>
        {roster ? <RosterTable team={roster.team} sum={roster.sum} players={players} />
          : <div style={{ color: "var(--dim)" }}>no roster for this season</div>}
      </div>
    </>
  );
}

function RosterTable({ team, sum, players }: { team: Team; sum: Map<string, SummaryRow>; players: PlayersMin }) {
  const rows = team.players.map(p => {
    const s = sum.get(p);
    const tag = team.taxi.includes(p) ? "TAXI" : team.reserve.includes(p) ? "IR"
      : team.starters.includes(p) ? "START" : "";
    return {
      id: p, nm: pInfo(players, p)[0], pos: pInfo(players, p)[1], tag,
      gp: s ? s[2] : 0, ppg: s ? s[4] : 0, war: s ? s[6] : 0,
    };
  }).sort((a, b) => b.war - a.war);
  return (
    <table style={{ width: "auto" }}>
      <thead><tr>
        <th style={{ textAlign: "left" }}>Player</th><th>Pos</th><th>GP</th><th>PPG</th><th>WAR</th>
      </tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.id} style={{ cursor: "default" }}>
            <td style={{ textAlign: "left" }}><PlayerLink pid={r.id} name={r.nm} />
              {r.tag && <span className="tag"
                style={r.tag === "START" ? { color: "var(--acc)", borderColor: "var(--acc)" } : {}}> {r.tag}</span>}</td>
            <td><PosBadge pos={r.pos} /></td>
            <td>{r.gp}</td>
            <td>{fmt(r.ppg)}</td>
            <td className={clsOf(r.war)}>{fmt(r.war, 3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
