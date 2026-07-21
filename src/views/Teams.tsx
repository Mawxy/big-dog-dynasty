import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Matchups, MatchEntry, PlayersMin, ProjectionsFile, SeasonData, Team, Weekly } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean, normCdf, normInv } from "../lib/stats";
import { pInfo, weekIndex, seasonSeg, optimalLineup } from "../lib/league";
import PosBadge from "../components/PosBadge";
import { PlayerLink } from "../components/PlayerLink";
import FranchisePage from "../components/FranchisePage";
import HoverTip from "../components/HoverTip";

type WkIdx = Record<string, Record<number, [number, number]>>;
const REG_WEEKS = 14;   // regular season length; composite rates are per-13 (bye)
interface LineupEntry { id: string; pos: string; war: number; slot: string; ppg: number | null; bye: number | null; age?: number }
interface Row {
  rid: number; seed: number; team: string; manager: string; wins: number; fpts: number;
  rec: string; med: string; medw: number; ppg: number; sdv: number; waa: number; war: number;
  ent: MatchEntry[];
  /** preseason: row built from projections — record is predicted, σ/WAA/vs-Median dash */
  proj?: boolean; lineup?: LineupEntry[]; bench?: LineupEntry[];
  /** preseason: avg opponent lineup WAR + per-week schedule with win prob,
   *  that week's bye-adjusted lineup WAR, and the opponent's bye WAR cost */
  sos?: number | null;
  sched?: { wk: number; opp: number; p: number; war?: number; oppD?: number;
    pts?: number; oppPts?: number;
    /** slot-by-slot lineup changes vs full strength (bye replacements) */
    subs?: { slot: string; out: string | null; in: string | null }[];
    /** opponent's bye-adjusted lineup this week + their bye replacements */
    oppL?: { slot: string; id: string | null; war: number }[];
    oppSubs?: { slot: string; out: string | null; in: string | null }[] }[];
}
type Key = keyof Row;
const COLS: { label: string; key: Key; hm?: boolean; noUpper?: boolean; w?: number | string }[] = [
  { label: "Seed", key: "seed", w: 44 },
  { label: "Team", key: "team" },
  { label: "Manager", key: "manager", hm: true, w: 170 },
  { label: "Record", key: "wins", w: 88 },
  { label: "vs Median", key: "medw", hm: true, w: 96 },
  { label: "PPG", key: "ppg", w: 80 },
  { label: "σ", key: "sdv", noUpper: true, w: 70 },
  { label: "WAA", key: "waa", w: 92 },
  { label: "WAR", key: "war", w: 92 },
];

interface Props {
  data: SeasonData; season: string; players: PlayersMin;
  detailRid: number | null; tab?: string;
}

