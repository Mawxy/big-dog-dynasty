import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Matchups, MatchEntry, PlayersMin, ProjectionsFile, SeasonData, Team, Weekly } from "../lib/types";
import { j } from "../lib/data";
import { fmt, sgn, clsOf, sd, mean, normCdf, normInv } from "../lib/stats";
import { pInfo, weekIndex, seasonSeg, optimalLineup } from "../lib/league";
import PosBadge from "../components/PosBadge";
import { PlayerLink } from "../components/PlayerLink";
import FranchisePage from "../components/FranchisePage";

type WkIdx = Record<string, Record<number, [number, number]>>;
const REG_WEEKS = 14;   // regular season length; composite rates are per-13 (bye)
interface LineupEntry { id: string; pos: string; war: number; slot: string; ppg: number | null; bye: number | null }
interface Row {
  rid: number; seed: number; team: string; manager: string; wins: number; fpts: number;
  rec: string; med: string; medw: number; ppg: number; sdv: number; waa: number; war: number;
  ent: MatchEntry[];
  /** preseason: row built from projections — record is predicted, σ/WAA/vs-Median dash */
  proj?: boolean; lineup?: LineupEntry[];
  /** preseason: avg opponent lineup WAR + per-week schedule with win prob,
   *  that week's bye-adjusted lineup WAR, and the opponent's bye WAR cost */
  sos?: number | null;
  sched?: { wk: number; opp: number; p: number; war?: number; oppD?: number;
    pts?: number; oppPts?: number }[];
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

  useEffect(() => {
    if (season === "ALL") return;
    let live = true;
    Promise.all([
      j<Weekly>(`data/${season}/weekly.json`),
      j<Matchups>(`data/${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } });
    return () => { live = false; };
  }, [season]);

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
          .map(p => ({ id: p.pid, pos: p.pos, war: p.composite[0] ?? 0, bye: p.bye ?? null, ppg: p.ppg ?? 0 }));
        const { slots } = optimalLineup(pool);
        const lineup: LineupEntry[] = slots.filter(s => s.player).map(s => ({
          ...s.player!, slot: s.slot === "SUPER_FLEX" ? "SF" : s.slot,
          ppg: byPid.get(s.player!.id)?.ppg ?? null,
        }));
        const war = lineup.reduce((a, l) => a + l.war, 0);
        const ppg = lineup.reduce((a, l) => a + (l.ppg ?? 0), 0);
        return { t, pool, war, ppg, lineup };
      });
      const meanWar = mean(built.map(b => b.war));
      const warOf = new Map(built.map(b => [b.t.roster_id, b.war]));
      const poolOf = new Map(built.map(b => [b.t.roster_id, b.pool]));
      // bye-aware weekly lineup: rebuild the optimal lineup without that
      // week's bye players, so a stacked bye week costs real win probability
      const wkCache = new Map<string, { war: number; ppg: number }>();
      const lineupAt = (rid: number, wk: number) => {
        const key = `${rid}:${wk}`;
        let v = wkCache.get(key);
        if (v == null) {
          const { slots } = optimalLineup((poolOf.get(rid) ?? []).filter(p => p.bye !== wk));
          v = {
            war: slots.reduce((a, s) => a + (s.player?.war ?? 0), 0),
            ppg: slots.reduce((a, s) => a + (s.player?.ppg ?? 0), 0),
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
      const rs: Row[] = built.map(({ t, war, ppg, lineup }) => {
        const gs = (games[t.roster_id] ?? []).sort((a, b) => a.wk - b.wk);
        let wins: number, sos: number | null = null;
        let sched: Row["sched"];
        if (gs.length) {
          sched = gs.map(g => ({
            ...g,
            p: normCdf(zAt(t.roster_id, g.wk) - zAt(g.opp, g.wk)),
            war: warAt(t.roster_id, g.wk),
            oppD: Math.max(0, (warOf.get(g.opp) ?? 0) - warAt(g.opp, g.wk)),
            pts: lineupAt(t.roster_id, g.wk).ppg,
            oppPts: lineupAt(g.opp, g.wk).ppg,
          }));
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
          proj: true, lineup, sos, sched,
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
  if (!mw || !weekly) return <div className="empty">Loading…</div>;
  if (detailRid !== null)
    return <FranchisePage rid={detailRid} players={players} tab={tab}
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
        {r.sos != null && <> · avg opponent lineup WAR {sgn(r.sos, 2)}</>}
      </div>
      <div className="wkflex">
        <div className="wkwrap">
          <table className="wktbl">
            <thead><tr><th>Slot</th><th style={{ textAlign: "left" }}>Player</th><th>Pos</th><th>Bye</th><th>PPG</th><th>Proj WAR</th></tr></thead>
            <tbody>
              {(r.lineup ?? []).map((l, i) => (
                <tr key={i}>
                  <td style={{ color: "var(--dim)" }}>{l.slot}</td>
                  <td style={{ textAlign: "left" }}><PlayerLink pid={l.id} name={pInfo(players, l.id)[0]} /></td>
                  <td><PosBadge pos={l.pos} /></td>
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
                <th title="this week's optimal lineup WAR, byes removed">Lineup</th>
                <th title="both sides' bye-adjusted lineups, PPG derived from WAR">Proj Score</th>
                <th>Win %</th></tr></thead>
              <tbody>
                {r.sched.map(g => {
                  const weakened = g.war != null && g.war < r.war - 0.005;
                  // starters (full-strength lineup) sitting out this week
                  const out = (r.lineup ?? []).filter(l => l.bye === g.wk)
                    .map(l => pInfo(players, l.id)[0].split(" ").slice(-1)[0]);
                  const oppWeak = (g.oppD ?? 0) > 0.005;
                  return (
                    <tr key={g.wk}>
                      <td>W{g.wk}</td>
                      <td style={{ textAlign: "left" }}>
                        {tnames[g.opp] || `Roster ${g.opp}`}
                        {oppWeak && <span className="num good" style={{ fontSize: 11 }}
                          title={`opponent's byes cost them ${fmt(g.oppD!, 2)} lineup WAR this week`}>
                          {" "}▼{fmt(g.oppD!, 1)}</span>}
                      </td>
                      <td style={{ textAlign: "left", color: "var(--dim)", fontSize: 11.5, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        title={out.length ? (r.lineup ?? []).filter(l => l.bye === g.wk).map(l => pInfo(players, l.id)[0]).join(", ") : undefined}>
                        {out.length ? out.join(", ") : "—"}
                      </td>
                      <td className={weakened ? "num bad" : undefined}
                        style={weakened ? undefined : { color: "var(--dim)" }}
                        title={weakened ? `byes cost ${fmt(r.war - (g.war ?? 0), 2)} WAR this week` : undefined}>
                        {g.war == null ? "—" : sgn(g.war, 2)}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {g.pts == null || g.oppPts == null ? <span style={{ color: "var(--dim)" }}>—</span> : <>
                          {fmt(g.pts, 1)}<span style={{ color: "var(--dim)" }}> – </span>{fmt(g.oppPts, 1)}
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

