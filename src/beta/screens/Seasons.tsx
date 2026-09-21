import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { BracketFile, Franchises, Matchups, Team, WeekOdds, Weekly } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { fmt } from "../../lib/stats";
import { POS_CHIPS, POS_COLOR, latestSeasonOf, lineupOf, pInfo, rosterSeasonOf } from "../../lib/league";
import PlayoffBracket from "../../components/PlayoffBracket";
import { RouteLink } from "../../components/RouteLink";
import { Band, DataError, IdCell, NUL, sgnWar, Spine, Strip, TapRow, useBetaPath } from "../ui";
import ScopeControl, { type ScopeSeason, type ScopeSel } from "../Scope";
import { PosLeaders, SlotDrawer, useFranchiseIndex, type SlotEntry } from "./League";
import { playedPlayoffWeeks, playedWeeks, weekFigures, weekGames, weekRows, type WeekGame, type WeekRow } from "../week";
import "./league.css";
import "./seasons.css";

/**
 * SEASONS — the week floor (Max, 2026-09-15).
 *
 * League · Current answers "what is happening this week"; League · History
 * answers "how did SEASON end". Neither answers "what happened in week 6 of
 * 2024", and that is this screen's whole job: any week of any season, its
 * games, its figures, its best starts — and, one tap down, a matchup slot by
 * slot with both benches.
 *
 * Nothing here is computed twice. The game cards, the median, the four-figure
 * strip and the position blocks are League's own modules (beta/week.ts and
 * the exports from League.tsx) pointed at a week the reader chose rather than
 * at the week in progress. One computation, one rendering: the figures the
 * League tab shows for last week are the ones a reader finds here.
 *
 * URL: /seasons/<season>/<week>[/<roster>], the addresses League already
 * links to. The season is a path segment, not the `?scope=` query the other
 * screens use, because every card on League deep-links a week by path; the
 * scope control reads the path and writes it.
 */

const POSITIONS = POS_CHIPS.filter(p => p !== "ALL");

/** a player's points in a week, or null when the season files carry none:
 *  weekly.json scores every rostered player through the regular season;
 *  playoff weeks are scored only for winners-bracket starters, in
 *  bracket.json's `stars`. Null is "not recorded", never 0.0. */
type PtsOf = (pid: string, wk: number) => number | null;
const ptsSource = (weekly: Weekly | null | undefined, bracket: BracketFile | null | undefined): PtsOf =>
  (pid, wk) => weekly?.[pid]?.find(x => x[0] === wk)?.[1] ?? bracket?.stars?.[pid]?.wk?.[String(wk)] ?? null;
const DASH = <span className="lgx-nul">—</span>;
/** rows the top-performers table shows folded, and unfolded */
const PERF_FOLDED = 12;
const PERF_ALL = 50;

