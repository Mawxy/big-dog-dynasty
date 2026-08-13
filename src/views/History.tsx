import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  Drafts, Franchises, Matchups, Trade, TradesPayload, Weekly,
} from "../lib/types";
import { jl } from "../lib/data";
import { useJson } from "../lib/useJson";
import { fmt, fmtWar, ord, rate } from "../lib/stats";
import { pInfo } from "../lib/league";
import { useLeague, useLeaguePath } from "../lib/context";
import { readTrades } from "../lib/trades";
import { PlayerLink } from "../components/PlayerLink";
import { RouteLink } from "../components/RouteLink";
import DataTable, { type Col, type Grp } from "../components/DataTable";

/**
 * League summary — the year-by-year story.
 *
 * Off the tab bar, reached from the League dashboard. Every figure on this page
 * is computed from published data at read time; nothing is transcribed. The one
 * exception is LEAGUE_NOTES below, which carries facts the Sleeper record cannot
 * hold — a manager being removed mid-season is invisible in the API, which only
 * ever reports whoever holds the franchise now.
 *
 * "Homegrown share" is the fraction of a team's regular-season starter WAR that
 * came from players that team drafted itself, crediting each week's WAR to the
 * roster that actually STARTED the player that week. A midseason acquisition
 * therefore counts only from the day he arrived, which is the whole point of the
 * figure: it separates a champion who drafted his roster from one who bought it.
 */

/** Off-record league history, keyed by season. Sleeper reports only the current
 *  holder of a franchise, so ownership changes have to be written down. */
const LEAGUE_NOTES: Record<string, string[]> = {
  "2022": [
    "Mooner was removed from the league in year one; Greenbean218 took over the franchise and has held it since.",
  ],
  "2023": [
    "PicklesPapa was removed in year two; Dchaillier10 inherited the roster and still runs it.",
  ],
};
// Craftzz -> taird is the same person under a new display name, not a change of
// hands. The manager column therefore reads "Craftzz" through 2024 and "taird"
// from 2025 for one continuous franchise; that is Sleeper's record, not an error.

type SeasonRow = {
  rid: number; name: string; manager: string;
  wins: number; losses: number; ties: number;
  ppg: number; war: number; finish: number; seed: number | null;
  prev: number | null;                 // previous season's finish
  topPid: string | null; topWar: number | null;
};

/** the standings board needs no per-render context; a shared constant rather
 *  than a `{}` literal, which would be a new object on every render and defeat
 *  DataTable's row memoization */
const NO_CTX: Record<string, never> = {};
/** The table is the season's settled result, ordered by finish, and no column
 *  declares a `sort` accessor — so no header is a control and the order cannot
 *  be taken away from the placing the spine marks. DataTable still takes the
 *  three sort props, so they are handed in inert. */
const NO_SORT = () => {};

/** Record, PPG and lineup WAR are the season; Prev and Move are the same
 *  franchise a year earlier. Both bands carry the divider their first column
 *  already drew; neither takes the accent, because nothing in this table is the
 *  screen's headline figure — the champion block above it is. */
const HIST_GROUPS: Grp[] = [
  { id: 0, label: "", cls: "" },
  { id: 1, label: "Results", cls: "edge" },
  { id: 2, label: "Last season", cls: "edge" },
];

type SeasonStory = {
  season: string;
  rows: SeasonRow[];                   // ordered by finish
  champ: SeasonRow;
  runnerUp: SeasonRow | null;
  bestRecord: SeasonRow;
  riser: SeasonRow | null;             // biggest climb into this season
  faller: SeasonRow | null;
  trades: number;
  picksMoved: number;
  homegrown: number | null;            // champion's own-draft share, 0..1
  champStarterWar: number | null;
  champBought: { pid: string; war: number; from: string }[];
};

