import { useDeferredValue, useMemo, useState } from "react";
import type { Franchises, Matchups, Team, WeekOdds } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useLeagueCaps } from "../../lib/caps";
import { rosterSeasonOf } from "../../lib/league";
import {
  buildState, fillBy, PLAYOFF_TEAMS, simulate, SIMS, type MachineGame, type Picks,
} from "../../lib/playoffMachine";
import { Band, DataError, IdCell, NUL, Spine, TapRow, useBetaPath } from "../ui";
import "./playoffs.css";

/**
 * PLAYOFF MACHINE (Max, 2026-10-07).
 *
 * Every remaining regular-season game, each one lockable, over the season
 * simulation the playoff race already runs (lib/playoffMachine). Lock a
 * winner and the table above re-runs: playoff and bye odds, and the projected
 * seeding, beside what the model says with nothing locked.
 *
 * Three fills set every game at once by one rule, and any game can be
 * overridden after:
 *
 *   Projection  the side the pregame line favors (odds.json, the projected
 *               lineups — what the playoff race prices)
 *   PPG         the higher points per game this season
 *   WAR         the higher starters' WAR this season (franchises.json)
 *
 * Nothing is saved. The picks live in this screen and reset when it is left,
 * which is the honest scope for a what-if.
 */

type Fill = "proj" | "ppg" | "war";
const FILLS: { k: Fill; label: string; note: string }[] = [
  { k: "proj", label: "Projection", note: "the side the pregame line favors" },
  { k: "ppg", label: "PPG", note: "the higher points per game this season" },
  { k: "war", label: "WAR", note: "the higher starters' WAR this season" },
];

const pct = (v: number) =>
  v >= 0.995 && v < 1 ? ">99%" : v > 0 && v < 0.005 ? "<1%" : `${Math.round(v * 100)}%`;

/** a signed change in percentage points, rounded the way the two figures are */
function Delta({ now, was }: { now: number; was: number }) {
  const d = Math.round(now * 100) - Math.round(was * 100);
  if (d === 0) return <span className="pm-d">—</span>;
  return <span className={`pm-d ${d > 0 ? "up" : "dn"}`}>{d > 0 ? `+${d}` : `−${-d}`}</span>;
}