export default function Seasons() {
  const { meta, league } = useLeague();
  const nav = useNavigate();
  const betaPath = useBetaPath();
  const p = useParams();
  const rosterSeason = rosterSeasonOf(league);
  const latest = latestSeasonOf(meta);

  /** the settled seasons, newest first, for the picker */
  const settled = useMemo(() => {
    const i = meta.seasons.indexOf(latest);
    return (i < 0 ? meta.seasons : meta.seasons.slice(0, i + 1)).slice().reverse()
      .filter(s => s !== rosterSeason);
  }, [meta.seasons, latest, rosterSeason]);

  const season = p.season && meta.seasons.includes(p.season) ? p.season : rosterSeason;
  const isCurrent = season === rosterSeason;

  const mwQ = useJson<Matchups>(`${season}/matchups.json`);
  const mw = mwQ.data;
  const odds = useJson<WeekOdds>(`${season}/odds.json`).data;
  const weekly = useJson<Weekly>(`${season}/weekly.json`).data;
  const teams = useJson<Team[]>(`${season}/teams.json`).data;
  const bracket = useJson<BracketFile>(`${season}/bracket.json`).data;
  const fr = useJson<Franchises>("franchises.json").data;

  const weeks = useMemo(() => playedWeeks(mw), [mw]);
  const poWeeks = useMemo(() => playedPlayoffWeeks(mw), [mw]);
  const ps = mw?.playoff_start || 15;
  const hasPlayoffs = !!bracket || poWeeks.length > 0;

  /* ---- the week ------------------------------------------------------------
     The path's week, else the newest played. "playoffs" is a week in the
     strip's vocabulary — the segment after the regular season. */
  const playoffs = p.wk?.toLowerCase() === "playoffs";
  const wantWk = p.wk != null && !playoffs ? Number(p.wk) : NaN;
  const wk = Number.isInteger(wantWk) && wantWk > 0 ? wantWk
    : weeks.length ? weeks[weeks.length - 1] : null;
  const mid = p.mid != null && Number.isInteger(Number(p.mid)) ? Number(p.mid) : null;

  /* ---- the picker's note: "champion · record", the same line League's
     picker reads, so a year is a history table rather than a number */
  const seasons = useMemo<ScopeSeason[]>(() => settled.map(id => {
    const won = fr && Object.values(fr).flatMap(f => f.seasons)
      .find(s => s.season === id && s.finish === 1);
    return won
      ? { id, note: `${won.name} · ${won.wins}-${won.losses}${won.ties ? `-${won.ties}` : ""}` }
      : { id };
  }), [settled, fr]);

  const scope: ScopeSel = isCurrent ? { scope: "current" } : { scope: "history", season };
  const setScope = (s: ScopeSel) =>
    nav(betaPath(`/seasons/${s.scope === "current" ? rosterSeason : s.season}`));

  const nameOf = (rid: number) => teams?.find(t => t.roster_id === rid)?.team ?? `Team ${rid}`;
  const ptsOf = useMemo(() => ptsSource(weekly, bracket), [weekly, bracket]);

  return (
    <>
      <div className="v3-head">
        <h1>Seasons</h1>
        <span className="sub">
          {mw ? `${season} · ${weeks.length} of ${ps - 1} weeks played${hasPlayoffs ? " + playoffs" : ""}` : season}
        </span>
      </div>
      {/* the roster season on the left, every settled season behind the
          right segment — the tense control every beta screen carries */}
      <ScopeControl value={scope} onChange={setScope} seasons={seasons}
        currentLabel={rosterSeason} />

      {/* THE WEEK STRIP: one segment per regular-season week, then the
          playoffs. Unplayed weeks stay in the strip so the season keeps its
          shape, but are not destinations. */}
      {mw && (
        <div className="v3-lens ssx-weeks" role="group" aria-label="Week">
          {Array.from({ length: ps - 1 }, (_, i) => i + 1).map(w => (
            <button key={w} type="button" className={!playoffs && w === wk ? "on" : ""}
              disabled={!weeks.includes(w)}
              onClick={() => nav(betaPath(`/seasons/${season}/${w}`))}>W{w}</button>
          ))}
          {hasPlayoffs && (
            <button type="button" className={playoffs ? "on" : ""}
              onClick={() => nav(betaPath(`/seasons/${season}/playoffs`))}>Playoffs</button>
          )}
        </div>
      )}

      {mwQ.error ? <DataError what="Season didn't load" />
        : !mw ? <div className="empty">Loading…</div>
        : playoffs ? (
          <Playoffs season={season} mw={mw} bracket={bracket} odds={odds} nameOf={nameOf} ptsOf={ptsOf} />
        ) : wk == null ? (
          <div className="empty">No week of {season} has been played yet.</div>
        ) : mid != null ? (
          <Matchup season={season} wk={wk} rid={mid} mw={mw} odds={odds} weekly={weekly} nameOf={nameOf} ptsOf={ptsOf} />
        ) : (
          <WeekBoard season={season} wk={wk} mw={mw} odds={odds} weekly={weekly} teams={teams} nameOf={nameOf} ptsOf={ptsOf} />
        )}
    </>
  );
}

/* ========================================================================
   THE WEEK BOARD — one played week
   ======================================================================== */

interface WeekProps {
  season: string; wk: number; mw: Matchups;
  odds: WeekOdds | null | undefined; weekly: Weekly | null | undefined;
  nameOf: (rid: number) => string;
  ptsOf: PtsOf;
}