export default function Teams({ data, season, players, detailRid, tab }: Props) {
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [sortCol, setSortCol] = useState(0);
  const [dir, setDir] = useState(1);
  const [openRid, setOpenRid] = useState<number | null>(null);
  const nav = useNavigate();

  const [projs, setProjs] = useState<ProjectionsFile | null>(null);
  const [err, setErr] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (season === "ALL") return;
    let live = true;
    setErr(false);
    Promise.all([
      j<Weekly>(`data/${season}/weekly.json`),
      j<Matchups>(`data/${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } })
      // without this, a transient weekly.json failure hangs on "Loading…" forever
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [season, reload]);

  // preseason: no scored weeks — predict the standings from the projections
  useEffect(() => {
    if (data.summary.length) return;
    let live = true;
    j<ProjectionsFile>("data/projections.json").then(p => { if (live) setProjs(p); }).catch(() => {});
    return () => { live = false; };
  }, [data]);
  const isProj = !data.summary.length && projs != null
    && String(projs.meta.roster_season) === season;

  const wkIdx: WkIdx = useMemo(() => weekly ? weekIndex(weekly) : {}, [weekly]);

  const rows = useMemo<Row[]>(() => {
    if (!mw) return [];
    if (isProj && projs) {
      // Optimal lineup per roster from year-1 composite WAR, then walk the
      // REAL schedule (Sleeper publishes all pairings preseason). Per game:
      // each team's per-week win-prob shift vs an average opponent is
      // s = (lineup WAR − league mean)/13; invert the engine's Φ mapping to an
      // equivalent margin and the head-to-head is P(i beats j) =
      // Φ(Φ⁻¹(½+sᵢ) − Φ⁻¹(½+sⱼ)). Expected wins = Σ P over the 14 weeks.
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
        // slot-by-slot ids of the full-strength lineup, for weekly diffs
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
      // bye-aware weekly lineup: rebuild the optimal lineup without that
      // week's bye players, so a stacked bye week costs real win probability
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
          // no schedule published (older data): strength-only fallback
          wins = Math.min(REG_WEEKS, Math.max(0, REG_WEEKS / 2 + (war - meanWar) * (REG_WEEKS / 13)));
        }
        return {
          rid: t.roster_id, seed: 0, team: t.team, manager: t.manager,
          wins, fpts: 0, rec: `${fmt(wins, 1)}-${fmt((gs.length || REG_WEEKS) - wins, 1)}`,
          med: "—", medw: 0, ppg, sdv: 0, waa: 0, war, ent: [],
          proj: true, lineup, bench, sos, sched,
        };
      });
      const seedOrder = rs.slice().sort((a, b) => b.wins - a.wins);
      rs.forEach(r => { r.seed = seedOrder.indexOf(r) + 1; });
      const k = COLS[sortCol].key;
      rs.sort((a, b) => typeof a[k] === "string"
        ? (a[k] as string).localeCompare(b[k] as string) * dir
        : ((a[k] as number) - (b[k] as number)) * dir);
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
      let waa = 0, war = 0;
      for (const e of reg) for (const p of e[4]) {
        const v = wkIdx[p]?.[e[0]];
        if (v) { waa += v[0]; war += v[1]; }
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
        sdv: sd(pts), waa, war, ent,
      };
    });
    const seedOrder = rs.slice().sort((a, b) => b.wins - a.wins || b.fpts - a.fpts);
    rs.forEach(r => { r.seed = seedOrder.indexOf(r) + 1; });
    const k = COLS[sortCol].key;
    rs.sort((a, b) => typeof a[k] === "string"
      ? (a[k] as string).localeCompare(b[k] as string) * dir
      : ((a[k] as number) - (b[k] as number)) * dir);
    return rs;
  }, [data, mw, wkIdx, sortCol, dir, isProj, projs]);

  if (season === "ALL") return <div className="empty">Teams are a per-season view — pick a year from the dropdown.</div>;
  if (err) return <div className="empty">Couldn't load team data.{" "}
    <button className="retry" onClick={() => setReload(n => n + 1)}>Retry</button></div>;
  if (!mw || !weekly) return <div className="empty">Loading…</div>;
  if (detailRid !== null)
    // key={detailRid} forces a fresh mount per franchise: without it, QuickJump
    // reuses the component and franchise A's pre-filtered trades stay rendered
    // under franchise B (the trades effect early-returns when trades is set).
    return <FranchisePage key={detailRid} rid={detailRid} players={players} tab={tab}
      onTab={t => nav(`/teams/${seasonSeg(season)}/${detailRid}/${t}`, { replace: true })}
      back={() => nav(`/teams/${seasonSeg(season)}`)} />;
  const ps = mw.playoff_start || 15;
  const clickCol = (i: number) => {
    if (sortCol === i) setDir(-dir);
    else { setSortCol(i); setDir(i <= 2 ? 1 : -1); }
  };
  return (
    <>
      <table>
        <thead>
          <tr>{COLS.map((c, i) => (
            <th key={c.label} style={{ width: c.w, ...(c.label === "Manager" ? { textAlign: "left" } : {}) }}
              className={`${c.hm ? "hm " : ""}${sortCol === i ? "sorted" : ""}`} onClick={() => clickCol(i)}>
              {c.noUpper ? <span style={{ textTransform: "none" }}>{c.label}</span> : c.label}
              {sortCol === i ? (dir < 0 ? " ▼" : " ▲") : ""}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <TeamRow key={r.rid} r={r} open={openRid === r.rid} ps={ps} wkIdx={wkIdx}
              teams={data.teams} players={players} bySum={data.summary}
              onToggle={() => setOpenRid(openRid === r.rid ? null : r.rid)}
              onOpenDetail={() => nav(`/teams/${seasonSeg(season)}/${r.rid}`)} />
          ))}
        </tbody>
      </table>
      <div style={{ color: "var(--dim)", fontSize: 12, marginTop: 8 }}>
        {isProj ? <>
          No scored weeks yet — <b style={{ color: "var(--txt)" }}>projected</b> standings
          over the real Sleeper schedule. WAR = optimal lineup summed from year-1
          composite projections; each game rebuilds both teams' optimal lineups
          <i> without that week's bye players</i>, and its win probability comes from the
          two lineups' WAR gap via the same Φ mapping the engine uses — the predicted
          record sums those probabilities. PPG derived from the same WAR. Injuries &amp;
          roster moves not modeled. Click a row for the lineup &amp; schedule · click a team name for
          the full roster.
        </> : <>
          WAA / WAR are summed from each week's actual starting lineup.
          Lineup WAA is measured against the league-wide <i>optimal</i> starter pool, so most teams land below zero — compare teams to each other, not to 0.
          Click a row for matchups &amp; roster highlights · click a team name for the full roster.
        </>}
      </div>
    </>
  );
}

function TeamRow(props: {
  r: Row; open: boolean; ps: number; wkIdx: WkIdx; teams: Team[]; players: PlayersMin;
  bySum: SeasonData["summary"]; onToggle: () => void; onOpenDetail: () => void;
}) {
  const { r, open, ps, wkIdx, teams, players, bySum, onToggle, onOpenDetail } = props;
  const panel = r.proj
    ? <ProjPanel r={r} players={players} teams={teams} />
    : <TeamPanel r={r} ps={ps} wkIdx={wkIdx} teams={teams} players={players} bySum={bySum} />;
  return (
    <>
      <tr onClick={onToggle}>
        <td style={{ color: "var(--dim)" }}>{r.seed}</td>
        <td><span className="tlink" onClick={e => { e.stopPropagation(); onOpenDetail(); }}>{r.team}</span></td>
        <td className="hm" style={{ textAlign: "left", color: "var(--dim)" }}>{r.manager}</td>
        <td>{r.rec}</td>
        <td className="hm">{r.med}</td>
        <td>{fmt(r.ppg, 1)}</td>
        <td>{r.proj ? "—" : fmt(r.sdv, 1)}</td>
        <td className={r.proj ? undefined : clsOf(r.waa)}>{r.proj ? "—" : fmt(r.waa, 3)}</td>
        <td className={clsOf(r.war)}>{fmt(r.war, 3)}</td>
      </tr>
      {open && <tr className="wkbox"><td colSpan={COLS.length}>{panel}</td></tr>}
    </>
  );
}

/** Preseason dropdown: projected optimal lineup + the real schedule with
 *  per-game win probabilities (this is exactly what the row's record sums). */
function ProjPanel({ r, players, teams }: { r: Row; players: PlayersMin; teams: Team[] }) {
  const tnames: Record<number, string> = {};
  teams.forEach(t => { tnames[t.roster_id] = t.team; });
  return (
    <>
      <div className="wkhead">
        <b>{r.team}</b> — {r.manager} · projected {r.rec} · {fmt(r.ppg, 1)} ppg
        {(() => {
          // WAR-weighted average starter age: the ages attached to the WAR you start
          const st = (r.lineup ?? []).filter(l => l.age != null);
          if (!st.length) return null;
          const wt = st.map(l => Math.max(0.1, l.war));
          const tot = wt.reduce((a, b) => a + b, 0);
          const age = st.reduce((a, l, i) => a + l.age! * wt[i], 0) / tot;
          return <> · <span title="WAR-weighted average age of the projected lineup">avg starter age {fmt(age, 1)}</span></>;
        })()}
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
              <thead><tr><th>Week</th><th style={{ textAlign: "left" }}>Opponent</th>
                <th style={{ textAlign: "left" }}>Byes</th>
                <th style={{ textAlign: "center" }} title="both sides' bye-adjusted lineups, PPG derived from WAR">Proj Score</th>
                <th>Win %</th></tr></thead>
              <tbody>
                {r.sched.map(g => {
                  const myD = g.war != null ? Math.max(0, r.war - g.war) : 0;
                  const weakened = myD > 0.005;
                  const oppName = tnames[g.opp] || `Roster ${g.opp}`;
                  const drops: [string, number][] = [];
                  if (weakened) drops.push([r.team.trim(), myD]);
                  if ((g.oppD ?? 0) > 0.005) drops.push([oppName.trim(), g.oppD!]);
                  // starters (full-strength lineup) sitting out this week
                  const out = (r.lineup ?? []).filter(l => l.bye === g.wk)
                    .map(l => pInfo(players, l.id)[0].split(" ").slice(-1)[0]);
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
                            {g.oppSubs && <>
                              <div style={{ color: "var(--txt)", margin: "4px 0 2px" }}>on bye</div>
                              {g.oppSubs.map((s, i) => (
                                <div key={i}>
                                  <span style={{ color: "var(--dim)" }}>{s.slot}: </span>
                                  {s.out ? pInfo(players, s.out)[0] : "—"}
                                  <span style={{ color: "var(--dim)" }}> → </span>
                                  <span style={{ color: "var(--txt)" }}>{s.in ? pInfo(players, s.in)[0] : "empty"}</span>
                                </div>
                              ))}
                            </>}
                          </>}>{oppName}</HoverTip>
                        ) : oppName}
                      </td>
                      <td style={{ textAlign: "left", color: "var(--dim)", fontSize: 11.5, maxWidth: 200 }}>
                        {g.subs ? (
                          <HoverTip align="left" block tip={
                            g.subs.map((s, i) => (
                              <div key={i}>
                                <span style={{ color: "var(--dim)" }}>{s.slot}: </span>
                                {s.out ? pInfo(players, s.out)[0] : "—"}
                                <span style={{ color: "var(--dim)" }}> → </span>
                                <span style={{ color: "var(--txt)" }}>{s.in ? pInfo(players, s.in)[0] : "empty"}</span>
                              </div>
                            ))}>
                            <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {out.length ? out.join(", ") : "—"}
                            </span>
                          </HoverTip>
                        ) : (out.length ? out.join(", ") : "—")}
                      </td>
                      <td style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", textAlign: "center" }}>
                        <HoverTip tip={
                          drops.length === 0 ? "no bye impact this week" : <>
                            bye impact:{drops.map(([nm, d], i) => (
                              <span key={nm}>{i > 0 && " ·"} {nm} <span className="num bad">−{fmt(d, 2)} WAR</span></span>
                            ))}
                          </>}>
                          {g.pts == null || g.oppPts == null ? <span style={{ color: "var(--dim)" }}>—</span> : <>
                            <span style={{ display: "inline-block", minWidth: "3.2em", textAlign: "right" }}>{fmt(g.pts, 1)}</span>
                            <span style={{ color: "var(--dim)" }}> – </span>
                            <span style={{ display: "inline-block", minWidth: "3.2em", textAlign: "left" }}>{fmt(g.oppPts, 1)}</span>
                          </>}
                        </HoverTip>
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

function TeamPanel({ r, ps, wkIdx, teams, players, bySum }: {
  r: Row; ps: number; wkIdx: WkIdx; teams: Team[]; players: PlayersMin; bySum: SeasonData["summary"];
}) {
  const tnames: Record<number, string> = {};
  teams.forEach(t => { tnames[t.roster_id] = t.team; });
  const t = teams.find(x => x.roster_id === r.rid)!;
  const sumById = new Map(bySum.map(s => [s[0], s]));
  const ranked = t.players.map(p => sumById.get(p)).filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b[6] - a[6]);
  const five = (a: typeof ranked) => a.map((s, i) => (
    <div key={i}><PlayerLink pid={s[0]} name={pInfo(players, s[0])[0]} /> <PosBadge pos={s[1]} /> <span className={clsOf(s[6])}>{fmt(s[6], 3)}</span></div>
  ));
  return (
    <>
      <div className="wkhead"><b>{r.team}</b> — {r.manager} · {r.rec} · {fmt(r.ppg, 1)} ppg · σ {fmt(r.sdv, 1)}</div>
      <div className="wkflex">
        <div>
          {r.ent.length ? (
            <div className="wkwrap">
              <table className="wktbl">
                <thead><tr><th>Week</th><th>Pts</th><th>Opponent</th><th>Opp Pts</th><th>Res</th><th>Lineup WAR</th></tr></thead>
                <tbody>
                  {r.ent.map(e => {
                    const [wk, pts, opp, opts, starters] = e;
                    let war = 0;
                    for (const p of starters) { const v = wkIdx[p]?.[wk]; if (v) war += v[1]; }
                    const res = opts == null ? "—" : pts > opts ? "W" : pts < opts ? "L" : "T";
                    return (
                      <tr key={wk}>
                        <td>W{wk}{wk >= ps && <> <span className="tag">P</span></>}</td>
                        <td><b>{fmt(pts, 1)}</b></td>
                        <td style={{ textAlign: "left" }}>{opp ? tnames[opp] || "?" : "—"}</td>
                        <td>{opts == null ? "—" : fmt(opts, 1)}</td>
                        <td className={res === "W" ? "num good" : res === "L" ? "num bad" : ""}>{res}</td>
                        <td>{wk < ps ? sgn(war) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : <div style={{ color: "var(--dim)" }}>no games yet</div>}
        </div>
        <div className="wkright" style={{ fontSize: 12.5, lineHeight: 1.9 }}>
          {ranked.length > 0 && (
            <>
              <b style={{ color: "var(--txt)" }}>Top 5 by WAR</b>
              {five(ranked.slice(0, 5))}
              <div style={{ marginTop: 8 }}><b style={{ color: "var(--txt)" }}>Bottom 5 by WAR</b></div>
              {five(ranked.slice(-5).reverse())}
            </>
          )}
        </div>
      </div>
    </>
  );
}

