import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Trade } from "../lib/types";
import { j } from "../lib/data";
import TradeCard from "../components/TradeCard";

const selStyle: CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", color: "var(--txt)", padding: "4px 8px", borderRadius: 8, fontSize: 13 };
const lblStyle: CSSProperties = { color: "var(--dim)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 };

export default function Trades() {
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [season, setSeason] = useState("all");
  const [team, setTeam] = useState("all");
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => { j<Trade[]>("data/trades.json").then(setTrades).catch(() => setTrades([])); }, []);

  const seasons = useMemo(() => [...new Set((trades ?? []).map(t => t.season))].sort().reverse(), [trades]);
  const teams = useMemo(
    () => [...new Set((trades ?? []).flatMap(t => t.sides.map(s => s.team)))].sort(),
    [trades]);
  const rows = useMemo(() => (trades ?? []).filter(t =>
    (season === "all" || t.season === season) &&
    (team === "all" || t.sides.some(s => s.team === team))), [trades, season, team]);

  if (!trades) return <div className="empty">Loading trades…</div>;
  if (!trades.length) return <div className="empty">No trades found.</div>;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "4px 0 14px", flexWrap: "wrap" }}>
        <label style={lblStyle}>Season
          <select value={season} onChange={e => { setSeason(e.target.value); setOpen(null); }} style={selStyle}>
            <option value="all">All</option>
            {seasons.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label style={lblStyle}>Team
          <select value={team} onChange={e => { setTeam(e.target.value); setOpen(null); }} style={selStyle}>
            <option value="all">All</option>
            {teams.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <span style={{ color: "var(--dim)", fontSize: 12 }}>
          {rows.length} trades · WAR = what each side's return produced while on their roster, from the trade forward
        </span>
      </div>

      {rows.map((t, i) => (
        <TradeCard key={`${t.ts}-${i}`} t={t} open={open === i}
          onToggle={() => setOpen(open === i ? null : i)} />
      ))}
    </>
  );
}
