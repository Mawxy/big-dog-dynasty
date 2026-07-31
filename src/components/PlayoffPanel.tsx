import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { BracketFile, BracketGame } from "../lib/types";
import { fmt } from "../lib/stats";
import { pInfo, POS_COLOR } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import PlayoffBracket from "./PlayoffBracket";
import { PlayerLink } from "./PlayerLink";

const wsgn = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), 3);
const wsgn2 = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), 2);

interface Perf {
  pid: string; rid: number; pts: number;
  /** RAW win probability added — the measured quantity; weeks sum to it */
  wpa: number | null;
  /** playoff WAR — production over replacement, credited win or lose */
  war: number | null;
  /** the award on the SEASON scale — 100 is this year's best run */
  mvp: number | null;
  /** the award as a historical index — 100 is the average MVP-winning run */
  mvpp: number | null;
  byWeek: Record<string, number>;
  wpaWeek: Record<string, number>;
  /** week -> MVP points; these sum to `mvp` */
  mvpWeek: Record<string, number>;
}

/**
 * One postseason in full: the year in four figures, the bracket, who won it
 * and who lost it, the upsets and the superlatives.
 *
 * This lives inside the Season tab's Playoffs scope rather than on a page of
 * its own — the season chips already split the league's history by year, so a
 * second per-year address was navigation that answered a question the tab bar
 * had already answered.
 */