function WeekBoard({ season, wk, mw, odds, weekly, teams, nameOf, ptsOf }: WeekProps & { teams: Team[] | null | undefined }) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const rows = useMemo(() => weekRows(mw, wk), [mw, wk]);
  const games = useMemo(() => weekGames(rows), [rows]);
  const figs = useMemo(() => weekFigures(rows, wk, odds, weekly, players), [rows, wk, odds, weekly, players]);
  const isPlayoff = wk >= (mw.playoff_start || 15);
  /** whose roster a player is on — that season's end-of-season roster */
  const teamOf = (pid: string) => teams?.find(t => t.players.includes(pid))?.team ?? null;

  return (
    <>
      <Band label={`Week ${wk} · ${season}`}
        note={`${games.length} matchups · tap one for both lineups`} />
      {figs?.median != null && (
        <div className="lgx-median">
          <span className="k">League median</span>
          <span className="v">{fmt(figs.median, 1)}</span>
          <span className="s">of the week's scores</span>
        </div>
      )}
      <Games season={season} wk={wk} games={games} mw={mw} odds={odds} weekly={weekly} nameOf={nameOf} ptsOf={ptsOf} />

      {!isPlayoff && figs && (
        <>
          <Band label="Week figures" note="the four the League tab shows for last week" />
          <div className="lgx-even">
            <Strip figures={[
              { key: "top", label: "Top score",
                value: <span className="lgx-good">{fmt(figs.top.pts, 1)}</span>, sub: nameOf(figs.top.rid) },
              { key: "low", label: "Low score",
                value: <span className="lgx-bad">{fmt(figs.low.pts, 1)}</span>, sub: nameOf(figs.low.rid) },
              { key: "upset", label: "Upset",
                value: figs.upset && figs.upsetWp != null
                  ? <span className="lgx-warn">{`${Math.round(figs.upsetWp * 100)}%`}</span> : DASH,
                sub: figs.upset
                  ? `${nameOf(figs.upset.rid)} beat ${figs.upset.opp != null ? nameOf(figs.upset.opp) : "—"}`
                  : "no winner beat the line" },
              { key: "close", label: "Closest score",
                value: figs.closest ? fmt(figs.closest.pts - figs.closest.oppPts, 1) : DASH,
                sub: figs.closest
                  ? `${nameOf(figs.closest.rid)} beat ${nameOf(figs.closest.opp)}, ${fmt(figs.closest.pts, 1)}–${fmt(figs.closest.oppPts, 1)}`
                  : "no scored game" },
            ]} />
          </div>
          <PosLeaders
            leaders={POSITIONS.map(pos => {
              const t = figs.posTop[pos];
              return t ? { pid: t.pid, value: `${fmt(t.pts, 1)} pts`, note: teamOf(t.pid) ?? "unrostered" } : null;
            })}
            settled={!!weekly}
            empty={pos => `no ${pos} scored`} />
          <Performers wk={wk} rows={rows} weekly={weekly} nameOf={nameOf} betaPath={betaPath} />
        </>
      )}
      <div className="tnote screen">
        {isPlayoff
          ? "A playoff week: WAR is scored for the regular season only, so this week carries points and no figures."
          : "WAR is the win-probability shift of the player's points against the replacement starter, using this week's spread of the twelve team scores. Vs avg and vs repl are points over the position's startable average and over its next man up. The position blocks count every rostered player, started or not."}
      </div>
    </>
  );
}

/* ---- the game cards ------------------------------------------------------
   League's card at the final: the two scores, the winner in the accent, the
   margin and the pregame line in the middle. Tapping a card opens the slot
   drawer under it, the full page is the link inside. */
