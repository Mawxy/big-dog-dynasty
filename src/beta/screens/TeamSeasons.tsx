import { Fragment, useMemo, useState } from "react";
import type { Franchises, FranchiseSeason, Matchups, Weekly } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useMobile } from "../../lib/useWidth";
import { fmt, ord } from "../../lib/stats";
import { pInfo } from "../../lib/league";
import TeamHonorMarks from "../../components/TeamHonorMarks";
import { teamHonorTotals, type TeamHonorKey } from "../../lib/teamHonors";
import { Band, IdCell, NUL, sgnWar, TapRow, useBetaPath } from "../ui";

/**
 * THE SEASON LEDGER (Max, 2026-09-15) — "how did my season go", on My Team.
 *
 * The player page's career table in the franchise's vocabulary: one row per
 * season the franchise has played — the name it played under, who held it,
 * the record, points, WAR, where it finished and what it won — then the
 * career row, the average season, and one row per manager who has held it.
 *
 * EACH SEASON ROW OPENS INTO ITS WEEKS. The row drawer, in the table flow:
 * one line per week with the opponent, the score and the margin, playoff
 * weeks banded after the regular season. A week taps through to that
 * matchup on Seasons, slot by slot. The week files load when a season is
 * opened, not before — five seasons is ten files nobody asked for.
 *
 * The rail's season ladder (desktop) stays what it is: navigation to the
 * League screen's year. This is the record.
 */

/** the row's honors, rarest first, as the ladder draws them */
type Honors = Map<string, TeamHonorKey[]>;

