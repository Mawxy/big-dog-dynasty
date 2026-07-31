import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLeaguePath } from "../lib/context";
import SeasonPicker from "../components/SeasonPicker";
import type { Matchups, MatchEntry, PlayersMin, ProjectionsFile, SeasonData, Team, Weekly } from "../lib/types";
import { jl } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean, normCdf, normInv } from "../lib/stats";
import { pInfo, weekIndex, seasonSeg, optimalLineup } from "../lib/league";
import { useMobile } from "../lib/useWidth";
import { PlayerLink } from "../components/PlayerLink";
import HoverTip from "../components/HoverTip";

type WkIdx = Record<string, Record<number, [number, number]>>;
const REG_WEEKS = 14;
interface LineupEntry { id: string; pos: string; war: number; slot: string; ppg: number | null; bye: number | null; age?: number }
interface Row {
  rid: number; seed: number; team: string; manager: string; wins: number; fpts: number;
  rec: string; med: string; medw: number; ppg: number; sdv: number; war: number;
  ent: MatchEntry[];
  proj?: boolean; lineup?: LineupEntry[]; bench?: LineupEntry[];
  sos?: number | null;
  sched?: { wk: number; opp: number; p: number; war?: number; oppD?: number;
    pts?: number; oppPts?: number;
    subs?: { slot: string; out: string | null; in: string | null }[];
    oppL?: { slot: string; id: string | null; war: number }[];
    oppSubs?: { slot: string; out: string | null; in: string | null }[] }[];
}

interface Props {
  data: SeasonData; season: string; players: PlayersMin;
}