function Games({ season, wk, games, odds, nameOf, ptsOf, solo = false }: WeekProps & {
  games: WeekGame[];
  /** the matchup page: one card, not a control */
  solo?: boolean;
}) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const [open, setOpen] = useState<string | null>(null);
  const line = odds?.weeks[String(wk)] ?? {};
  const slots = useSlots(wk, ptsOf);
  /** a game whose starters were scored — a consolation game in a playoff
   *  week has no per-player points on file, so it gets a card and no drawer */
  const scored = (g: WeekGame) =>
    [...g.a.starters, ...g.b.starters].some(pid => pid && pid !== "0" && ptsOf(pid, wk) != null);

  if (!games.length) return <div className="empty">No scored game this week.</div>;
  return (
    <div className={`lgx-games${solo ? " ssx-solo" : ""}`}>
      {games.map(g => {
        const aWon = g.a.pts > g.b.pts, bWon = g.b.pts > g.a.pts;
        const wpA = line[String(g.a.rid)]?.wp, wpB = line[String(g.b.rid)]?.wp;
        const key = `${g.a.rid}-${g.b.rid}`;
        const isOpen = !solo && open === key;
        const side = (x: WeekRow, won: boolean, right: boolean) => (
          <div className={`side${right ? " r" : ""}${won ? " won" : ""}`}>
            <div className="nm">{nameOf(x.rid)}</div>
            <div className="fig">{fmt(x.pts, 1)}</div>
          </div>
        );
        const card = (
          <>
            {side(g.a, aWon, false)}
            <div className="mid">
              <span className="k">Final</span>
              <span className="v edge">
                <span className="ar">{aWon ? "◂" : ""}</span>
                <span className="n">{fmt(Math.abs(g.a.pts - g.b.pts), 1)}</span>
                <span className="ar">{bWon ? "▸" : ""}</span>
              </span>
              {/* the pregame line, so an upset reads as one: "was 62–38" */}
              {wpA != null && wpB != null && (
                <>
                  <span className="k">Was</span>
                  <span className="v">{Math.round(wpA * 100)}–{Math.round(wpB * 100)}</span>
                </>
              )}
            </div>
            {side(g.b, bWon, true)}
          </>
        );
        if (solo || !scored(g)) return <div key={key} className="lgx-game ssx-still">{card}</div>;
        return [
          <button key={key} type="button" className={`lgx-game${isOpen ? " open" : ""}`}
            aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : key)}>
            {card}
          </button>,
          isOpen && (
            <SlotDrawer key={`${key}-drawer`}
              a={{ rid: g.a.rid, name: nameOf(g.a.rid), slots: slots(g.a) }}
              b={{ rid: g.b.rid, name: nameOf(g.b.rid), slots: slots(g.b) }}
              played players={players} board={null}
              to={betaPath(`/seasons/${season}/${wk}/${g.a.rid}`)} />
          ),
        ];
      })}
    </div>
  );
}

/** a side's starting lineup as it was scored, one entry per slot in the
 *  league's lineup order, each slot carrying the points it returned. An
 *  empty slot is a real 0.0 — that IS the weakness. */
function useSlots(wk: number, ptsOf: PtsOf) {
  const { meta } = useLeague();
  return useMemo(() => {
    const lineup = lineupOf(meta).filter(sl => !["BN", "IR", "TAXI"].includes(sl));
    const pts = (pid: string) => ptsOf(pid, wk) ?? 0;
    return (r: WeekRow): SlotEntry[] => {
      // a lineup file from before the league's slot list changed: read the
      // starters in order and label what is left generically
      const n = Math.max(lineup.length, r.starters.length);
      return Array.from({ length: n }, (_, i) => {
        const pid = r.starters[i];
        const real = !!pid && pid !== "0";
        const v = real ? pts(pid) : 0;
        return { slot: lineup[i] ?? "FLEX", pid: real ? pid : null, v, over: true, est: v };
      });
    };
  }, [meta, wk, ptsOf]);
}

/* ---- top performers -------------------------------------------------------
   Started players only, by WAR. The badge-rank on the sub-line is rank within
   position for THIS sort; the phone folds points onto the sub-line, the
   desktop gets them as columns. */
