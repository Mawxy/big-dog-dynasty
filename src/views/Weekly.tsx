import { Fragment, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLeaguePath } from "../lib/context";
import type { BracketFile, MatchEntry, Matchups, PlayersMin, SeasonData, WeekOdds, Weekly as WeeklyT } from "../lib/types";
import { jl } from "../lib/data";
import { fmt, sgn, clsOf } from "../lib/stats";
import { pInfo, POS_COLOR, weekIndex, seasonSeg } from "../lib/league";
import { useMobile } from "../lib/useWidth";
import PosBadge from "../components/PosBadge";
import TScroll from "../components/TScroll";
import { PlayerLink } from "../components/PlayerLink";
import PlayerPanel from "../components/PlayerPanel";
import MatchupDetail from "../components/MatchupDetail";
import PlayoffPanel from "../components/PlayoffPanel";
import SeasonPicker from "../components/SeasonPicker";

/** the week's entries, one per roster that has a row for it */
function weekEntries(mw: Matchups, wk: number): Record<string, MatchEntry> {
  const ent: Record<string, MatchEntry> = {};
  for (const [rid, list] of Object.entries(mw.teams)) {
    const e = list.find(x => x[0] === wk);
    if (e) ent[rid] = e;
  }
  return ent;
}

/**
 * The week's pairings: from played entries when they exist, otherwise from the
 * published schedule — Sleeper posts pairings well before kickoff, so a future
 * week still has a fixture list, just no scores.
 */
function weekPairs(ent: Record<string, MatchEntry>, mw: Matchups, wk: number):
  [number, number, number | null, number | null][] {
  const seen = new Set<number>();
  const pairs: [number, number, number | null, number | null][] = [];
  for (const [rid, e] of Object.entries(ent)) {
    const a = +rid, b = e[2];
    if (seen.has(a)) continue;
    seen.add(a); if (b) seen.add(b);
    pairs.push([a, e[1], b, e[3]]);
  }
  if (!pairs.length)
    for (const [x, y] of mw.schedule?.[String(wk)] ?? []) pairs.push([x, 0, y, null]);
  return pairs;
}

/** a side's best starter this week, by WAR — bench monsters won nobody anything */
function topStarterOf(ent: Record<string, MatchEntry>, weekly: WeeklyT, rid: number, wk: number) {
  const e = ent[String(rid)];
  if (!e) return null;
  let top: { pid: string; pts: number; war: number } | null = null;
  for (const p of e[4]) {
    const w = weekly[p]?.find(x => x[0] === wk);
    if (w && (!top || w[5] > top.war)) top = { pid: p, pts: w[1], war: w[5] };
  }
  return top;
}

/** the MATCHUP's top scorer by points, across both sides' starters — the
 *  stacked phone unit names one, where the desktop names one per side */
function topScorerOf(ent: Record<string, MatchEntry>, weekly: WeeklyT, rids: (number | null)[], wk: number) {
  let top: { pid: string; pts: number } | null = null;
  for (const rid of rids) {
    if (rid == null) continue;
    const e = ent[String(rid)];
    if (!e) continue;
    for (const p of e[4]) {
      const w = weekly[p]?.find(x => x[0] === wk);
      if (w && (!top || w[1] > top.pts)) top = { pid: p, pts: w[1] };
    }
  }
  return top;
}

/**
 * One week's matchups as a grid of head-to-head units. Winner takes the
 * accent rule, score and name; the spine holds `vs`; no margin figure — the
 * two scores state it.
 */
