import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { BracketFile, BracketGame } from "../lib/types";
import { jl } from "../lib/data";
import { fmt } from "../lib/stats";
import { pInfo, POS_COLOR } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import PlayoffBracket from "../components/PlayoffBracket";
import { PlayerLink } from "../components/PlayerLink";

interface Perf {
  pid: string; rid: number; pts: number;
  /** round-weighted WPA — what ranks MVP; null before the engine has run */
  wpa: number | null; rawWpa: number | null;
  byWeek: Record<string, number>;
  wpaWeek: Record<string, number>;
}

const wsgn = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), 3);

/**
 * One postseason as its own page: the bracket, the MVP and top performers,
 * the biggest upset, and the superlatives. Reached from the Season tab's
 * Playoffs chip — the season owns the axis, this page owns the detail.
 */
export default function PlayoffDetail() {
  const season = useParams().season ?? "";
  const { players } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [bracket, setBracket] = useState<BracketFile | null>(null);
  const [err, setErr] = useState(false);
  const [openSec, setOpenSec] = useState<Record<string, boolean>>({ bracket: true, mvp: true });

  useEffect(() => {
    jl<BracketFile>(`${season}/bracket.json`).then(setBracket).catch(() => setErr(true));
  }, [season]);

  /** Every starter, ranked by round-weighted WPA — win probability added,
   *  computed per matchup by scripts/playoff_wpa.py. Points ride along as the
   *  secondary column: WPA says who won the games, points say who scored.
   *  Falls back to points-order for a season built before the engine ran. */
  const perf = useMemo<Perf[]>(() => {
    if (!bracket?.stars) return [];
    const w = bracket.wpa ?? {};
    const rows = Object.entries(bracket.stars).map(([pid, s]) => ({
      pid, rid: s.rid, byWeek: s.wk,
      pts: Object.values(s.wk).reduce((a, b) => a + b, 0),
      wpa: w[pid]?.wtot ?? null,
      rawWpa: w[pid]?.tot ?? null,
      wpaWeek: w[pid]?.wk ?? {},
    }));
    return bracket.wpa
      ? rows.sort((a, b) => (b.wpa ?? -99) - (a.wpa ?? -99))
      : rows.sort((a, b) => b.pts - a.pts);
  }, [bracket]);
  const hasWpa = !!bracket?.wpa;

  const weeks = useMemo(
    () => bracket ? [...new Set(bracket.winners.map(g => g.week))].sort((a, b) => a - b) : [],
    [bracket]);

  /** worse seed beats better seed, ranked by seed gap then margin */
  const upsets = useMemo(() => {
    if (!bracket) return [];
    return bracket.winners
      .filter(g => g.w != null && g.l != null)
      .map(g => {
        const sw = bracket.seeds[String(g.w)] ?? 0, sl = bracket.seeds[String(g.l)] ?? 0;
        const margin = g.t1_pts != null && g.t2_pts != null ? Math.abs(g.t1_pts - g.t2_pts) : 0;
        return { g, gap: sw - sl, margin };
      })
      .filter(u => u.gap > 0)
      .sort((a, b) => b.gap - a.gap || b.margin - a.margin);
  }, [bracket]);

  const finals = bracket?.winners.find(g => g.p === 1);
  const third = bracket?.winners.find(g => g.p === 3);
  const nameOf = (rid: number | null | undefined) =>
    rid == null ? "—" : bracket?.names[String(rid)] ?? `Roster ${rid}`;
  const seedOf = (rid: number | null | undefined) =>
    rid == null ? null : bracket?.seeds[String(rid)] ?? null;
  const mvp = perf[0];

  /** superlatives over the winners-bracket games */
  const supers = useMemo(() => {
    if (!bracket) return null;
    const scored = bracket.winners.filter(g => g.t1_pts != null && g.t2_pts != null);
    if (!scored.length) return null;
    const sides = scored.flatMap(g => [
      { rid: g.t1, pts: g.t1_pts as number, g }, { rid: g.t2, pts: g.t2_pts as number, g }]);
    const high = sides.reduce((a, b) => (b.pts > a.pts ? b : a));
    const withM = scored.map(g => ({ g, m: Math.abs((g.t1_pts as number) - (g.t2_pts as number)) }));
    const close = withM.reduce((a, b) => (b.m < a.m ? b : a));
    const blow = withM.reduce((a, b) => (b.m > a.m ? b : a));
    return { high, close, blow };
  }, [bracket]);

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

  if (err) return <div className="empty">No bracket for {season}.</div>;
  if (!bracket) return <div className="empty">Loading playoffs…</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">{season} playoffs</span>
        <button type="button" className="chip"
          onClick={() => nav(lp(`/weekly/${season}/playoffs`))}>
          ‹ {season} season
        </button>
        <span className="screen-note">
          weeks {weeks[0]}–{weeks[weeks.length - 1]} · six teams
        </span>
      </div>

      {/* the year in four figures */}
      <div className="figstrip">
        {[
          ["CHAMPION", nameOf(finals?.w), `seed ${seedOf(finals?.w) ?? "—"}`],
          ["RUNNER-UP", nameOf(finals?.l), `seed ${seedOf(finals?.l) ?? "—"}`],
          ["THIRD", nameOf(third?.w), `seed ${seedOf(third?.w) ?? "—"}`],
          ["PLAYOFF MVP", mvp ? pInfo(players, mvp.pid)[0] : "—",
            !mvp ? "no scored weeks"
              : mvp.wpa != null ? `${wsgn(mvp.wpa)} WPA · ${nameOf(mvp.rid)}`
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

      {/* (b) MVP & top performers */}
      {secBand("mvp", "Top performers", hasWpa
        ? "win probability added, per matchup — points ride along"
        : "fantasy points across the playoff weeks, credited while starting")}
      {openSec.mvp && (perf.length ? (
        <table>
          <thead>
            <tr className="grp">
              <th colSpan={4}></th>
              <th colSpan={weeks.length} className="edge">WPA by week</th>
              <th colSpan={2} className="edge acc">Playoff total</th>
            </tr>
            <tr>
              <th className="t" style={{ width: "5%" }}>Rk</th>
              <th className="t" style={{ width: "26%" }}>Player</th>
              <th className="c" style={{ width: "6%" }}>Pos</th>
              <th className="t" style={{ width: "19%" }}>For</th>
              {weeks.map(w => (
                <th key={w} className="n" style={{ width: "9%" }}>WK {w}</th>
              ))}
              <th className="n key" style={{ width: "11%" }}>WPA</th>
              <th className="n" style={{ width: "9%" }}>Points</th>
            </tr>
          </thead>
          <tbody>
            {perf.slice(0, 10).map((p, i) => {
              const [nm, pos] = pInfo(players, p.pid);
              return (
                <tr key={p.pid} className={i % 2 ? "zebra" : ""}>
                  <td className="rank">
                    <span className="spine" style={{ background: i === 0 ? "var(--acc)" : POS_COLOR[pos] || "#2b3642" }} />
                    <span className="fig">{i + 1}</span>
                  </td>
                  <td className="name">
                    <PlayerLink pid={p.pid} name={nm} />
                    {i === 0 && <span className="name-note" style={{ color: "var(--acc)" }}>MVP</span>}
                  </td>
                  <td className="c"><span className={`pos ${pos}`}>{pos}</span></td>
                  <td className="sub">{nameOf(p.rid)}</td>
                  {weeks.map(w => {
                    const v = p.wpaWeek[String(w)];
                    const started = p.byWeek[String(w)] != null;
                    return (
                      <td key={w} className="fig n">
                        {v == null
                          // started, but in a placement game — no WPA by design
                          ? <span className="quiet">{started ? "·" : "—"}</span>
                          : <span style={{ color: v > 0.005 ? "var(--good)" : v < -0.005 ? "var(--bad)" : "var(--dim)" }}>
                            {wsgn(v)}
                          </span>}
                      </td>
                    );
                  })}
                  <td className="fig n key">
                    <b>{p.wpa == null ? "—" : wsgn(p.wpa)}</b>
                  </td>
                  <td className="fig quiet n">{fmt(p.pts, 1)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="empty">No scored playoff weeks yet.</div>
      ))}
      {openSec.mvp && hasWpa && (
        <div className="tnote" style={{ padding: "10px var(--pad) 0", marginTop: 0 }}>
          WPA is the share of his team's win-probability swing a player caused, allocated
          by Shapley value so every game's swing is fully accounted for. Weighted by round
          — a final counts 1.5×, a semifinal 1.25× — so a bye can't cost the top seeds the
          award. A dot marks a week he started only in a placement game, which doesn't count.
        </div>
      )}

      {/* (c) biggest upset */}
      {secBand("upset", "Biggest upset",
        upsets.length ? `${upsets.length} games went to the worse seed` : "chalk all the way")}
      {openSec.upset && (upsets.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, padding: "14px var(--pad) 4px" }}>
          {upsets.slice(0, 3).map((u, i) => gameCard(u.g,
            i === 0
              ? `Seed ${seedOf(u.g.w)} over seed ${seedOf(u.g.l)}`
              : `Seed ${seedOf(u.g.w)} over seed ${seedOf(u.g.l)}`))}
        </div>
      ) : (
        <div className="empty">Every game went to the better seed.</div>
      ))}

      {/* (d) superlatives */}
      {secBand("extras", "Superlatives", "highest score, closest game, biggest blowout")}
      {openSec.extras && supers && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 18, padding: "14px var(--pad) 4px" }}>
          {gameCard(supers.high.g, `Highest score — ${fmt(supers.high.pts, 2)} by ${nameOf(supers.high.rid)}`)}
          {gameCard(supers.close.g, `Closest game — by ${fmt(supers.close.m, 2)}`)}
          {gameCard(supers.blow.g, `Biggest blowout — by ${fmt(supers.blow.m, 2)}`)}
        </div>
      )}

      <div className="footnote">
        MVP is the biggest round-weighted win-probability swing, not the most points: WAR
        doesn't extend to the postseason — it needs a replacement baseline and fungible
        wins, and weeks 15–17 have neither once half the league stops setting lineups — so
        each game is modelled on its own, every starter priced off his regular-season form
        and credited by Shapley value · elimination games only, placement games excluded ·
        upsets and superlatives read the bracket only · seeds are regular-season, wins then points
      </div>
    </>
  );
}