export default function PlayoffPanel({ season, bracket }: { season: string; bracket: BracketFile }) {
  const { players } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({ bracket: true, mvp: true });

  /** Every starter, ranked by MVP score. WPA is shown raw — the win
   *  probability actually measured, so the week columns add up to the total —
   *  and the award's two adjustments (round weight, the historical scale) live
   *  in the MVP column alone. Points ride along: WPA says who won the games,
   *  points say who scored. Computed by scripts/playoff_wpa.py. */
  const perf = useMemo<Perf[]>(() => {
    if (!bracket.stars) return [];
    const w = bracket.wpa ?? {};
    const rows = Object.entries(bracket.stars).map(([pid, s]) => ({
      pid, rid: s.rid, byWeek: s.wk,
      pts: Object.values(s.wk).reduce((a, b) => a + b, 0),
      wpa: w[pid]?.tot ?? null,
      war: bracket.war?.[pid]?.war ?? null,
      mvp: w[pid]?.mvp ?? null,
      mvpp: w[pid]?.mvpp ?? null,
      wpaWeek: w[pid]?.wk ?? {},
      mvpWeek: w[pid]?.mvpwk ?? {},
    }));
    return bracket.wpa
      ? rows.sort((a, b) => (b.mvp ?? -999) - (a.mvp ?? -999))
      : rows.sort((a, b) => b.pts - a.pts);
  }, [bracket]);
  const hasWpa = !!bracket.wpa;
  const anchor = bracket.wpa_meta;

  const weeks = useMemo(
    () => [...new Set(bracket.winners.map(g => g.week))].sort((a, b) => a - b),
    [bracket]);

  /** worse seed beats better seed, ranked by seed gap then margin */
  const upsets = useMemo(() => bracket.winners
    .filter(g => g.w != null && g.l != null && !(g.p && g.p > 1))
    .map(g => {
      const sw = bracket.seeds[String(g.w)] ?? 0, sl = bracket.seeds[String(g.l)] ?? 0;
      const margin = g.t1_pts != null && g.t2_pts != null ? Math.abs(g.t1_pts - g.t2_pts) : 0;
      return { g, gap: sw - sl, margin };
    })
    .filter(u => u.gap > 0)
    .sort((a, b) => b.gap - a.gap || b.margin - a.margin), [bracket]);

  /** superlatives over the elimination games */
  const supers = useMemo(() => {
    const scored = bracket.winners.filter(
      g => g.t1_pts != null && g.t2_pts != null && !(g.p && g.p > 1));
    if (!scored.length) return null;
    const sides = scored.flatMap(g => [
      { rid: g.t1, pts: g.t1_pts as number, g }, { rid: g.t2, pts: g.t2_pts as number, g }]);
    const high = sides.reduce((a, b) => (b.pts > a.pts ? b : a));
    const withM = scored.map(g => ({ g, m: Math.abs((g.t1_pts as number) - (g.t2_pts as number)) }));
    return {
      high,
      close: withM.reduce((a, b) => (b.m < a.m ? b : a)),
      blow: withM.reduce((a, b) => (b.m > a.m ? b : a)),
    };
  }, [bracket]);

  const final = bracket.winners.find(g => g.p === 1);
  const third = bracket.winners.find(g => g.p === 3);
  const nameOf = (rid: number | null | undefined) =>
    rid == null ? "—" : bracket.names[String(rid)] ?? `Roster ${rid}`;
  const seedOf = (rid: number | null | undefined) =>
    rid == null ? null : bracket.seeds[String(rid)] ?? null;
  const mvp = perf[0];

  const secBand = (id: string, label: string, note: string) => (
    <button type="button" className="band dband" aria-expanded={!!openSec[id]}
      style={{ marginTop: 22 }}
      onClick={() => setOpenSec(s => ({ ...s, [id]: !s[id] }))}>
      <span className="band-label">
        <span className="caret" style={{ color: openSec[id] ? "var(--acc)" : "var(--dim)" }}>
          {openSec[id] ? "▾" : "▸"}
        </span>
        {label}
      </span>
      <span className="band-note">{note}</span>
    </button>
  );

  const gameCard = (g: BracketGame, caption: string) => (
    <div className="bgame tap" style={{ maxWidth: 420 }}
      title={`Open the week ${g.week} matchup`}
      onClick={() => g.t1 != null && nav(lp(`/weekly/${season}/${g.week}/${g.t1}`))}>
      <div className="bgame-head"><span>{caption}</span><span>WK {g.week}</span></div>
      {[[g.t1, g.t1_pts] as const, [g.t2, g.t2_pts] as const].map(([rid, pts], i) => (
        <div key={i} className={`bside ${rid != null && g.w === rid ? "won" : ""}`}>
          <span className="seed">{seedOf(rid) ?? "—"}</span>
          <span className="team">{nameOf(rid)}</span>
          <span className="pts">{pts == null ? "—" : fmt(pts, 2)}</span>
        </div>
      ))}
    </div>
  );

  /** A compact WPA leaderboard, half-width so the two ends sit side by side.
   *  Raw win probability only — no win share, no award: this pair answers
   *  "who swung the games", and swinging them is signed. */
  const wpaTable = (rows: Perf[]) => (
    <table>
      <thead><tr>
        <th className="t" style={{ width: "7%" }}>Rk</th>
        <th className="t" style={{ width: "38%" }}>Player</th>
        {weeks.map(w => (
          <th key={w} className="n" style={{ width: `${(39 / weeks.length).toFixed(1)}%` }}>
            WK {w}
          </th>
        ))}
        <th className="n key" style={{ width: "16%" }}>WPA</th>
      </tr></thead>
      <tbody>
        {rows.map((p, i) => {
          const [nm, pos] = pInfo(players, p.pid);
          return (
            <tr key={p.pid}>
              <td className="t" style={{ font: "600 15px/1 var(--cond)", color: "var(--txt2)" }}>
                {i + 1}
              </td>
              <td className="who">
                <div className="line">
                  <span className="pos mini" style={{ background: POS_COLOR[pos] || "var(--rule)" }}>{pos}</span>
                  <span className="nm">{nm}</span>
                </div>
                <div className="by">{nameOf(p.rid)}</div>
              </td>
              {weeks.map(w => {
                const v = p.wpaWeek[String(w)];
                const started = p.byWeek[String(w)] != null;
                return (
                  // `fig`, not `sub`: sub carries text-overflow:ellipsis, which
                  // clipped these to "+0…" in a half-width table
                  <td key={w} className="fig quiet n">
                    {v == null ? (started ? "·" : "—") : wsgn(v)}
                  </td>
                );
              })}
              <td className="n vs" style={{
                color: (p.wpa ?? 0) > 0.005 ? "var(--good)"
                  : (p.wpa ?? 0) < -0.005 ? "var(--bad)" : "var(--dim)",
                font: "700 17px/1 var(--cond)",
              }}>
                {p.wpa == null ? "—" : wsgn(p.wpa)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  /** The award table. Ranked by MVP score, which is the round-weighted win
   *  share on the all-time scale; win share rides alongside in its own units
   *  so the reader can see what the score was built from. */
  const mvpTable = (rows: Perf[]) => (
    <table>
      <thead>
        <tr className="grp">
          <th colSpan={4}></th>
          <th colSpan={weeks.length} className="edge">MVP points by week</th>
          <th className="edge">Production</th>
          <th colSpan={2} className="edge acc">Award</th>
        </tr>
        <tr>
          <th className="t" style={{ width: "6%" }}>Rk</th>
          <th className="t" style={{ width: "27%" }}>Player</th>
          <th className="c" style={{ width: "7%" }}>Pos</th>
          <th className="t" style={{ width: "21%" }}>For</th>
          {weeks.map(w => (
            <th key={w} className="n" style={{ width: "9%" }}>WK {w}</th>
          ))}
          <th className="n" style={{ width: "9%" }}>WAR</th>
          <th className="n key" style={{ width: "10%" }}>MVP</th>
          <th className="n" style={{ width: "10%" }}>MVP+</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p, i) => {
          const [nm, pos] = pInfo(players, p.pid);
          return (
            <tr key={p.pid} className={i % 2 ? "zebra" : ""}>
              <td className="rank">
                <span className="spine" style={{
                  background: i === 0 ? "var(--acc)" : POS_COLOR[pos] || "#2b3642",
                }} />
                <span className="fig">{i + 1}</span>
              </td>
              <td className="name">
                <PlayerLink pid={p.pid} name={nm} />
                {i === 0 && <span className="name-note" style={{ color: "var(--acc)" }}>MVP</span>}
              </td>
              <td className="c"><span className={`pos ${pos}`}>{pos}</span></td>
              <td className="sub">{nameOf(p.rid)}</td>
              {weeks.map(w => {
                // MVP points — the weighted win share on the award scale.
                // They add up to the MVP column, which IS their sum.
                const v = p.mvpWeek[String(w)];
                const started = p.byWeek[String(w)] != null;
                return (
                  <td key={w} className="fig n">
                    {v == null ? <span className="quiet">{started ? "·" : "—"}</span>
                      : v === 0 ? <span className="quiet">0.0</span>
                        : fmt(v, 1)}
                  </td>
                );
              })}
              {/* production, not the award: this one counts in a loss too */}
              <td className="fig n">
                {p.war == null ? <span className="quiet">—</span> : wsgn2(p.war)}
              </td>
              <td className="fig n key">
                <b style={{ color: i === 0 ? "var(--acc)" : undefined }}>
                  {p.mvp == null ? "—" : fmt(p.mvp, 1)}
                </b>
              </td>
              {/* the across-year index: above 100 beat a typical winner */}
              <td className="fig n">
                {p.mvpp == null ? <span className="quiet">—</span>
                  : <span style={{ color: p.mvpp >= 100 ? "var(--good)" : undefined }}>
                    {fmt(p.mvpp, 0)}
                  </span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const N = 10;
  // `perf` arrives sorted by MVP, which is what the award table wants. The
  // WPA pair is a different question and must be ranked by WPA itself —
  // ordering a win-probability table by the award would print a column that
  // doesn't monotonically decrease, which reads as a bug.
  const ranked = perf.filter(p => p.mvp != null);
  const byWpa = ranked.slice().sort((a, b) => (b.wpa ?? 0) - (a.wpa ?? 0));
  const top = byWpa.slice(0, N);
  // The other end: only players who actually cost their team, worst first.
  // (Win share can't do this job — a loss pays 0.0, it never charges you.)
  const bottom = byWpa.filter(p => (p.wpa ?? 0) < 0).reverse().slice(0, N);

  return (
    <>
      {/* the year in four figures */}
      <div className="figstrip">
        {[
          ["CHAMPION", nameOf(final?.w), `seed ${seedOf(final?.w) ?? "—"}`],
          ["RUNNER-UP", nameOf(final?.l), `seed ${seedOf(final?.l) ?? "—"}`],
          ["THIRD", nameOf(third?.w), `seed ${seedOf(third?.w) ?? "—"}`],
          ["PLAYOFF MVP", mvp ? pInfo(players, mvp.pid)[0] : "—",
            !mvp ? "no scored weeks"
              : mvp.mvp != null
                ? `${fmt(mvp.mvp, 1)} MVP · ${wsgn(mvp.wpa ?? 0)} WPA · ${nameOf(mvp.rid)}`
                : `${fmt(mvp.pts, 1)} pts · ${nameOf(mvp.rid)}`],
        ].map(([k, v, sub]) => (
          <div key={k} className="figcell">
            <div className="figkey">{k}</div>
            <div className="figval" style={{ fontSize: 21, ...(k === "CHAMPION" ? { color: "var(--acc)" } : {}) }}>{v}</div>
            <div className="figsub">{sub}</div>
          </div>
        ))}
      </div>

      {/* (a) the bracket */}
      {secBand("bracket", "Bracket", "click a game for the full matchup")}
      {openSec.bracket && <PlayoffBracket season={season} bracket={bracket} />}

      {/* (b) who swung the games — the two ends of raw WPA, side by side */}
      {secBand("mvp", "Who won it — and who cost it",
        hasWpa ? "raw win probability added, per matchup"
          : "fantasy points across the playoff weeks, credited while starting")}
      {openSec.mvp && (!perf.length ? (
        <div className="empty">No scored playoff weeks yet.</div>
      ) : !hasWpa ? mvpTable(perf.slice(0, N)) : <>
        <div className="pick-tables wpa">
          <div>
            <div className="pick-title best">Won it for them</div>
            {wpaTable(top)}
          </div>
          <div>
            <div className="pick-title worst">Cost them</div>
            {bottom.length ? wpaTable(bottom)
              : <div className="empty">Nobody finished with negative WPA.</div>}
          </div>
        </div>
        <div className="tnote" style={{ padding: "0 var(--pad) 8px", marginTop: 0 }}>
          WPA is how much win probability a start swung, allocated by Shapley value so each
          game’s swing is fully accounted for — which is why the two tables mirror: one
          team’s gain is the other’s loss. Signed, and unweighted: this is the measured
          quantity, not the award. A dot marks a week he started only in a placement game.
        </div>
      </>)}

      {/* (b2) the award, on its own — round-weighted win share */}
      {hasWpa && secBand("award", "Playoff MVP",
        "round-weighted win share, on the all-time scale")}
      {hasWpa && openSec.award && (
        <>
          {mvpTable(ranked.slice(0, N))}
          <div className="tnote" style={{ padding: "10px var(--pad) 0", marginTop: 0 }}>
Every elimination game hands out exactly 1.0 win to the side that won it, split
            half by leverage and half by production — so a blowout pays the same as a
            nail-biter, which WPA alone can’t do, since a game never in doubt has almost no
            probability left to hand out even though those players are the reason it wasn’t in
            doubt. Each game’s share is then weighted by round: the final counts double a
            quarterfinal and half again a semifinal, so a bye can’t cost the top seeds the
            award. That total is shown on two scales. <b>MVP</b> is within this season — 100 is
            {anchor?.season_anchor_name ? ` ${anchor.season_anchor_name}` : " the year's best run"},
            so the week columns are points out of a shared 100 and add up to it. <b>MVP+</b> is
            across seasons, like OPS+: 100 is the average MVP-winning run
            {anchor?.mvp_avg_seasons?.length ? ` over ${anchor.mvp_avg_seasons.length} postseasons` : ""},
            so above 100 beat a typical champion’s best player and below it was a thin year.{" "}
            <b>WAR</b> is the one figure here that doesn’t care who won: points above what a
            replacement-level player at the same position scored that week, converted to wins.
            A big game in a loss earns WAR and nothing else — which is the whole reason it’s
            on the page. Its points-per-win rate is imported from the regular season, because
            the consolation bracket’s unset lineups inflate the playoff-week spread and would
            quietly discount every performance.
          </div>
        </>
      )}

      {/* (c) biggest upset */}
      {secBand("upset", "Biggest upset",
        upsets.length ? `${upsets.length} games went to the worse seed` : "chalk all the way")}
      {openSec.upset && (upsets.length ? (
        <div className="card-row">
          {upsets.slice(0, 3).map((u, i) => (
            <div key={i}>{gameCard(u.g, `Seed ${seedOf(u.g.w)} over seed ${seedOf(u.g.l)}`)}</div>
          ))}
        </div>
      ) : (
        <div className="empty">Every game went to the better seed.</div>
      ))}

      {/* (d) superlatives */}
      {secBand("extras", "Superlatives", "highest score, closest game, biggest blowout")}
      {openSec.extras && supers && (
        <div className="card-row">
          <div>{gameCard(supers.high.g, `Highest — ${fmt(supers.high.pts, 2)} by ${nameOf(supers.high.rid)}`)}</div>
          <div>{gameCard(supers.close.g, `Closest — by ${fmt(supers.close.m, 2)}`)}</div>
          <div>{gameCard(supers.blow.g, `Biggest blowout — by ${fmt(supers.blow.m, 2)}`)}</div>
        </div>
      )}

      <div className="footnote">
        MVP is the biggest round-weighted win-probability swing, not the most points: WAR
        doesn't extend to the postseason — it needs a replacement baseline and fungible wins,
        and weeks {weeks[0]}–{weeks[weeks.length - 1]} have neither once half the league stops
        setting lineups — so each game is modelled on its own, every starter priced off his
        regular-season form and credited by Shapley value · elimination games only, placement
        games excluded · upsets rank by the pregame win probability of the side that won, not
        by seed — a seed is a regular-season finish and says nothing about the two rosters that
        actually took the field · seeds shown are regular-season, wins then points
      </div>
    </>
  );
}