function MatchupGrid({ season, wk, mw, weekly, players, tnames, odds }: {
  season: string; wk: number; mw: Matchups; weekly: WeeklyT;
  players: PlayersMin; tnames: Record<number, string>; odds: WeekOdds | null;
}) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  // MOBILE.md M7 — at ≤640px the unit rotates: sides stack, the spine becomes
  // a horizontal divider carrying the margin, and one footer line names the
  // matchup's top scorer
  const mobile = useMobile();
  const ps = mw.playoff_start || 15;
  const wkIdx = useMemo(() => weekIndex(weekly), [weekly]);
  const ent = weekEntries(mw, wk);
  const pairs = weekPairs(ent, mw, wk);
  const lineupWar = (rid: number) => {
    const e = ent[String(rid)];
    if (!e) return 0;
    let w = 0;
    for (const p of e[4]) { const v = wkIdx[p]?.[wk]; if (v) w += v[1]; }
    return w;
  };
  if (!pairs.length) return <div className="empty">No matchups for this week.</div>;
  return (
    <div className="h2h-grid">
      {pairs.map(([a, ap, b, bp]) => {
        const scored = bp != null;
        const aw = scored && ap > bp!, bw = scored && bp! > ap;
        if (mobile) {
          const go = () => nav(lp(`/weekly/${seasonSeg(season)}/${wk}/${a}`));
          const row = (rid: number | null, pts: number | null, win: boolean, lose: boolean) => {
            if (rid == null) return (
              <div className="h2h-row">
                <span className="wl" />
                <span className="nm" style={{ color: "var(--dim)" }}>Bye</span>
                <span className="pts" style={{ color: "var(--dim3)" }}>—</span>
              </div>
            );
            const od = odds?.weeks?.[String(wk)]?.[String(rid)];
            const lw = scored && wk < ps ? lineupWar(rid) : null;
            return (
              <div className={`h2h-row${win ? " win" : ""}`}>
                <span className="wl">{scored ? (win ? "W" : lose ? "L" : "T") : ""}</span>
                <span className="nm">{tnames[rid] || `Roster ${rid}`}</span>
                <span className="pts" style={!scored && od ? { color: "var(--dim)" } : undefined}>
                  {scored ? fmt(pts ?? 0, 1) : od ? fmt(od.mu, 1) : !pts ? "—" : fmt(pts, 1)}
                </span>
                {/* the same second figure position on both sides: lineup WAR
                    once played, the pregame line before */}
                {lw != null
                  ? <span className={`sub2 ${clsOf(lw)}`}>{sgn(lw, 2)}</span>
                  : od?.wp != null
                    ? <span className="sub2">{fmt(od.wp * 100, 0)}%</span>
                    : <span className="sub2" />}
              </div>
            );
          };
          const top = scored ? topScorerOf(ent, weekly, [a, b], wk) : null;
          return (
            <div key={a} className="h2h m click" tabIndex={0} role="button"
              onClick={go}
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
              }}>
              {row(a, ap, aw, bw)}
              <div className="h2h-div">
                <span className="ln" />
                <span>vs</span>
                <span className="ln" />
                {/* the margin is a deliberate, documented exception to the
                    desktop's no-margin rule: stacked, the two scores sit ~60px
                    apart and the side-by-side subtraction is no longer free */}
                {scored && b != null && <span className="by">by {fmt(Math.abs(ap - (bp ?? 0)), 1)}</span>}
              </div>
              {row(b, bp, bw, aw)}
              {top && (
                <div className="h2h-top">
                  <span className="k">Top scorer</span>
                  <span className="tnm">{pInfo(players, top.pid)[0]}</span>
                  <span className="tpts">· {fmt(top.pts, 1)} pts</span>
                </div>
              )}
            </div>
          );
        }
        const sideOf = (rid: number | null, pts: number | null, win: boolean, lose: boolean) => {
          if (rid == null) return (
            <div className="h2h-side">
              <div className="nm">Bye</div>
              <div className="score" style={{ color: "var(--dim3)" }}>—</div>
              <div className="res">{" "}</div>
            </div>
          );
          const top = topStarterOf(ent, weekly, rid, wk);
          const od = odds?.weeks?.[String(wk)]?.[String(rid)];
          const pct = od?.wp != null ? `${fmt(od.wp * 100, 0)}%` : null;
          return (
            <div className={`h2h-side${win ? " win" : ""}`}>
              <div className="nm">{tnames[rid] || `Roster ${rid}`}</div>
              {/* an unplayed week shows its PROJECTED total in the score slot;
                  a played one shows what was actually scored */}
              <div className="score" style={!scored && od ? { color: "var(--dim)" } : undefined}>
                {scored ? fmt(pts ?? 0, 1)
                  : od ? fmt(od.mu, 1)
                    : !pts ? "—" : fmt(pts, 1)}
              </div>
              <div className="res">
                {!scored ? (od ? "projected" : "upcoming")
                  : win ? "won" : lose ? "lost" : "tied"}
                {/* the pregame line — built from weeks before this one, so on a
                    played week it says what the matchup looked like at kickoff */}
                {pct && <> · <span style={{ color: (od?.wp ?? 0) >= 0.5 ? "var(--txt2)" : "var(--dim)" }}>
                  {scored ? "was " : ""}{pct}
                </span></>}
                {scored && wk < ps ? <> · lineup WAR {sgn(lineupWar(rid), 2)}</> : null}
              </div>
              {top && (
                <div className="star">
                  <PosBadge pos={pInfo(players, top.pid)[1]} />
                  <span className="snm">{pInfo(players, top.pid)[0]}</span>
                  <span className="spts">{fmt(top.pts, 1)}</span>
                </div>
              )}
            </div>
          );
        };
        return (
          <div key={a} className="h2h click"
            onClick={() => nav(lp(`/weekly/${seasonSeg(season)}/${wk}/${a}`))}>
            {sideOf(a, ap, aw, bw)}
            <div className="h2h-spine">vs</div>
            {sideOf(b, bp, bw, aw)}
          </div>
        );
      })}
    </div>
  );
}