function Performers({ wk, rows, weekly, nameOf, betaPath }: {
  wk: number; rows: WeekRow[]; weekly: Weekly | null | undefined;
  nameOf: (rid: number) => string; betaPath: (p: string) => string;
}) {
  const { players } = useLeague();
  const [all, setAll] = useState(false);
  const perf = useMemo(() => {
    const started = new Map<string, number>();
    for (const r of rows) for (const pid of r.starters) if (pid && pid !== "0") started.set(pid, r.rid);
    const list: { pid: string; rid: number; pos: string; pts: number; avg: number; repl: number; war: number; prank: number }[] = [];
    for (const [pid, rid] of started) {
      const w = weekly?.[pid]?.find(x => x[0] === wk);
      if (!w) continue;
      list.push({ pid, rid, pos: pInfo(players, pid)[1], pts: w[1], avg: w[2], repl: w[3], war: w[5], prank: 0 });
    }
    list.sort((x, y) => y.war - x.war);
    const seen: Record<string, number> = {};
    for (const x of list) x.prank = (seen[x.pos] = (seen[x.pos] ?? 0) + 1);
    return list;
  }, [rows, weekly, wk, players]);
  const shown = perf.slice(0, all ? PERF_ALL : PERF_FOLDED);
  /** a signed points figure, one place, true minus */
  const sPts = (v: number) => (
    <span className={`f${v > 0.005 ? " up" : v < -0.005 ? " down" : ""}`}>
      {(v > 0.005 ? "+" : v < -0.005 ? "−" : "") + fmt(Math.abs(v), 1)}
    </span>
  );
  return (
    <>
      <Band label="Top performers" note="started players only · by WAR"
        right={perf.length > PERF_FOLDED && (
          <button type="button" className="lgx-all" onClick={() => setAll(a => !a)}>
            {all ? `Top ${PERF_FOLDED} ▴` : `All ${Math.min(PERF_ALL, perf.length)} ▾`}
          </button>
        )} />
      {!weekly ? <div className="empty">Loading…</div> : !perf.length ? <div className="empty">No scored starter this week.</div> : (
        <table className="v3tbl lgx-grid">
          <thead>
            <tr>
              <th className="sp" />
              <th className="t">Player</th>
              <th className="n lgx-desk" style={{ width: "12%" }}>Pts</th>
              <th className="n lgx-desk" style={{ width: "12%" }}>Vs avg</th>
              <th className="n lgx-desk" style={{ width: "12%" }}>Vs repl</th>
              <th className="n sorted" style={{ width: "20%" }}>WAR</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((x, i) => (
              <TapRow key={x.pid} to={betaPath(`/player/${x.pid}`)} className={i % 2 ? "zebra" : ""}>
                <Spine color={POS_COLOR[x.pos]} rank={i + 1} top={i === 0} />
                <IdCell name={pInfo(players, x.pid)[0]}
                  sub={<>
                    {x.pos}{x.prank}
                    {/* the phone folds the points onto the sub-line, ahead of the
                        team so it is the team name that ellipsises, not the figure */}
                    <span className="lgx-phone"> · {fmt(x.pts, 1)} pts</span>
                    {" · "}{nameOf(x.rid)}
                  </>} />
                <td className="n lgx-desk"><span className="f">{fmt(x.pts, 1)}</span></td>
                <td className="n lgx-desk">{sPts(x.avg)}</td>
                <td className="n lgx-desk">{sPts(x.repl)}</td>
                <td className="n"><span className="f hd">{sgnWar(x.war)}</span></td>
              </TapRow>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/* ========================================================================
   THE MATCHUP — one game, slot by slot, then both benches
   ======================================================================== */

function Matchup({ season, wk, rid, mw, odds, weekly, nameOf, ptsOf }: WeekProps & { rid: number }) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const rows = useMemo(() => weekRows(mw, wk), [mw, wk]);
  const games = useMemo(() => weekGames(rows), [rows]);
  const slots = useSlots(wk, ptsOf);
  const g = games.find(x => x.a.rid === rid || x.b.rid === rid);
  if (!g) return <div className="empty">No game for that team in week {wk}.</div>;
  const scored = [...g.a.starters, ...g.b.starters].some(pid => pid && pid !== "0" && ptsOf(pid, wk) != null);

  const bench = (r: WeekRow) => {
    const list = r.bench
      .map(pid => ({ pid, pts: ptsOf(pid, wk), war: weekly?.[pid]?.find(x => x[0] === wk)?.[5] ?? null }))
      .filter((x): x is { pid: string; pts: number; war: number | null } => x.pts != null)
      .sort((x, y) => y.pts - x.pts);
    return (
      <div>
        <Band label={`Bench · ${nameOf(r.rid)}`}
          note={list.length ? `${list.length} not started · by points` : "no bench recorded"} />
        {list.length > 0 && (
          <table className="v3tbl lgx-grid">
            <thead>
              <tr>
                <th className="sp" />
                <th className="t">Player</th>
                <th className="n" style={{ width: "20%" }}>Pts</th>
                <th className="n" style={{ width: "22%" }}>WAR</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x, i) => {
                const [name, pos, club] = pInfo(players, x.pid);
                return (
                  <tr key={x.pid} className={i % 2 ? "zebra" : ""}>
                    <Spine color={POS_COLOR[pos]} rank="" />
                    <IdCell name={name} sub={`${club || "FA"} · ${pos}`} />
                    <td className="n"><span className="f">{fmt(x.pts, 1)}</span></td>
                    <td className="n">{x.war == null ? NUL : <span className="f q">{sgnWar(x.war)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  return (
    <>
      <Band label={`${nameOf(g.a.rid)} vs ${nameOf(g.b.rid)}`} note={`${season} · week ${wk} · final`} />
      <Games season={season} wk={wk} games={[g]} mw={mw} odds={odds} weekly={weekly} nameOf={nameOf} ptsOf={ptsOf} solo />
      <Band label="Lineups" note={scored ? "slot by slot · the higher figure takes the arrow, only the totals take the accent" : "no per-player scoring on file for this game"} />
      {scored && (
        <div className="ssx-lineups">
          <SlotDrawer
            a={{ rid: g.a.rid, name: nameOf(g.a.rid), slots: slots(g.a) }}
            b={{ rid: g.b.rid, name: nameOf(g.b.rid), slots: slots(g.b) }}
            played players={players} board={null} />
        </div>
      )}
      <div className="ssx-two">
        {bench(g.a)}
        {bench(g.b)}
      </div>
      <div className="tnote screen">
        The bench is who was rostered that week and not started, scored the same way. A bench WAR is what the
        slot would have returned had he been started, not a credit to the team.
        {" "}<RouteLink to={betaPath(`/seasons/${season}/${wk}`)} className="lgx-all">← Week {wk}</RouteLink>
      </div>
    </>
  );
}

/* ========================================================================
   THE PLAYOFFS — the bracket, then each round's games
   ======================================================================== */

function Playoffs({ season, mw, bracket, odds, nameOf, ptsOf }: {
  season: string; mw: Matchups; bracket: BracketFile | null | undefined;
  odds: WeekOdds | null | undefined;
  nameOf: (rid: number) => string; ptsOf: PtsOf;
}) {
  const { league } = useLeague();
  const { keyOf, hrefOf } = useFranchiseIndex(rosterSeasonOf(league));
  const weeks = useMemo(() => playedPlayoffWeeks(mw), [mw]);
  const final = bracket?.winners.find(g => g.p === 1);
  const champ = final?.w ?? null;
  const runner = final?.l ?? null;
  /** the round each playoff week decides, named from the end: the last week
   *  is the Final, the one before it the Semifinals, then Quarterfinals */
  const roundName = (wk: number) => {
    const wks = bracket
      ? [...new Set(bracket.winners.filter(g => g.p == null || g.p === 1).map(g => g.week))].sort((a, b) => a - b)
      : weeks;
    const fromEnd = wks.length - 1 - wks.indexOf(wk);
    return fromEnd === 0 ? "Final" : fromEnd === 1 ? "Semifinals" : fromEnd === 2 ? "Quarterfinals" : `Round ${wks.indexOf(wk) + 1}`;
  };
  /* THE CHAMPION'S PAGE, INSIDE THIS SHELL (2026-09-21). This linked
     `/franchise/<fkey>`, and `franchise` is in BetaShell's CLASSIC_ONLY list —
     so tapping the champion forwarded a beta reader out to the classic board
     and stranded him there. The beta franchise page is `/team/<rid>` and it
     addresses the ROSTER season's slots, so the link is resolved through the
     franchise key: the champion of an old season who is still in the league
     gets a link, one who has left reads as plain text rather than opening
     whoever inherited his roster slot. */
  const champHref = champ != null ? hrefOf(keyOf(season, champ)) : null;

  return (
    <>
      {champ != null && (
        <div className="lgx-champ">
          <div className="k">{season} champion</div>
          {champHref
            ? <RouteLink to={champHref} className="nm">{nameOf(champ)}</RouteLink>
            : <span className="nm">{nameOf(champ)}</span>}
          <div className="sub">
            {runner != null ? `over ${nameOf(runner)}` : ""}
            {final?.t1_pts != null && final?.t2_pts != null
              ? ` · ${fmt(Math.max(final.t1_pts, final.t2_pts), 1)}–${fmt(Math.min(final.t1_pts, final.t2_pts), 1)}` : ""}
          </div>
        </div>
      )}
      <Band label="Bracket" note={bracket ? "tap a game for its lineups" : "no bracket file for this season"} />
      {bracket ? <PlayoffBracket season={season} bracket={bracket} />
        : <div className="empty">{weeks.length ? "The bracket has not been built for this season." : "No playoff week has been played."}</div>}
      {weeks.map(wk => {
        const rows = weekRows(mw, wk);
        const games = weekGames(rows);
        return (
          <div key={wk}>
            <Band label={`Week ${wk} · ${roundName(wk)}`}
              note={`${games.length} games · placement games included`} />
            <Games season={season} wk={wk} games={games} mw={mw} odds={odds} weekly={null} nameOf={nameOf} ptsOf={ptsOf} />
          </div>
        );
      })}
      <div className="tnote screen">
        Every game the week scored, the bracket's and the placement games alike. WAR is regular season only, so
        playoff weeks carry points and the pregame line but no figures or leaders.
      </div>
    </>
  );
}
