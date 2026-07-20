import { useState } from "react";
import TradeCalc from "../components/TradeCalc";

/** Trade calculator. Generic mode values assets straight up; team mode names
 *  the two sides and applies each franchise's computed per-year discount δ
 *  (contenders discount future WAR harder than rebuilders). The old
 *  league-wide trade log lives on in each franchise page's Trades tab. */
export default function Trades() {
  const [mode, setMode] = useState<"generic" | "team">(
    () => sessionStorage.getItem("bdd-trade-prefill") ? "team" : "generic");
  return (
    <>
      <div className="bar" style={{ marginBottom: 10 }}>
        <span className={`chip ${mode === "generic" ? "on" : ""}`} onClick={() => setMode("generic")}>Calculator</span>
        <span className={`chip ${mode === "team" ? "on" : ""}`} onClick={() => setMode("team")}>Team mode</span>
      </div>
      <TradeCalc teamMode={mode === "team"} />
    </>
  );
}