interface Props {
  data: SeasonData; season: string; players: PlayersMin;
  week: number | null;
  /** one side's roster_id — renders that single matchup instead of the week */
  matchupRid: number | null;
  /** the bracket scope: the season's last chip, after the weeks */
  playoffs?: boolean;
}

/**
 * Season (1F): ONE week at a time — the chip row is the navigation, so there
 * is no separate all-weeks index. Landing without a week in the URL shows the
 * newest played week (or the first scheduled one, preseason). The last chip is
 * the postseason bracket: the playoffs are where a season ends, so they belong
 * on the season's own axis rather than in a tab of their own.
 */
export default function Weekly({ data, season, players, week, matchupRid, playoffs }: Props) {
  const [weekly, setWeekly] = useState<WeeklyT | null>(null);
  const [mw, setMw] = useState<Matchups | null>(null);
  const [bracket, setBracket] = useState<BracketFile | null>(null);
  /** the pregame line per matchup — absent for data built before week_odds.py */
  const [odds, setOdds] = useState<WeekOdds | null>(null);
  /** the bracket fetch has settled, either way — so the playoffs scope can
   *  tell "still loading" from "this season has no bracket" */
  const [brDone, setBrDone] = useState(false);
  const [err, setErr] = useState(false);
  const [reload, setReload] = useState(0);
  const nav = useNavigate();
  const lp = useLeaguePath();

  useEffect(() => {
    if (season === "ALL") return;
    let live = true;
    setErr(false);
    setBracket(null);
    setBrDone(false);
    jl<BracketFile>(`${season}/bracket.json`)
      .then(b => { if (live) setBracket(b); })
      .catch(() => { /* no bracket yet — the chip just doesn't appear */ })
      .finally(() => { if (live) setBrDone(true); });
    setOdds(null);
    jl<WeekOdds>(`${season}/odds.json`)
      .then(o => { if (live) setOdds(o); })
      .catch(() => { /* no odds file — the lines just don't render */ });
    Promise.all([
      jl<WeeklyT>(`${season}/weekly.json`),
      jl<Matchups>(`${season}/matchups.json`).catch(() => ({ playoff_start: 15, teams: {} } as Matchups)),
    ]).then(([w, m]) => { if (live) { setWeekly(w); setMw(m); } })
      .catch(() => { if (live) setErr(true); });
    return () => { live = false; };
  }, [season, reload]);

  // The season picker lives in this view's header, so an early return that
  // skips the header strands the reader on a season with nothing to show — no
  // control left to pick a different year. Every empty state renders the header.
  const shell = (msg: React.ReactNode) => (
    <>
      <div className="screen-head">
        <span className="screen-title">Season</span>
        <SeasonPicker allTime={false} />
      </div>
      <div className="empty">{msg}</div>
    </>
  );
  if (season === "ALL") return shell("Season is a per-year view — pick a year.");
  if (err) return shell(<>Couldn't load weekly data.{" "}
    <button className="retry" onClick={() => setReload(n => n + 1)}>Retry</button></>);
  if (!weekly || !mw) return shell("Loading weekly data…");

  // The chip row is the REGULAR season. Sleeper publishes a full 18-week
  // schedule for an upcoming year, so an unplayed season would otherwise show
  // W15-W18 chips for weeks that are the postseason — which the Playoffs chip
  // owns. (Home.tsx already drops them the same way when projecting records.)
  const ps = mw.playoff_start || 15;
  const played = new Set(Object.values(weekly).flatMap(rows => rows.map(r => r[0])));
  const allWeeks = [...new Set([
    ...played,
    ...Object.keys(mw.schedule ?? {}).map(Number),
  ])].filter(w => w < ps).sort((x, y) => x - y);
  if (!allWeeks.length) return shell("Nothing scheduled or played yet for this season.");

  if (week !== null && matchupRid !== null)
    return <MatchupDetail season={season} wk={week} rid={matchupRid} data={data}
      weekly={weekly} mw={mw} players={players}
      back={() => nav(lp(`/weekly/${seasonSeg(season)}/${week}`))} />;

  if (playoffs)
    return <BracketScope season={season} bracket={bracket} loaded={brDone}
      allWeeks={allWeeks} />;

  // no week in the URL -> the newest played week; preseason -> the first fixture
  const want = week ?? (played.size ? Math.max(...played) : allWeeks[0]);
  // A week carried over from another season's chip row may not exist here —
  // seasons differ in length. Land on the nearest week that does rather than
  // on an empty page the reader has to navigate out of.
  const wk = allWeeks.includes(want) ? want
    : allWeeks.reduce((a, b) =>
      Math.abs(b - want) < Math.abs(a - want) ? b : a, allWeeks[0]);
  return <WeekDetail wk={wk} season={season} data={data} weekly={weekly} mw={mw}
    players={players} allWeeks={allWeeks} hasBracket={!!bracket} odds={odds} />;
}