export default function Teams({ data, season, players }: Props) {
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [openRid, setOpenRid] = useState<number | null>(null);
  const nav = useNavigate();
  const lp = useLeaguePath();
  const mobile = useMobile();

  const [projs, setProjs] = useState<ProjectionsFile | null>(null);
  const [err, setErr] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (season === "ALL") return;
    let live = true;
    setErr(false);
    Promise.all([
      jl<Weekly>(`${season}/weekly.json`),
      jl<Matchups>(`${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [season, reload]);

  useEffect(() => {
    if (data.summary.length) return;
    let live = true;
    jl<ProjectionsFile>("projections.json").then(p => { if (live) setProjs(p); }).catch(() => {});
    return () => { live = false; };
  }, [data]);
  const isProj = !data.summary.length && projs != null && String(projs.meta.roster_season) === season;

  const wkIdx: WkIdx = useMemo(() => weekly ? weekIndex(weekly) : {}, [weekly]);

  const rows = useMemo<Row[]>(() => {
    if (!mw) return [];
    if (isProj && projs) {
      const byPid = new Map(projs.players.map(p => [p.pid, p]));
      const built = data.teams.map(t => {
        const pool = t.players
          .map(pid => byPid.get(pid))
          .filter((p): p is NonNullable<typeof p> => !!p)
          .map(p => ({ id: p.pid, pos: p.pos, war: p.composite[0] ?? 0, bye: p.bye ?? null, ppg: p.ppg ?? 0, age: p.age }));
        const { slots, starters } = optimalLineup(pool);
        const lineup: LineupEntry[] = slots.filter(s => s.player).map(s => ({
          ...s.player!, slot: s.slot === "SUPER_FLEX" ? "SF" : s.slot,
          ppg: byPid.get(s.player!.id)?.ppg ?? null,
        }));
        const slotInfo = slots.map(s => ({
          name: s.slot === "SUPER_FLEX" ? "SF" : s.slot, id: s.player?.id ?? null,
        }));
        const bench: LineupEntry[] = pool.filter(p => !starters.has(p.id))
          .sort((a, b) => b.war - a.war).slice(0, 5)
          .map(p => ({ ...p, slot: "BN", ppg: byPid.get(p.id)?.ppg ?? null }));
        const war = lineup.reduce((a, l) => a + l.war, 0);
        const ppg = lineup.reduce((a, l) => a + (l.ppg ?? 0), 0);
        return { t, pool, war, ppg, lineup, bench, slotInfo };
      });
      const meanWar = mean(built.map(b => b.war));
      const warOf = new Map(built.map(b => [b.t.roster_id, b.war]));
      const poolOf = new Map(built.map(b => [b.t.roster_id, b.pool]));
      const slotsOf = new Map(built.map(b => [b.t.roster_id, b.slotInfo]));
      interface WkSlot { id: string | null; war: number }
      const wkCache = new Map<string, { war: number; ppg: number; slots: WkSlot[] }>();
      const lineupAt = (rid: number, wk: number) => {
        const key = `${rid}:${wk}`;
        let v = wkCache.get(key);
        if (v == null) {
          const { slots } = optimalLineup((poolOf.get(rid) ?? []).filter(p => p.bye !== wk));
          v = {
            war: slots.reduce((a, s) => a + (s.player?.war ?? 0), 0),
            ppg: slots.reduce((a, s) => a + (s.player?.ppg ?? 0), 0),
            slots: slots.map(s => ({ id: s.player?.id ?? null, war: s.player?.war ?? 0 })),
          };
          wkCache.set(key, v);
        }
        return v;
      };
      const warAt = (rid: number, wk: number) => lineupAt(rid, wk).war;
      const zAt = (rid: number, wk: number) => {
        const s = Math.min(0.45, Math.max(-0.45, (warAt(rid, wk) - meanWar) / 13));
        return normInv(0.5 + s);
      };
      const psWk = mw.playoff_start || 15;
      const games: Record<number, { wk: number; opp: number }[]> = {};
      for (const [wkS, pairs] of Object.entries(mw.schedule ?? {})) {
        const wk = +wkS;
        if (wk >= psWk) continue;
        for (const [a, b] of pairs) {
          (games[a] ??= []).push({ wk, opp: b });
          (games[b] ??= []).push({ wk, opp: a });
        }
      }
      const rs: Row[] = built.map(({ t, war, ppg, lineup, bench }) => {
        const gs = (games[t.roster_id] ?? []).sort((a, b) => a.wk - b.wk);
        let wins: number, sos: number | null = null;
        let sched: Row["sched"];
        if (gs.length) {
          sched = gs.map(g => {
            const me = lineupAt(t.roster_id, g.wk);
            const opp = lineupAt(g.opp, g.wk);
            const subs = (slotsOf.get(t.roster_id) ?? [])
              .map((s, i) => ({ slot: s.name, out: s.id, in: me.slots[i]?.id ?? null }))
              .filter(x => x.out !== x.in);
            const oppL = (slotsOf.get(g.opp) ?? [])
              .map((s, i) => ({ slot: s.name, ...opp.slots[i] }));
            const oppSubs = (slotsOf.get(g.opp) ?? [])
              .map((s, i) => ({ slot: s.name, out: s.id, in: opp.slots[i]?.id ?? null }))
              .filter(x => x.out !== x.in);
            return {
              ...g,
              p: normCdf(zAt(t.roster_id, g.wk) - zAt(g.opp, g.wk)),
              war: me.war,
              oppD: Math.max(0, (warOf.get(g.opp) ?? 0) - opp.war),
              pts: me.ppg,
              oppPts: opp.ppg,
              subs: subs.length ? subs : undefined,
              oppL,
              oppSubs: oppSubs.length ? oppSubs : undefined,
            };
          });
          wins = sched.reduce((a, g) => a + g.p, 0);
          sos = mean(gs.map(g => warOf.get(g.opp) ?? meanWar));
        } else {
          wins = Math.min(REG_WEEKS, Math.max(0, REG_WEEKS / 2 + (war - meanWar) * (REG_WEEKS / 13)));
        }
        return {
          rid: t.roster_id, seed: 0, team: t.team, manager: t.manager,
          wins, fpts: 0, rec: `${fmt(wins, 1)}-${fmt((gs.length || REG_WEEKS) - wins, 1)}`,
          med: "—", medw: 0, ppg, sdv: 0, war, ent: [],
          proj: true, lineup, bench, sos, sched,
        };
      });
      const seedOrder = rs.slice().sort((a, b) => b.wins - a.wins);
      rs.forEach(r => { r.seed = seedOrder.indexOf(r) + 1; });
      rs.sort((a, b) => a.seed - b.seed);
      return rs;
    }
    const ps = mw.playoff_start || 15;
    const weekPts: Record<number, number[]> = {};
    for (const list of Object.values(mw.teams))
      for (const e of list) if (e[0] < ps) (weekPts[e[0]] ??= []).push(e[1]);
    const medians: Record<number, number> = {};
    for (const [wk, pts] of Object.entries(weekPts)) {
      const v = pts.slice().sort((a, b) => a - b), n = v.length;
      medians[+wk] = n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }
    const rs: Row[] = data.teams.map(t => {
      const ent = mw.teams[String(t.roster_id)] || [];
      const reg = ent.filter(e => e[0] < ps);
      const pts = reg.map(e => e[1]);
      let war = 0;
      for (const e of reg) for (const p of e[4]) {
        const v = wkIdx[p]?.[e[0]];
        if (v) war += v[1];
      }
      let mwin = 0, mloss = 0, mtie = 0;
      for (const e of reg) {
        const m = medians[e[0]];
        if (m == null) continue;
        e[1] > m ? mwin++ : e[1] < m ? mloss++ : mtie++;
      }
      const g = t.wins + t.losses + t.ties;
      return {
        rid: t.roster_id, seed: 0, team: t.team, manager: t.manager, wins: t.wins, fpts: t.fpts,
        rec: `${t.wins}-${t.losses}${t.ties ? "-" + t.ties : ""}`,
        med: `${mwin}-${mloss}${mtie ? "-" + mtie : ""}`, medw: mwin,
        ppg: pts.length ? mean(pts) : (g ? t.fpts / g : 0),
        sdv: sd(pts), war, ent,
      };
    });
    const seedOrder = rs.slice().sort((a, b) => b.wins - a.wins || b.fpts - a.fpts);
    rs.forEach(r => { r.seed = seedOrder.indexOf(r) + 1; });
    rs.sort((a, b) => a.seed - b.seed);
    return rs;
  }, [data, mw, wkIdx, isProj, projs]);

  // keep the header (and its season picker) on every empty state, or a season
  // with nothing to show leaves no control to pick a different one
  const shell = (msg: React.ReactNode) => (
    <>
      <div className="screen-head">
        <span className="screen-title">Standings</span>
        <SeasonPicker />
      </div>
      <div className="empty">{msg}</div>
    </>
  );
  if (season === "ALL") return shell("Standings are a per-season view — pick a year.");
  if (err) return shell(<>Couldn't load team data.{" "}
    <button className="retry" onClick={() => setReload(n => n + 1)}>Retry</button></>);
  if (!mw || !weekly) return shell("Loading…");

  const warMax = Math.max(0.01, ...rows.map(r => r.war));
  const tnames: Record<number, string> = {};
  data.teams.forEach(t => { tnames[t.roster_id] = t.team; });
  const openRow = openRid != null ? rows.find(r => r.rid === openRid) : undefined;
  const ps = mw.playoff_start || 15;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{isProj ? "Projected standings" : "Final standings"}</span>
        <SeasonPicker />
        <span className="screen-note">Playoffs from week {ps} · top 6 seeds</span>
      </div>

      <table>
        <colgroup>
          <col style={{ width: 52 }} /><col /><col className="hm" style={{ width: 150 }} />
          <col style={{ width: 96 }} /><col className="hm" style={{ width: 110 }} /><col style={{ width: 96 }} />
          <col style={{ width: 86 }} /><col className="hm" style={{ width: 100 }} /><col style={{ width: 186 }} />
        </colgroup>
        <thead>
          <tr className="grp">
            <th colSpan={mobile ? 2 : 3}></th>
            <th className="edge" colSpan={mobile ? 2 : 3}>Results</th>
            <th className="edge value" colSpan={mobile ? 2 : 3}>Scoring &amp; value</th>
          </tr>
          <tr>
            <th className="c">Seed</th>
            <th className="t">Franchise</th>
            <th className="t hm">Manager</th>
            <th className="n edge">Record</th>
            <th className="n hm">Vs median</th>
            <th className="n">Luck</th>
            <th className="n edge">PPG</th>
            <th className="n hm">Volatility</th>
            <th className="n key">Lineup WAR</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const luck = r.proj ? null : r.wins - r.medw;
            return (
              <tr key={r.rid} className={`click ${openRid === r.rid ? "open" : i % 2 ? "zebra" : ""}`}
                onClick={() => setOpenRid(openRid === r.rid ? null : r.rid)}>
                <td className="rank">
                  <span className="spine" style={{ background: r.seed <= 6 ? "var(--acc)" : "#2b3642" }} />
                  <span className="fig">{r.seed}</span>
                </td>
                <td className="name">
                  <span className="tlink" onClick={e => { e.stopPropagation(); nav(lp(`/franchise/${r.rid}`)); }}>{r.team}</span>
                </td>
                <td className="sub hm">{r.manager}</td>
                <td className="edge n" style={{ font: "600 20px/1 var(--cond)" }}>{r.rec}</td>
                <td className="fig quiet hm n">{r.proj ? "—" : r.med}</td>
                <td className="n" style={{ font: "600 15px/1.4 var(--cond)", color: luckColor(luck) }}>{luckStr(luck)}</td>
                <td className="fig strong edge n">{fmt(r.ppg, 1)}</td>
                <td className="fig quiet hm n">{r.proj ? "—" : fmt(r.sdv, 1)}</td>
                <td className="n last">
                  <div className="meter">
                    <div className="track team"><div className="fill" style={{ width: Math.round(r.war / warMax * 100) + "%" }} /></div>
                    <span className="val head-fig md">{fmt(r.war, 3)}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {openRow && !openRow.proj && <TeamDrawer r={openRow} tnames={tnames} ps={ps} />}
      {openRow && openRow.proj && (
        <div className="drawer">
          <ProjPanel r={openRow} players={players} teams={data.teams} />
        </div>
      )}

      <div className="footnote">
        Vs median = record against each week's league median score · luck = actual wins minus median wins ·
        lineup WAR sums each week's real starters, measured against the league-wide optimal pool
      </div>
    </>
  );
}

const luckStr = (l: number | null) => l == null ? "—" : (l > 0 ? "+" : l < 0 ? "−" : "") + Math.abs(l);
const luckColor = (l: number | null) => l == null || l === 0 ? "var(--dim)" : l > 0 ? "var(--good)" : "var(--bad)";

/** Season as a wrap of week cards, rendered after the table. */
function TeamDrawer({ r, tnames, ps }: { r: Row; tnames: Record<number, string>; ps: number }) {
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="drawer-title">{r.team}</span>
        <span className="drawer-sub">{r.manager} · {r.rec} · {fmt(r.ppg, 1)} ppg · lineup WAR {fmt(r.war, 3)}</span>
      </div>
      <div className="week-grid">
        {r.ent.filter(e => e[0] < ps).map(e => {
          const [wk, pts, opp, oppPts] = e;
          const res = oppPts == null ? "—" : pts > oppPts ? "W" : pts < oppPts ? "L" : "T";
          const cls = res === "W" ? "win" : res === "L" ? "loss" : "";
          return (
            <div key={wk} className={`week-card ${cls}`}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span className="wk">W{wk}</span>
                <span className="res" style={{ color: res === "W" ? "var(--good)" : res === "L" ? "var(--bad)" : "var(--dim)" }}>{res}</span>
              </div>
              <div className="score">{fmt(pts, 1)}</div>
              <div className="opp">vs {opp != null ? tnames[opp] || "?" : "—"}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Preseason projection detail — projected lineup + real schedule with per-game
 *  win probabilities, in the shared quick-look panel idiom. */
function ProjPanel({ r, players, teams }: { r: Row; players: PlayersMin; teams: Team[] }) {
  const tnames: Record<number, string> = {};
  teams.forEach(t => { tnames[t.roster_id] = t.team; });
  return (
    <>
      <div className="wkhead">
        <b>{r.team}</b> — {r.manager} · projected {r.rec} · {fmt(r.ppg, 1)} ppg
        {r.sos != null && <> · avg opponent lineup WAR {sgn(r.sos, 2)}</>}
      </div>
      <div className="wkflex">
        <div className="wkwrap">
          <table className="wktbl">
            <thead><tr><th>Slot</th><th style={{ textAlign: "left" }}>Player</th><th>Bye</th><th>PPG</th><th>Proj WAR</th></tr></thead>
            <tbody>
              {[...(r.lineup ?? []), ...(r.bench ?? [])].map((l, i) => (
                <tr key={i} style={l.slot === "BN" ? { opacity: 0.75 } : undefined}>
                  <td style={{ color: "var(--dim)" }}>{l.slot}</td>
                  <td style={{ textAlign: "left" }}><PlayerLink pid={l.id} name={pInfo(players, l.id)[0]} /></td>
                  <td style={{ color: "var(--dim)" }}>{l.bye ? `W${l.bye}` : "—"}</td>
                  <td>{l.ppg == null ? "—" : fmt(l.ppg, 1)}</td>
                  <td className={clsOf(l.war)}>{sgn(l.war)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.sched && r.sched.length > 0 && (
          <div className="wkwrap">
            <table className="wktbl">
              <thead><tr><th>Week</th><th style={{ textAlign: "left" }}>Opponent</th><th style={{ textAlign: "center" }}>Proj Score</th><th>Win %</th></tr></thead>
              <tbody>
                {r.sched.map(g => {
                  const oppName = tnames[g.opp] || `Roster ${g.opp}`;
                  return (
                    <tr key={g.wk}>
                      <td>W{g.wk}</td>
                      <td style={{ textAlign: "left" }}>
                        {g.oppL ? (
                          <HoverTip align="left" tip={<>
                            <div style={{ color: "var(--txt)", marginBottom: 2 }}>{oppName} · W{g.wk} lineup</div>
                            {g.oppL.map((s, i) => (
                              <div key={i}>
                                <span style={{ color: "var(--dim)", display: "inline-block", minWidth: 34 }}>{s.slot}</span>
                                <span style={{ color: "var(--txt)" }}>{s.id ? pInfo(players, s.id)[0] : "empty"}</span>
                                {s.id && <span className={clsOf(s.war)}> {sgn(s.war, 2)}</span>}
                              </div>
                            ))}
                          </>}>{oppName}</HoverTip>
                        ) : oppName}
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textAlign: "center" }}>
                        {g.pts == null || g.oppPts == null ? <span style={{ color: "var(--dim)" }}>—</span> : <>
                          <span style={{ display: "inline-block", minWidth: "3.2em", textAlign: "right" }}>{fmt(g.pts, 1)}</span>
                          <span style={{ color: "var(--dim)" }}> – </span>
                          <span style={{ display: "inline-block", minWidth: "3.2em", textAlign: "left" }}>{fmt(g.oppPts, 1)}</span>
                        </>}
                      </td>
                      <td className={g.p >= 0.5 ? "num good" : "num bad"}>{fmt(g.p * 100, 0)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
