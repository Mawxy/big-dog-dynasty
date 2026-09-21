import { useEffect, useMemo, useState } from "react";
import type { BracketFile, Franchises, Matchups } from "../../lib/types";
import { jl } from "../../lib/data";
import { useLeague } from "../../lib/context";
import { fmt } from "../../lib/stats";
import { Band, IdCell, LensStrip, NUL, TapRow, useBetaPath } from "../ui";

/**
 * HEAD TO HEAD (Max, 2026-09-21) — this franchise's record against every
 * other franchise in the league, all-time.
 *
 * THREE PHASES, one chip row: Regular / Playoffs / Both.
 *
 *   REGULAR    matchups.json, weeks before playoff_start with a played score.
 *   PLAYOFFS   bracket.json's WINNERS bracket only — elimination rounds and
 *              the championship. The consolation bracket never counts (Max),
 *              and neither do the 3rd/5th place games: they decide a placing,
 *              not who advances, the same line playoff_wpa draws.
 *
 * Keyed by FRANCHISE, not by roster slot: a season's rid is joined to its
 * fkey through franchises.json, so in a redraft league (franchise = owner) a
 * manager who changed slots is still one opponent.
 */

type Phase = "reg" | "po" | "both";

const PHASES: { id: Phase; label: string }[] = [
  { id: "reg", label: "Regular" },
  { id: "po", label: "Playoffs" },
  { id: "both", label: "Both" },
];

/** one game from this franchise's side */
interface Game { season: string; wk: number; opp: string; pf: number; pa: number; po: boolean; w: boolean | null }

interface Row { fkey: string; w: number; l: number; t: number; pf: number; pa: number; last: Game }

