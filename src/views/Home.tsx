import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  DviFile, Franchises, PickValues, PicksOwned, ProjectionsFile, Team,
  Trade, TradesPayload, Values,
} from "../lib/types";
import { j, jl, jDaily, jlDaily } from "../lib/data";
import { fmt, sgn } from "../lib/stats";
import { useLeague, useLeaguePath } from "../lib/context";
import { computePostures, rosterShapes } from "../lib/rosterModel";
import { DEFAULT_LINEUP } from "../lib/league";
import TradeCard, { readTrades } from "../components/TradeCard";
import { PlayerLink } from "../components/PlayerLink";
import PosBadge from "../components/PosBadge";

const ord = (n: number) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const ORD_R = ["1st", "2nd", "3rd", "4th"];
const RECENT_TRADES = 5;
const MOVERS = 6;
/** the window the movers list reports; matches the player page's mid window */
const MOVER_DAYS = 14;

interface Row {
  rid: number; name: string; manager: string;
  finish: number | null; record: string;
  war: number; warRank: number;
  dvi: number; dviRank: number;
  status: string; age: number | null;
  picks: Record<number, number>;   // round -> count, across future seasons
}

export default function Home() {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [fr, setFr] = useState<Franchises | null>(null);
  const [proj, setProj] = useState<ProjectionsFile | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [dvi, setDvi] = useState<DviFile | null>(null);
  const [pv, setPv] = useState<PickValues | null>(null);
  const [owned, setOwned] = useState<PicksOwned | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [vals, setVals] = useState<Values | null>(null);
  const [hist, setHist] = useState<Record<string, [string, number, number][]> | null>(null);
  const [openTrade, setOpenTrade] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    const set = <T,>(f: (v: T) => void) => (v: T) => { if (live) f(v); };
    jl<Franchises>("franchises.json").then(set(setFr)).catch(() => {});
    jl<ProjectionsFile>("projections.json").then(p => {
      if (!live) return;
      setProj(p);
      jl<Team[]>(`${p.meta.roster_season}/teams.json`).then(set(setTeams)).catch(() => {});
    }).catch(() => {});
    jlDaily<DviFile>("dvi.json").then(set(setDvi)).catch(() => {});
    jlDaily<PickValues>("pick_values.json").then(set(setPv)).catch(() => {});
    jl<PicksOwned>("picks_owned.json").then(set(setOwned)).catch(() => {});
    jl<TradesPayload>("trades.json")
      .then(p => { if (live) setTrades(readTrades(p).trades); }).catch(() => {});
    jDaily<Values>("data/values.json").then(set(setVals)).catch(() => {});
    j<Record<string, [string, number, number][]>>("data/values_history.json")
      .then(set(setHist)).catch(() => {});
    return () => { live = false; };
  }, []);

  /** the franchise board — one row per team, ranked two ways */
  const rows = useMemo<Row[] | null>(() => {
    if (!fr || !proj || !teams || !dvi) return null;
    const season = String(proj.meta.roster_season);
    const flat: Record<string, number> = {};
    for (const [pid, r] of Object.entries(dvi.players)) flat[pid] = r.dvi;
    const lineup = meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP;
    void rosterShapes(proj.players, teams, flat, lineup);  // warms shared work

    // WAR side: postures already rank current strength and classify a window.
    // Picks need pick_values + picks_owned; without them it still ranks, just
    // on the lineup alone, so the board renders before those land.
    const postures = pv
      ? computePostures(proj.players, teams, pv, owned, +season)
      : [];
    const warOf = new Map(postures.map(p => [p.rid, p]));

    const byPid = new Map(proj.players.map(p => [p.pid, p]));
    const dviTotal = new Map(teams.map(t => [
      t.roster_id,
      t.players.reduce((a, pid) => a + (byPid.has(pid) ? flat[pid] ?? 0 : 0), 0),
    ]));
    const rank = (v: number, all: number[]) => 1 + all.filter(x => x > v + 1e-9).length;
    const warAll = teams.map(t => warOf.get(t.roster_id)?.s?.[0] ?? 0);
    const dviAll = [...dviTotal.values()];

    // the last completed season is what "finish" means — not the roster season,
    // which in the offseason has no games and every team at 0-0
    const done = league.latest;
    return teams.map(t => {
      const rid = t.roster_id;
      const f = fr[String(rid)];
      const cur = f?.seasons.find(s => s.season === season) ?? f?.seasons[f.seasons.length - 1];
      const last = f?.seasons.find(s => s.season === done);
      const p = warOf.get(rid);
      const war = p?.s?.[0] ?? 0;
      const dv = dviTotal.get(rid) ?? 0;
      const picks: Record<number, number> = {};
      for (const pk of owned?.owned?.[String(rid)] ?? [])
        picks[pk.round] = (picks[pk.round] ?? 0) + 1;
      return {
        rid, name: cur?.name ?? t.team, manager: cur?.manager ?? t.manager,
        finish: last?.finish ?? null,
        record: last ? `${last.wins}-${last.losses}${last.ties ? `-${last.ties}` : ""}` : "—",
        war, warRank: rank(war, warAll),
        dvi: dv, dviRank: rank(dv, dviAll),
        status: p?.status ?? "—", age: p?.age ?? null,
        picks,
      };
    }).sort((a, b) => a.warRank - b.warRank);
  }, [fr, proj, teams, dvi, pv, owned, meta, league]);

  /** biggest market moves over the window, league-wide */
  const movers = useMemo(() => {
    if (!hist || !teams || !vals) return null;
    const owner = new Map<string, string>();
    for (const t of teams) for (const pid of t.players) owner.set(pid, t.team);
    const out: { pid: string; d: number; now: number; team: string }[] = [];
    for (const [pid, rows] of Object.entries(hist)) {
      if (!owner.has(pid) || rows.length < 2) continue;
      const now = rows[rows.length - 1];
      // walk back to the first snapshot at least MOVER_DAYS old; short history
      // just uses the oldest one there is rather than dropping the player
      const cutoff = Date.parse(now[0]) - MOVER_DAYS * 864e5;
      let prev = rows[0];
      for (const r of rows) { if (Date.parse(r[0]) <= cutoff) prev = r; }
      const a = now[2], b = prev[2];
      if (!a || !b) continue;
      out.push({ pid, d: a - b, now: a, team: owner.get(pid)! });
    }
    out.sort((x, y) => y.d - x.d);
    return { up: out.slice(0, MOVERS), down: out.slice(-MOVERS).reverse() };
  }, [hist, teams, vals]);

  const recent = useMemo(
    () => trades.slice().sort((a, b) => b.ts - a.ts).slice(0, RECENT_TRADES),
    [trades]);

  const champ = rows?.find(r => r.finish === 1);
  const rounds = [...new Set((rows ?? []).flatMap(r => Object.keys(r.picks).map(Number)))]
    .sort((a, b) => a - b);

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{league.name}</span>
        <span className="screen-note">
          {league.seasons.length} seasons · {league.rosterSeason} rosters
          {champ && <> · {league.latest} champion <b>{champ.name}</b></>}
        </span>
      </div>

      {/* ---- franchise board ---- */}
      <div className="dwrap">
        <div className="dhead">
          <div className="chart-label" style={{ marginBottom: 0 }}>The league</div>
        </div>
        {!rows ? <div className="empty">Loading league…</div> : (
          <div className="dscroll">
            <table className="wide homeboard">
              <thead><tr>
                <th className="t">Franchise</th>
                <th className="t hm">Window</th>
                <th className="n">WAR</th>
                <th className="n hm">Rank</th>
                <th className="n">DVI</th>
                <th className="n hm">Rank</th>
                <th className="n hm">Age</th>
                <th className="n">{league.latest ?? "Last"}</th>
                {rounds.map(r => <th key={r} className="n hm">{ORD_R[r - 1] ?? `R${r}`}</th>)}
              </tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.rid} className="click"
                    onClick={() => nav(lp(`/teams/${league.rosterSeason}/${r.rid}`))}>
                    <td className="t">
                      <div className="nm">{r.name}</div>
                      <div className="by">{r.manager}</div>
                    </td>
                    <td className={`t hm win-${r.status}`}>{r.status}</td>
                    <td className="n"><b>{fmt(r.war, 2)}</b></td>
                    <td className="n hm sub">{ord(r.warRank)}</td>
                    <td className="n"><b>{fmt(r.dvi, 0)}</b></td>
                    <td className="n hm sub">{ord(r.dviRank)}</td>
                    <td className="n hm sub">{r.age == null ? "—" : fmt(r.age, 1)}</td>
                    <td className="n">
                      {r.finish ? <span className={r.finish === 1 ? "fin champ" : "fin"}>
                        {r.finish === 1 ? "🏆" : ord(r.finish)}
                      </span> : "—"}
                      <div className="by">{r.record}</div>
                    </td>
                    {rounds.map(k => (
                      <td key={k} className="n hm sub">{r.picks[k] || "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="tnote">
          WAR is the projected starting lineup for {league.rosterSeason} plus owned picks;
          DVI is total dynasty value across the whole roster. Finish and record are {league.latest}.
          Pick columns count future rookie picks held.
        </div>
      </div>

      {/* ---- recent trades ---- */}
      {recent.length > 0 && (
        <div className="dwrap">
          <div className="dhead">
            <div className="chart-label" style={{ marginBottom: 0 }}>Recent trades</div>
            <button type="button" className="dtoggle" onClick={() => nav(lp("/trades"))}>
              All trades
            </button>
          </div>
          {recent.map((t, i) => (
            <TradeCard key={t.ts} t={t} open={openTrade === i}
              onToggle={() => setOpenTrade(openTrade === i ? null : i)} />
          ))}
        </div>
      )}

      {/* ---- market movers ---- */}
      {movers && (movers.up.length > 0 || movers.down.length > 0) && (
        <div className="dwrap">
          <div className="dhead">
            <div className="chart-label" style={{ marginBottom: 0 }}>
              Market movers · {MOVER_DAYS} days
            </div>
          </div>
          <div className="pick-tables">
            {([["Rising", "best", movers.up], ["Falling", "worst", movers.down]] as const)
              .map(([title, cls, list]) => (
                <div key={cls}>
                  <div className={`pick-title ${cls}`}>{title}</div>
                  <table>
                    <tbody>
                      {list.map(m => {
                        const p = proj?.players.find(x => x.pid === m.pid);
                        return (
                          <tr key={m.pid}>
                            <td className="who">
                              <div className="line">
                                {p && <PosBadge pos={p.pos} />}
                                <PlayerLink pid={m.pid} name={p?.name ?? m.pid} />
                              </div>
                              <div className="by">{m.team}</div>
                            </td>
                            <td className="n sub">{fmt(m.now, 0)}</td>
                            <td className="n vs"
                              style={{ color: m.d >= 0 ? "var(--good)" : "var(--bad)" }}>
                              {sgn(m.d, 0)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ))}
          </div>
          <div className="tnote">
            Change in KeepTradeCut value over the last {MOVER_DAYS} days, rostered players only.
          </div>
        </div>
      )}
    </>
  );
}
