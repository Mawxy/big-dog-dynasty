import { useEffect, useMemo, useState } from "react";
import type { Trade, TradeSide, TradesPayload } from "../lib/types";
import { jl } from "../lib/data";
import { fmt } from "../lib/stats";
import { pInfo } from "../lib/league";
import { useLeague } from "../lib/context";

/**
 * Trade ledger — every trade, each side scored on the WAR its return actually
 * produced. A dedicated page off the tab bar, reached from the League
 * dashboard's activity module; the forward-looking calculator is the Trade
 * machine tab. The two answer different questions ("how did our trades turn
 * out" vs "should I make this one") and sharing a screen buried this one
 * behind a mode toggle.
 */
export default function Ledger() {
  const { players } = useLeague();
  const [trades, setTrades] = useState<Trade[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    jl<TradesPayload>("trades.json")
      .then(p => setTrades(Array.isArray(p) ? p : p.trades))
      .catch(() => setErr(true));
  }, []);

  const cards = useMemo(() => {
    if (!trades) return [];
    // realized WAR of a side = its player assets; null when it took only picks
    const sideWar = (s: TradeSide): number | null =>
      s.got.some(a => a.kind === "player") ? s.war : null;
    return trades
      .filter(t => t.sides.length >= 2)
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map(t => {
        const [A, B] = t.sides;
        const aw = sideWar(A), bw = sideWar(B);
        let verdict = "Even so far", cls = "", vcolor = "var(--dim)";
        if (aw != null && bw != null && Math.abs(aw - bw) > 0.15) {
          verdict = `${aw > bw ? A.team : B.team} ahead by ${fmt(Math.abs(aw - bw), 3)} WAR`;
          cls = "win"; vcolor = "var(--good)";
        } else if (aw != null && bw == null) {
          verdict = `${A.team} banked ${fmt(aw, 3)} WAR · ${B.team} took picks`; cls = "pick"; vcolor = "var(--acc)";
        } else if (bw != null && aw == null) {
          verdict = `${B.team} banked ${fmt(bw, 3)} WAR · ${A.team} took picks`; cls = "pick"; vcolor = "var(--acc)";
        }
        return { key: t.ts, wk: t.week, verdict, cls, vcolor, sides: t.sides.map(s => ({ side: s, war: sideWar(s) })) };
      });
  }, [trades]);

  if (err) return <div className="empty">No trade data yet.</div>;
  if (!trades) return <div className="empty">Loading trades…</div>;
  if (!cards.length) return <div className="empty">No trades recorded.</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Trade ledger</span>
        <span className="screen-note"><b>{cards.length}</b> trades</span>
      </div>
      <div className="band">
        <span className="band-label">Every trade · newest first</span>
        <span className="band-note">
          Each side scored on the WAR its return produced after the trade · both sides in the
          same neutral ink
        </span>
      </div>
      <div className="ledger" style={{ paddingTop: 14 }}>
        {cards.map(c => (
          <div key={c.key} className={`trade ${c.cls}`}>
            <div className="trade-head">
              <span className="trade-wk">WEEK {c.wk}</span>
              <span className="trade-verdict" style={{ color: c.vcolor }}>{c.verdict}</span>
            </div>
            <div className="trade-sides">
              {c.sides.map(({ side, war }, i) => (
                <div key={i} className="trade-side">
                  <div className="hd">
                    <div>
                      <div className="k">Received</div>
                      <div className="team">{side.team}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div className="k">Return</div>
                      <div className="total" style={{ color: war == null ? "var(--dim3)" : undefined }}>
                        {war == null ? "—" : fmt(war, 3)}
                      </div>
                    </div>
                  </div>
                  {/* the same asset row the franchise page draws, and
                      deliberately the same neutral ink on both sides: coloring
                      each basket's figures green and red made every asset argue
                      for a winner, which is the verdict line's job (SKILL §5) */}
                  {side.got.map((a, k) => {
                    const isPick = a.kind !== "player";
                    const pos = !isPick && a.pid ? pInfo(players, a.pid)[1] : "PICK";
                    return (
                      <div key={k} className="trade-asset">
                        <span className={`pos sm ${isPick ? "PICK" : pos}`}>{isPick ? "PK" : pos}</span>
                        <span className={`nm ${isPick ? "pick" : ""}`}>{a.label}</span>
                        <span className="war" style={{ color: isPick ? "var(--dim3)" : "var(--txt2)" }}>
                          {isPick ? "—" : fmt(a.war, 3)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="tnote screen">
        Picks show no realized WAR until they convert to a player. Each player asset is scored on the
        WAR it produced while starting for the team that acquired it.
      </div>
    </>
  );
}
