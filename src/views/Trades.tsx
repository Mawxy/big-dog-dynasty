import { useNavigate } from "react-router-dom";
import TradeCalc from "../components/TradeCalc";
import { useLeaguePath } from "../lib/context";

/**
 * Trade — the forward-looking calculator, and the default face of the Trade
 * tab. The realized-WAR ledger keeps its own route (views/Ledger.tsx) but is
 * one lens flip away rather than a separate destination: "should I make this
 * one" opens first, "how did our trades turn out" is the other segment. The
 * two stay separate ROUTES so either can be linked directly and the machine's
 * state isn't rebuilt under a mode toggle.
 */
export default function Trades() {
  const nav = useNavigate();
  const lp = useLeaguePath();
  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Trade machine</span>
        <span className="screen-note">Each side = what that team sends away</span>
      </div>
      <div className="lens" role="tablist" aria-label="Trade machine or ledger">
        <button type="button" className="seg on" role="tab" aria-selected="true">
          Trade machine
        </button>
        <button type="button" className="seg" role="tab" aria-selected="false"
          onClick={() => nav(lp("/ledger"))}>
          Ledger
        </button>
      </div>
      <TradeCalc />
    </>
  );
}