export default function History() {
  const { meta, players, league } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const [play, setPlay] = useState<Record<string, { m: Matchups; w: Weekly }> | null>(null);

  const frFile = useJson<Franchises>("franchises.json");
  const fr = frFile.data;
  const err = frFile.error;
  // both are tolerated absences — the story just loses that column
  const drafts = useJson<Drafts>("drafts.json").data;
  const tradesFile = useJson<TradesPayload>("trades.json");
  const trades = useMemo<Trade[] | null>(
    () => (tradesFile.data ? readTrades(tradesFile.data).trades
      : tradesFile.error ? [] : null),
    [tradesFile.data, tradesFile.error]);

  /** seasons that have actually been played out (a finish exists) */
  const played = useMemo(() => {
    if (!fr) return [];
    const s = new Set<string>();
    for (const f of Object.values(fr))
      for (const sn of f.seasons) if (sn.finish) s.add(sn.season);
    return [...s].sort();
  }, [fr]);

  /** starters + weekly WAR, only for seasons that were played */
  useEffect(() => {
    if (!played.length) return;
    let live = true;
    Promise.all(played.map(s => Promise.all([
      jl<Matchups>(`${s}/matchups.json`),
      jl<Weekly>(`${s}/weekly.json`),
    ]).then(([m, w]) => [s, { m, w }] as const).catch(() => null)))
      .then(pairs => {
        if (!live) return;
        const out: Record<string, { m: Matchups; w: Weekly }> = {};
        for (const p of pairs) if (p) out[p[0]] = p[1];
        setPlay(out);
      });
    return () => { live = false; };
  }, [played, league]);

  /** pid -> roster_id that actually made the pick (drafted_by overrides the
   *  original slot owner, which is what drafts.json is keyed by) */
  const draftedBy = useMemo(() => {
    const m = new Map<string, number>();
    if (!drafts) return m;
    for (const [orig, list] of Object.entries(drafts))
      for (const p of list)
        if (p.pid) m.set(p.pid, p.drafted_by ?? +orig);
    return m;
  }, [drafts]);

  /**
   * Regular-season WAR credited to the roster that started the player, by
   * season. Playoff weeks are excluded so this matches every other WAR figure
   * on the board.
   */
  const credited = useMemo(() => {
    const out = new Map<string, Map<number, Map<string, number>>>();
    if (!play) return out;
    for (const [season, { m, w }] of Object.entries(play)) {
      const wk = new Map<string, Map<number, number>>();
      for (const [pid, rows] of Object.entries(w)) {
        const byWeek = new Map<number, number>();
        for (const r of rows) byWeek.set(r[0], r[5]);
        wk.set(pid, byWeek);
      }
      const byRid = new Map<number, Map<string, number>>();
      for (const [ridS, entries] of Object.entries(m.teams)) {
        const rid = +ridS;
        const acc = new Map<string, number>();
        for (const e of entries) {
          const [week, , , , starters] = e;
          if (week >= m.playoff_start) continue;
          for (const pid of starters ?? []) {
            const v = wk.get(pid)?.get(week);
            if (v) acc.set(pid, (acc.get(pid) ?? 0) + v);
          }
        }
        byRid.set(rid, acc);
      }
      out.set(season, byRid);
    }
    return out;
  }, [play]);

  const stories: SeasonStory[] = useMemo(() => {
    if (!fr || !played.length) return [];
    const nameOf = (rid: number, season: string) => {
      const f = fr[String(rid)];
      const sn = f?.seasons.find(s => s.season === season) ?? f?.seasons[f.seasons.length - 1];
      return { name: sn?.name ?? `Roster ${rid}`, manager: sn?.manager ?? "" };
    };
    return played.map((season, si) => {
      const prevSeason = si ? played[si - 1] : null;
      const rows: SeasonRow[] = [];
      for (const [ridS, f] of Object.entries(fr)) {
        const sn = f.seasons.find(s => s.season === season);
        if (!sn?.finish) continue;
        const pv = prevSeason
          ? f.seasons.find(s => s.season === prevSeason)?.finish ?? null : null;
        rows.push({
          rid: +ridS, name: sn.name, manager: sn.manager,
          wins: sn.wins, losses: sn.losses, ties: sn.ties,
          ppg: sn.ppg, war: sn.war, finish: sn.finish, seed: sn.seed ?? null,
          prev: pv ?? null,
          topPid: sn.top?.pid ?? null, topWar: sn.top?.war ?? null,
        });
      }
      rows.sort((a, b) => a.finish - b.finish);
      const moves = rows.filter(r => r.prev != null);
      const riser = moves.length
        ? moves.reduce((a, b) => (b.prev! - b.finish) > (a.prev! - a.finish) ? b : a) : null;
      const faller = moves.length
        ? moves.reduce((a, b) => (b.prev! - b.finish) < (a.prev! - a.finish) ? b : a) : null;
      const seasonTrades = (trades ?? []).filter(t => t.season === season);
      const picksMoved = seasonTrades.reduce((a, t) =>
        a + t.sides.reduce((b, s) => b + s.got.filter(g => g.kind === "pick").length, 0), 0);

      const champ = rows[0];
      const acc = credited.get(season)?.get(champ.rid) ?? null;
      let homegrown: number | null = null, champStarterWar: number | null = null;
      const bought: { pid: string; war: number; from: string }[] = [];
      if (acc && acc.size) {
        let tot = 0, own = 0;
        for (const [pid, v] of acc) {
          tot += v;
          if (draftedBy.get(pid) === champ.rid) own += v;
        }
        if (tot > 0) { homegrown = own / tot; champStarterWar = tot; }
        for (const [pid, v] of [...acc].sort((a, b) => b[1] - a[1])) {
          const by = draftedBy.get(pid);
          if (by != null && by !== champ.rid && v > 0)
            bought.push({ pid, war: v, from: nameOf(by, season).manager });
          if (bought.length >= 4) break;
        }
      }
      return {
        season, rows, champ,
        runnerUp: rows[1] ?? null,
        bestRecord: rows.slice().sort((a, b) =>
          (b.wins - b.losses) - (a.wins - a.losses) || b.ppg - a.ppg)[0],
        riser: riser && riser.prev! - riser.finish > 0 ? riser : null,
        faller: faller && faller.prev! - faller.finish < 0 ? faller : null,
        trades: seasonTrades.length,
        picksMoved,
        homegrown, champStarterWar, champBought: bought,
      };
    });
  }, [fr, played, trades, credited, draftedBy]);

  /** league-wide headline figures */
  const totals = useMemo(() => {
    const t = trades ?? [];
    const withPicks = t.filter(x => x.sides.some(s => s.got.some(g => g.kind === "pick")));
    const picks = t.reduce((a, x) =>
      a + x.sides.reduce((b, s) => b + s.got.filter(g => g.kind === "pick").length, 0), 0);
    const titles = new Map<string, number>();
    for (const s of stories) titles.set(s.champ.manager, (titles.get(s.champ.manager) ?? 0) + 1);
    const repeat = [...titles.entries()].filter(([, n]) => n > 1);
    return {
      seasons: stories.length, trades: t.length, withPicks: withPicks.length, picks,
      champions: titles.size, repeat,
    };
  }, [trades, stories]);

  /**
   * One registry, drawn once for every season's table below.
   *
   * Records mode (MOBILE.md M5) is what this board was missing: at ≤640px the
   * `hm` class hid the manager and left the rest of an eight-column table to be
   * squeezed into a phone. The roles say what each column becomes on the
   * two-line record — the placing is the spine, the franchise the identity, the
   * record the headline figure, and PPG, WAR and the move are the micros. Prev
   * has no role and drops: the move already states it, and the full ladder is
   * on the franchise page.
   */
  const cols = useMemo<Col<SeasonRow, Record<string, never>>[]>(() => [
    {
      id: "fin", label: "Fin", grp: 0, w: 6, align: "c", td: "spine-cell", role: "spine",
      cell: (r, _x, i) => <>
        <span className="spine" style={{ background: i < 4 ? "var(--acc)" : "var(--rule-2)" }} />
        <span className={`rank${i ? "" : " top"}`}>{r.finish}</span>
      </>,
    },
    {
      // the row opens the franchise on click; the name is the anchor that gets
      // a keyboard there and opens in a new tab. The champion's gold moves from
      // the cell to the anchor inside it — DataTable owns the <td>, and
      // `.blocklink` takes its own ink, so the painted text is unchanged.
      id: "team", label: "Franchise", grp: 0, w: 26, align: "t", td: "t name",
      role: "identity",
      cell: (r, _x, i) => (
        <RouteLink to={lp(`/franchise/${r.rid}`)} className="blocklink"
          style={i ? undefined : { color: "var(--acc)" }}>
          {r.name}
        </RouteLink>
      ),
    },
    {
      // NOT flagged `hm`: a column that is loses its place on the record
      // entirely, and the manager is the identity block's sub-line there. The
      // class stays on the cell, which is all the desktop table ever used it
      // for — below 640px this board is records, not a squeezed table.
      id: "manager", label: "Manager", grp: 0, w: 14, align: "t", td: "t sub hm",
      role: "sub", cell: r => r.manager,
    },
    {
      id: "rec", label: "Record", grp: 1, w: 12, align: "n", edge: true, td: "n fig edge",
      role: "headline", microKey: "Rec",
      cell: r => `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`,
    },
    {
      id: "ppg", label: "PPG", grp: 1, w: 11, align: "n", td: "n fig",
      role: "micro", microKey: "PPG", cell: r => fmt(r.ppg, 1),
    },
    {
      id: "war", label: "Lineup WAR", grp: 1, w: 12, align: "n", td: "n fig",
      role: "micro", microKey: "WAR", cell: r => fmtWar(r.war),
    },
    {
      id: "prev", label: "Prev", grp: 2, w: 9, align: "n", edge: true, td: "n fig edge",
      cell: r => <span style={{ color: "var(--dim)" }}>{r.prev == null ? "—" : r.prev}</span>,
    },
    {
      id: "move", label: "Move", grp: 2, w: 10, align: "n", td: "n fig strong",
      role: "micro", microKey: "Move",
      cell: r => {
        const mv = r.prev == null ? null : r.prev - r.finish;
        return (
          <span style={{
            color: mv == null ? "var(--dim3)"
              : mv > 0 ? "var(--good)" : mv < 0 ? "var(--bad)" : "var(--dim)",
          }}>
            {mv == null ? "—" : mv === 0 ? "0" : `${mv > 0 ? "+" : "−"}${Math.abs(mv)}`}
          </span>
        );
      },
    },
  ], [lp]);

  if (err) return <div className="empty">No league history yet.</div>;
  // trades gate the story too: it counts them per season, and painting before
  // they land would show every year as having had none
  if (!fr || !trades || !stories.length) return <div className="empty">Loading league history…</div>;

  return (
    <>
      <div className="screen-head">
        <span className="screen-title">League summary</span>
        <span style={{ font: "400 14px/1 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--dim)" }}>
          {played[0]}–{played[played.length - 1]} · {totals.seasons} completed seasons
        </span>
        <button type="button" className="dlink" onClick={() => nav(lp("/"))}>Dashboard</button>
      </div>

      <div className="band">
        <span className="band-label">The story so far</span>
        <span className="band-note">
          Every figure computed from the league's own record · WAR is regular season only,
          credited to the roster that started the player that week
        </span>
      </div>

      <div className="stat-row" style={{ padding: "16px var(--pad) 18px" }}>
        <div>
          <div className="stat-k">Seasons</div>
          <div className="stat-v">{totals.seasons}</div>
        </div>
        <div>
          <div className="stat-k">Champions</div>
          <div className="stat-v acc">{totals.champions}</div>
        </div>
        <div>
          <div className="stat-k">Trades</div>
          <div className="stat-v">{totals.trades}</div>
        </div>
        <div>
          <div className="stat-k">Involving picks</div>
          <div className="stat-v">
            {totals.trades ? Math.round(totals.withPicks / totals.trades * 100) : 0}%
          </div>
        </div>
        <div>
          <div className="stat-k">Pick assets moved</div>
          <div className="stat-v">{totals.picks}</div>
        </div>
      </div>
      <div className="tnote screen">
        {totals.repeat.length
          ? `${totals.repeat.map(([m, n]) => `${m} has ${n}`).join(", ")} of the ${totals.seasons} titles; every other champion has one.`
          : "No franchise has won twice."}
        {" "}This league does not trade players so much as it trades picks — {totals.withPicks} of
        {" "}{totals.trades} deals moved draft capital.
      </div>

      {stories.map((s, i) => {
        const climb = s.riser ? s.riser.prev! - s.riser.finish : 0;
        const drop = s.faller ? s.faller.finish - s.faller.prev! : 0;
        return (
          <div key={s.season}>
            <div className="band" style={{ marginTop: i ? 26 : 8 }}>
              <span className="band-label">{s.season} · {ord(i + 1)} season</span>
              <span className="band-note">
                {s.champ.name} took the title · {s.trades} trades, {s.picksMoved} pick assets moved
              </span>
              <button type="button" className="dlink"
                onClick={() => nav(lp(`/weekly/${s.season}/playoffs`))}>
                Bracket
              </button>
            </div>

            {/* the year's verdict — prose over the figures beside it. `.feeds`
                is the sheet's own two-panel row (auto-fit, 320px floor, 18px
                gutter), the same pattern the League page and Insights pair
                their modules with; the magic number lived inline here. */}
            <div className="feeds" style={{ padding: "16px var(--pad) 4px" }}>
              <div className="panel" style={{ margin: 0, borderLeft: "3px solid var(--acc)" }}>
                <div className="chart-label" style={{ color: "var(--acc)" }}>Champion</div>
                {/* an anchor, not a div with a handler: the champion's name is
                    the panel's one navigation and has to be keyboard-reachable */}
                <RouteLink to={lp(`/franchise/${s.champ.rid}`)} className="blocklink"
                  style={{ font: "700 34px/1.05 var(--cond)", letterSpacing: ".02em", textTransform: "uppercase" }}>
                  {s.champ.name}
                </RouteLink>
                <div style={{ font: "400 14px/1.4 var(--cond)", letterSpacing: ".1em", textTransform: "uppercase", color: "var(--dim)", marginTop: 5 }}>
                  {s.champ.manager} · {s.champ.wins}-{s.champ.losses}
                  {s.champ.ties ? `-${s.champ.ties}` : ""} · {fmt(s.champ.ppg, 1)} ppg
                  {s.champ.seed ? ` · ${ord(s.champ.seed)} seed` : ""}
                </div>
                <div style={{ display: "flex", marginTop: 14 }}>
                  <div className="figcell">
                    <div className="figkey">Lineup WAR</div>
                    <div className="figval">{fmtWar(s.champ.war)}</div>
                    <div className="figsub">actual starters</div>
                  </div>
                  <div className="figcell">
                    <div className="figkey">Homegrown</div>
                    <div className="figval" style={{ color: s.homegrown == null ? "var(--dim3)" : "var(--acc)" }}>
                      {rate(s.homegrown) ?? "—"}
                    </div>
                    <div className="figsub">of starter WAR, own picks</div>
                  </div>
                  <div className="figcell">
                    <div className="figkey">Top player</div>
                    <div className="figval" style={{ fontSize: 19, lineHeight: 1.35 }}>
                      {s.champ.topPid
                        ? <PlayerLink pid={s.champ.topPid} name={pInfo(players, s.champ.topPid)[0]} />
                        : "—"}
                    </div>
                    <div className="figsub">{s.champ.topWar != null ? `${fmtWar(s.champ.topWar)} WAR` : ""}</div>
                  </div>
                </div>
              </div>

              <div className="panel" style={{ margin: 0, borderTopColor: "var(--rule-2)" }}>
                <div className="chart-label">What happened</div>
                <div style={{ font: "400 13.5px/1.7 var(--sans)", color: "var(--txt2)", textWrap: "pretty" }}>
                  <p style={{ margin: "0 0 9px" }}>
                    {s.champ.name} ({s.champ.manager}) won it at {s.champ.wins}-{s.champ.losses}
                    {s.champ.ties ? `-${s.champ.ties}` : ""}, {fmt(s.champ.ppg, 1)} points a week
                    {s.runnerUp ? `, over ${s.runnerUp.name} in the final` : ""}.
                    {s.bestRecord.rid !== s.champ.rid && (
                      ` ${s.bestRecord.name} had the best regular season at ${s.bestRecord.wins}-${s.bestRecord.losses} and finished ${ord(s.bestRecord.finish)}.`
                    )}
                    {s.homegrown != null && (
                      ` ${rate(s.homegrown) ?? "—"} of the champion's starter WAR came from players he drafted himself.`
                    )}
                  </p>
                  {(s.riser || s.faller) && (
                    <p style={{ margin: "0 0 9px" }}>
                      {s.riser && `${s.riser.manager} made the year's biggest climb — ${ord(s.riser.prev!)} to ${ord(s.riser.finish)}, ${climb} places.`}
                      {s.riser && s.faller ? " " : ""}
                      {s.faller && `${s.faller.manager} fell the furthest, ${ord(s.faller.prev!)} to ${ord(s.faller.finish)}.`}
                    </p>
                  )}
                  {!!s.champBought.length && (
                    <p style={{ margin: "0 0 9px" }}>
                      Bought, not drafted: {s.champBought.map((b, k) => (
                        <span key={b.pid}>
                          {k ? ", " : ""}
                          <PlayerLink pid={b.pid} name={pInfo(players, b.pid)[0]} />
                          {` (${fmtWar(b.war)} WAR, drafted by ${b.from})`}
                        </span>
                      ))}.
                    </p>
                  )}
                  {(LEAGUE_NOTES[s.season] ?? []).map(n => (
                    <p key={n} style={{ margin: "0 0 9px", color: "var(--dim2)" }}>{n}</p>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <DataTable cols={cols} groups={HIST_GROUPS} rows={s.rows} ctx={NO_CTX}
                label={`${s.season} final standings`}
                rowKey={r => String(r.rid)} sortId="" dir={-1} onSort={NO_SORT}
                onRowClick={r => nav(lp(`/franchise/${r.rid}`))}
                recordsOnMobile recordsClass="t3" />
            </div>
          </div>
        );
      })}

      {/* The old line read "finish is the final placing, not the seed", which
          stopped being true of the bottom half when the consolation bracket
          stopped deciding it (build_site_data.py has the reasoning). The split
          is the honest thing to state: playoff teams are placed by the
          playoffs, everyone else by the season they played. */}
      <div className="footnote">
        Finish is the playoff result for teams that made it, regular-season standings for those
        that didn't · move is places gained on the previous season ·
        homegrown share credits each week's WAR to the roster that started the player
      </div>
    </>
  );
}
