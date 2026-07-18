import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { Trade, TradeAsset } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf } from "../lib/stats";
import { PlayerLink } from "../components/PlayerLink";

const selStyle: CSSProperties = { background: "var(--card)", border: "1px solid var(--line)", color: "var(--txt)", padding: "4px 8px", borderRadius: 8, fontSize: 13 };
const lblStyle: CSSProperties = { color: "var(--dim)", fontSize: 13, display: "flex", alignItems: "center", gap: 6 };

const KIND: Record<string, string> = { player: "player", pick: "pick", faab: "FAAB" };
const when = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";

function Asset({ a }: { a: TradeAsset }) {
  const [head, tail] = a.label.split(" → ");
  return (
    <tr style={{ cursor: "default" }}>
      <td style={{ textAlign: "left" }}>
        <span className="tag">{KIND[a.kind] ?? a.kind}</span>{" "}
        {a.kind === "pick" && <span style={{ color: "var(--dim)" }}>{head}{tail ? " → " : ""}</span>}
        {a.pid ? <PlayerLink pid={a.pid} name={tail ?? head} /> : (tail ?? head)}
      </td>
      <td className={clsOf(a.war)} style={{ textAlign: "right" }}>{fmt(a.war, 2)}</td>
    </tr>
  );
}

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

      {rows.map((t, i) => {
        const best = Math.max(...t.sides.map(s => s.war));
        const spread = best - Math.min(...t.sides.map(s => s.war));
        const isOpen = open === i;
        return (
          <div key={`${t.ts}-${i}`} className="trade" onClick={() => setOpen(isOpen ? null : i)}>
            <div className="tradehead">
              <span className="ownwk">{t.season} W{t.week}</span>
              <span style={{ color: "var(--dim)", fontSize: 12 }}>{when(t.ts)}</span>
              <span style={{ marginLeft: "auto", color: "var(--dim)", fontSize: 12 }}>
                {spread < 0.001 ? "even" : `${sgn(spread, 2)} WAR edge`} · {isOpen ? "hide" : "detail"}
              </span>
            </div>
            <div className="tradesides">
              {t.sides.map(s => (
                <div key={s.rid} className={"tradeside" + (s.war === best && spread > 0.001 ? " win" : "")}>
                  <div className="tradeteam">{s.team}</div>
                  <div className={"tradewar " + clsOf(s.war)}>{fmt(s.war, 2)}</div>
                  {isOpen
                    ? <table style={{ width: "100%", marginTop: 6 }}>
                      <tbody>{s.got.map((a, k) => <Asset key={k} a={a} />)}</tbody>
                    </table>
                    : <div className="tradeassets">
                      {s.got.map(a => a.label.split(" → ").slice(-1)[0]).join(", ")}
                    </div>}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}
