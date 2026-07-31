import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { BracketFile, BracketGame } from "../lib/types";
import { fmt } from "../lib/stats";
import { pInfo, POS_COLOR } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import PlayoffBracket from "./PlayoffBracket";
import { PlayerLink } from "./PlayerLink";

const wsgn = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "") + fmt(Math.abs(v), 3);

interface Perf {
  pid: string; rid: number; pts: number;
  /** RAW win probability added — the measured quantity; weeks sum to it */
  wpa: number | null;
  /** win share, in wins: each game hands 1.0 to the winning side, so a
   *  champion's nine starters sum to 3.0 */
  ws: number | null;
  /** the derived 0-100 award scale: round-weighted, anchored historically */
  mvp: number | null;
  byWeek: Record<string, number>;
  wpaWeek: Record<string, number>;
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
      ws: w[pid]?.ws ?? null,
      mvp: w[pid]?.mvp ?? null,
      wpaWeek: w[pid]?.wk ?? {},
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
        <th className="t" style={{ width: "10%" }}>Rk</th>
        <th className="t" style={{ width: "52%" }}>Player</th>
        {weeks.map(w => (
          <th key={w} className="n" style={{ width: `${Math.floor(26 / weeks.length)}%` }}>
            WK {w}
          </th>
        ))}
        <th className="n key" style={{ width: "12%" }}>WPA</th>
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
                  <td key={w} className="n sub">
                    {v == null ? <span className="quiet">{started ? "·" : "—"}</span> : wsgn(v)}
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
          <th colSpan={3} className="edge acc">Wins created</th>
        </tr>
        <tr>
          <th className="t" style={{ width: "6%" }}>Rk</th>
          <th className="t" style={{ width: "30%" }}>Player</th>
          <th className="c" style={{ width: "7%" }}>Pos</th>
          <th className="t" style={{ width: "23%" }}>For</th>
          <th className="n" style={{ width: "11%" }}>Win share</th>
          <th className="n" style={{ width: "11%" }}>Points</th>
          <th className="n key" style={{ width: "12%" }}>MVP</th>
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
              <td className="fig n">{p.ws == null ? <span className="quiet">—</span> : fmt(p.ws, 2)}</td>
              <td className="fig quiet n">{fmt(p.pts, 1)}</td>
              <td className="fig n key">
                <b style={{ color: i === 0 ? "var(--acc)" : undefined }}>
                  {p.mvp == null ? "—" : fmt(p.mvp, 1)}
                </b>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  const N = 10;
  const ranked = perf.filter(p => p.mvp != null);
  const top = ranked.slice(0, N);
  // The bottom table ranks by RAW WPA, not by MVP. Win share is never
  // negative — a loss pays 0.0, it doesn't charge you — so ranking the bottom
  // by the award would just list ties at zero. Signed WPA is where a bust
  // actually shows up: he made his team less likely to win.
  const bottom = ranked
    .filter(p => (p.wpa ?? 0) < 0)
    .slice().sort((a, b) => (a.wpa ?? 0) - (b.wpa ?? 0))
    .slice(0, N);

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
                ? `${fmt(mvp.ws ?? 0, 2)} of the wins · ${fmt(mvp.mvp, 1)} MVP · ${nameOf(mvp.rid)}`
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
        <div className="pick-tables">
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
            <b>Win share</b> is in wins: every elimination game hands out exactly 1.0 to the
            side that won it, split by contribution, so a champion’s nine starters sum to
            3.0. It pays a blowout the same as a nail-biter — which WPA can’t, since a
            game never in doubt has almost no probability left to hand out, even though those
            players are the reason it wasn’t in doubt. <b>MVP</b> weights that by round —
            the final counts double a quarterfinal and half again a semifinal, so a bye can’t
            cost the top seeds it — then rescales so 100 is the best postseason on record
            {anchor?.anchor_name && anchor.anchor_season
              ? `: ${anchor.anchor_name}, ${anchor.anchor_season}` : ""}.
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
        games excluded · seeds are regular-season, wins then points
      </div>
    </>
  );
}