/** the chip row: every week, then the bracket — the season's whole axis */
function WeekChips({ season, allWeeks, on, hasBracket }: {
  season: string; allWeeks: number[]; on: number | "playoffs"; hasBracket: boolean;
}) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  return (
    <div className="screen-head" style={{ paddingTop: 10 }}>
      {allWeeks.map(w => (
        <button key={w} className={`chip ${w === on ? "on" : ""}`}
          onClick={() => nav(lp(`/weekly/${seasonSeg(season)}/${w}`))}>W{w}</button>
      ))}
      {hasBracket && (
        <button className={`chip ${on === "playoffs" ? "on" : ""}`}
          onClick={() => nav(lp(`/weekly/${seasonSeg(season)}/playoffs`))}>Playoffs</button>
      )}
    </div>
  );
}

/** the season's last scope: its bracket, with the year's own page a click away */
function BracketScope({ season, bracket, allWeeks, loaded }: {
  season: string; bracket: BracketFile | null; allWeeks: number[]; loaded: boolean;
}) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const champ = bracket?.winners.find(g => g.p === 1);
  const champName = champ?.w != null ? bracket?.names[String(champ.w)] : null;
  return (
    <>
      {/* One identity line, like every other screen: the title says WHAT you
          are looking at and the season chip beside it says which year. This
          used to be "Season" at 20px with a second 34px "Playoffs" block under
          it — the only screen on the site with two titles. */}
      <div className="screen-head">
        <span className="screen-title">Playoffs</span>
        <SeasonPicker allTime={false} />
        {champName && (
          <span className="screen-note">
            champion <b style={{ color: "var(--acc)" }}>{champName}</b>
          </span>
        )}
      </div>
      {/* always show the chip here: it is the scope being viewed, and hiding
          it mid-refetch would make the active chip blink out on a season
          switch (and strand a season that genuinely has no bracket) */}
      <WeekChips season={season} allWeeks={allWeeks} on="playoffs" hasBracket />
      {bracket ? <PlayoffPanel season={season} bracket={bracket} />
        : !loaded ? <div className="empty">Loading the bracket…</div>
          : <div className="empty">
            No bracket for {season} — pick a week above, or another season.
          </div>}
    </>
  );
}