export default function PlayoffMachine() {
  const { league } = useLeague();
  const caps = useLeagueCaps();
  const betaPath = useBetaPath();
  const season = rosterSeasonOf(league);
  const mwQ = useJson<Matchups>(`${season}/matchups.json`);
  const oddsQ = useJson<WeekOdds>(caps.odds ? `${season}/odds.json` : null);
  const teams = useJson<Team[]>(`${season}/teams.json`).data;
  const fr = useJson<Franchises>("franchises.json").data;

  const st = useMemo(() => (mwQ.data && oddsQ.data ? buildState(mwQ.data, oddsQ.data) : null),
    [mwQ.data, oddsQ.data]);
  const [picks, setPicks] = useState<Picks>({});
  const [fill, setFill] = useState<Fill | null>(null);
  // the table re-runs off a deferred copy, so a tap paints the pick at once
  // and the ~10,000-season run lands a beat later instead of blocking it
  const dPicks = useDeferredValue(picks);
  const base = useMemo(() => (st ? simulate(st, {}) : null), [st]);
  const res = useMemo(() => (st ? (Object.keys(dPicks).length ? simulate(st, dPicks) : base) : null),
    [st, dPicks, base]);
  const stale = dPicks !== picks;

  const name = (rid: number) => teams?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;
  const mgr = (rid: number) => teams?.find(t => t.roster_id === rid)?.manager;
  const rec = (rid: number) => {
    if (!st) return "";
    const t = st.ties[rid];
    return `${st.wins[rid]}-${st.losses[rid]}${t ? `-${t}` : ""}`;
  };

  const ppg = useMemo(() => {
    const m: Record<number, number> = {};
    for (const t of teams ?? []) {
      const g = t.wins + t.losses + t.ties;
      m[t.roster_id] = g ? t.fpts / g : 0;
    }
    return m;
  }, [teams]);
  const war = useMemo(() => {
    const m: Record<number, number> = {};
    for (const f of Object.values(fr ?? {}))
      for (const s of f.seasons) if (s.season === season && s.rid != null) m[s.rid] = s.war;
    return m;
  }, [fr, season]);

  const applyFill = (k: Fill) => {
    if (!st) return;
    const score = (rid: number, g: MachineGame) =>
      k === "proj" ? (rid === g.a ? g.ma : g.mb) : k === "ppg" ? ppg[rid] ?? 0 : war[rid] ?? 0;
    setPicks(fillBy(st, score));
    setFill(k);
  };
  const toggle = (g: MachineGame, rid: number) => {
    setFill(null);
    setPicks(p => {
      const n = { ...p };
      if (n[g.id] === rid) delete n[g.id]; else n[g.id] = rid;
      return n;
    });
  };
  const clearWeek = (wk: number) => {
    setFill(null);
    setPicks(p => Object.fromEntries(Object.entries(p).filter(([id]) => !id.startsWith(`${wk}:`))));
  };

  if (!caps.odds) return (
    <>
      <div className="v3-head"><h1>Playoff machine</h1></div>
      <div className="empty">Not published for this league.</div>
    </>
  );
  if (mwQ.error || oddsQ.error) return (
    <>
      <div className="v3-head"><h1>Playoff machine</h1></div>
      <DataError what="The schedule didn't load" />
    </>
  );

  const nPicked = Object.keys(picks).length;
  const rows = res && st
    ? st.rids.slice().sort((x, y) => res[x].seed - res[y].seed || res[y].playoff - res[x].playoff)
    : null;

  return (
    <>
      <div className="v3-head">
        <h1>Playoff machine</h1>
        {st && <span className="sub">
          {st.weeks.length ? `Weeks ${st.weeks[0]}–${st.weeks[st.weeks.length - 1]} · ` : ""}
          {SIMS.toLocaleString()} seasons per run</span>}
      </div>

      {/* ---- the fills -------------------------------------------------- */}
      <div className="v3-filters pm-fills" role="group" aria-label="Fill every game">
        <span className="pm-k">Fill winners</span>
        {FILLS.map(f => (
          <button key={f.k} type="button" className={`chip${fill === f.k ? " on" : ""}`}
            aria-pressed={fill === f.k} title={f.note} onClick={() => applyFill(f.k)}>
            {f.label}
          </button>
        ))}
        <button type="button" className="chip" disabled={!nPicked}
          onClick={() => { setPicks({}); setFill(null); }}>Clear</button>
      </div>

      {/* ---- the table -------------------------------------------------- */}
      <Band label={`Projected seeding · ${season}`}
        note={st ? `${nPicked} of ${st.games.length} games locked · wins, then points · top ${PLAYOFF_TEAMS} make it` : undefined} />
      {!rows || !base || !res ? <div className="empty">{mwQ.loading || oddsQ.loading ? "Loading…" : "No games left to play."}</div> : (
        <table className={`v3tbl pm-tbl${stale ? " pm-stale" : ""}`}>
          <thead>
            <tr>
              <th className="c sp">Seed</th>
              <th className="t">Franchise</th>
              <th className="n" style={{ width: "17%" }}>Wins</th>
              <th className="n" style={{ width: "20%" }}>Playoff</th>
              <th className="n" style={{ width: "17%" }}>Bye</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((rid, i) => {
              const r = res[rid], b = base[rid];
              return (
                <TapRow key={rid} to={betaPath(`/team/${rid}`)}
                  className={`${i % 2 ? "zebra" : ""}${i === PLAYOFF_TEAMS - 1 ? " pm-cut" : ""}`}>
                  <Spine rank={i + 1} top={i === 0} />
                  <IdCell name={name(rid)} sub={`${rec(rid)}${mgr(rid) ? ` · ${mgr(rid)}` : ""}`} to={betaPath(`/team/${rid}`)} />
                  <td className="n"><span className="f">{r.wins.toFixed(1)}</span></td>
                  <td className="n">
                    <span className="f">{pct(r.playoff)}</span>
                    <div className="idc-s r">{nPicked ? <Delta now={r.playoff} was={b.playoff} /> : NUL}</div>
                  </td>
                  <td className="n">
                    <span className="f">{pct(r.bye)}</span>
                    <div className="idc-s r">{nPicked ? <Delta now={r.bye} was={b.bye} /> : NUL}</div>
                  </td>
                </TapRow>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="tnote screen pm-note">
        Seed is the order of average finish. Wins are the average final total. The line under each
        figure is the change from the model with nothing locked. A locked game still draws its
        scores, so points for, the tiebreak, moves the way it would.
      </div>

      {/* ---- the games --------------------------------------------------- */}
      {st?.weeks.map(wk => {
        const games = st.games.filter(g => g.wk === wk);
        const locked = games.filter(g => picks[g.id] != null).length;
        return (
          <section key={wk}>
            <Band label={`Week ${wk}`}
              note={locked ? `${locked} of ${games.length} locked` : "Tap a team to lock the win"}
              right={locked ? <button type="button" className="pm-clr" onClick={() => clearWeek(wk)}>Clear week</button> : undefined} />
            <div className="pm-games">
              {games.map(g => {
                const w = picks[g.id];
                const side = (rid: number, wp: number, right: boolean) => (
                  <button type="button"
                    className={`pm-side${right ? " r" : ""}${w === rid ? " won" : w != null ? " lost" : ""}`}
                    aria-pressed={w === rid} onClick={() => toggle(g, rid)}>
                    <span className="nm">{name(rid)}</span>
                    <span className="wp">{w === rid ? "Win" : w != null ? "Loss" : pct(wp)}</span>
                  </button>
                );
                return (
                  <div className="pm-game" key={g.id}>
                    {side(g.a, g.wpA, false)}
                    <span className="pm-vs">vs</span>
                    {side(g.b, 1 - g.wpA, true)}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </>
  );
}
