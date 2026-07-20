import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PicksOwned, PickValues, ProjectionsFile, Team, Values } from "../lib/types";
import { j, jDaily } from "../lib/data";
import { fmt, sgn } from "../lib/stats";
import { computePostures, suggestTrades } from "../lib/tradeModel";
import { PlayerLink } from "./PlayerLink";

/** Win-win trade ideas that fill this franchise's weakest starting spot(s),
 *  found by marginal-lineup search over every roster (see tradeModel).
 *  "Try it out" opens the Trade Calculator prefilled with the deal. */
export default function SuggestedTrades({ rid }: { rid: number }) {
  const nav = useNavigate();
  const [proj, setProj] = useState<ProjectionsFile | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [pv, setPv] = useState<PickValues | null>(null);
  const [owned, setOwned] = useState<PicksOwned | null>(null);
  const [vals, setVals] = useState<Values | null>(null);

  useEffect(() => {
    let live = true;
    j<ProjectionsFile>("data/projections.json").then(p => {
      if (!live) return;
      setProj(p);
      j<Team[]>(`data/${p.meta.roster_season}/teams.json`)
        .then(t => { if (live) setTeams(t); }).catch(() => {});
    }).catch(() => {});
    j<PickValues>("data/pick_values.json").then(x => { if (live) setPv(x); }).catch(() => {});
    j<PicksOwned>("data/picks_owned.json").then(x => { if (live) setOwned(x); }).catch(() => {});
    jDaily<Values>("data/values.json").then(x => { if (live) setVals(x); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const sugg = useMemo(() => {
    if (!proj || !teams || !pv) return null;
    const season = +proj.meta.roster_season;
    const postures = computePostures(proj.players, teams, pv, owned, season);
    return {
      me: postures.find(p => p.rid === rid) ?? null,
      list: suggestTrades(rid, proj.players, teams, pv, owned, postures, season, vals),
    };
  }, [proj, teams, pv, owned, vals, rid]);

  if (!sugg) return null;
  if (!sugg.list.length) return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 16px", margin: "12px 0 4px" }}>
      <b style={{ color: "var(--txt)", fontSize: 13.5 }}>Suggested trades</b>{" "}
      <span style={{ color: "var(--dim)", fontSize: 12.5 }}>
        none found — no deal fills this roster's weakest spot while leaving both
        sides better off at realistic market prices. That usually means the roster
        is strong everywhere, or the missing piece is priced above what the
        surplus can buy.
      </span>
    </div>
  );
  const tryIt = (s: (typeof sugg.list)[number]) => {
    sessionStorage.setItem("bdd-trade-prefill", JSON.stringify({
      whoA: sugg.me?.name ?? "", whoB: s.fromName,
      a: [...s.sendPids.map(p => `p${p}`), ...s.sendPicks.map(k => `k${k.label}`)],
      b: [`p${s.targetPid}`],
    }));
    nav("/trades");
  };

  return (
    <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 16px", margin: "12px 0 4px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <b style={{ color: "var(--txt)", fontSize: 13.5 }}>Suggested trades</b>
        <span style={{ color: "var(--dim)", fontSize: 12 }}>
          win-win deals that fill the roster's weakest starting spot — both sides
          net positive under their own window weights
        </span>
      </div>
      {sugg.list.map(s => (
        <div key={s.targetPid} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10, fontSize: 13.5 }}>
          <div style={{ flex: "1 1 320px", lineHeight: 1.6 }}>
            Get <PlayerLink pid={s.targetPid} name={s.targetName} />{" "}
            <span style={{ color: "var(--dim)" }}>({s.targetPos}, from {s.fromName})</span>{" "}
            for{" "}
            <span style={{ color: "var(--txt)" }}>
              {[...s.sendNames, ...s.sendPicks.map(k => k.label)].join(" + ") || "—"}
            </span>
            <div style={{ color: "var(--dim)", fontSize: 12 }}>
              {s.shortfall > 0.05
                ? <>fills {s.needPos} ({s.needRank}th of 12, {fmt(s.shortfall, 2)} WAR below the avg starter group)</>
                : <>upgrades the roster's weakest spot, {s.needPos} ({s.needRank}th of 12)</>}
              {" · "}you <span className="num good">{sgn(s.netMe, 2)}</span>
              {" · "}them <span className="num good">{sgn(s.netThem, 2)}</span>
              {" weighted WAR"}
            </div>
          </div>
          <span className="chip" onClick={() => tryIt(s)}>Try it out →</span>
        </div>
      ))}
    </div>
  );
}
