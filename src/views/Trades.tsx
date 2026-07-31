import TradeCalc from "../components/TradeCalc";

/**
 * Trade machine — the forward-looking calculator (1G). The realized-WAR
 * ledger it used to share this screen with is its own page (views/Ledger.tsx),
 * reached from the League dashboard: "how did our trades turn out" and
 * "should I make this one" are different questions.
 */
export default function Trades() {
  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Trade machine</span>
        <span className="screen-note">Each side = what that team sends away</span>
      </div>
      <TradeCalc />
    </>
  );
}