/** The week page: header + chip row, the head-to-head grid, top performers. */
function WeekDetail({ wk, season, data, weekly, mw, players, allWeeks, hasBracket, odds }: {
  wk: number; season: string; data: SeasonData; weekly: WeeklyT; mw: Matchups;
  players: PlayersMin; allWeeks: number[]; hasBracket: boolean; odds: WeekOdds | null;
}) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [openPid, setOpenPid] = useState<string | null>(null);
  const ps = mw.playoff_start || 15;
  const tnames: Record<number, string> = {};
  data.teams.forEach(t => { tnames[t.roster_id] = t.team; });
  const ent = weekEntries(mw, wk);
  const pairs = weekPairs(ent, mw, wk);

  /** pid -> the team that actually started him this week */
  const startedBy: Record<string, string> = {};
  for (const [rid, e] of Object.entries(ent))
    for (const p of e[4]) startedBy[p] = tnames[+rid] ?? `Roster ${rid}`;

  const performers = Object.entries(weekly).flatMap(([pid, rows]) => {
    const w = rows.find(x => x[0] === wk);
    return w ? [{ pid, pts: w[1], paa: w[2], par: w[3], war: w[5], pos: pInfo(players, pid)[1] }] : [];
  }).sort((a, b) => b.war - a.war).slice(0, 50);
  const warMax = Math.max(0.001, ...performers.map(p => p.war));

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">Week {wk}{wk >= ps ? " · playoffs" : ""}</span>
        <SeasonPicker allTime={false} />
        <span className="screen-note">
          <b>{pairs.length}</b> matchups · click one for both lineups
        </span>
      </div>
      {/* a playoff week is reached from a bracket link, not from the row —
          light the Playoffs chip so something in the row is still active */}
      <WeekChips season={season} allWeeks={allWeeks} hasBracket={hasBracket}
        on={wk >= ps ? "playoffs" : wk} />

      <MatchupGrid season={season} wk={wk} mw={mw} weekly={weekly}
        players={players} tnames={tnames} odds={odds} />

      {performers.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="band">
            <span className="band-label">Top performers</span>
            <span className="band-note">Started for resolves from the week's actual lineups · WAR vs the best player left out of the startable pool</span>
          </div>
          <TScroll>
          <table style={{ tableLayout: "fixed" }}>
            <thead>
              <tr className="grp">
                <th colSpan={4}></th>
                <th className="edge" colSpan={3}>Production</th>
                <th className="edge value" colSpan={1}>Wins added</th>
              </tr>
              <tr>
                <th className="c" style={{ width: "6%" }}>Rk</th>
                <th className="t" style={{ width: "24%" }}>Player</th>
                <th className="c" style={{ width: "7%" }}>Pos</th>
                <th className="t hm" style={{ width: "17%" }}>Started for</th>
                <th className="n edge" style={{ width: "9%" }}>Points</th>
                <th className="n hm" style={{ width: "9%" }}>Vs avg</th>
                <th className="n hm" style={{ width: "9%" }}>Vs repl</th>
                <th className="n key edge" style={{ width: "19%" }}>WAR</th>
              </tr>
            </thead>
            <tbody>
              {performers.map((e, i) => (
                <Fragment key={e.pid}>
                  <tr className={`click ${openPid === e.pid ? "open" : i % 2 ? "zebra" : ""}`}
                    onClick={() => setOpenPid(openPid === e.pid ? null : e.pid)}>
                    <td className="spine-cell">
                      <span className="spine" style={{ background: POS_COLOR[e.pos] || "var(--rule)" }} />
                      <span className="rank">{i + 1}</span>
                    </td>
                    <td className="t name"><PlayerLink pid={e.pid} name={pInfo(players, e.pid)[0]} /></td>
                    <td className="c"><PosBadge pos={e.pos} /></td>
                    <td className="t sub hm">{startedBy[e.pid]
                      ?? <span style={{ color: "var(--dim3)" }}>not started</span>}</td>
                    <td className="n fig strong edge">{fmt(e.pts, 1)}</td>
                    <td className={`n hm ${clsOf(e.paa)}`}>{sgn(e.paa, 1)}</td>
                    <td className={`n hm ${clsOf(e.par)}`}>{sgn(e.par, 1)}</td>
                    <td className="n last edge">
                      <div className="meter-row">
                        <div className="meter"><i style={{ width: `${Math.round(Math.max(0, e.war) / warMax * 100)}%` }} /></div>
                        <span className="fig">{fmt(e.war, 3)}</span>
                      </div>
                    </td>
                  </tr>
                  {openPid === e.pid && (
                    <tr className="drawer-row">
                      <td colSpan={8}>
                        <PlayerPanel pid={e.pid} season={season} teams={data.teams} players={players} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          </TScroll>
        </div>
      )}

      <div className="footnote">
        A fixed margin is worth more wins in a low-scoring week — each week's conversion uses that week's
        own <span className="sigma">σ</span> of the twelve team scores
      </div>
    </>
  );
}