export default function TeamRivals({ fkey, fr, seasons, rosterSeason }: {
  fkey: string; fr: Franchises | null | undefined; seasons: string[]; rosterSeason: string;
}) {
  const betaPath = useBetaPath();
  const { league } = useLeague();
  const [phase, setPhase] = useState<Phase>("both");
  const [files, setFiles] = useState<{ m: (Matchups | null)[]; b: (BracketFile | null)[] } | null>(null);

  useEffect(() => {
    let live = true;
    setFiles(null);
    Promise.all([
      Promise.all(seasons.map(s => jl<Matchups>(`${s}/matchups.json`).catch(() => null))),
      Promise.all(seasons.map(s => jl<BracketFile>(`${s}/bracket.json`).catch(() => null))),
    ]).then(([m, b]) => { if (live) setFiles({ m, b }); });
    return () => { live = false; };
  }, [seasons.join(","), league]);

  /** season -> rid -> fkey */
  const keyOf = useMemo(() => {
    const out = new Map<string, Map<number, string>>();
    for (const [k, f] of Object.entries(fr ?? {}))
      for (const s of f.seasons) {
        const m = out.get(s.season) ?? new Map<number, string>();
        m.set(s.rid ?? Number(k), k);
        out.set(s.season, m);
      }
    return out;
  }, [fr]);

  const games = useMemo<Game[]>(() => {
    if (!files) return [];
    const out: Game[] = [];
    seasons.forEach((season, i) => {
      const ids = keyOf.get(season);
      if (!ids) return;
      const me = [...ids.entries()].find(([, k]) => k === fkey)?.[0];
      if (me == null) return;
      const m = files.m[i];
      if (m) {
        const ps = m.playoff_start || 15;
        for (const e of m.teams[String(me)] ?? []) {
          const [wk, pts, opp, oppPts] = e;
          if (wk >= ps || opp == null || oppPts == null) continue;
          const ok = ids.get(opp);
          if (ok) out.push({ season, wk, opp: ok, pf: pts, pa: oppPts, po: false, w: null });
        }
      }
      for (const g of files.b[i]?.winners ?? []) {
        if (g.p != null && g.p !== 1) continue;           // placement games are not elimination games
        if (g.t1 == null || g.t2 == null || g.w == null) continue;
        if (g.t1 !== me && g.t2 !== me) continue;
        const mine1 = g.t1 === me;
        const ok = ids.get(mine1 ? g.t2 : g.t1);
        if (!ok) continue;
        out.push({
          season, wk: g.week, opp: ok, po: true, w: g.w === me,
          pf: (mine1 ? g.t1_pts : g.t2_pts) ?? 0,
          pa: (mine1 ? g.t2_pts : g.t1_pts) ?? 0,
        });
      }
    });
    return out;
  }, [files, keyOf, fkey, seasons.join(",")]);

  const rows = useMemo<Row[]>(() => {
    const by = new Map<string, Row>();
    for (const g of games) {
      if (phase === "reg" && g.po) continue;
      if (phase === "po" && !g.po) continue;
      const r = by.get(g.opp) ?? { fkey: g.opp, w: 0, l: 0, t: 0, pf: 0, pa: 0, last: g };
      // a bracket game is decided by the bracket's own winner, not the scores
      const res = g.w != null ? (g.w ? "w" : "l") : g.pf > g.pa ? "w" : g.pf < g.pa ? "l" : "t";
      r[res]++;
      r.pf += g.pf; r.pa += g.pa;
      if (g.season > r.last.season || (g.season === r.last.season && g.wk > r.last.wk)) r.last = g;
      by.set(g.opp, r);
    }
    const pct = (r: Row) => (r.w + r.t / 2) / (r.w + r.l + r.t);
    return [...by.values()].sort((a, b) =>
      pct(b) - pct(a) || (b.w + b.l + b.t) - (a.w + a.l + a.t) || (b.pf - b.pa) - (a.pf - a.pa));
  }, [games, phase]);

  /** the name a franchise plays under now — its latest season's */
  const latest = (k: string) => {
    const s = fr?.[k]?.seasons ?? [];
    return s[s.length - 1];
  };
  const rec = (w: number, l: number, t: number) => `${w}-${l}${t ? `-${t}` : ""}`;
  const signed = (x: number) => (x > 0.05 ? "+" : x < -0.05 ? "−" : "") + fmt(Math.abs(x), 1);

  const tot = rows.reduce((a, r) => ({
    w: a.w + r.w, l: a.l + r.l, t: a.t + r.t, pf: a.pf + r.pf, pa: a.pa + r.pa,
  }), { w: 0, l: 0, t: 0, pf: 0, pa: 0 });
  const tg = tot.w + tot.l + tot.t;

  return (
    <>
      <Band label="Head to head"
        note="all-time vs each franchise · playoffs are the winners bracket only, no placement or consolation games" />
      <LensStrip options={PHASES} value={phase} onChange={setPhase} label="Phase" />
      <table className="v3tbl lgx-grid tms-tbl">
        <thead>
          <tr>
            <th className="t">Opponent</th>
            <th className="n" style={{ width: "13%" }}>W-L</th>
            <th className="n sorted" style={{ width: "12%" }}>Pct</th>
            <th className="n v3-desk" style={{ width: "11%" }}>PF</th>
            <th className="n v3-desk" style={{ width: "11%" }}>PA</th>
            <th className="n" style={{ width: "16%" }} title="Average margin per game">Avg +/−</th>
            <th className="n v3-desk" style={{ width: "12%" }}>Last</th>
          </tr>
        </thead>
        <tbody>
          {!files && (
            <tr><td colSpan={7} className="t"><span className="f q">Loading…</span></td></tr>
          )}
          {files && !rows.length && (
            <tr><td colSpan={7} className="t"><span className="f q">
              {phase === "po" ? "No winners-bracket games on file." : "No games on file."}
            </span></td></tr>
          )}
          {rows.map((r, i) => {
            const s = latest(r.fkey);
            const g = r.w + r.l + r.t;
            const p = (r.w + r.t / 2) / g;
            const cur = fr?.[r.fkey]?.seasons.find(x => x.season === rosterSeason);
            const rid = cur ? cur.rid ?? Number(r.fkey) : null;
            const lastWon = r.last.w != null ? r.last.w : r.last.pf > r.last.pa;
            const lastTie = r.last.w == null && r.last.pf === r.last.pa;
            const cells = (
              <>
                <IdCell name={s?.name?.trim() ?? `Team ${r.fkey}`}
                  sub={<>{s?.manager}<span className="v3-phone"> · {g} game{g === 1 ? "" : "s"}</span></>} />
                <td className="n"><span className="f q">{rec(r.w, r.l, r.t)}</span></td>
                <td className="n"><span className="f hd">{fmt(p * 100, 0)}%</span></td>
                <td className="n v3-desk"><span className="f">{fmt(r.pf, 0)}</span></td>
                <td className="n v3-desk"><span className="f">{fmt(r.pa, 0)}</span></td>
                <td className="n"><span className="f">{signed((r.pf - r.pa) / g)}</span></td>
                <td className="n v3-desk">
                  <span className="f q" title={`${fmt(r.last.pf, 1)}–${fmt(r.last.pa, 1)}`}>
                    {lastTie ? "T" : lastWon ? "W" : "L"} {r.last.po ? "PO" : `W${r.last.wk}`} ’{r.last.season.slice(2)}
                  </span>
                </td>
              </>
            );
            return rid != null
              ? <TapRow key={r.fkey} to={betaPath(`/team/${rid}`)} className={i % 2 ? "zebra" : ""}>{cells}</TapRow>
              : <tr key={r.fkey} className={i % 2 ? "zebra" : ""}>{cells}</tr>;
          })}
          {tg > 0 && (
            <tr className="tms-sum">
              <IdCell name="All opponents" sub={<span className="v3-phone">{tg} games</span>} />
              <td className="n"><span className="f q">{rec(tot.w, tot.l, tot.t)}</span></td>
              <td className="n"><span className="f acc">{fmt((tot.w + tot.t / 2) / tg * 100, 0)}%</span></td>
              <td className="n v3-desk"><span className="f">{fmt(tot.pf, 0)}</span></td>
              <td className="n v3-desk"><span className="f">{fmt(tot.pa, 0)}</span></td>
              <td className="n"><span className="f">{signed((tot.pf - tot.pa) / tg)}</span></td>
              <td className="n v3-desk">{NUL}</td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