export default function TeamSeasons({ fkey, rid, fr, honors, rosterSeason }: {
  fkey: string; rid: number; fr: Franchises | null | undefined;
  honors: Honors; rosterSeason: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  /* THE DRAWER SPANS THE VISIBLE COLUMNS ONLY. A colSpan over a hidden
     (display: none) column hands that column width back in a fixed layout —
     Chromium distributes a spanning cell across every column it names — so
     the phone's four-column table grew four ghost columns the moment a
     drawer opened and the Team cell collapsed to 37px. */
  const mobile = useMobile("(max-width: 899px)");
  const span = mobile ? 4 : 8;
  const seasons = useMemo(
    () => (fr?.[fkey]?.seasons ?? []).slice().sort((a, b) => b.season.localeCompare(a.season)),
    [fr, fkey]);
  /** the managers who have held the franchise, in the order they did */
  const managers = useMemo(() => {
    const by = new Map<string, FranchiseSeason[]>();
    for (const s of seasons.slice().reverse()) by.set(s.manager, [...(by.get(s.manager) ?? []), s]);
    return [...by.entries()].reverse();
  }, [seasons]);
  if (!seasons.length) return null;

  /** a season the roster season has not started — the row reads "live" */
  const isLive = (s: FranchiseSeason) => s.season === rosterSeason && s.wins + s.losses + s.ties === 0;
  const played = seasons.filter(s => !isLive(s));
  const rec = (w: number, l: number, t: number) => `${w}-${l}${t ? `-${t}` : ""}`;
  const finish = (s: FranchiseSeason) =>
    s.finish === 1 ? <span className="mark acc">Champ</span>
    : s.finish != null ? <span className="f">{ord(s.finish)}</span>
    : isLive(s) ? <span className="mark">Live</span> : NUL;

  /* ---- the summary rows --------------------------------------------------- */
  const sum = (rows: FranchiseSeason[]) => rows.reduce((a, s) => ({
    w: a.w + s.wins, l: a.l + s.losses, t: a.t + s.ties, pf: a.pf + s.fpts, war: a.war + s.war,
    g: a.g + s.wins + s.losses + s.ties,
  }), { w: 0, l: 0, t: 0, pf: 0, war: 0, g: 0 });
  const career = sum(played);
  const honorsOf = (rows: FranchiseSeason[]) =>
    teamHonorTotals(rows.map(s => ({ season: s.season, keys: honors.get(s.season) ?? [] })));
  return (
    <>
      <Band label="Seasons" note="tap a season for its weeks · WAR is the lineup's, vs replacement" />
      <table className="v3tbl lgx-grid tms-tbl">
        <thead>
          <tr>
            <th className="t tms-yr">Season</th>
            <th className="t">Team</th>
            <th className="n v3-desk" style={{ width: "10%" }}>W-L</th>
            <th className="n v3-desk" style={{ width: "10%" }}>PF</th>
            <th className="n" style={{ width: "15%" }}>PPG</th>
            <th className="n sorted" style={{ width: "17%" }}>WAR</th>
            <th className="n v3-desk" style={{ width: "10%" }}>Finish</th>
            <th className="t v3-desk" style={{ width: "16%" }}>Honors</th>
          </tr>
        </thead>
        <tbody>
          {seasons.map((s, i) => {
            const live = isLive(s);
            const on = open === s.season;
            const marks = honors.get(s.season) ?? [];
            return (
              <Fragment key={s.season}>
                <TapRow onTap={() => setOpen(on ? null : s.season)}
                  className={`${i % 2 ? "zebra" : ""}${on ? " tms-on" : ""}`}>
                  <td className="t tms-yr"><span className="f">{s.season}</span></td>
                  <IdCell name={s.name}
                    sub={<>
                      {s.manager}
                      <span className="v3-phone"> · {live ? "live" : rec(s.wins, s.losses, s.ties)}</span>
                      {!live && s.finish != null && <span className="v3-phone"> · {s.finish === 1 ? "champ" : ord(s.finish)}</span>}
                    </>} />
                  <td className="n v3-desk"><span className="f q">{live ? "—" : rec(s.wins, s.losses, s.ties)}</span></td>
                  <td className="n v3-desk"><span className="f">{live ? NUL : fmt(s.fpts, 0)}</span></td>
                  <td className="n"><span className="f">{live ? NUL : fmt(s.ppg, 1)}</span></td>
                  <td className="n"><span className="f hd">{live ? NUL : sgnWar(s.war)}</span></td>
                  <td className="n v3-desk">{finish(s)}</td>
                  <td className="t v3-desk">{marks.length ? <TeamHonorMarks marks={marks} size={14} showCounts={false} /> : NUL}</td>
                </TapRow>
                {on && (
                  <tr className="tms-drawrow">
                    <td colSpan={span}>
                      <SeasonWeeks season={s.season} rid={s.rid ?? rid} fr={fr} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}

          {/* the career row: every played season summed */}
          <tr className="tms-sum">
            <td className="t tms-yr"><span className="mark">Career</span></td>
            <IdCell name={`${played.length} season${played.length === 1 ? "" : "s"}`}
              sub={<span className="v3-phone">{rec(career.w, career.l, career.t)}</span>} />
            <td className="n v3-desk"><span className="f q">{rec(career.w, career.l, career.t)}</span></td>
            <td className="n v3-desk"><span className="f">{fmt(career.pf, 0)}</span></td>
            <td className="n"><span className="f">{career.g ? fmt(career.pf / career.g, 1) : NUL}</span></td>
            <td className="n"><span className="f acc">{sgnWar(career.war)}</span></td>
            <td className="n v3-desk">{NUL}</td>
            <td className="t v3-desk">{honorsOf(played).length ? <TeamHonorMarks marks={honorsOf(played)} size={14} /> : NUL}</td>
          </tr>
          {/* the average season, on the quiet ramp — a shape to read the rows against */}
          {played.length > 1 && (
            <tr className="tms-sum tms-avg">
              <td className="t tms-yr"><span className="mark">Avg</span></td>
              <IdCell name="Average season" />
              <td className="n v3-desk"><span className="f q">{fmt(career.w / played.length, 1)}-{fmt(career.l / played.length, 1)}</span></td>
              <td className="n v3-desk"><span className="f q">{fmt(career.pf / played.length, 0)}</span></td>
              <td className="n"><span className="f q">{career.g ? fmt(career.pf / career.g, 1) : NUL}</span></td>
              <td className="n"><span className="f q">{sgnWar(career.war / played.length)}</span></td>
              <td className="n v3-desk"><span className="f q">{fmt(played.reduce((a, s) => a + (s.finish ?? 0), 0) / played.filter(s => s.finish != null).length, 1)}</span></td>
              <td className="t v3-desk">{NUL}</td>
            </tr>
          )}
          {/* one row per manager who has held the franchise */}
          {managers.length > 1 && managers.map(([mgr, rows]) => {
            const mine = rows.filter(s => !isLive(s));
            const t = sum(mine);
            const yrs = rows.length > 1 ? `${rows[0].season}–${rows[rows.length - 1].season}` : rows[0].season;
            return (
              <tr key={mgr} className="tms-sum tms-mgr">
                <td className="t tms-yr"><span className="mark">Held</span></td>
                <IdCell name={mgr} sub={<>{yrs} · {mine.length} season{mine.length === 1 ? "" : "s"}<span className="v3-phone"> · {rec(t.w, t.l, t.t)}</span></>} />
                <td className="n v3-desk"><span className="f q">{rec(t.w, t.l, t.t)}</span></td>
                <td className="n v3-desk"><span className="f">{fmt(t.pf, 0)}</span></td>
                <td className="n"><span className="f">{t.g ? fmt(t.pf / t.g, 1) : NUL}</span></td>
                <td className="n"><span className="f">{sgnWar(t.war)}</span></td>
                <td className="n v3-desk">{NUL}</td>
                <td className="t v3-desk">{honorsOf(mine).length ? <TeamHonorMarks marks={honorsOf(mine)} size={14} /> : NUL}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

/* ---- the drawer: one season, week by week -------------------------------- */

function SeasonWeeks({ season, rid, fr }: { season: string; rid: number; fr: Franchises | null | undefined }) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const mwQ = useJson<Matchups>(`${season}/matchups.json`);
  const weekly = useJson<Weekly>(`${season}/weekly.json`).data;
  const mw = mwQ.data;
  const ps = mw?.playoff_start || 15;

  /** the name a roster played under THAT season — franchises.json carries
   *  every season's name, so the opponent needs no second file */
  const nameOf = (r: number | null) => {
    if (r == null) return "—";
    for (const [k, f] of Object.entries(fr ?? {})) {
      const s = f.seasons.find(x => x.season === season && (x.rid ?? Number(k)) === r);
      if (s) return s.name;
    }
    return `Team ${r}`;
  };

  const rows = useMemo(() => {
    if (!mw) return [];
    const list = mw.teams[String(rid)] ?? [];
    return list.slice().sort((a, b) => a[0] - b[0]).map(e => {
      const wk = e[0];
      // the top starter by points, where the week is scored player by player
      let top: { pid: string; pts: number } | null = null;
      for (const pid of e[4] ?? []) {
        const w = weekly?.[pid]?.find(x => x[0] === wk);
        if (w && (!top || w[1] > top.pts)) top = { pid, pts: w[1] };
      }
      return { wk, pts: e[1], opp: e[2], oppPts: e[3], top };
    });
  }, [mw, rid, weekly]);

  if (mwQ.error) return <div className="tms-draw"><div className="empty">The season's weeks didn't load.</div></div>;
  if (!mw) return <div className="tms-draw"><div className="empty">Loading…</div></div>;
  if (!rows.length) return <div className="tms-draw"><div className="empty">No week of {season} on file for this franchise.</div></div>;

  const wins = rows.filter(r => r.oppPts != null && r.pts > r.oppPts && r.wk < ps).length;
  const losses = rows.filter(r => r.oppPts != null && r.pts < r.oppPts && r.wk < ps).length;
  const reg = rows.filter(r => r.wk < ps), po = rows.filter(r => r.wk >= ps);
  const line = (r: typeof rows[number], i: number) => {
    const d = r.oppPts != null ? r.pts - r.oppPts : null;
    const won = d != null && d > 0, lost = d != null && d < 0;
    return (
      <TapRow key={r.wk} to={betaPath(`/seasons/${season}/${r.wk}/${rid}`)} className={i % 2 ? "zebra" : ""}>
        <td className="t tms-yr"><span className="f q">W{r.wk}</span></td>
        <IdCell name={r.opp == null ? "Bye" : <>{won ? "def. " : lost ? "lost to " : "vs "}{nameOf(r.opp)}</>}
          sub={<>
            {fmt(r.pts, 1)}{r.oppPts != null ? `–${fmt(r.oppPts, 1)}` : ""}
            {r.top && <span className="v3-desk"> · {pInfo(players, r.top.pid)[0]} {fmt(r.top.pts, 1)}</span>}
          </>} />
        <td className="n">
          {d == null ? NUL : <span className={`f${won ? " up" : lost ? " down" : ""}`}>{(d > 0 ? "+" : d < 0 ? "−" : "") + fmt(Math.abs(d), 1)}</span>}
        </td>
      </TapRow>
    );
  };
  return (
    <div className="tms-draw">
      <div className="hd">
        <span className="k">{season} · week by week</span>
        <span className="mt">{wins}-{losses} in the regular season{po.length ? ` · ${po.length} playoff week${po.length === 1 ? "" : "s"}` : ""} · tap a week for the matchup</span>
      </div>
      <table className="v3tbl lgx-grid tms-weeks">
        <thead>
          <tr>
            <th className="t tms-yr">Wk</th>
            <th className="t">Opponent</th>
            <th className="n" style={{ width: "18%" }}>Margin</th>
          </tr>
        </thead>
        <tbody>
          {reg.map(line)}
          {po.length > 0 && (
            <tr className="tms-grp"><td colSpan={3}>Playoffs</td></tr>
          )}
          {po.map((r, i) => line(r, i))}
        </tbody>
      </table>
    </div>
  );
}
