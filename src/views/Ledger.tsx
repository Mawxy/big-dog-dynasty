import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import type { TradesPayload } from "../lib/types";
import { useJson } from "../lib/useJson";
import { readTrades, tradeWhen } from "../lib/trades";
import { fmtWar } from "../lib/stats";
import { useLeague, useLeaguePath } from "../lib/context";
import TradeCard, { sideRealized } from "../components/TradeCard";

/**
 * Trade ledger — every trade, each side scored on the WAR its return actually
 * produced. The other half of the Trade tab's machine/ledger lens: the
 * calculator (views/Trades.tsx) is the tab's default face and this is one
 * segment flip away. Still its own route so the League dashboard's activity
 * module and any old link land here directly.
 */
export default function Ledger() {
  const { players } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const file = useJson<TradesPayload>("trades.json");
  const err = file.error;
  // readTrades, not an inline Array.isArray: a TradesFile written without its
  // `trades` key left state undefined here and the page stuck on "Loading".
  const trades = useMemo(
    () => (file.data ? readTrades(file.data).trades : null), [file.data]);

  const cards = useMemo(() => {
    if (!trades) return [];
    return trades
      .filter(t => t.sides.length >= 2)
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .map((t, i) => {
        const [A, B] = t.sides;
        const aw = sideRealized(A), bw = sideRealized(B);
        let verdict = "Even so far", cls = "", vcolor = "var(--dim)";
        if (aw != null && bw != null && Math.abs(aw - bw) > 0.15) {
          verdict = `${aw > bw ? A.team : B.team} ahead by ${fmtWar(Math.abs(aw - bw))} WAR`;
          cls = "win"; vcolor = "var(--good)";
        } else if (aw != null && bw == null) {
          verdict = `${A.team} banked ${fmtWar(aw)} WAR · ${B.team} took picks`; cls = "pick"; vcolor = "var(--acc)";
        } else if (bw != null && aw == null) {
          verdict = `${B.team} banked ${fmtWar(bw)} WAR · ${A.team} took picks`; cls = "pick"; vcolor = "var(--acc)";
        }
        // ts is a Sleeper transaction timestamp and two trades processed in the
        // same batch share it — a bare ts as the React key collided and the two
        // cards traded contents on any re-render. Composite with the index, the
        // way the franchise page's trade list already does it.
        return { key: `${t.ts}-${i}`, trade: t, when: tradeWhen(t.ts), verdict, cls, vcolor };
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
      <div className="lens" role="tablist" aria-label="Trade machine or ledger">
        <button type="button" className="seg" role="tab" aria-selected="false"
          onClick={() => nav(lp("/trades"))}>
          Trade machine
        </button>
        <button type="button" className="seg on" role="tab" aria-selected="true">
          Ledger
        </button>
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
          <TradeCard key={c.key} trade={c.trade} players={players} cls={c.cls}
            when={c.when} verdict={c.verdict} verdictColor={c.vcolor}
            sideFig="return" />
        ))}
      </div>
      <div className="tnote screen">
        Picks show no realized WAR until they convert to a player. Each player asset is scored on the
        WAR it produced while starting for the team that acquired it.
      </div>
    </>
  );
}
