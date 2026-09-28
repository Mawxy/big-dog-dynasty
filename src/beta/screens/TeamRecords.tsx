import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BracketFile, Franchises, Matchups, Weekly } from "../../lib/types";
import { jl } from "../../lib/data";
import { useLeague } from "../../lib/context";
import { POS_COLOR } from "../../lib/league";
import { fmt, sgn } from "../../lib/stats";
import { Band, IdCell, LensStrip, NUL, sgnWar, Spine, TapRow, useBetaPath } from "../ui";
import { useNearViewport } from "./TeamRivals";

/**
 * THE RECORD BOOK (Max, 2026-09-27) — this franchise's own all-time bests and
 * worsts: its biggest and smallest games, its streaks, and the best games and
 * seasons a player ever gave it.
 *
 * WHAT COUNTS AS A GAME: the regular season (matchups.json, a played score on
 * both sides) and the WINNERS bracket (bracket.json). The consolation bracket
 * never counts, the rule Head to head and the finish column already draw.
 *
 * WHAT COUNTS AS A PLAYER'S GAME HERE: a week he was IN THIS FRANCHISE'S
 * LINEUP. A 40-point week on the bench is not this team's record — it is the
 * week somebody chose wrong. Regular-season points and WAR come from
 * weekly.json; playoff points from bracket.json's `stars` (starters only) and
 * playoff WAR from its `war` block, which is credited win or lose.
 *
 * Keyed by FRANCHISE through franchises.json, so a redraft owner who changed
 * roster slots keeps one record book. Loads when scrolled near, like Head to
 * head: it needs every season's matchups, weekly and bracket files.
 */

interface Game {
  season: string; wk: number; po: boolean;
  opp: string; pf: number; pa: number;
  /** the result: a bracket game by the bracket's winner, a regular one by score */
  res: "w" | "l" | "t";
}
interface PWeek {
  season: string; wk: number; po: boolean; pid: string;
  pts: number | null; war: number | null; opp: string;
}
interface Rec {
  key: string; label: string; value: ReactNode; detail: ReactNode;
  when: string; to?: string;
}

type Top = "games" | "pts" | "war";
const TOPS: { id: Top; label: string }[] = [
  { id: "games", label: "Team games" },
  { id: "pts", label: "Player points" },
  { id: "war", label: "Player WAR" },
];
const TOP_N = 10;

/** "W7 ’24", "PO W16 ’24" — the Head to head table's shorthand */
const whenOf = (season: string, wk: number, po: boolean) =>
  `${po ? "PO " : ""}W${wk} ’${season.slice(2)}`;
const score = (g: Game) => `${fmt(g.pf, 1)}–${fmt(g.pa, 1)}`;
const resLetter = (g: Game) => (g.res === "w" ? "W" : g.res === "l" ? "L" : "T");

export default function TeamRecords({ fkey, fr, seasons }: {
  fkey: string; fr: Franchises | null | undefined; seasons: string[];
}) {
  const betaPath = useBetaPath();
  const { league, players } = useLeague();
  const [top, setTop] = useState<Top>("games");
  const [files, setFiles] = useState<{
    m: (Matchups | null)[]; w: (Weekly | null)[]; b: (BracketFile | null)[];
  } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);

  useEffect(() => {
    if (!near) return;
    let live = true;
    setFiles(null);
    Promise.all([
      Promise.all(seasons.map(s => jl<Matchups>(`${s}/matchups.json`).catch(() => null))),
      Promise.all(seasons.map(s => jl<Weekly>(`${s}/weekly.json`).catch(() => null))),
      Promise.all(seasons.map(s => jl<BracketFile>(`${s}/bracket.json`).catch(() => null))),
    ]).then(([m, w, b]) => { if (live) setFiles({ m, w, b }); });
    return () => { live = false; };
  }, [near, seasons.join(","), league]);

  const book = useMemo(() => {
    if (!files) return null;
    const games: Game[] = [];
    const weeks: PWeek[] = [];

    seasons.forEach((season, i) => {
      /* this season's roster slots -> franchise keys, and which slot is ours */
      const ids = new Map<number, string>();
      for (const [k, f] of Object.entries(fr ?? {})) {
        const s = f.seasons.find(x => x.season === season);
        if (s) ids.set(s.rid ?? Number(k), k);
      }
      const me = [...ids.entries()].find(([, k]) => k === fkey)?.[0];
      if (me == null) return;
      const b = files.b[i];
      const oppName = (rid: number | null) => {
        if (rid == null) return "—";
        const k = ids.get(rid);
        return (k ? fr?.[k]?.seasons.find(x => x.season === season)?.name?.trim() : null)
          ?? b?.names[String(rid)] ?? `Roster ${rid}`;
      };

      /* ---- the regular season ---- */
      const m = files.m[i];
      const wk = files.w[i];
      if (m) {
        const ps = m.playoff_start || 15;
        for (const e of m.teams[String(me)] ?? []) {
          const [w, pf, opp, pa] = e;
          // no opponent score = not played yet (or a bye): not a game
          if (w >= ps || opp == null || pa == null) continue;
          const on = oppName(opp);
          games.push({
            season, wk: w, po: false, opp: on, pf, pa,
            res: pf > pa ? "w" : pf < pa ? "l" : "t",
          });
          for (const pid of e[4] ?? []) {
            if (!pid || pid === "0") continue;
            const r = wk?.[pid]?.find(x => x[0] === w);
            // started and never scored a line: a start, not a record
            if (!r) continue;
            weeks.push({ season, wk: w, po: false, pid, pts: r[1], war: r[5], opp: on });
          }
        }
      }

      /* ---- the winners bracket ---- */
      if (b) {
        const oppByWeek = new Map<number, string>();
        for (const g of b.winners) {
          if (g.t1 == null || g.t2 == null || g.w == null) continue;
          if (g.t1 !== me && g.t2 !== me) continue;
          const mine1 = g.t1 === me;
          const on = oppName(mine1 ? g.t2 : g.t1);
          oppByWeek.set(g.week, on);
          games.push({
            season, wk: g.week, po: true, opp: on,
            pf: (mine1 ? g.t1_pts : g.t2_pts) ?? 0,
            pa: (mine1 ? g.t2_pts : g.t1_pts) ?? 0,
            res: g.w === me ? "w" : "l",
          });
        }
        for (const [pid, st] of Object.entries(b.stars ?? {})) {
          if (st.rid !== me) continue;
          const pw = b.war?.[pid];
          for (const [w, pts] of Object.entries(st.wk)) {
            weeks.push({
              season, wk: Number(w), po: true, pid, pts,
              war: pw && pw.rid === me ? pw.wk[w] ?? null : null,
              opp: oppByWeek.get(Number(w)) ?? "—",
            });
          }
        }
      }
    });

    games.sort((a, b) => a.season.localeCompare(b.season) || a.wk - b.wk);

    const maxBy = <T,>(xs: T[], f: (x: T) => number | null): T | null => {
      let best: T | null = null, bv = -Infinity;
      for (const x of xs) { const v = f(x); if (v != null && v > bv) { bv = v; best = x; } }
      return best;
    };

    /* ---- streaks: consecutive results, a tie breaks both ---- */
    const streak = (k: "w" | "l") => {
      let run: Game[] = [], best: Game[] = [];
      for (const g of games) {
        if (g.res === k) { run.push(g); if (run.length > best.length) best = run.slice(); }
        else run = [];
      }
      return best;
    };

    /* ---- a player's seasons and career FOR THIS FRANCHISE ---- */
    const seasonWar = new Map<string, { pid: string; season: string; war: number; n: number }>();
    const career = new Map<string, { pid: string; starts: number; pts: number }>();
    for (const w of weeks) {
      if (!w.po && w.war != null) {
        const k = `${w.pid}|${w.season}`;
        const s = seasonWar.get(k) ?? { pid: w.pid, season: w.season, war: 0, n: 0 };
        s.war += w.war; s.n++;
        seasonWar.set(k, s);
      }
      const c = career.get(w.pid) ?? { pid: w.pid, starts: 0, pts: 0 };
      c.starts++; c.pts += w.pts ?? 0;
      career.set(w.pid, c);
    }

    /* ---- the franchise's seasons, off franchises.json ---- */
    const fseasons = (fr?.[fkey]?.seasons ?? []).filter(s => s.wins + s.losses + s.ties > 0);

    const name = (pid: string) => players[pid]?.[0] ?? `#${pid}`;
    const gameTo = (g: Game) => betaPath(`/seasons/${g.season}/${g.wk}`);
    const recs: Rec[] = [];
    const push = (r: Rec | null) => { if (r) recs.push(r); };
    const gameRec = (key: string, label: string, g: Game | null, value: (g: Game) => ReactNode) =>
      g && push({
        key, label, value: value(g),
        detail: `${resLetter(g)} ${score(g)} vs ${g.opp}`,
        when: whenOf(g.season, g.wk, g.po), to: gameTo(g),
      });

    gameRec("hi", "Most points, game", maxBy(games, g => g.pf), g => fmt(g.pf, 1));
    gameRec("lo", "Fewest points, game", maxBy(games, g => -g.pf), g => fmt(g.pf, 1));
    gameRec("bigw", "Biggest win", maxBy(games.filter(g => g.res === "w"), g => g.pf - g.pa),
      g => sgn(g.pf - g.pa, 1));
    gameRec("bigl", "Worst loss", maxBy(games.filter(g => g.res === "l"), g => g.pa - g.pf),
      g => sgn(g.pf - g.pa, 1));
    gameRec("hil", "Most points in a loss", maxBy(games.filter(g => g.res === "l"), g => g.pf),
      g => fmt(g.pf, 1));
    gameRec("low", "Fewest points in a win", maxBy(games.filter(g => g.res === "w"), g => -g.pf),
      g => fmt(g.pf, 1));

    for (const [k, label] of [["w", "Longest win streak"], ["l", "Longest losing streak"]] as const) {
      const s = streak(k);
      if (!s.length) continue;
      const a = s[0], z = s[s.length - 1];
      push({
        key: `st${k}`, label, value: s.length,
        detail: s.length > 1
          ? `${whenOf(a.season, a.wk, a.po)} to ${whenOf(z.season, z.wk, z.po)}`
          : whenOf(a.season, a.wk, a.po),
        when: a.season === z.season ? a.season : `${a.season}–${z.season.slice(2)}`,
      });
    }

    const bestPf = maxBy(fseasons, s => s.fpts);
    if (bestPf) push({
      key: "pfs", label: "Most points, season", value: fmt(bestPf.fpts, 1),
      detail: `${bestPf.wins}-${bestPf.losses}${bestPf.ties ? `-${bestPf.ties}` : ""} · ${fmt(bestPf.ppg, 1)} ppg`,
      when: bestPf.season, to: betaPath(`/seasons/${bestPf.season}`),
    });
    /* MOST WINS, NOT BEST PERCENTAGE (Max, 2026-09-28): by percentage a 1-0
       start in the season being played outranks every 12-2 there has ever
       been, so the record changed hands every September. Wins first (a tie is
       half of one), then fewer losses, then points as the last word. */
    const bestRec = maxBy(fseasons,
      s => (s.wins + s.ties / 2) * 1e6 - s.losses * 1e3 + s.fpts / 1e4);
    if (bestRec) push({
      key: "rec", label: "Best record, season",
      value: `${bestRec.wins}-${bestRec.losses}${bestRec.ties ? `-${bestRec.ties}` : ""}`,
      detail: `${fmt(bestRec.fpts, 1)} points · ${bestRec.finish != null ? `finished ${bestRec.finish}` : "unfinished"}`,
      when: bestRec.season, to: betaPath(`/seasons/${bestRec.season}`),
    });

    const pRec = (key: string, label: string, w: PWeek | null, value: (w: PWeek) => ReactNode) =>
      w && push({
        key, label, value: value(w),
        detail: `${name(w.pid)} · vs ${w.opp}`,
        when: whenOf(w.season, w.wk, w.po), to: betaPath(`/player/${w.pid}`),
      });
    pRec("ppts", "Best player game, points", maxBy(weeks, w => w.pts), w => fmt(w.pts ?? 0, 1));
    pRec("pwar", "Best player game, WAR", maxBy(weeks, w => w.war), w => sgnWar(w.war ?? 0));

    const sw = maxBy([...seasonWar.values()], s => s.war);
    if (sw) push({
      key: "swar", label: "Best player season, WAR", value: sgnWar(sw.war),
      detail: `${name(sw.pid)} · ${sw.n} start${sw.n === 1 ? "" : "s"}, regular season`,
      when: sw.season, to: betaPath(`/player/${sw.pid}`),
    });
    const ms = maxBy([...career.values()], c => c.starts * 1e6 + c.pts);
    if (ms) push({
      key: "starts", label: "Most starts", value: ms.starts,
      detail: `${name(ms.pid)} · ${fmt(ms.pts, 1)} points as a starter`,
      when: "all-time", to: betaPath(`/player/${ms.pid}`),
    });
    const mp = maxBy([...career.values()], c => c.pts);
    if (mp) push({
      key: "cpts", label: "Most points as a starter", value: fmt(mp.pts, 1),
      detail: `${name(mp.pid)} · ${mp.starts} starts`,
      when: "all-time", to: betaPath(`/player/${mp.pid}`),
    });

    const topGames = games.slice().sort((a, b) => b.pf - a.pf).slice(0, TOP_N);
    const topPts = weeks.filter(w => w.pts != null)
      .sort((a, b) => (b.pts ?? 0) - (a.pts ?? 0)).slice(0, TOP_N);
    const topWar = weeks.filter(w => w.war != null)
      .sort((a, b) => (b.war ?? 0) - (a.war ?? 0)).slice(0, TOP_N);

    return { recs, topGames, topPts, topWar, n: games.length };
  }, [files, fr, fkey, seasons.join(","), players, betaPath]);

  const loading = <tr><td colSpan={4} className="t"><span className="f q">Loading…</span></td></tr>;
  const none = <tr><td colSpan={4} className="t"><span className="f q">No games on file.</span></td></tr>;

  return (
    <div ref={box}>
      <Band label="Record book"
        note="all-time · regular season and winners bracket · a player's game counts only when he started here" />
      <table className="v3tbl">
        <thead>
          <tr>
            <th className="t">Record</th>
            <th className="n" style={{ width: "22%" }}>Figure</th>
            <th className="n" style={{ width: "20%" }}>When</th>
          </tr>
        </thead>
        <tbody>
          {!book && <tr><td colSpan={3} className="t"><span className="f q">Loading…</span></td></tr>}
          {book && !book.n && <tr><td colSpan={3} className="t"><span className="f q">No games on file.</span></td></tr>}
          {book?.n ? book.recs.map((r, i) => {
            const cells = (
              <>
                <IdCell name={r.label} sub={r.detail} />
                <td className="n"><span className="f hd">{r.value}</span></td>
                <td className="n"><span className="f q">{r.when}</span></td>
              </>
            );
            return r.to
              ? <TapRow key={r.key} to={r.to} className={i % 2 ? "zebra" : ""}>{cells}</TapRow>
              : <tr key={r.key} className={i % 2 ? "zebra" : ""}>{cells}</tr>;
          }) : null}
        </tbody>
      </table>

      <Band label={`Top ${TOP_N}`} note="the franchise's best single games, by the measure picked" />
      <LensStrip options={TOPS} value={top} onChange={setTop} label="Top list" />
      <table className="v3tbl">
        <thead>
          {top === "games" ? (
            <tr>
              <th className="c sp">#</th>
              <th className="t">Game</th>
              <th className="n sorted" style={{ width: "20%" }}>Pts</th>
              <th className="n" style={{ width: "20%" }}>When</th>
            </tr>
          ) : (
            <tr>
              <th className="c sp">#</th>
              <th className="t">Player</th>
              <th className={`n${top === "pts" ? " sorted" : ""}`} style={{ width: "18%" }}>Pts</th>
              <th className={`n${top === "war" ? " sorted" : ""}`} style={{ width: "18%" }}>WAR</th>
            </tr>
          )}
        </thead>
        <tbody>
          {!book && loading}
          {book && !book.n && none}
          {book && top === "games" && book.topGames.map((g, i) => (
            <TapRow key={`${g.season}-${g.wk}-${g.po}`} to={betaPath(`/seasons/${g.season}/${g.wk}`)}
              className={i % 2 ? "zebra" : ""}>
              <Spine rank={i + 1} top={i === 0} />
              <IdCell name={`vs ${g.opp}`} sub={`${resLetter(g)} ${score(g)}`} />
              <td className="n"><span className="f hd">{fmt(g.pf, 1)}</span></td>
              <td className="n"><span className="f q">{whenOf(g.season, g.wk, g.po)}</span></td>
            </TapRow>
          ))}
          {book && top !== "games" && (top === "pts" ? book.topPts : book.topWar).map((w, i) => {
            const info = players[w.pid];
            const pos = info?.[1] ?? "";
            return (
              <TapRow key={`${w.pid}-${w.season}-${w.wk}-${w.po}`} to={betaPath(`/player/${w.pid}`)}
                className={i % 2 ? "zebra" : ""}>
                <Spine color={POS_COLOR[pos]} rank={i + 1} top={i === 0} />
                <IdCell name={info?.[0] ?? `#${w.pid}`}
                  sub={`${pos ? `${pos} · ` : ""}${whenOf(w.season, w.wk, w.po)} vs ${w.opp}`} />
                <td className="n">
                  <span className={`f${top === "pts" ? " hd" : ""}`}>{w.pts == null ? NUL : fmt(w.pts, 1)}</span>
                </td>
                <td className="n">
                  <span className={`f${top === "war" ? " hd" : ""}`}>{w.war == null ? NUL : sgnWar(w.war)}</span>
                </td>
              </TapRow>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
